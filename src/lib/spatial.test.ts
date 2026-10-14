import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from './config'
import {
  bounds3,
  constructionOpening,
  containsBounds,
  contextZones,
  EQUIPMENT_ENVELOPES,
  equipmentFootprint,
  externalZones,
  FINISHED_FLOOR_Y,
  intersects,
  occupiedEnvelope,
  openingPanels,
  panelEnvelope,
  openingTravelZone,
  placementIssues,
  presentationBounds,
  roofDeckElevation,
  spatialContract,
  stairLayout,
  usableInterior,
  workingEnvelope,
  type SpatialConfig,
  type SpatialItem,
} from './spatial'

const empty = { ...DEFAULT_CONFIG, items: [] }
const item: SpatialItem = { id: 'r', sku: 'rack', x: -3, z: -0.05, rotation: 0 }

describe('plain spatial contract', () => {
  it('is serializable, distinguishes physical and illustrative envelopes, and never mutates a document', () => {
    const c = { ...empty, items: [item] },
      before = JSON.stringify(c),
      contract = spatialContract(c)
    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract)
    expect(JSON.stringify(c)).toBe(before)
    expect(contract.equipment[0].workingClassification).toBe('illustrative-not-certified')
    expect(contract.entrance.kind).toBe('access-guidance')
    expect(contract.finishedFloor).toBe(FINISHED_FLOOR_Y)
    expect(containsBounds(workingEnvelope(item), occupiedEnvelope(item))).toBe(true)
  })
  it('rotates asymmetric occupied extents around the actual model origin', () => {
    const bench = { ...item, sku: 'bench' as const, rotation: 90 as const }
    const b = occupiedEnvelope(bench, { x: 8, y: 2, z: -6 })
    expect(b.min.x).toBeCloseTo(8 + bench.x - 2.08)
    expect(b.max.x).toBeCloseTo(8 + bench.x + 2.186)
    expect(b.min.y).toBeCloseTo(2 + FINISHED_FLOOR_Y)
    expect(equipmentFootprint(bench).offsetX).toBeCloseTo(0.053)
  })
  it('flags the loaded rack against the Container ceiling rather than shrinking it', () => {
    expect(placementIssues(item, { ...empty, family: 'container' }).map((i) => i.code)).toContain(
      'ceiling',
    )
    expect(placementIssues(item, empty).map((i) => i.code)).not.toContain('ceiling')
    expect(EQUIPMENT_ENVELOPES.rack.max.x - EQUIPMENT_ENVELOPES.rack.min.x).toBe(7.26)
  })
  it('detects physical sleeve contact without borrowing working clearance', () => {
    const bar = { ...item, x: 0, z: -1.7 },
      mat = { ...item, id: 'm', sku: 'mat' as const, x: 3, z: -1.7 }
    expect(placementIssues(mat, { ...empty, items: [bar, mat] }).map((i) => i.code)).toContain(
      'overlap',
    )
    const a = { ...item, sku: 'bench' as const, x: -4 },
      b = { ...a, id: 'b', x: -1.9 }
    expect(intersects(workingEnvelope(a), workingEnvelope(b))).toBe(true)
    expect(placementIssues(a, { ...empty, items: [a, b] }).map((i) => i.code)).not.toContain(
      'overlap',
    )
  })
  it('marks approach guidance separately from physical overhead collisions', () => {
    const doorway = { ...item, sku: 'mat' as const, x: 0, z: 0.7 }
    expect(placementIssues(doorway, empty).find((i) => i.code === 'entry')?.category).toBe(
      'access-guidance',
    )
    const sauna = { ...item, sku: 'sauna' as const, x: 5.8, z: -1.4 }
    expect(placementIssues(sauna, { ...empty, family: 'container' }).map((i) => i.code)).toContain(
      'overhead',
    )
  })
  it.each(['studio', 'container'] as const)(
    'uses lined floor, not nominal exterior in %s',
    (family) => {
      for (const length of [20, 40] as const) {
        const c = { ...empty, family, length },
          room = usableInterior(c)
        expect(room.max.x - room.min.x).toBeLessThan(length)
        expect(room.max.z - room.min.z).toBeLessThan(8)
        for (const sku of Object.keys(EQUIPMENT_ENVELOPES) as SpatialItem['sku'][])
          for (const rotation of [0, 90] as const) {
            const local = occupiedEnvelope({ ...item, sku, rotation, x: 0, z: 0 })
            const atRight = { ...item, sku, rotation, x: room.max.x - local.max.x, z: -0.04 }
            expect(
              placementIssues(atRight, c).some(
                (i) => i.code === 'wall' && local.max.z - local.min.z <= room.max.z - room.min.z,
              ),
            ).toBe(false)
            expect(
              placementIssues({ ...atRight, x: atRight.x + 0.01 }, c).map((i) => i.code),
            ).toContain('wall')
          }
      }
    },
  )
  it('rejects non-finite and unsupported transforms without mutating recoverable state', () => {
    expect(placementIssues({ ...item, x: NaN }, empty)[0].code).toBe('non-finite')
    expect(placementIssues({ ...item, rotation: 45 as 0 }, empty)[0].code).toBe('non-finite')
  })
  it('keeps physical overlap elevation-aware', () => {
    expect(intersects(bounds3(0, 0, 0, 1, 1, 1), bounds3(0, 2, 0, 1, 3, 1))).toBe(false)
    expect(intersects(bounds3(0, 0, 0, 1, 1, 1), bounds3(1, 0, 0, 2, 1, 1))).toBe(false)
  })
})

describe('site-only context and presentation fit', () => {
  it('keeps absent, product and unknown context out of site scope', () => {
    expect(contextZones({ ...empty, presentation: undefined })).toEqual([])
    for (const context of ['product', 'future-context'])
      expect(contextZones({ ...empty, presentation: { ...empty.presentation, context } })).toEqual(
        [],
      )
  })
  it.each(['custom-wellness', 'sunken-lounge'] as const)(
    'labels %s as inquiry-only without changing equipment validation or product zones',
    (context) => {
      const base = { ...empty, items: [item] },
        c = { ...base, presentation: { ...base.presentation, context } },
        before = JSON.stringify(c)
      const zones = contextZones(c),
        contract = spatialContract(c)
      expect(zones).toHaveLength(1)
      expect(zones[0]).toMatchObject({
        id: context,
        kind: 'site-context',
        scope: 'site-only',
        inquiryOnly: true,
      })
      expect(zones[0].label).toContain('inquiry only')
      expect(placementIssues(item, c)).toEqual(placementIssues(item, base))
      expect(externalZones(c)).toEqual(externalZones(base))
      expect(contract.context).toEqual(zones)
      expect(contract.presentationBounds).toEqual(presentationBounds(c))
      expect(JSON.parse(JSON.stringify(contract))).toEqual(contract)
      expect(JSON.stringify(c)).toBe(before)
    },
  )
  it('gates gazebo on both Studio family and the requested addon', () => {
    expect(externalZones(empty).some((z) => z.id === 'gazebo')).toBe(false)
    const c = { ...empty, addons: { ...empty.addons, gazebo: true } }
    expect(externalZones(c).find((z) => z.id === 'gazebo')?.kind).toBe('physical')
    expect(externalZones({ ...c, family: 'container' }).some((z) => z.id === 'gazebo')).toBe(false)
  })
  it('fits current panel poses and site geometry, not entry guidance or engineering travel', () => {
    const closed = {
      ...empty,
      family: 'container' as const,
      length: 40 as const,
      openingConcept: 'hinged-solid' as const,
      presentation: { openingPose: 'closed' as const, context: 'product' },
    }
    const open = {
      ...closed,
      presentation: { ...closed.presentation, openingPose: 'open' as const },
    }
    const fit = presentationBounds(open)
    expect(presentationBounds(closed).max.z).toBe(4.25)
    expect(fit.max.z).toBeGreaterThan(13)
    expect(fit.max.z).toBeLessThan(openingTravelZone(open)!.bounds.max.z)
    expect(
      presentationBounds({
        ...open,
        presentation: { ...open.presentation, context: 'sunken-lounge' },
      }).max.z,
    ).toBe(23)
    expect(presentationBounds(closed).max.z).toBeLessThan(
      spatialContract(closed).entrance.bounds.max.z,
    )
    expect(presentationBounds({ ...closed, family: 'studio' }).max.y).toBeCloseTo(10.31)
  })
  it('includes physically displaced recovery equipment but not its working margins', () => {
    const displaced = { ...item, x: 30 },
      c = { ...empty, items: [displaced] },
      before = JSON.stringify(c)
    const fit = presentationBounds(c),
      occupied = occupiedEnvelope(displaced)
    expect(fit.max.x).toBe(occupied.max.x)
    expect(fit.max.x).toBeLessThan(workingEnvelope(displaced).max.x)
    fit.max.x = 0
    expect(presentationBounds(c).max.x).toBe(occupied.max.x)
    expect(JSON.stringify(c)).toBe(before)
  })
})

describe('external and opening contract', () => {
  it.each(['studio', 'container'] as const)(
    'connects %s stair arrival to roof deck, independently from ground deck',
    (family) => {
      for (const length of [20, 40] as const) {
        const c = {
            ...empty,
            family,
            length,
            addons: { deck: true, roof: true, stairs: true, gazebo: false },
          },
          s = stairLayout(c),
          zones = externalZones(c)
        expect(s.ground + s.risers * s.rise).toBeCloseTo(roofDeckElevation(c))
        expect(s.start - (s.risers - 1) * s.going - 0.475).toBeCloseTo(s.landing.max.z)
        expect(s.landing.min.x).toBeLessThan(length / 2 - 0.85)
        const deck = zones.find((z) => z.id === 'ground-deck')!,
          roof = zones.find((z) => z.id === 'roof-deck')!
        expect(intersects(deck.bounds, roof.bounds)).toBe(false)
        expect(zones.find((z) => z.id === 'roof-rail-right')!.bounds.min.z).toBe(-0.45)
        expect(zones.filter((z) => z.id.startsWith('landing-support'))).toHaveLength(2)
      }
    },
  )
  it('does not generate a stranded stair without a roof destination', () => {
    expect(externalZones({ ...empty, addons: { ...empty.addons, stairs: true } })).toEqual([])
  })
  it('retains legacy partial opening position only for the standard concept', () => {
    const c: SpatialConfig = { ...empty, family: 'container', containerOpening: 'partial' }
    expect(constructionOpening(c)).toEqual({ width: 9.4, center: -5 })
    expect(constructionOpening({ ...c, openingConcept: 'raised-glazed' })).toEqual({
      width: 18.6,
      center: 0,
    })
  })
  it.each(['sectional-glazed', 'raised-glazed', 'hinged-solid'] as const)(
    'has distinct %s endpoints and an independently classified travel envelope',
    (openingConcept) => {
      const c = { ...empty, family: 'container' as const, openingConcept }
      const opened = openingPanels(c),
        closed = openingPanels({ ...c, presentation: { ...c.presentation, openingPose: 'closed' } })
      expect(opened).not.toEqual(closed)
      expect(openingTravelZone(c)?.kind).toBe('opening-projection')
      if (openingConcept === 'sectional-glazed')
        expect(opened.slice(1).every((p) => p.rotationX === -Math.PI / 2)).toBe(true)
      if (openingConcept === 'raised-glazed') expect(opened[0].center.z).toBeGreaterThan(7)
      if (openingConcept === 'hinged-solid') expect(opened).toHaveLength(4)
    },
  )
  it('does not invent an invisible closure for an open-front concept', () => {
    expect(openingPanels({ ...empty, openingConcept: 'open-front' })).toEqual([])
    expect(openingTravelZone({ ...empty, openingConcept: 'open-front' })).toBeNull()
  })
  it('connects the open sectional panels inside the Container roof and rear lining', () => {
    const c = {
      ...empty,
      family: 'container' as const,
      openingConcept: 'sectional-glazed' as const,
    }
    const panels = openingPanels(c),
      room = usableInterior(c)
    for (const p of panels) {
      const b = panelEnvelope(p)
      expect(b.min.z).toBeGreaterThan(room.min.z)
      expect(b.max.y).toBeLessThan(room.max.y)
    }
    const first = panels[0],
      second = panels[1]
    expect(
      Math.abs(first.center.y + (Math.cos(first.rotationX) * first.height) / 2 - second.center.y),
    ).toBeLessThan(0.03)
    expect(
      Math.abs(
        first.center.z +
          (Math.sin(first.rotationX) * first.height) / 2 -
          second.center.z -
          second.height / 2,
      ),
    ).toBeLessThan(0.03)
  })
  it('can reach the sixteen-item editor cap without certifying working-space capacity', () => {
    const items: SpatialItem[] = [-1, 1].flatMap((s, j) =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `mat-${j * 8 + i}`,
        sku: 'mat',
        x: s * (2.7 + i * 2.16),
        z: -0.04,
        rotation: 0,
      })),
    )
    const c = { ...empty, family: 'container' as const, length: 40 as const, items }
    expect(items.flatMap((i) => placementIssues(i, c))).toEqual([])
    expect(intersects(workingEnvelope(items[0]), workingEnvelope(items[1]))).toBe(true)
  })
})
