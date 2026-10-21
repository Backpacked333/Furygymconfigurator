import { describe, expect, it } from 'vitest'
import { FrameGuard, GUARD_SAMPLES, GUARD_SKIP, MOVING_FRAME_BUDGET_MS } from './frameGuard'

/** Feeds `intervals` as consecutive moving frames; returns the frames (from 1) whose verdict trips. */
function run(guard: FrameGuard, intervals: number[], start = 0) {
  let now = start
  const tripped: number[] = []
  guard.frame(now, true)
  intervals.forEach((interval, i) => {
    now += interval
    if (guard.frame(now, true)) tripped.push(i + 1)
  })
  return tripped
}

describe("the live view's frame guard (synthetic timestamps)", () => {
  it('never trips at 60 Hz, nor on a display capped at 30 Hz', () => {
    expect(run(new FrameGuard(), Array(300).fill(1000 / 60))).toEqual([])
    expect(run(new FrameGuard(), Array(300).fill(1000 / 30))).toEqual([])
  })

  it('trips on the first full window of frames over the budget, after the skipped ones', () => {
    const slow = Array(100).fill(MOVING_FRAME_BUDGET_MS + 5)
    const tripped = run(new FrameGuard(), slow)
    expect(tripped[0]).toBe(GUARD_SKIP + GUARD_SAMPLES)
    // Each later window gives its own verdict.
    expect(tripped[1]).toBe(GUARD_SKIP + 2 * GUARD_SAMPLES)
  })

  it('ignores the first intervals after it is made, however slow', () => {
    const intervals = [...Array(GUARD_SKIP).fill(500), ...Array(GUARD_SAMPLES).fill(16)]
    expect(run(new FrameGuard(), intervals)).toEqual([])
  })

  it('takes the median: a hitch every third frame does not trip it', () => {
    const intervals = Array.from({ length: 300 }, (_, i) => (i % 3 === 2 ? 300 : 16))
    expect(run(new FrameGuard(), intervals)).toEqual([])
  })

  it('never measures across a frame at rest: pauses between moves are not frame times', () => {
    const guard = new FrameGuard(40, 4, 0)
    let now = 0
    const tripped: boolean[] = []
    for (let i = 0; i < 40; i++) {
      // A frame at rest, nothing drawn for two seconds, then two smooth moving frames.
      for (const [interval, moving] of [
        [16, false],
        [2000, true],
        [16, true],
      ] as const)
        tripped.push(guard.frame((now += interval), moving))
    }
    expect(tripped).not.toContain(true)
  })

  it('skips again after a change, keeping the samples it already has', () => {
    const guard = new FrameGuard(40, 4, 2)
    // Two skipped, then two samples of 100 ms.
    expect(run(guard, [100, 100, 100, 100])).toEqual([])
    guard.change()
    // Two more skipped (however fast), then the two the window still needs: 100, 100, 100, 100.
    let now = 400
    const verdicts = [10, 10, 100, 100].map((interval) => guard.frame((now += interval), true))
    expect(verdicts).toEqual([false, false, false, true])
  })
})
