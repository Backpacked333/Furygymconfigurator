import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  PMREMGenerator,
  RendererUtils,
  Vector3,
  type Light,
  type LightShadow,
  type Mesh,
  type Object3D,
  type RenderTarget,
  type WebGPURenderer,
} from 'three/webgpu'
import { productHeight, type Config } from '../lib/config'
import { onMaterialsChanged, setInteriorEnvironment } from '../render/materials'
import type { Quality } from '../render/quality'
import type { PresentationStore } from '../lib/presentation'

/** Changes arriving faster than this (slider drags) are captured once, after they stop. */
const DEBOUNCE_MS = 250

/**
 * Interior image-based lighting. A radiance cube is captured from the middle of the room and used
 * as the environment for interior surfaces, so walls, floor, and equipment are lit and reflected
 * by the room itself (light through the glazing, luminaires, finishes) rather than the open sky.
 * Two captures per change approximate a second diffuse bounce; targets ping-pong so a probe is
 * never sampled while it is being written.
 */
export function InteriorProbe({
  config,
  quality,
  presentation,
  onError,
}: {
  config: Config
  quality: Quality
  presentation?: PresentationStore
  onError?: (error: unknown) => void
}) {
  const { gl, scene, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const state = useRef<{
    generator: PMREMGenerator
    targets: ({ target: RenderTarget; size: number } | null)[]
    current: number
    passes: number
    ready: boolean
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)
  const center = useRef(new Vector3())
  center.current.set(0, productHeight(config) * 0.52, 0.3)

  useEffect(() => {
    const created = {
      generator: new PMREMGenerator(renderer),
      targets: [null, null] as ({ target: RenderTarget; size: number } | null)[],
      current: 0,
      passes: 0,
      ready: false,
      timer: null as ReturnType<typeof setTimeout> | null,
    }
    state.current = created
    return () => {
      if (created.timer !== null) clearTimeout(created.timer)
      setInteriorEnvironment(null)
      created.targets.forEach((t) => t?.target.dispose())
      created.generator.dispose()
      if (state.current === created) state.current = null
    }
  }, [renderer])

  // Re-capture after any configuration or lighting change, once textures settle.
  useEffect(() => {
    const schedule = () => {
      const probe = state.current
      if (!probe) return
      if (probe.timer !== null) clearTimeout(probe.timer)
      probe.passes = 2
      probe.ready = false
      if (presentation) presentation.probePending = true
      probe.timer = setTimeout(() => {
        probe.timer = null
        probe.ready = true
        invalidate()
      }, DEBOUNCE_MS)
    }
    schedule()
    const stop = onMaterialsChanged((change) => {
      if (change === 'textures') schedule()
    })
    return () => {
      stop()
      if (state.current?.timer != null) clearTimeout(state.current.timer)
    }
  }, [config, quality, invalidate, presentation])

  useFrame(() => {
    const probe = state.current
    if (!probe || probe.passes <= 0 || !probe.ready || presentation?.capturing) return
    const next = 1 - probe.current
    // Planar reflectors keep a render target per camera and must not render into the six capture
    // cameras. Transmissive surfaces sample a copy of the frame being drawn, which here is the
    // probe itself. Dense instanced foliage adds cost but no meaningful light to the room. Shadow
    // maps are rendered once for the capture rather than once per cube face.
    const hidden: Object3D[] = []
    const shadows: { shadow: LightShadow; autoUpdate: boolean }[] = []
    scene.traverse((object) => {
      const surface = (object as Mesh).material as { transmission?: number } | undefined
      if ((object.userData.noProbe || (surface?.transmission ?? 0) > 0) && object.visible) {
        object.visible = false
        hidden.push(object)
      }
      const light = object as Light & { shadow?: LightShadow }
      if (light.isLight && light.castShadow && light.shadow) {
        shadows.push({ shadow: light.shadow, autoUpdate: light.shadow.autoUpdate })
        light.shadow.autoUpdate = false
        light.shadow.needsUpdate = true
      }
    })
    let target: RenderTarget
    const size = quality === 'lite' ? 64 : 128
    const previous = probe.targets[next]
    const rendererState = RendererUtils.saveRendererState(renderer)
    try {
      target = probe.generator.fromScene(scene, 0, 0.05, 400, {
        size,
        position: center.current,
        renderTarget: previous?.size === size ? previous.target : undefined,
      })
    } catch (error) {
      probe.passes = 0
      onError?.(error)
      return
    } finally {
      RendererUtils.restoreRendererState(renderer, rendererState)
      hidden.forEach((object) => (object.visible = true))
      shadows.forEach(({ shadow, autoUpdate }) => (shadow.autoUpdate = autoUpdate))
    }
    probe.targets[next] = { target, size }
    probe.current = next
    probe.passes--
    setInteriorEnvironment(target.texture)
    if (previous && previous.target !== target) previous.target.dispose()
    if (presentation) {
      presentation.probePending = probe.passes > 0
      presentation.reset()
    }
    invalidate()
  }, 0)
  return null
}
