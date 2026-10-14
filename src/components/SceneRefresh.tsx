import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import type { Config, Unit, View } from '../lib/config'
import type { Quality } from '../render/quality'

export function SceneRefresh({
  config,
  view,
  dimensions,
  unit,
  quality,
  autoRotate,
  onReset,
}: {
  config: Config
  view: View
  dimensions: boolean
  unit: Unit
  quality: Quality
  autoRotate: boolean
  onReset?: () => void
}) {
  const invalidate = useThree((state) => state.invalidate)
  const reset = useRef(onReset)
  reset.current = onReset
  // Demand rendering also needs a frame when a change only removes scene objects.
  useEffect(() => {
    reset.current?.()
    invalidate()
  }, [config, view, dimensions, unit, quality, autoRotate, invalidate])
  return null
}
