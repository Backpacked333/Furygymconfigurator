import { describe, expect, it } from 'vitest'
import { FREE_ORBIT, SWEEP_SPEED, room, sweep, widen, type ArcWindow } from './orbitWindow'

const deg = Math.PI / 180
/** As OrbitControls reads it back from the camera: within (-180°, 180°]. */
const azimuth = (theta: number) => Math.atan2(Math.sin(theta), Math.cos(theta))

describe('orbit window', () => {
  const window: ArcWindow = { min: -10 * deg, max: 151.5 * deg }

  it('widens just enough to hold a camera outside it, never moving it', () => {
    expect(widen(window, 60 * deg)).toBe(window)
    const wider = widen(window, -50 * deg)
    expect(wider.min / deg).toBeCloseTo(-50)
    expect(wider.max).toBe(window.max)
    expect(room(wider, -50 * deg, -1)).toBe(0)
    // Past ±180° from a window that reaches there: measured the short way round.
    const behind = { min: 100 * deg, max: 200 * deg }
    expect(widen(behind, -150 * deg).max / deg).toBeCloseTo(210)
    expect(widen({ min: -172.5 * deg, max: 172.5 * deg }, 178 * deg)).toBe(FREE_ORBIT)
    expect(widen(FREE_ORBIT, 1)).toBe(FREE_ORBIT)
  })
  it('measures the room left toward either end, the short way round', () => {
    const behind = { min: 100 * deg, max: 200 * deg }
    expect(room(behind, -170 * deg, 1) / deg).toBeCloseTo(10)
    expect(room(behind, -170 * deg, -1) / deg).toBeCloseTo(90)
    expect(room(behind, 120 * deg, 1) / deg).toBeCloseTo(80)
    expect(room(behind, 90 * deg, -1)).toBe(0)
    expect(room(window, window.max, 1)).toBe(0)
    expect(room(FREE_ORBIT, 0, 1)).toBe(Infinity)
  })
})

describe('auto-rotate sweep under an arc', () => {
  /** Runs the sweep for `seconds` at `hz`, turning the camera by it each frame as CameraRig does. */
  const run = (window: ArcWindow, start: number, seconds: number, hz = 60) => {
    let theta = start,
      way: 1 | -1 = -1,
      turns = 0,
      low = Infinity,
      high = -Infinity
    const steps: number[] = []
    for (let i = 0; i < seconds * hz; i++) {
      const next = sweep(window, theta, way, 1 / hz)
      if (next.way !== way) turns++
      way = next.way
      steps.push(next.turn)
      theta = azimuth(theta + next.turn)
      // Where it stands along the window: never outside it.
      const along = window.max - room(window, theta, 1)
      expect(room(window, theta, -1)).toBeCloseTo(along - window.min, 5)
      low = Math.min(low, along)
      high = Math.max(high, along)
    }
    return { steps, turns, theta, low, high }
  }

  it('turns back at each end, moving every frame and never faster than its speed', () => {
    const window = { min: -10 * deg, max: 151.5 * deg }
    const { steps, turns, low, high } = run(window, 29.7 * deg, 400)
    expect(turns).toBeGreaterThanOrEqual(4)
    expect(low / deg).toBeCloseTo(-10, 3)
    expect(high / deg).toBeCloseTo(151.5, 3)
    for (const step of steps) {
      expect(step).not.toBe(0)
      expect(Math.abs(step)).toBeLessThanOrEqual((SWEEP_SPEED * deg) / 60 + 1e-12)
    }
    // It starts the way OrbitControls' auto-rotate turns.
    expect(steps[0]).toBeLessThan(0)
  })
  it('reaches both ends of a window that crosses ±180°', () => {
    const { low, high } = run({ min: 100 * deg, max: 260 * deg }, 150 * deg, 400)
    expect(low / deg).toBeCloseTo(100, 3)
    expect(high / deg).toBeCloseTo(260, 3)
  })
  it('turns back the moment it stands on an end', () => {
    const window = { min: -10 * deg, max: 151.5 * deg }
    const next = sweep(window, window.max, 1, 1 / 60)
    expect(next.way).toBe(-1)
    expect(next.turn).toBeLessThan(0)
  })
  it('keeps time, not frames: a 120 Hz screen turns no faster', () => {
    const window = { min: -90 * deg, max: 90 * deg }
    expect(run(window, 0, 1, 120).theta).toBeCloseTo(run(window, 0, 1, 60).theta, 6)
    expect(-run(window, 0, 1, 60).theta / deg).toBeCloseTo(SWEEP_SPEED, 6)
  })
  it('turns steadily one way without a limit', () => {
    expect(sweep(FREE_ORBIT, 0, -1, 0.5)).toEqual({ turn: (-SWEEP_SPEED * deg) / 2, way: -1 })
  })
})
