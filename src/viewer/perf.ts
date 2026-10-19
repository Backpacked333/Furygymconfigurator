import { useEffect, useState } from 'react'
import type { Quality } from './quality'

/** `?debug=perf`: the render loop records what it draws, for a HUD or an automated check. */
export const perfEnabled = () =>
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('debug') === 'perf'

export type PerfSnapshot = {
  quality: Quality | null
  /** Frames drawn by each pipeline since load. */
  frames: { motion: number; rest: number }
  /** Median interval of recent back-to-back frames, in ms. */
  intervals: { motion: number | null; rest: number | null }
  triangles: number
  calls: number
  /** Governor decisions, oldest first. */
  decisions: string[]
}

const snapshot: PerfSnapshot = {
  quality: null,
  frames: { motion: 0, rest: 0 },
  intervals: { motion: null, rest: null },
  triangles: 0,
  calls: 0,
  decisions: [],
}
const recent: Record<'motion' | 'rest', number[]> = { motion: [], rest: [] }

export const perf = {
  get: () => snapshot,
  frame(kind: 'motion' | 'rest', info: { triangles: number; calls: number }, interval?: number) {
    snapshot.frames[kind]++
    snapshot.triangles = info.triangles
    snapshot.calls = info.calls
    if (interval === undefined) return
    const list = recent[kind]
    list.push(interval)
    if (list.length > 30) list.shift()
    snapshot.intervals[kind] = [...list].sort((a, b) => a - b)[list.length >> 1]
  },
  decide(text: string) {
    snapshot.decisions.push(text)
  },
  tier(quality: Quality) {
    snapshot.quality = quality
  },
}
if (perfEnabled()) (window as unknown as { __viewer360: typeof perf }).__viewer360 = perf

/** The current snapshot, refreshed twice a second (for a debug overlay). */
export function usePerf() {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  return snapshot
}
