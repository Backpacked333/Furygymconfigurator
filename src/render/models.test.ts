// @vitest-environment jsdom
import { Box3 } from 'three'
import { describe, expect, it } from 'vitest'
import { CATALOG, DEFAULT_CONFIG, productHeight, setFamily, type Config } from '../lib/config'
import {
  containsBounds,
  EQUIPMENT_ENVELOPES,
  FINISHED_FLOOR_Y,
  occupiedEnvelope,
  placementIssues,
  translateBounds,
  usableInterior,
} from '../lib/spatial'
import {
  containerInterior,
  containerShell,
  studioGlazing,
  studioInterior,
  studioShell,
} from './architecture'
import { deck, pergola, roofDeck, stairs, timberAccent } from './addons'
import { equipmentParts } from './equipment'
import { batch, compose, disposeBatches, measureParts, type Part } from './parts'

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
    '%s is enclosed by its measured physical contract after rotation and world/floor transforms',
    (_, item) => {
      const parts = equipmentParts(item.id)
      expect(parts.length).toBeGreaterThan(3)
      const b = measureParts(parts)
      expect(containsBounds(EQUIPMENT_ENVELOPES[item.id], b)).toBe(true)
      expect(b.min.y).toBeGreaterThanOrEqual(-0.00001)
      expect(b.min.y).toBeLessThan(0.002)
      for (const rotation of [0, 90] as const)
        for (const family of ['studio', 'container'] as const)
          for (const length of [20, 40] as const) {
            const placed = { id: item.id, sku: item.id, rotation, x: -length / 4, z: -0.04 },
              c = { ...DEFAULT_CONFIG, family, length, items: [placed] }
            const offset = { x: 12.5, y: 0.7, z: -9.5 }
            const measured = measureParts(
              parts,
              compose(
                [placed.x + offset.x, FINISHED_FLOOR_Y + offset.y, placed.z + offset.z],
                [0, (-rotation * Math.PI) / 180, 0],
              ),
            )
            const expected = occupiedEnvelope(placed, offset)
            expect(containsBounds(expected, measured)).toBe(true)
            if (!placementIssues(placed, c).some((i) => i.category === 'physical'))
              expect(containsBounds(translateBounds(usableInterior(c), offset), measured)).toBe(
                true,
              )
            const room = usableInterior(c),
              local = occupiedEnvelope({ ...placed, x: 0, z: 0 })
            if (local.max.z - local.min.z > room.max.z - room.min.z || local.max.y > room.max.y) {
              expect(
                placementIssues(placed, c).some((i) => i.code === 'wall' || i.code === 'ceiling'),
              ).toBe(true)
              continue
            }
            const cx = (room.min.x + room.max.x - local.min.x - local.max.x) / 2,
              cz = (room.min.z + room.max.z - local.min.z - local.max.z) / 2
            for (const [x, z, dx, dz] of [
              [room.min.x - local.min.x, cz, -0.01, 0],
              [room.max.x - local.max.x, cz, 0.01, 0],
              [cx, room.min.z - local.min.z, 0, -0.01],
              [cx, room.max.z - local.max.z, 0, 0.01],
            ]) {
              const edge = { ...placed, x, z },
                actual = measureParts(
                  parts,
                  compose(
                    [x + offset.x, FINISHED_FLOOR_Y + offset.y, z + offset.z],
                    [0, (-rotation * Math.PI) / 180, 0],
                  ),
                )
              expect(containsBounds(translateBounds(room, offset), actual)).toBe(true)
              expect(
                placementIssues({ ...edge, x: x + dx, z: z + dz }, c).some(
                  (i) => i.code === 'wall',
                ),
              ).toBe(true)
            }
          }
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
      disposeBatches(batches)
    }
  })
})

describe('architecture', () => {
  const studio: Config = {
    ...DEFAULT_CONFIG,
    addons: { deck: true, gazebo: true, roof: true, stairs: true },
    presentation: { ...DEFAULT_CONFIG.presentation, openingPose: 'closed' },
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
          ...setFamily({ ...DEFAULT_CONFIG, items: [] }, 'container'),
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
