// @vitest-environment jsdom
import { Box3, CylinderGeometry, MeshBasicMaterial, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../lib/config'
import {
  constructionOpening,
  externalZones,
  openingPanels,
  roofDeckElevation,
  stairLayout,
} from '../lib/spatial'
import { auditCylinderUV } from '../dev/visual/uvAudit'
import { conceptOpening, containerShell, studioGlazing, studioShell } from './architecture'
import { deck, roofDeck, siteContext, stairs } from './addons'
import { box, cylinderProjectUV } from './geometry'
import { batch, disposeBatches, measureParts, part, type Part } from './parts'
import { equipmentParts } from './equipment'

const triangleCount = (parts: Part[]) =>
  parts.reduce(
    (sum, p) => sum + (p.geometry.index?.count ?? p.geometry.getAttribute('position').count) / 3,
    0,
  )
const c: Config = {
  ...DEFAULT_CONFIG,
  family: 'container',
  addons: { deck: true, roof: true, stairs: true, gazebo: false },
  items: [],
}

describe('reference construction mechanisms', () => {
  it.each(['studio', 'container'] as const)(
    'builds every %s concept at both supported lengths and both poses',
    (family) => {
      for (const length of [20, 40] as const)
        for (const openingConcept of [
          'standard',
          'sectional-glazed',
          'raised-glazed',
          'open-front',
          'hinged-solid',
        ] as const)
          for (const openingPose of ['open', 'closed'] as const) {
            const config = {
              ...c,
              family,
              length,
              openingConcept,
              presentation: { ...c.presentation, openingPose },
            }
            const shell =
              family === 'studio'
                ? [...studioShell(config), ...studioGlazing(config)]
                : containerShell(config)
            expect(shell.length).toBeGreaterThan(10)
            const b = measureParts(shell)
            expect(
              [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite),
            ).toBe(true)
            if (openingConcept === 'raised-glazed' && openingPose === 'open')
              expect(b.max.z).toBeGreaterThan(10)
            if (openingConcept === 'hinged-solid' && openingPose === 'open')
              expect(b.max.z).toBeGreaterThan(7)
          }
    },
  )
  it.each(['sectional-glazed', 'raised-glazed', 'hinged-solid'] as const)(
    'changes actual %s construction, not just fixture metadata',
    (openingConcept) => {
      const config = { ...c, openingConcept },
        opened = conceptOpening(config),
        closed = conceptOpening({
          ...config,
          presentation: { ...c.presentation, openingPose: 'closed' },
        })
      expect(opened.map((p) => p.matrix.elements)).not.toEqual(closed.map((p) => p.matrix.elements))
      const b = measureParts(opened)
      expect(b.min.y).toBeGreaterThan(0.9)
      expect(triangleCount(opened)).toBeLessThan(30000)
    },
  )
  it('keeps sectional leaves overhead and raised glazing exterior', () => {
    const sectional = openingPanels({ ...c, openingConcept: 'sectional-glazed' }),
      raised = openingPanels({ ...c, openingConcept: 'raised-glazed' })
    expect(sectional.every((p) => p.center.z < 3.8 && p.center.y > 7.5)).toBe(true)
    expect(raised.every((p) => p.center.z > 7)).toBe(true)
    expect(conceptOpening({ ...c, openingConcept: 'open-front' })).toHaveLength(2)
  })
  it('leaves a real opening through the closed Studio glass when the entrance leaf opens', () => {
    const closed = studioGlazing({
      ...DEFAULT_CONFIG,
      presentation: { ...c.presentation, openingPose: 'closed' },
    })
    const opened = studioGlazing(DEFAULT_CONFIG)
    expect(measureParts(closed).max.z).toBeLessThan(4.1)
    expect(measureParts(opened).max.z).toBeGreaterThan(7)
    // The fixed glazing extrusion has a door-shaped hole, not a coplanar full-width glass sheet.
    const glass = opened[1].geometry
    expect(glass.type).toBe('ExtrudeGeometry')
    const position = glass.getAttribute('position'),
      indices = glass.index
    for (let i = 0; i < (indices?.count ?? position.count); i += 3) {
      const ids = [0, 1, 2].map((j) => (indices ? indices.getX(i + j) : i + j))
      const center = ids
        .reduce((v, id) => v.add(new Vector3().fromBufferAttribute(position, id)), new Vector3())
        .divideScalar(3)
      expect(
        Math.abs(center.x) < 1.5 && center.y > -4.25 && center.y < 3.1 && Math.abs(center.z) < 0.02,
      ).toBe(false)
    }
  })
  it('uses actual apertured casting face geometry instead of painted-black dots', () => {
    const shell = containerShell(c)
    const faces = shell.filter((p) => p.geometry.type === 'ExtrudeGeometry')
    expect(faces.length).toBeGreaterThanOrEqual(32)
    expect(constructionOpening({ ...c, openingConcept: 'raised-glazed' }).width).toBe(18.6)
  })
})

describe('reference external access and context', () => {
  it.each(['studio', 'container'] as const)(
    'grounds %s access and connects its roof-height landing',
    (family) => {
      for (const length of [20, 40] as const) {
        const config = { ...c, family, length },
          layout = stairLayout(config),
          parts = stairs(config)
        const treads = parts.slice(0, layout.risers)
        for (let i = 0; i < treads.length; i++) {
          const b = measureParts([treads[i]])
          expect(b.max.y).toBeCloseTo(layout.ground + (i + 1) * layout.rise, 5)
        }
        expect(measureParts([treads.at(-1)!]).max.y).toBeCloseTo(roofDeckElevation(config))
        expect(measureParts([treads.at(-1)!]).min.z).toBeCloseTo(layout.landing.max.z)
        const all = measureParts(parts)
        expect(all.min.y).toBeGreaterThanOrEqual(-0.0001)
        expect(all.min.y).toBeLessThan(0.001)
        expect(measureParts(deck(config)).max.y).toBeCloseTo(0.86)
        // The access gap is genuinely unfilled, not hidden behind a solid end rail.
        for (const p of roofDeck(config)) {
          const b = measureParts([p])
          if (b.max.y > layout.top + 0.4 && b.min.x > length / 2 - 1)
            expect(b.min.z).toBeGreaterThan(-0.6)
        }
        const zones = externalZones(config)
        for (const p of parts) {
          const b = measureParts([p])
          const center = {
            x: (b.min.x + b.max.x) / 2,
            y: (b.min.y + b.max.y) / 2,
            z: (b.min.z + b.max.z) / 2,
          }
          expect(
            zones.some((zone) =>
              (['x', 'y', 'z'] as const).every(
                (k) =>
                  center[k] >= zone.bounds.min[k] - 0.001 &&
                  center[k] <= zone.bounds.max[k] + 0.001,
              ),
            ),
          ).toBe(true)
        }
      }
    },
  )
  it('keeps R08/R09 contexts opt-in and independent of product/equipment totals', () => {
    expect(siteContext(c)).toEqual([])
    for (const context of ['custom-wellness', 'sunken-lounge'] as const) {
      const config = { ...c, presentation: { ...c.presentation, context } },
        before = JSON.stringify(config),
        parts = siteContext(config)
      expect(parts.length).toBeGreaterThan(10)
      expect(measureParts(parts).min.z).toBeGreaterThanOrEqual(3.89)
      expect(JSON.stringify(config)).toBe(before)
    }
  })
})

describe('UV continuity, mirrored normals and resource ownership', () => {
  it.each([false, true])('unwraps cylindrical triangles continuously, swap=%s', (swap) => {
    const geometry = cylinderProjectUV(new CylinderGeometry(1, 1, 2, 32), { swap })
    const audit = auditCylinderUV(geometry)
    expect(audit.sideTriangles).toBe(64)
    expect(audit.discontinuousTriangles).toBe(0)
    expect(audit.maxStretchRatio).toBeLessThan(1.01)
    expect(geometry.index).toBeNull()
    geometry.dispose()
  })
  it('preserves physical scale with explicit UV repeat multiplier', () => {
    const a = cylinderProjectUV(new CylinderGeometry(1, 1, 2, 32)),
      b = cylinderProjectUV(new CylinderGeometry(1, 1, 2, 32), { scale: 2 })
    for (let i = 0; i < a.getAttribute('uv').count; i++)
      for (const k of [0, 1])
        expect(b.getAttribute('uv').getComponent(i, k)).toBeCloseTo(
          a.getAttribute('uv').getComponent(i, k) * 2,
        )
    a.dispose()
    b.dispose()
  })
  it('corrects mirrored winding without corrupting borrowed source geometry/materials', () => {
    const source = box(1, 2, 3),
      material = new MeshBasicMaterial(),
      sourceDispose = vi.spyOn(source, 'dispose'),
      materialDispose = vi.spyOn(material, 'dispose'),
      original = source.getAttribute('position').array.slice()
    const batches = batch([part(source, material, [0, 0, 0], undefined, [-1, 1, 1])])
    const g = batches[0].geometry,
      p = g.getAttribute('position'),
      n = g.getAttribute('normal')
    for (let i = 0; i < p.count; i += 3) {
      const a = new Vector3().fromBufferAttribute(p, i),
        b = new Vector3().fromBufferAttribute(p, i + 1),
        c = new Vector3().fromBufferAttribute(p, i + 2)
      const face = b.sub(a).cross(c.sub(a)).normalize()
      expect(face.dot(new Vector3().fromBufferAttribute(n, i))).toBeGreaterThan(0.999)
    }
    expect(Array.from(source.getAttribute('position').array)).toEqual(Array.from(original))
    const dispose = vi.spyOn(g, 'dispose')
    disposeBatches([batches[0], batches[0]])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(sourceDispose).not.toHaveBeenCalled()
    expect(materialDispose).not.toHaveBeenCalled()
    material.dispose()
  })
  it('keeps the detailed reformer under 20k triangles without shrinking its frame', () => {
    const parts = equipmentParts('reformer')
    expect(triangleCount(parts)).toBeLessThan(20000)
    const b = measureParts(parts),
      size = new Box3(
        new Vector3(b.min.x, b.min.y, b.min.z),
        new Vector3(b.max.x, b.max.y, b.max.z),
      ).getSize(new Vector3())
    expect(size.z).toBeCloseTo(6.4)
    expect(size.x).toBeCloseTo(2.34)
  })
})
