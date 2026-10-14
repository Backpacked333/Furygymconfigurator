import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Matrix4, type WebGPURenderer } from 'three/webgpu'
import { createPipeline, type Pipeline } from '../render/pipeline'
import { onMaterialsChanged } from '../render/materials'
import type { Quality } from '../render/renderer'

/**
 * Drives the TSL pipeline. Rendering stays on demand, but after any change it keeps drawing for a
 * short settle window so temporal anti-aliasing, AO, and GI accumulate into a clean still.
 */
export function RenderEffects({
  quality,
  onCaptureReady,
}: {
  quality: Quality
  onCaptureReady: (capture: () => string) => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const pipeline = useRef<Pipeline | null>(null)
  const settle = useRef(0)
  const lastView = useRef(new Matrix4())

  useEffect(() => {
    const created = createPipeline(renderer, scene, camera, quality)
    pipeline.current = created
    settle.current = 0
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
    const moved = !lastView.current.equals(camera.matrixWorld)
    if (moved || settle.current <= 0) {
      settle.current = active.settleFrames
      lastView.current.copy(camera.matrixWorld)
    }
    active.render()
    settle.current--
    if (settle.current > 0) invalidate()
  }, 1)
  return null
}
