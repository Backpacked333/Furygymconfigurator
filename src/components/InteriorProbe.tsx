import { useCallback, useEffect, useRef } from 'react'
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
import { sceneWork } from '../render/progress'

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
  debounce = DEBOUNCE_MS,
  passes = 2,
}: {
  config: Config
  quality: Quality
  /** Stills capture at once; the live view waits for a burst of changes to end. */
  debounce?: number
  /** Captures per change: each adds a diffuse bounce. */
  passes?: number
}) {
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
  const wake = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Wakes the demand loop when a capture falls due, instead of drawing identical frames. */
  const wakeAt = useCallback(
    (due: number) => {
      clearTimeout(wake.current)
      wake.current = setTimeout(invalidate, Math.max(0, due - performance.now()))
    },
    [invalidate],
  )

  useEffect(() => {
    state.current = {
      generator: new PMREMGenerator(renderer),
      targets: [null, null],
      current: 0,
      passes: 0,
      due: 0,
    }
    return () => {
      clearTimeout(wake.current)
      sceneWork.set('probe', false)
      setInteriorEnvironment(null)
      state.current?.targets.forEach((t) => t?.dispose())
      state.current?.generator.dispose()
      state.current = null
    }
  }, [renderer])

  // Re-capture after any configuration or lighting change, once textures settle.
  useEffect(() => {
    if (!state.current) return
    state.current.passes = passes
    state.current.due = performance.now() + debounce
    sceneWork.set('probe', true)
    wakeAt(state.current.due)
  }, [config, quality, wakeAt, passes, debounce])
  useEffect(
    () =>
      onMaterialsChanged((change) => {
        if (change !== 'textures' || !state.current) return
        state.current.passes = passes
        state.current.due = performance.now() + debounce
        sceneWork.set('probe', true)
        wakeAt(state.current.due)
      }),
    [wakeAt, passes, debounce],
  )

  useFrame(() => {
    const probe = state.current
    if (!probe || probe.passes <= 0) return
    if (performance.now() < probe.due) {
      wakeAt(probe.due)
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
      const surface = (object as Mesh).material as
        { transmission?: number; userData?: { glass?: boolean } } | undefined
      const glazing = (surface?.transmission ?? 0) > 0 || surface?.userData?.glass
      if ((object.userData.noProbe || glazing) && object.visible) {
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
    const size = quality === 'lite' ? 64 : 128
    // Reuse the idle target only at its own cube size; Lite and High/Ultra differ.
    if (probe.targets[next] && probe.targets[next].height !== 4 * size) {
      probe.targets[next].dispose()
      probe.targets[next] = null
    }
    let target: RenderTarget
    try {
      target = probe.generator.fromScene(scene, 0, 0.05, 400, {
        size,
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
    if (probe.passes <= 0) sceneWork.set('probe', false)
    setInteriorEnvironment(target.texture)
    invalidate()
  }, 0)
  return null
}
