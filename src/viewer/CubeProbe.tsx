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
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import { sceneChanges, sceneWork, type SceneChange } from './progress'
import { shadowsPending } from './shadows'
import { reusable } from './cube'
import { useTier } from './tierContext'
import type { Vec3 } from './OrbitRig'

/** Changes arriving faster than this (slider drags) are captured once, after they stop. */
const DEBOUNCE_MS = 250

/** Hidden from every capture: planar reflectors, transmissive surfaces, and opted-out objects. */
function hiddenFromProbe(object: Object3D) {
  if (object.userData.noProbe) return true
  const surface = (object as Mesh).material as
    { transmission?: number; userData?: { glass?: boolean } } | undefined
  return (surface?.transmission ?? 0) > 0 || !!surface?.userData?.glass
}

/**
 * A radiance probe: a PMREM cube captured from `position` and handed to `onCapture`, for image-
 * based lighting of a space by the space itself (an interior lit by its windows and luminaires
 * rather than the open sky). Captured only when `captureKey` changes or a listed scene change
 * arrives, never per frame, and only once shadow maps are current, so a capture never redraws
 * them. Each extra pass adds a diffuse bounce; targets ping-pong so a probe is never sampled
 * while it is being written, and are reused for every later capture.
 */
export function CubeProbe({
  position,
  captureKey,
  onCapture,
  hide,
  size,
  passes,
  debounce = DEBOUNCE_MS,
  recaptureOn = ['textures'],
}: {
  position: Vec3
  /** Captures again whenever this changes: encode everything that affects the probe's view. */
  captureKey: string
  onCapture: (texture: Texture | null) => void
  /** More objects to hide from the capture (dense foliage that adds cost but little light). */
  hide?: (object: Object3D) => boolean
  /** Defaults to the tier's probe size and passes. */
  size?: number
  passes?: number
  debounce?: number
  recaptureOn?: SceneChange[]
}) {
  const { gl, scene, invalidate } = useThree()
  const { spec } = useTier()
  const faceSize = size ?? spec.probe.size
  const bounces = passes ?? spec.probe.passes
  const renderer = gl as unknown as WebGPURenderer
  const state = useRef<{
    generator: PMREMGenerator
    targets: (RenderTarget | null)[]
    current: number
    passes: number
    due: number
  } | null>(null)
  const center = useRef(new Vector3())
  center.current.set(...position)
  const report = useRef(onCapture)
  report.current = onCapture
  const filter = useRef(hide)
  filter.current = hide
  const wake = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Wakes the demand loop when a capture falls due, instead of drawing identical frames. */
  const wakeAt = useCallback(
    (due: number) => {
      clearTimeout(wake.current)
      wake.current = setTimeout(invalidate, Math.max(0, due - performance.now()))
    },
    [invalidate],
  )
  const schedule = useCallback(() => {
    if (!state.current) return
    state.current.passes = bounces
    state.current.due = performance.now() + debounce
    sceneWork.set('probe', true)
    wakeAt(state.current.due)
  }, [bounces, debounce, wakeAt])

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
      report.current(null)
      state.current?.targets.forEach((t) => t?.dispose())
      state.current?.generator.dispose()
      state.current = null
    }
  }, [renderer])

  useEffect(schedule, [captureKey, faceSize, schedule])
  const triggers = recaptureOn.join()
  useEffect(
    () =>
      sceneChanges.subscribe((change) => {
        if (triggers.split(',').includes(change)) schedule()
      }),
    [triggers, schedule],
  )

  useFrame(() => {
    const probe = state.current
    if (!probe || probe.passes <= 0) return
    if (performance.now() < probe.due) {
      wakeAt(probe.due)
      return
    }
    // The capture uses the shadow maps as they are; stale ones are redrawn by the next frame.
    if (shadowsPending(scene)) {
      wakeAt(performance.now() + 16)
      return
    }
    const next = 1 - probe.current
    const hidden: Object3D[] = []
    const shadows: { shadow: LightShadow; autoUpdate: boolean }[] = []
    scene.traverse((object) => {
      if (object.visible && (hiddenFromProbe(object) || filter.current?.(object))) {
        object.visible = false
        hidden.push(object)
      }
      const light = object as Light & { shadow?: LightShadow }
      if (light.isLight && light.castShadow && light.shadow) {
        shadows.push({ shadow: light.shadow, autoUpdate: light.shadow.autoUpdate })
        light.shadow.autoUpdate = false
      }
    })
    if (!reusable(probe.targets[next], faceSize)) {
      probe.targets[next]?.dispose()
      probe.targets[next] = null
    }
    let target: RenderTarget
    try {
      target = probe.generator.fromScene(scene, 0, 0.05, 400, {
        size: faceSize,
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
    report.current(target.texture)
    invalidate()
  }, 0)
  return null
}
