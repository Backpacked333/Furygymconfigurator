import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Matrix4, type WebGPURenderer } from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import { keepDecodedTextures, onMaterialsChanged } from '../render/materials'
import { MotionShutter } from '../render/motionBlur'
import { PathTraceSession, loadTracerModule, lookKey, sceneSignature } from '../render/pathtrace'
import { createPipeline, type Pipeline } from '../render/pipeline'
import { sceneProgress, textureProgress } from '../render/progress'
import { backendOf, beginFrame, FRAME_BEGIN, type Quality } from '../render/renderer'
import { createProgressivePresentation } from './presentation'

export type ViewerStatus = 'loading' | 'interactive' | 'refining' | 'settled' | 'raster-only'
export const LIVE_SAMPLES = 1024
const REST_MS = 150

/** Local-only rendering controller. Product geometry and configuration stay in the adapter. */
export function ProgressiveRenderer({
  active,
  revision,
  look,
  quality,
  place,
  onReady,
  onStatus,
}: {
  active: boolean
  revision: string
  look: SkyLook
  quality: Quality
  place: 'exterior' | 'interior'
  onReady: () => void
  onStatus: (status: ViewerStatus) => void
}) {
  const { gl, scene, camera, invalidate, size, viewport } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const state = useRef<{
    pipe: Pipeline
    present: ReturnType<typeof createProgressivePresentation>
    tracer: PathTraceSession | null
    failed: boolean
    dirty: boolean
    ready: boolean
    tracing: boolean
    interacting: boolean
    restAt: number
    remaining: number
    view: Matrix4
    projection: Matrix4
    status: ViewerStatus
    shutter: MotionShutter
    signature: number | null
  } | null>(null)
  const props = useRef({ active, look, place, onReady, onStatus })
  useLayoutEffect(() => {
    props.current = { active, look, place, onReady, onStatus }
    if (state.current) {
      state.current.dirty = true
      if (!active) {
        state.current.tracer?.halt()
        state.current.tracing = false
      }
    }
    invalidate()
  }, [
    active,
    revision,
    look,
    place,
    onReady,
    onStatus,
    invalidate,
    size.width,
    size.height,
    viewport.dpr,
  ])

  useEffect(() => {
    let disposed = false
    const runtime = {
      pipe: createPipeline(renderer, scene, camera, quality),
      present: createProgressivePresentation(renderer),
      tracer: null as PathTraceSession | null,
      failed: backendOf(renderer) !== 'webgpu',
      dirty: true,
      ready: false,
      tracing: false,
      interacting: false,
      restAt: 0,
      remaining: 0,
      view: new Matrix4(),
      projection: new Matrix4(),
      status: 'loading' as ViewerStatus,
      shutter: new MotionShutter(),
      signature: null as number | null,
    }
    state.current = runtime
    const dirty = () => {
      runtime.dirty = true
      runtime.tracer?.invalidate()
      if (props.current.active) invalidate()
    }
    const materials = onMaterialsChanged(dirty)
    const textures = textureProgress.subscribe(dirty)
    const interrupt = () => {
      runtime.tracer?.halt()
      runtime.tracing = false
      runtime.dirty = true
      if (props.current.active) invalidate()
    }
    const down = () => {
      runtime.interacting = true
      interrupt()
    }
    const up = () => {
      if (!runtime.interacting) return
      runtime.interacting = false
      interrupt()
    }
    renderer.domElement.addEventListener('pointerdown', down)
    renderer.domElement.addEventListener('wheel', interrupt, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    const visibility = () => {
      if (document.hidden) {
        runtime.tracer?.halt()
        runtime.tracing = false
      }
      runtime.dirty = true
      if (!document.hidden && props.current.active) invalidate()
    }
    document.addEventListener('visibilitychange', visibility)
    let keepingDecoded = false
    if (!runtime.failed)
      void loadTracerModule()
        .then(async (modules) => {
          if (disposed) return
          // The tracer packs its own texture atlas from the scans' decoded pixels; a map released
          // after upload traces black (the ground, the brick, everything in shade).
          keepingDecoded = true
          await keepDecodedTextures(true)
          if (disposed) return
          runtime.tracer = new PathTraceSession(renderer, modules, true, {
            multiView: true,
            maxBounces: 10,
            batchMs: 12,
            maxPasses: 8,
          })
          runtime.dirty = true
          if (props.current.active) invalidate()
        })
        .catch(() => {
          if (disposed) return
          runtime.failed = true
          invalidate()
        })
    invalidate()
    return () => {
      disposed = true
      state.current = null
      materials()
      textures()
      renderer.domElement.removeEventListener('pointerdown', down)
      renderer.domElement.removeEventListener('wheel', interrupt)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
      document.removeEventListener('visibilitychange', visibility)
      runtime.tracer?.dispose()
      if (keepingDecoded) void keepDecodedTextures(false)
      runtime.present.dispose()
      runtime.pipe.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  useFrame(() => {
    if (props.current.active && !document.hidden) beginFrame(renderer)
  }, FRAME_BEGIN)
  useFrame(() => {
    const current = state.current
    if (!current || !props.current.active || document.hidden) return
    const { pipe, tracer } = current
    const report = (status: ViewerStatus) => {
      if (current.status === status) return
      current.status = status
      props.current.onStatus(status)
    }
    const now = performance.now()
    camera.updateMatrixWorld()
    scene.updateMatrixWorld()
    const signature = sceneSignature(scene, lookKey(props.current.look))
    if (signature !== current.signature) {
      current.signature = signature
      current.dirty = true
    }
    const moved = !current.view.equals(camera.matrixWorld)
    if (current.dirty) current.shutter.cut()
    if (pipe.shutter) pipe.shutter.value = current.shutter.frame(now, moved && !current.dirty)
    if (current.dirty || moved || !current.projection.equals(camera.projectionMatrix)) {
      tracer?.halt()
      current.tracing = false
      current.dirty = false
      current.view.copy(camera.matrixWorld)
      current.projection.copy(camera.projectionMatrix)
      current.restAt = now + REST_MS
      current.remaining = Math.max(6, pipe.settleFrames)
    }
    pipe.setPlace(props.current.place)
    if (!current.tracing) {
      pipe.render()
      sceneProgress.drawn()
      if (!current.ready) {
        current.ready = true
        props.current.onReady()
      }
      report(current.failed ? 'raster-only' : 'interactive')
      current.remaining--
      const textures = textureProgress.get()
      if (
        tracer &&
        !current.failed &&
        !current.interacting &&
        now >= current.restAt &&
        current.remaining <= pipe.settleFrames - 6 &&
        textures.loaded >= textures.requested
      ) {
        try {
          current.present.capture(() => pipe.render())
          tracer.begin(scene, camera, props.current.look, LIVE_SAMPLES)
          current.tracing = true
        } catch {
          tracer.halt()
          current.failed = true
          report('raster-only')
        }
      }
      if (current.remaining > 0 || (!current.failed && now < current.restAt)) invalidate()
    }
    if (current.tracing && tracer) {
      try {
        const developing = tracer.step()
        const view = tracer.view(now)
        if (view.t > 0) current.present.render(view)
        report(developing ? 'refining' : 'settled')
        if (developing) invalidate()
      } catch {
        tracer.halt()
        current.failed = true
        current.tracing = false
        current.dirty = true
        report('raster-only')
        invalidate()
      }
    }
  }, 1)
  return null
}
