import { describe, expect, it } from 'vitest'
import { historyCapacity } from '../render/historyCache'
import { REFERENCE_PIXELS, liveProfile, requestedTraceScale, traceScale } from './liveProfile'

describe("the 360° view's trace scale", () => {
  it('traces Lite at half, whatever the canvas or the request', () => {
    expect(traceScale('lite', 3000, 2000, null)).toBe(0.5)
    expect(traceScale('lite', 640, 400, null)).toBe(0.5)
    expect(traceScale('lite', 1545, 966, 0.75)).toBe(0.5)
  })

  it("traces High and Ultra at the canvas's own resolution up to the Cycles image's pixels", () => {
    expect(REFERENCE_PIXELS).toBe(1920 * 1200)
    expect(traceScale('ultra', 1545, 966, null)).toBe(1)
    expect(traceScale('high', 1920, 1200, null)).toBe(1)
    expect(traceScale('high', 0, 0, null)).toBe(1)
  })

  it('caps larger canvases at the reference, rounded as the tracer sizes itself', () => {
    for (const [width, height] of [
      [2976, 1860],
      [2616, 1635],
      [3840, 2400],
      [1977, 1236],
    ])
      for (const quality of ['high', 'ultra'] as const) {
        const scale = traceScale(quality, width, height, null)
        expect(scale).toBeLessThan(1)
        // The tracer and PathTraceSession.syncSize both floor scale × buffer.
        const traced = Math.floor(scale * width) * Math.floor(scale * height)
        expect(traced).toBeLessThanOrEqual(REFERENCE_PIXELS)
        expect(traced).toBeGreaterThan(0.99 * REFERENCE_PIXELS)
      }
  })

  it('leaves room for history on a large canvas, which at full resolution keeps none', () => {
    const scale = traceScale('ultra', 2976, 1860, null)
    expect(historyCapacity(2976, 1860)).toBe(0)
    expect(
      historyCapacity(Math.floor(scale * 2976), Math.floor(scale * 1860)),
    ).toBeGreaterThanOrEqual(1)
  })

  it('takes ?traceScale= from 0.5 to 1 on High and Ultra, ignoring anything else', () => {
    expect(requestedTraceScale('?traceScale=0.75')).toBe(0.75)
    expect(requestedTraceScale('?traceScale=0.5')).toBe(0.5)
    expect(requestedTraceScale('?traceScale=1')).toBe(1)
    for (const search of [
      '',
      '?traceScale=',
      '?traceScale=%20',
      '?traceScale=0.2',
      '?traceScale=1.5',
      '?traceScale=abc',
      '?traceScale=Infinity',
    ])
      expect(requestedTraceScale(search)).toBeNull()
    expect(traceScale('ultra', 1545, 966, 0.75)).toBe(0.75)
    expect(traceScale('high', 3840, 2400, 1)).toBe(1)
  })
})

describe("the 360° view's live profile", () => {
  it('names no trace scale of its own: the canvas decides it at each start', () => {
    for (const quality of ['lite', 'high', 'ultra'] as const)
      expect(liveProfile(quality)).not.toHaveProperty('renderScale')
  })
})
