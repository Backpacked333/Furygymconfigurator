import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Matrix4, type WebGPURenderer } from 'three/webgpu'
import { createPipeline, type Pipeline } from '../render/pipeline'
import { onMaterialsChanged } from '../render/materials'
import type { Quality } from '../render/quality'

/** Median frame time (ms) of a settle run above which a tier is too heavy for this device. */
const SLOW_FRAME_MS: Record<Quality, number> = { ultra: 50, high: 75, lite: Infinity }

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
  onCaptureReady: (capture: () => string) => void
  /** Called once per tier when consecutive frames are consistently slow. */
  onSlow?: () => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const pipeline = useRef<Pipeline | null>(null)
  const settle = useRef(0)
  const lastView = useRef(new Matrix4())
  const timing = useRef({ last: 0, samples: [] as number[], frames: 0, reported: false })

  useEffect(() => {
    const created = createPipeline(renderer, scene, camera, quality)
    pipeline.current = created
    settle.current = 0
    timing.current = { last: 0, samples: [], frames: 0, reported: false }
    invalidate()
    return () => {
      pipeline.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  useEffect(
    () =>
      onMaterialsChanged(() => {
        settle.current = 0
        invalidate()
      }),
    [invalidate],
  )

  useEffect(() => {
    onCaptureReady(() => {
      pipeline.current?.render()
      return renderer.domElement.toDataURL('image/png')
    })
  }, [renderer, onCaptureReady])

  useFrame(() => {
    const active = pipeline.current
    if (!active) return
    const chained = settle.current > 0
    const moved = !lastView.current.equals(camera.matrixWorld)
    if (moved || settle.current <= 0) {
      settle.current = active.settleFrames
      lastView.current.copy(camera.matrixWorld)
    }
    active.render()
    settle.current--
    if (settle.current > 0) invalidate()
    // Back-to-back settle frames measure what this GPU can sustain at this tier. The first frames
    // after a pipeline is built include shader compilation and are ignored.
    const t = timing.current
    const now = performance.now()
    t.frames++
    if (chained && t.last && t.frames > 8 && !t.reported) {
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
