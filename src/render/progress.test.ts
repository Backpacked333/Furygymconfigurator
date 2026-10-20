import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FRAME_OVERHEAD_MS,
  PROGRESS_CAP,
  SEED_MS_PER_PIXEL_SAMPLE,
  continuedProgress,
  estimatedProgress,
  measuredProgress,
  queueEstimate,
  renderRate,
  sceneProgress,
  secondsLeft,
} from './progress'

describe('scene start-up progress', () => {
  it('moves through its phases and is ready once a frame is drawn', () => {
    const listener = vi.fn()
    const stop = sceneProgress.subscribe(listener)
    expect(sceneProgress.get()).toBe('engine')
    sceneProgress.set('renderer')
    sceneProgress.set('shaders')
    sceneProgress.drawn()
    expect(sceneProgress.get()).toBe('ready')
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
  })

  it('runs after-draw callbacks once, unless cancelled', () => {
    const once = vi.fn()
    const cancelled = vi.fn()
    sceneProgress.afterNextDraw(once)
    sceneProgress.afterNextDraw(cancelled)()
    sceneProgress.drawn()
    sceneProgress.drawn()
    expect(once).toHaveBeenCalledTimes(1)
    expect(cancelled).not.toHaveBeenCalled()
  })
})

describe('still progress', () => {
  afterEach(() => renderRate.reset())
  const frame = { width: 1200, height: 827, samples: 64, timeLimit: 6 }

  it('estimates a cloud frame from the seed before any has come back', () => {
    expect(renderRate.msPerPixelSample()).toBe(SEED_MS_PER_PIXEL_SAMPLE)
    // 1.5 s for 64 samples at 1200x827 on an L40S, plus the round trip.
    expect(renderRate.estimateMs(frame)).toBeCloseTo(1500 + FRAME_OVERHEAD_MS, 6)
    // Four times the samples, four times the time, up to the frame's time limit.
    expect(renderRate.estimateMs({ ...frame, samples: 256, timeLimit: 20 })).toBeCloseTo(
      6000 + FRAME_OVERHEAD_MS,
      6,
    )
    expect(renderRate.estimateMs({ ...frame, samples: 1024, timeLimit: 4 })).toBe(
      4000 + FRAME_OVERHEAD_MS,
    )
  })

  it("learns this page's cost per pixel sample from the median of its frames", () => {
    const work = frame.width * frame.height * frame.samples
    renderRate.record(3000, frame)
    renderRate.record(4000, frame)
    renderRate.record(100_000, { ...frame, timeLimit: 200 })
    expect(renderRate.msPerPixelSample()).toBeCloseTo(4000 / work, 12)
    // A frame stopped by its time limit cost at least that much a sample: the next estimate of
    // a longer frame reaches for its time limit too.
    renderRate.reset()
    renderRate.record(6200, frame)
    expect(renderRate.estimateMs({ ...frame, samples: 256, timeLimit: 20 })).toBe(
      20_000 + FRAME_OVERHEAD_MS,
    )
  })

  it('adds what is left of the frames ahead on the GPU', () => {
    expect(queueEstimate(5000, [])).toBe(5000)
    expect(
      queueEstimate(5000, [
        { estimateMs: 6000, elapsedMs: 2000 },
        { estimateMs: 1000, elapsedMs: 3000 },
      ]),
    ).toBe(9000)
  })

  it('eases toward the cap and never claims to be done', () => {
    expect(estimatedProgress(0, 4000)).toBe(0)
    const atTime = estimatedProgress(4000, 4000)
    expect(atTime).toBeGreaterThan(0.8)
    expect(atTime).toBeLessThan(PROGRESS_CAP)
    expect(estimatedProgress(60_000, 4000)).toBeLessThanOrEqual(PROGRESS_CAP)
    expect(estimatedProgress(60_000, 4000)).toBeCloseTo(PROGRESS_CAP, 6)
    // Monotone: a later moment is never less far along.
    let last = 0
    for (let t = 0; t <= 10_000; t += 250) {
      const p = estimatedProgress(t, 4000)
      expect(p).toBeGreaterThanOrEqual(last)
      last = p
    }
    expect(estimatedProgress(1000, 0)).toBe(0)
  })

  it('carries the line on from where it stood when the estimate is revised, never back', () => {
    expect(continuedProgress(0, 4000, 4000)).toBeCloseTo(estimatedProgress(4000, 4000), 12)
    expect(continuedProgress(0.6, 0, 9000)).toBe(0.6)
    let last = 0.6
    for (let t = 0; t <= 20_000; t += 500) {
      const p = continuedProgress(0.6, t, 9000)
      expect(p).toBeGreaterThanOrEqual(last)
      expect(p).toBeLessThanOrEqual(PROGRESS_CAP)
      last = p
    }
    // An estimate already run out holds the line where it is.
    expect(continuedProgress(0.7, 1000, 0)).toBe(0.7)
  })

  it('counts the seconds left, at least one, and none once the estimate has run out', () => {
    expect(secondsLeft(0, 4000)).toBe(4)
    expect(secondsLeft(3500, 4000)).toBe(1)
    expect(secondsLeft(3990, 4000)).toBe(1)
    expect(secondsLeft(4000, 4000)).toBeNull()
  })

  it('measures a local trace by its samples', () => {
    expect(measuredProgress(64, 256)).toBe(0.25)
    expect(measuredProgress(300, 256)).toBe(1)
    expect(measuredProgress(10, 0)).toBe(0)
  })
})
