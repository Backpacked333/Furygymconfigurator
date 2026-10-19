import type { Quality } from './quality'

/**
 * Picks the tier a device can sustain from the frames it actually draws. Pure: fed frame
 * intervals, answers with a verdict, so the policy is unit-tested without a GPU.
 *
 * - Motion frames (drawn while the camera moves) decide smoothness: when they miss the tier's
 *   budget, the tier steps down.
 * - Rest frames (the settle run after the camera stops) decide how long the picture takes to
 *   sharpen: slow ones step down too.
 * - A High device that draws both comfortably fast is promoted to Ultra, once.
 */
export type FrameKind = 'motion' | 'rest'
export type Verdict = 'promote' | 'demote' | null

/** Median interval (ms) above which a tier counts as too heavy. */
export const DEMOTE_ABOVE: Record<FrameKind, Record<Quality, number>> = {
  // Ultra steps down to the cheap single-pass High as soon as motion misses ~45 fps; High only
  // when it is really stuttering (~25 fps), not because a browser caps frames at 30 to save power.
  motion: { ultra: 22, high: 40, lite: Infinity },
  rest: { ultra: 30, high: 34, lite: Infinity },
}
/** High is promoted when its rest and motion medians are both under these. */
export const PROMOTE_BELOW: Record<FrameKind, number> = { motion: 9, rest: 10 }
/** Frames per measurement window. */
const WINDOW = 16

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]

export class FrameGovernor {
  private samples: Record<FrameKind, number[]> = { motion: [], rest: [] }
  private fast: Record<FrameKind, boolean> = { motion: false, rest: false }
  private done = false

  constructor(
    readonly quality: Quality,
    readonly options: { promote: boolean } = { promote: false },
  ) {}

  /** One frame interval. Returns a verdict at most once per governor. */
  sample(kind: FrameKind, ms: number): Verdict {
    if (this.done || !(ms > 0)) return null
    const list = this.samples[kind]
    list.push(ms)
    if (list.length < WINDOW) return null
    const m = median(list)
    this.samples[kind] = []
    if (m > DEMOTE_ABOVE[kind][this.quality]) {
      this.done = true
      return 'demote'
    }
    if (this.quality === 'high' && this.options.promote) {
      this.fast[kind] = m < PROMOTE_BELOW[kind]
      if (this.fast.motion && this.fast.rest) {
        this.done = true
        return 'promote'
      }
    }
    return null
  }
}

export const lower = (q: Quality): Quality => (q === 'ultra' ? 'high' : 'lite')

/**
 * Remembers, per GPU, the tier the governor settled on, so a returning visitor starts there
 * instead of measuring again. Storage failures (private mode, blocked storage) just forget.
 */
const KEY = 'viewer360:tier'
export const tierMemory = {
  get(gpu: string): Quality | null {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Quality>
      const q = saved[gpu]
      return q === 'ultra' || q === 'high' || q === 'lite' ? q : null
    } catch {
      return null
    }
  },
  set(gpu: string, quality: Quality) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Quality>
      saved[gpu] = quality
      localStorage.setItem(KEY, JSON.stringify(saved))
    } catch {
      // Not remembered; the next visit measures again.
    }
  },
}
