import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { Config, Unit, View } from '../lib/config'

export function SceneRefresh({
  config,
  view,
  dimensions,
  unit,
  quality,
  autoRotate,
}: {
  config: Config
  view: View
  dimensions: boolean
  unit: Unit
  quality: 'high' | 'lite'
  autoRotate: boolean
}) {
  const invalidate = useThree((state) => state.invalidate)
  // Demand rendering also needs a frame when a change only removes scene objects.
  useEffect(() => {
    invalidate()
  }, [config, view, dimensions, unit, quality, autoRotate, invalidate])
  return null
}
