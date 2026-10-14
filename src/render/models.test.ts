// @vitest-environment jsdom
import { Box3 } from 'three'
import { describe, expect, it } from 'vitest'
import { CATALOG, DEFAULT_CONFIG, productHeight, setFamily, type Config } from '../lib/config'
import {
  containerInterior,
  containerShell,
  studioGlazing,
  studioInterior,
  studioShell,
} from './architecture'
import { deck, pergola, roofDeck, stairs, timberAccent } from './addons'
import { equipmentParts } from './equipment'
import { batch, type Part } from './parts'

function bounds(parts: Part[]) {
  const box = new Box3()
  for (const p of parts) {
    p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox!.clone().applyMatrix4(p.matrix))
  }
  return box
}

describe('equipment models', () => {
  it.each(CATALOG.map((item) => [item.id, item] as const))(
    '%s fits its planning footprint and height',
    (_, item) => {
      const parts = equipmentParts(item.id)
      expect(parts.length).toBeGreaterThan(3)
      const b = bounds(parts)
      // The floor-plan collision check uses these footprints, so models must not exceed them.
      // A racked Olympic bar overhangs its uprights, as on real racks; that overhang stays within
      // the rack's published side working clearance.
      const sideAllowance = item.id === 'rack' ? item.clearance : 0.06
      expect(b.max.x).toBeLessThanOrEqual(item.w / 2 + sideAllowance)
      expect(-b.min.x).toBeLessThanOrEqual(item.w / 2 + sideAllowance)
      expect(b.max.z).toBeLessThanOrEqual(item.d / 2 + 0.06)
      expect(-b.min.z).toBeLessThanOrEqual(item.d / 2 + 0.06)
      expect(b.min.y).toBeGreaterThanOrEqual(-0.01)
      expect(b.max.y).toBeLessThanOrEqual(Math.max(item.h, 0.6) + 0.35)
    },
  )
  it('batches every model into a handful of draw calls with valid attributes', () => {
    for (const item of CATALOG) {
      const batches = batch(equipmentParts(item.id))
      expect(batches.length).toBeLessThanOrEqual(12)
      for (const b of batches) {
        const position = b.geometry.getAttribute('position')
        expect(position.count % 3).toBe(0)
        expect(b.geometry.getAttribute('normal').count).toBe(position.count)
        expect(b.geometry.getAttribute('uv').count).toBe(position.count)
        expect(Number.isFinite(b.geometry.boundingSphere!.radius)).toBe(true)
      }
    }
  })
})

describe('architecture', () => {
  const studio: Config = {
    ...DEFAULT_CONFIG,
    addons: { deck: true, gazebo: true, roof: true, stairs: true },
  }
  it.each([20, 40] as const)('keeps the %s-foot Studio within its nominal envelope', (length) => {
    const c = { ...studio, length }
    const shell = bounds([...studioShell(c), ...studioInterior(c), ...studioGlazing(c)])
    expect(shell.max.x - shell.min.x).toBeCloseTo(length, 1)
    expect(shell.max.z - shell.min.z).toBeLessThanOrEqual(8.05)
    expect(shell.max.y).toBeLessThanOrEqual(productHeight(c) + 0.31)
    for (const build of [deck, pergola, roofDeck, stairs, timberAccent])
      expect(build(c).length).toBeGreaterThan(0)
  })
  it.each(['roll-up', 'center', 'partial', 'full'] as const)(
    'builds the Container with a %s opening inside its nominal envelope',
    (opening) => {
      for (const length of [20, 40] as const) {
        const c: Config = {
          ...setFamily(DEFAULT_CONFIG, 'container'),
          containerOpening: opening,
          length,
        }
        const b = bounds([...containerShell(c), ...containerInterior(c)])
        expect(b.max.x - b.min.x).toBeLessThanOrEqual(length + 0.05)
        expect(b.max.z - b.min.z).toBeLessThanOrEqual(8.05)
        expect(b.max.y).toBeLessThanOrEqual(productHeight(c) + 0.01)
      }
    },
  )
})
