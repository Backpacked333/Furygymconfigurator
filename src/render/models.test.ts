// @vitest-environment jsdom
import { Box3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  DEFAULT_CONFIG,
  INTERIORS,
  productHeight,
  setFamily,
  type Config,
} from '../lib/config'
import { OPENING_INFILLS, STUDIO_DOORS } from '../lib/products'
import {
  containerInterior,
  containerShell,
  studioGlazing,
  studioInterior,
  studioShell,
} from './architecture'
import { canopy, deck, pergola, roofDeck, stairs, timberAccent } from './addons'
import {
  apartmentBlock,
  curtainWallOffice,
  loungeSet,
  modernHouse,
  precastOffice,
} from './buildings'
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
      // the rack's side working clearance.
      const sideAllowance = item.id === 'rack' || item.id === 'halfrack' ? item.clearance : 0.06
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
    addons: { deck: true, gazebo: true, roof: true, stairs: true, canopy: false },
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
  for (const door of STUDIO_DOORS)
    for (const open of [false, true])
      it(`keeps the Studio with a ${door.id} door (${open ? 'open' : 'closed'}) in its envelope`, () => {
        for (const length of [20, 40] as const) {
          const c: Config = { ...DEFAULT_CONFIG, length, studioDoor: door.id, doorsOpen: open }
          const b = bounds([...studioShell(c), ...studioGlazing(c)])
          expect(b.max.x - b.min.x).toBeCloseTo(length, 1)
          expect(b.max.y).toBeLessThanOrEqual(productHeight(c) + 0.31)
          // An open hinged leaf swings outward past the facade; closed glazing stays inside it.
          if (!open || door.id === 'sliding') expect(b.max.z).toBeLessThanOrEqual(4.05)
          else expect(b.max.z).toBeGreaterThan(5)
        }
      })
  for (const infill of OPENING_INFILLS)
    for (const open of [false, true])
      it(`fits the ${infill.id} Container infill (${open ? 'open' : 'closed'}) in its envelope`, () => {
        for (const length of [20, 40] as const)
          for (const opening of ['center', 'partial', 'full'] as const) {
            const c: Config = {
              ...setFamily(DEFAULT_CONFIG, 'container'),
              length,
              containerOpening: opening,
              openingInfill: infill.id,
              doorsOpen: open,
            }
            const b = bounds([...containerShell(c), ...containerInterior(c)])
            expect(b.max.x - b.min.x).toBeLessThanOrEqual(length + 0.05)
            expect(b.max.y).toBeLessThanOrEqual(productHeight(c) + 0.01)
            expect(b.min.z).toBeGreaterThanOrEqual(-4.02)
            // Propped awning sashes project outward; everything else stays within 8 feet.
            if (infill.id === 'awning' && open) expect(b.max.z).toBeGreaterThan(8)
            else expect(b.max.z).toBeLessThanOrEqual(4.05)
          }
      })
  it.each(INTERIORS.map((i) => i.id))('builds the %s interior for both families', (style) => {
    for (const family of ['studio', 'container'] as const) {
      const c: Config = { ...setFamily(DEFAULT_CONFIG, family), interiorStyle: style }
      const parts = family === 'studio' ? studioInterior(c) : containerInterior(c)
      expect(parts.length).toBeGreaterThan(8)
      const b = bounds(parts)
      expect(b.max.x - b.min.x).toBeLessThanOrEqual(c.length + 0.05)
    }
  })
  it('builds Container decks, roof decks, stairs, and canopy with either railing', () => {
    for (const railing of ['glass', 'cable'] as const) {
      const c: Config = {
        ...setFamily(DEFAULT_CONFIG, 'container'),
        addons: { deck: true, gazebo: false, roof: true, stairs: true, canopy: true },
        railing,
      }
      for (const build of [deck, roofDeck, stairs, canopy])
        expect(build(c).length).toBeGreaterThan(3)
      // The roof deck frame sits on the container and stays within its plan.
      const roof = bounds(roofDeck(c))
      expect(roof.min.y).toBeGreaterThanOrEqual(productHeight(c) - 0.01)
      expect(roof.max.x).toBeLessThanOrEqual(c.length / 2 + 0.2)
      // The stair lands beside the roof deck (its landing laps the deck edge) at walking height.
      const flight = bounds(stairs(c))
      expect(flight.min.x).toBeGreaterThan(c.length / 2 - 1)
      expect(flight.max.y).toBeGreaterThan(productHeight(c) + 1)
    }
  })
})

describe('surroundings', () => {
  it('builds every background building with valid batched geometry', () => {
    for (const parts of [
      apartmentBlock({ length: 120, style: 'brick' }),
      apartmentBlock({ length: 90, style: 'timber' }),
      curtainWallOffice({ length: 100, floors: 5, depth: 60 }),
      precastOffice({ length: 90, floors: 4, depth: 50 }),
      modernHouse(),
      loungeSet({ flame: true }),
    ]) {
      expect(parts.length).toBeGreaterThan(5)
      for (const b of batch(parts)) {
        const position = b.geometry.getAttribute('position')
        expect(position.count % 3).toBe(0)
        expect(Number.isFinite(b.geometry.boundingSphere!.radius)).toBe(true)
      }
    }
  })
})
