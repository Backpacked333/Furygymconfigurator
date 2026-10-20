export const HISTORY_BYTES_PER_PIXEL = 36
export const HISTORY_MEMORY_BUDGET = 128 * 1024 * 1024
export const MAX_HISTORY_VIEWS = 3

export type HistoryPose = {
  position: readonly number[]
  direction: readonly number[]
}

export function historyCapacity(width: number, height: number, budget = HISTORY_MEMORY_BUDGET) {
  if (width <= 0 || height <= 0) return 0
  return Math.max(
    0,
    Math.min(MAX_HISTORY_VIEWS, Math.floor(budget / (width * height * HISTORY_BYTES_PER_PIXEL))),
  )
}

/** Rank candidates only; the GPU still rejects disocclusions and incompatible surface samples. */
export function historyDistance(a: HistoryPose, b: HistoryPose) {
  const distance = Math.hypot(...a.position.map((value, i) => value - b.position[i]))
  const scale = Math.max(1, Math.hypot(...a.position), Math.hypot(...b.position))
  const turn = a.direction.reduce((sum, value, i) => sum + value * b.direction[i], 0)
  return distance / scale + 2 * (1 - Math.min(1, Math.max(-1, turn)))
}
