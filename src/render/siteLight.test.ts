import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, ENVIRONMENTS } from '../lib/config'
import type { KeepOut } from './scenery'
import {
  CAPTURE_POINT,
  hemisphere,
  irradianceFacing,
  sampleField,
  siteField,
  siteLightField,
  siteLightScale,
  unitShape,
} from './siteLight'

type Vec3 = [number, number, number]
const UP: Vec3 = [0, 1, 0]
const NOON = 13.25
/** A long block behind the site (−z), 50 ft tall, its face 10 ft from the origin. */
const block: KeepOut = {
  kind: 'building',
  porous: false,
  shape: 'box',
  x: 0,
  z: -10,
  turn: 0,
  min: [-200, 0, -40],
  max: [200, 50, 0],
}
const crown: KeepOut = {
  kind: 'crown',
  porous: true,
  shape: 'cylinder',
  x: 30,
  z: 30,
  radius: 8,
  bottom: 6,
  top: 16,
}

const field = (shapes: KeepOut[], time = NOON) =>
  siteLightField(shapes, null, 'residences', time, CAPTURE_POINT)
const scaleAt = (f: ReturnType<typeof field>, p: Vec3, n: Vec3) =>
  siteLightScale(irradianceFacing(sampleField(f, p), n), irradianceFacing(f.capture, n))

describe('site light', () => {
  it('spreads its sight lines evenly over each hemisphere', () => {
    for (const sign of [1, -1]) {
      const rays = hemisphere(40, sign)
      expect(rays.reduce((s, d) => s + d[1], 0) / rays.length).toBeCloseTo(0.5 * sign, 2)
      expect(Math.abs(rays.reduce((s, d) => s + d[0], 0) / rays.length)).toBeLessThan(0.02)
    }
  })

  it('leaves an open site as the capture sees it', () => {
    const f = field([])
    for (const n of [UP, [1, 0, 0], [0, 0, -1]] as Vec3[])
      expect(scaleAt(f, [20, 0.5, 15], n)).toBeCloseTo(1, 1)
  })

  it('darkens the shade at the foot of a tall block, most for a face turned to it', () => {
    // A block across the court toward the sun (+z), its face 40 ft away: its foot is in its shadow.
    const f = field([{ ...block, z: 40, turn: Math.PI }])
    const paving = scaleAt(f, [0, 0.5, 38], UP)
    // Against paving as far from the block on the open side of the court.
    expect(paving).toBeLessThan(scaleAt(f, [0, 0.5, -38], UP) - 0.1)
    expect(scaleAt(f, [0, 3, 38], [0, 0, 1])).toBeLessThan(paving)
  })

  it('darkens the ground under a crown', () => {
    const f = field([crown])
    expect(scaleAt(f, [30, 0.5, 30], UP)).toBeLessThan(scaleAt(f, [0, 0.5, 30], UP))
  })

  it('gives a building face the open side of it, not the inside of the block', () => {
    const f = field([block])
    expect(scaleAt(f, [0, 10, -9.9], [0, 0, 1])).toBeGreaterThan(0.4)
  })

  it('looks through the unit, as the capture does, but keeps its shadow on the ground', () => {
    const unit = unitShape(DEFAULT_CONFIG)
    const f = siteLightField([], unit, 'residences', NOON, CAPTURE_POINT)
    expect(irradianceFacing(f.capture, UP)).toBeGreaterThan(0)
    // A wall facing back over the noon shadow behind the unit gets less from the ground.
    const back = scaleAt(f, [0, 3, -12], [0, 0, 1])
    expect(back).toBeLessThan(scaleAt(f, [0, 3, 12], [0, 0, -1]))
  })

  it('is worked out once per design, and covers every setting in a moment', () => {
    const a = siteField(DEFAULT_CONFIG)!
    expect(siteField({ ...DEFAULT_CONFIG })).toBe(a)
    expect(siteField({ ...DEFAULT_CONFIG, environment: 'studio' })).toBeNull()
    for (const { id } of ENVIRONMENTS) {
      const started = performance.now()
      const f = siteField({ ...DEFAULT_CONFIG, environment: id, time: 11 })
      if (!f) continue
      console.log(id, f.dims.join('×'), `${(performance.now() - started).toFixed(0)} ms`)
      expect(f.values.every(Number.isFinite)).toBe(true)
    }
  }, 60_000)
})
