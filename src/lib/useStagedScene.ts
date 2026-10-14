import { useEffect, useState } from 'react'
import type { Config } from './config'
import type { Quality } from '../render/quality'
import { sceneProgress } from '../render/progress'

/** Longest an "updating" notice stays up if the scene never draws (hidden, or failed). */
const GIVE_UP_MS = 20_000

/**
 * Changes that rebuild much of the scene (size, product, surroundings, quality) can hold the main
 * thread while new geometry and shaders are prepared. Those reach the scene one painted frame
 * later, so an "updating" notice is already on screen, and its compositor-driven animation keeps
 * moving through the stall. Every other change passes straight through.
 */
export function useStagedScene(config: Config, quality: Quality) {
  const [staged, setStaged] = useState({ config, quality })
  // Applied to the scene, but not yet drawn by it.
  const [drawing, setDrawing] = useState(false)
  const heavy =
    staged.quality !== quality ||
    staged.config.length !== config.length ||
    staged.config.family !== config.family ||
    staged.config.environment !== config.environment
  if (!heavy && staged.config !== config) setStaged({ config, quality })

  useEffect(() => {
    if (!heavy) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        setStaged({ config, quality })
        setDrawing(true)
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [heavy, config, quality])

  useEffect(() => {
    if (!drawing) return
    const timer = setTimeout(() => setDrawing(false), GIVE_UP_MS)
    const cancel = sceneProgress.afterNextDraw(() => setDrawing(false))
    return () => {
      clearTimeout(timer)
      cancel()
    }
  }, [drawing, staged])

  // Derived during render, so the notice commits with the change that caused it.
  return { config: staged.config, quality: staged.quality, updating: heavy || drawing }
}
