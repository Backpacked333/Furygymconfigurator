import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { Config, Unit, View } from '../lib/config'
import type { Quality } from '@fury/viewer360'
import { invalidateShadows } from '@fury/viewer360/3d'

export function SceneRefresh({
  active,
  config,
  view,
  interactive = false,
  dimensions,
  unit,
  quality,
  autoRotate,
}: {
  active: boolean
  config: Config
  view: View
  interactive?: boolean
  dimensions: boolean
  unit: Unit
  quality: Quality
  autoRotate: boolean
}) {
  const invalidate = useThree((state) => state.invalidate)
  const scene = useThree((state) => state.scene)
  // Demand rendering also needs a frame when a change only removes scene objects. Passive effects
  // run after every layout effect of the commit, so the shadow redraw sees the finished scene.
  useEffect(() => {
    invalidateShadows(scene)
    invalidate()
  }, [active, config, view, interactive, dimensions, unit, quality, autoRotate, scene, invalidate])
  return null
}
