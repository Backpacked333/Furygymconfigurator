import { describe, expect, it } from 'vitest'
import { nextTracePasses, nextTracePassesOverLatency } from './traceBudget'

/** Batches of `passes` taking `perPass` ms each, read `latency` ms late, sized over `batches`. */
const run = (
  perPass: number,
  latency: number,
  budget: number,
  maximum: number,
  size: typeof nextTracePassesOverLatency = nextTracePassesOverLatency,
  batches = 20,
) => {
  let passes = 1
  let floor = Infinity
  for (let i = 0; i < batches; i++) {
    const elapsed = latency + passes * perPass
    if (passes === 1) floor = Math.min(floor, elapsed)
    passes = size(passes, elapsed, floor, budget, maximum)
  }
  return passes
}
const withoutFloor: typeof nextTracePassesOverLatency = (current, elapsed, _floor, budget, max) =>
  nextTracePasses(current, elapsed, budget, max)

describe('sizing trace batches over a completion latency', () => {
  it('never grows past one pass when a frame-late completion is read as work (the old sizing)', () => {
    // Chrome on Metal: done a frame (~17 ms) after the GPU finished a 3 ms pass.
    expect(run(3, 17, 12, 32, withoutFloor)).toBe(1)
  })

  it('grows until the passes beyond the latency fill the budget', () => {
    const passes = run(3, 17, 12, 32)
    expect(passes).toBeGreaterThanOrEqual(4)
    // The GPU work of a batch stays near its budget.
    expect((passes - 1) * 3).toBeLessThanOrEqual(12)
    expect(run(3, 17, 24, 64)).toBeGreaterThanOrEqual(8)
  })

  it('still keeps a slow GPU at one pass, and never past the maximum', () => {
    expect(run(30, 17, 12, 32)).toBe(1)
    expect(run(0.1, 17, 12, 32)).toBe(32)
  })

  it('grows at most by half each batch, so one fast reading never floods the GPU', () => {
    expect(nextTracePassesOverLatency(4, 17, 17, 12, 64)).toBe(6)
  })

  it('sizes as before until a one-pass batch has given the latency', () => {
    expect(nextTracePassesOverLatency(4, 30, Infinity, 12, 32)).toBe(nextTracePasses(4, 30, 12, 32))
  })
})
