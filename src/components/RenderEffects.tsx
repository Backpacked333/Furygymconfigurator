import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Quaternion, Vector3, type WebGPURenderer } from 'three/webgpu'
import { createPipeline, type Pipeline } from '../render/pipeline'
import { onMaterialsChanged } from '../render/materials'
import { sceneProgress } from '../render/progress'
import type { Quality } from '../render/quality'
import { FRAME_BEGIN, beginFrame } from '../render/renderer'
import { invalidateShadows, refreshShadows } from '../render/shadows'

/**
 * Camera motion below OrbitControls' own change threshold (squared distance and quaternion terms of
 * 1e-6) is not motion: its damping keeps nudging the camera by such amounts for hundreds of frames
 * after an orbit, and restarting the settle run for each nudge kept the GPU busy and delayed the
 * converged image long after anything visibly moved.
 */
const STILL = 1e-6

/** Median frame time (ms) of a settle run above which a tier is too heavy for this device. */
const SLOW_FRAME_MS: Record<Quality, number> = { ultra: 34, high: 40, lite: Infinity }

/**
 * Drives the TSL pipeline. Rendering stays on demand, but after any change it keeps drawing for a
 * short settle window so temporal anti-aliasing, AO, and GI accumulate into a clean still.
 */
export function RenderEffects({
  quality,
  onCaptureReady,
  onSlow,
}: {
  quality: Quality
  onCaptureReady: (capture: (() => string) | null) => void
  /** Called once per tier when consecutive frames are consistently slow. */
  onSlow?: () => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const pipeline = useRef<Pipeline | null>(null)
  const settle = useRef(0)
  const lastView = useRef({ position: new Vector3(Infinity, 0, 0), quaternion: new Quaternion() })
  const timing = useRef({
    last: 0,
    samples: [] as number[],
    frames: 0,
    reported: false,
    eventful: false,
  })

  useEffect(() => {
    const created = createPipeline(renderer, scene, camera, quality)
    let disposed = false
    invalidateShadows(scene)
    settle.current = 0
    timing.current = { last: 0, samples: [], frames: 0, reported: false, eventful: false }
    // Draw only once the shaders are ready, so the page stays responsive while they compile.
    created.warm().finally(() => {
      if (disposed) return
      pipeline.current = created
      invalidate()
    })
    return () => {
      disposed = true
      pipeline.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  // Streamed textures change surfaces, and each interior probe capture redraws shadow maps with
  // foliage and glazing hidden, so both also refresh the shadows.
  useEffect(
    () =>
      onMaterialsChanged(() => {
        invalidateShadows(scene)
        settle.current = 0
        invalidate()
      }),
    [scene, invalidate],
  )

  useEffect(() => {
    onCaptureReady(() => {
      beginFrame(renderer)
      refreshShadows(scene)
      pipeline.current?.render()
      return renderer.domElement.toDataURL('image/png')
    })
    // A capture must never read the canvas of a renderer that is gone.
    return () => onCaptureReady(null)
  }, [renderer, scene, onCaptureReady])

  // Before every other frame subscriber: camera controls, environment and probe captures, the pipeline.
  useFrame(() => beginFrame(renderer), FRAME_BEGIN)

  useFrame(() => {
    const active = pipeline.current
    if (!active) return
    const chained = settle.current > 0
    const last = lastView.current
    const moved =
      last.position.distanceToSquared(camera.position) > STILL ||
      8 * (1 - Math.abs(last.quaternion.dot(camera.quaternion))) > STILL
    if (moved || settle.current <= 0) {
      settle.current = active.settleFrames
      last.position.copy(camera.position)
      last.quaternion.copy(camera.quaternion)
    }
    // A frame right after a change, a streamed texture, or a probe capture also compiles
    // shaders, uploads textures, and redraws shadows: one-off work, not the cost of the tier.
    const eventful = refreshShadows(scene)
    active.render()
    sceneProgress.drawn()
    settle.current--
    if (settle.current > 0) invalidate()
    // Back-to-back settle frames measure what this GPU can sustain at this tier. The first frames
    // after a pipeline is built, and eventful frames with the one after them (whose interval
    // still carries their GPU work), are ignored.
    const t = timing.current
    const now = performance.now()
    t.frames++
    const steady = !eventful && !t.eventful
    t.eventful = eventful
    if (chained && steady && t.last && t.frames > 8 && !t.reported) {
      t.samples.push(now - t.last)
      if (t.samples.length >= 16) {
        const sorted = [...t.samples].sort((a, b) => a - b)
        if (sorted[sorted.length >> 1] > SLOW_FRAME_MS[quality]) {
          t.reported = true
          onSlow?.()
        }
        t.samples = []
      }
    }
    t.last = now
  }, 1)
  return null
}
