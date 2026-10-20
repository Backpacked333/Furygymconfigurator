import { describe, expect, it } from 'vitest'
import {
  HISTORY_BYTES_PER_PIXEL,
  HISTORY_MEMORY_BUDGET,
  historyCapacity,
  historyDistance,
} from './historyCache'
import { nextTracePasses } from './traceBudget'

describe('bounded orbit history', () => {
  it('caps view count and bytes across laptop and high-DPI canvases', () => {
    expect(historyCapacity(1024, 600)).toBe(3)
    expect(historyCapacity(1920, 1080)).toBe(1)
    expect(historyCapacity(3840, 2160)).toBe(0)
    expect(historyCapacity(0, 0)).toBe(0)
    for (const width of [800, 1280, 1920, 2560, 3840]) {
      const height = width * 0.625
      expect(
        historyCapacity(width, height) * width * height * HISTORY_BYTES_PER_PIXEL,
      ).toBeLessThanOrEqual(HISTORY_MEMORY_BUDGET)
    }
  })
  it('prefers a revisited angle over the last, opposite view', () => {
    const front = { position: [0, 0, 20], direction: [0, 0, 1] }
    const back = { position: [0, 0, -20], direction: [0, 0, -1] }
    const next = { position: [1, 0, 20], direction: [0, 0, 1] }
    expect(historyDistance(front, next)).toBeLessThan(historyDistance(back, next))
    expect(historyDistance(front, front)).toBe(0)
  })
})

describe('interaction-oriented batch budget', () => {
  it('shrinks slow batches promptly and grows fast batches conservatively', () => {
    expect(nextTracePasses(8, 48, 12, 8)).toBe(2)
    expect(nextTracePasses(1, 100, 12, 8)).toBe(1)
    expect(nextTracePasses(2, 3, 12, 8)).toBe(3)
    expect(nextTracePasses(8, 3, 12, 8)).toBe(8)
    expect(nextTracePasses(2, NaN, 12, 8)).toBe(2)
  })
})
