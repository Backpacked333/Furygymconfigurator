import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Matrix4,
  PerspectiveCamera,
  RendererUtils,
  Vector2,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu'
import { createPipeline, type Pipeline } from '../render/pipeline'
import { onMaterialsChanged } from '../render/materials'
import {
  createQualityGovernor,
  resetQualitySampling,
  sampleQuality,
  type Quality,
  type QualityMode,
} from '../render/quality'
import { deviceProfile, observeRendererLoss } from '../render/renderer'
import { createCaptureProvider, type CaptureRegistration } from '../lib/capture'
import { captureFov } from '../lib/camera'
import type { AssetReadiness, PresentationStore } from '../lib/presentation'

/**
 * Drives the TSL pipeline. Rendering stays on demand, but after any change it keeps drawing for a
 * short settle window so temporal anti-aliasing, AO, and GI accumulate into a clean still.
 */
export function RenderEffects({
  quality,
  onCaptureReady,
  onSlow,
  presentation,
  onCaptureProvider,
  onError,
  assets,
  qualityMode = quality,
}: {
  quality: Quality
  onCaptureReady?: (capture: () => string) => void
  /** Called once per tier when consecutive frames are consistently slow. */
  onSlow?: () => void
  presentation: PresentationStore
  onCaptureProvider?: CaptureRegistration
  onError: (error: unknown) => void
  assets?: AssetReadiness
  qualityMode?: QualityMode
}) {
  const { gl, scene, camera, invalidate, size, controls, viewport: liveViewport, get } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const pipeline = useRef<Pipeline | null>(null)
  const captureProvider = useRef<ReturnType<typeof createCaptureProvider> | null>(null)
  const settle = useRef(0)
  const lastView = useRef(new Matrix4())
  const timing = useRef({
    last: 0,
    governor: createQualityGovernor(quality, qualityMode),
    reported: false,
  })
  const waiting = useRef(assets)
  waiting.current = assets
  const fail = useRef(onError)
  fail.current = onError

  useEffect(() => {
    let created: Pipeline
    try {
      created = createPipeline(renderer, scene, camera, quality)
    } catch (error) {
      fail.current(error)
      return
    }
    pipeline.current = created
    presentation.set({ ...presentation.get(), stage: 'refining' })
    settle.current = created.settleFrames
    presentation.reset = () => {
      created.resetHistory()
      settle.current = created.settleFrames
      const state = presentation.get()
      if (state.stage !== 'lost') presentation.set({ ...state, stage: 'refining' })
      invalidate()
    }
    invalidate()
    return () => {
      captureProvider.current?.dispose()
      if (pipeline.current === created) pipeline.current = null
      presentation.reset = () => {}
      created.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate, presentation])

  useEffect(() => {
    timing.current = {
      last: 0,
      governor: createQualityGovernor(quality, qualityMode),
      reported: false,
    }
  }, [quality, qualityMode])

  useEffect(
    () =>
      observeRendererLoss(renderer, (reason) => {
        presentation.set({ ...presentation.get(), stage: 'lost', reasons: [reason] })
        fail.current(new Error(reason))
      }),
    [renderer, presentation],
  )

  useLayoutEffect(() => {
    presentation.reset()
  }, [assets?.pending, assets?.degraded, assets?.revision, presentation])

  useEffect(() => {
    const reset = () => {
      timing.current.last = 0
      timing.current.governor = resetQualitySampling(timing.current.governor)
      if (!document.hidden) presentation.reset()
    }
    reset()
    document.addEventListener('visibilitychange', reset)
    return () => document.removeEventListener('visibilitychange', reset)
  }, [size.width, size.height, liveViewport.dpr, presentation])

  useEffect(() => onMaterialsChanged(() => presentation.reset()), [presentation])

  useEffect(() => {
    let alive = true
    onCaptureReady?.(() => {
      if (!alive || presentation.get().stage === 'lost' || presentation.capturing)
        throw new Error('Capture generation is no longer available')
      pipeline.current?.render()
      return renderer.domElement.toDataURL('image/png')
    })
    return () => {
      alive = false
    }
  }, [renderer, onCaptureReady, presentation])

  useEffect(() => {
    const provider = createCaptureProvider({
      generation: presentation.get().token.generation,
      profile: deviceProfile(renderer),
      getState: presentation.get,
      subscribe: presentation.subscribe,
      nextFrame: (signal) =>
        new Promise<void>((resolve) => {
          const abort = () => {
            cancelAnimationFrame(id)
            resolve()
          }
          const id = requestAnimationFrame(() => {
            signal.removeEventListener('abort', abort)
            resolve()
          })
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }),
      prepare(request) {
        const active = pipeline.current
        if (!active || !(camera instanceof PerspectiveCamera))
          throw new Error('Capture camera is unavailable')
        const saved = RendererUtils.saveRendererState(renderer)
        const oldSize = renderer.getSize(new Vector2())
        const liveSize = { ...get().size }
        const viewport = renderer.getViewport(new Vector4())
        const scissor = renderer.getScissor(new Vector4())
        const cameraCopy = camera.clone()
        const orbit = controls as unknown as { enabled: boolean } | null
        const enabled = orbit?.enabled
        let restored = false
        const restore = () => {
          if (restored) return
          restored = true
          try {
            const latest = get()
            const currentToken = presentation.get().token
            const exposure = renderer.toneMappingExposure
            const resized =
              liveSize.width !== latest.size.width || liveSize.height !== latest.size.height
            camera.copy(cameraCopy, false)
            renderer.setSize(oldSize.x, oldSize.y, false)
            RendererUtils.restoreRendererState(renderer, saved)
            if (
              currentToken.revision !== request.token.revision ||
              currentToken.presentation !== request.token.presentation
            )
              renderer.toneMappingExposure = exposure
            renderer.setViewport(viewport)
            renderer.setScissor(scissor)
            if (resized || latest.viewport.dpr !== saved.pixelRatio) {
              renderer.setPixelRatio(latest.viewport.dpr)
              renderer.setSize(latest.size.width, latest.size.height, false)
              camera.aspect = latest.size.width / latest.size.height
              camera.updateProjectionMatrix()
              renderer.setViewport(0, 0, latest.size.width, latest.size.height)
              renderer.setScissor(0, 0, latest.size.width, latest.size.height)
            }
            const restoredBuffer = renderer.getDrawingBufferSize(new Vector2())
            active.resize(restoredBuffer.x, restoredBuffer.y)
            active.resetHistory()
          } finally {
            if (orbit && enabled !== undefined)
              orbit.enabled =
                presentation.get().token.view === request.token.view
                  ? enabled
                  : presentation.get().token.view === 'exterior'
            presentation.capturing = false
            presentation.reset()
          }
        }
        try {
          presentation.capturing = true
          if (orbit) orbit.enabled = false
          camera.fov =
            request.framing === 'center-crop'
              ? captureFov(camera.fov, camera.aspect, request.width / request.height)
              : camera.fov
          camera.aspect = request.width / request.height
          camera.clearViewOffset()
          camera.updateProjectionMatrix()
          renderer.setRenderTarget(null)
          renderer.setPixelRatio(1)
          renderer.setSize(request.width, request.height, false)
          renderer.setViewport(0, 0, request.width, request.height)
          renderer.setScissorTest(false)
          active.resize(request.width, request.height)
          active.resetHistory()
          return {
            frames: active.settleFrames,
            render() {
              try {
                active.render()
              } catch (error) {
                fail.current(error)
                throw error
              }
              const actual = renderer.getDrawingBufferSize(new Vector2())
              return { width: actual.x, height: actual.y }
            },
            encode: () =>
              new Promise<Blob | null>((resolve) =>
                renderer.domElement.toBlob(resolve, 'image/png'),
              ),
            restore,
          }
        } catch (error) {
          restore()
          throw error
        }
      },
    })
    captureProvider.current = provider
    const unregister = onCaptureProvider?.(provider)
    return () => {
      provider.dispose()
      if (captureProvider.current === provider) captureProvider.current = null
      unregister?.()
    }
  }, [
    renderer,
    camera,
    controls,
    presentation,
    onCaptureProvider,
    size.width,
    size.height,
    liveViewport.dpr,
    get,
    quality,
  ])

  useFrame(() => {
    const active = pipeline.current
    if (!active || presentation.capturing || presentation.get().stage === 'lost') return
    const moved = !lastView.current.equals(camera.matrixWorld)
    if (moved) {
      settle.current = active.settleFrames
      lastView.current.copy(camera.matrixWorld)
    }
    const buffer = renderer.getDrawingBufferSize(new Vector2())
    try {
      active.resize(buffer.x, buffer.y)
      active.render()
    } catch (error) {
      presentation.set({
        ...presentation.get(),
        stage: 'lost',
        reasons: ['Render submission failed'],
      })
      fail.current(error)
      return
    }
    settle.current--
    if (settle.current > 0) invalidate()
    const state = presentation.get()
    const pending = presentation.probePending || (waiting.current?.pending ?? 0) > 0
    const degraded = !waiting.current || waiting.current.degraded
    const stage = state.animating
      ? 'interactive'
      : settle.current > 0 || pending
        ? 'refining'
        : degraded
          ? 'degraded'
          : 'settled'
    if (
      state.stage !== stage ||
      state.rendered.width !== buffer.x ||
      state.rendered.height !== buffer.y ||
      state.display?.width !== size.width ||
      state.display?.height !== size.height
    )
      presentation.set({
        ...state,
        stage,
        rendered: { width: buffer.x, height: buffer.y },
        display: {
          width: size.width,
          height: size.height,
          dpr: buffer.x / Math.max(1, size.width),
        },
        reasons: !waiting.current
          ? ['Active-owner asset readiness is not connected.']
          : degraded
            ? ['One or more active assets use fallbacks.']
            : [],
      })
    const t = timing.current
    const now = performance.now()
    if (state.animating && moved && t.last && !t.reported) {
      t.governor = sampleQuality(t.governor, now - t.last, now, !document.hidden)
      if (t.governor.tier !== quality) {
        t.reported = true
        onSlow?.()
      }
    } else if (!state.animating || !moved) {
      t.governor = resetQualitySampling(t.governor)
    }
    t.last = now
  }, 1)
  return null
}
