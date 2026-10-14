import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  PMREMGenerator,
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

/** Changes arriving faster than this (slider drags) are captured once, after they stop. */
const DEBOUNCE_MS = 250

/**
 * Interior image-based lighting. A radiance cube is captured from the middle of the room and used
 * as the environment for interior surfaces, so walls, floor, and equipment are lit and reflected
 * by the room itself (light through the glazing, luminaires, finishes) rather than the open sky.
 * Two captures per change approximate a second diffuse bounce; targets ping-pong so a probe is
 * never sampled while it is being written.
 */
export function InteriorProbe({ config, quality }: { config: Config; quality: Quality }) {
  const { gl, scene, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const state = useRef<{
    generator: PMREMGenerator
    targets: (RenderTarget | null)[]
    current: number
    passes: number
    due: number
  } | null>(null)
  const center = useRef(new Vector3())
  center.current.set(0, productHeight(config) * 0.52, 0.3)

  useEffect(() => {
    state.current = {
      generator: new PMREMGenerator(renderer),
      targets: [null, null],
      current: 0,
      passes: 0,
      due: 0,
    }
    return () => {
      setInteriorEnvironment(null)
      state.current?.targets.forEach((t) => t?.dispose())
      state.current?.generator.dispose()
      state.current = null
    }
  }, [renderer])

  // Re-capture after any configuration or lighting change, once textures settle.
  useEffect(() => {
    if (!state.current) return
    state.current.passes = 2
    state.current.due = performance.now() + DEBOUNCE_MS
    invalidate()
  }, [config, quality, invalidate])
  useEffect(
    () =>
      onMaterialsChanged((change) => {
        if (change !== 'textures' || !state.current) return
        state.current.passes = 2
        state.current.due = performance.now() + DEBOUNCE_MS
      }),
    [],
  )

  useFrame(() => {
    const probe = state.current
    if (!probe || probe.passes <= 0) return
    if (performance.now() < probe.due) {
      invalidate()
      return
    }
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
    try {
      target = probe.generator.fromScene(scene, 0, 0.05, 400, {
        size: quality === 'lite' ? 64 : 128,
        position: center.current,
        renderTarget: probe.targets[next] ?? undefined,
      })
    } finally {
      hidden.forEach((object) => (object.visible = true))
      shadows.forEach(({ shadow, autoUpdate }) => (shadow.autoUpdate = autoUpdate))
    }
    probe.targets[next] = target
    probe.current = next
    probe.passes--
    setInteriorEnvironment(target.texture)
    invalidate()
  }, 0)
  return null
}
