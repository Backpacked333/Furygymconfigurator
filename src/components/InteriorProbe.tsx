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
import { onMaterialsChanged, setProbeEnvironment, type ProbeKind } from '../render/materials'
import type { Quality } from '../render/quality'

/** Changes arriving faster than this (slider drags) are captured once, after they stop. */
export const DEBOUNCE_MS = 250

type ProbeOptions = {
  kind: ProbeKind
  config: Config
  quality: Quality
  /** Capture point, in world feet. */
  center: [number, number, number]
  /** Captures per change; a second capture adds a diffuse bounce of the first. */
  passes: number
  /** Cube face size per tier. */
  size: number
  /** Extra objects to leave out of the capture. */
  exclude?: (object: Object3D) => boolean
}

/**
 * Captures the scene into a radiance cube (PMREM) from one point and assigns it as the
 * environment of the materials that probe lights. Re-captures after any configuration or lighting
 * change, once textures settle; targets ping-pong so a probe is never sampled while it is being
 * written.
 */
function useRadianceProbe({ kind, config, quality, center, passes, size, exclude }: ProbeOptions) {
  const { gl, scene, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const state = useRef<{
    generator: PMREMGenerator
    targets: (RenderTarget | null)[]
    current: number
    passes: number
    due: number
    /** Whether a capture was taken: the first is taken at once, the rest after a pause. */
    captured: boolean
  } | null>(null)
  const position = useRef(new Vector3())
  const options = useRef({ size, exclude })
  useEffect(() => {
    position.current.set(...center)
    options.current = { size, exclude }
  })
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
      captured: false,
    }
    return () => {
      clearTimeout(wake.current)
      setProbeEnvironment(kind, null)
      state.current?.targets.forEach((t) => t?.dispose())
      state.current?.generator.dispose()
      state.current = null
    }
  }, [renderer, kind])

  useEffect(() => {
    if (!state.current) return
    state.current.passes = passes
    // The first capture in the first frame, before that frame draws: a probe that first exists
    // gives the materials it lights a new shader (materials.ts setProbeEnvironment), which the
    // spin would take for an edit (pathtrace.ts sceneParts reads a material's version) and
    // render its first frames again for; signed with the probe in from its first frame, the
    // design holds. A change after it is captured once the changes stop: a slider drag is many.
    state.current.due = state.current.captured ? performance.now() + DEBOUNCE_MS : 0
    wakeAt(state.current.due)
  }, [config, quality, passes, wakeAt])
  useEffect(
    () =>
      onMaterialsChanged((change) => {
        if (change !== 'textures' || !state.current) return
        state.current.passes = passes
        state.current.due = performance.now() + DEBOUNCE_MS
        wakeAt(state.current.due)
      }),
    [passes, wakeAt],
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
    // probe itself. Shadow maps are rendered once for the capture rather than once per cube face.
    const hidden: Object3D[] = []
    const shadows: { shadow: LightShadow; autoUpdate: boolean }[] = []
    // The sky's sun disc is a tiny, enormously bright spot: in a filtered capture it only adds
    // fireflies and counts the sun twice, since the sun light already lights every surface.
    const discs: { uniform: { value: number }; value: number }[] = []
    const { exclude: skip, size: faceSize } = options.current
    scene.traverse((object) => {
      const disc = (object as Object3D & { showSunDisc?: { value: number } }).showSunDisc
      if (disc) {
        discs.push({ uniform: disc, value: disc.value })
        disc.value = 0
      }
      const surface = (object as Mesh).material as
        { transmission?: number; userData?: { glass?: boolean } } | undefined
      const glazing = (surface?.transmission ?? 0) > 0 || surface?.userData?.glass
      const leave = object.userData.noProbe || glazing || (skip?.(object) ?? false)
      if (leave && object.visible) {
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
    // Reuse the idle target only at its own cube size; Lite and High/Ultra differ.
    if (probe.targets[next] && probe.targets[next].height !== 4 * faceSize) {
      probe.targets[next].dispose()
      probe.targets[next] = null
    }
    let target: RenderTarget
    try {
      target = probe.generator.fromScene(scene, 0, 0.05, 900, {
        size: faceSize,
        position: position.current,
        renderTarget: probe.targets[next] ?? undefined,
      })
    } finally {
      hidden.forEach((object) => (object.visible = true))
      shadows.forEach(({ shadow, autoUpdate }) => (shadow.autoUpdate = autoUpdate))
      discs.forEach(({ uniform, value }) => (uniform.value = value))
    }
    probe.targets[next] = target
    probe.current = next
    probe.passes--
    probe.captured = true
    setProbeEnvironment(kind, target.texture)
    invalidate()
  }, 0)
}

/**
 * Interior image-based lighting. A radiance cube is captured from the middle of the room and used
 * as the environment for interior surfaces, so walls, floor, and equipment are lit and reflected
 * by the room itself (light through the glazing, luminaires, finishes) rather than the open sky.
 * Two captures per change approximate a second diffuse bounce.
 */
export function InteriorProbe({ config, quality }: { config: Config; quality: Quality }) {
  useRadianceProbe({
    kind: 'interior',
    config,
    quality,
    center: [0, productHeight(config) * 0.52, 0.3],
    passes: 2,
    size: quality === 'lite' ? 64 : 128,
  })
  return null
}

/** The unit itself is left out of the site capture, which is taken from just in front of it. */
const isUnit = (object: Object3D) => object.userData.unit === true

/**
 * Local reflections for the outside of the unit. A radiance cube is captured just in front of the
 * glazing with the unit itself hidden, and used by glazing and glossy exterior finishes, so they
 * reflect the actual buildings, trees, and paving around them instead of only the open sky.
 */
export function SiteProbe({ config, quality }: { config: Config; quality: Quality }) {
  useRadianceProbe({
    kind: 'site',
    config,
    quality,
    center: [0, productHeight(config) * 0.5, 6],
    passes: 1,
    size: quality === 'lite' ? 128 : 256,
    exclude: isUnit,
  })
  return null
}
