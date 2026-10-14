// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  DEFAULT_CONFIG,
  PACKAGES,
  addEquipment,
  changeFamily,
  decodeConfig,
  encodeConfig,
  footprint,
  inspectDocument,
  layoutDiagnostics,
  layoutIssues,
  packageDefinition,
  packageItems,
  placementIssue,
  setAddon,
  type Config,
} from './config'
import { CONTAINER_OPENINGS, OPENING_CONCEPTS, STUDIO_LAYOUTS } from './products'
import {
  containsBounds,
  equipmentFootprint,
  FINISHED_FLOOR_Y,
  occupiedEnvelope,
  placementIssues,
  usableInterior,
  workingEnvelope,
} from './spatial'
import { configReducer, type EditState } from './editTransactions'
import { equipmentParts } from '../render/equipment'
import { compose, measureParts } from '../render/parts'

const empty = (family: Config['family'], length: Config['length']): Config => ({
  ...structuredClone(DEFAULT_CONFIG),
  family,
  length,
  package: 'empty',
  items: [],
})

describe('SPACE-01..04 model-derived domain contract', () => {
  it.each(CATALOG.map((item) => item.id))(
    '%s matches actual occupied vertices at both rotations/families/lengths',
    (sku) => {
      const parts = equipmentParts(sku)
      const metadata = CATALOG.find((item) => item.id === sku)!
      const raw = measureParts(parts)
      expect(metadata.w).toBeGreaterThanOrEqual(raw.max.x - raw.min.x - 0.00001)
      expect(metadata.d).toBeGreaterThanOrEqual(raw.max.z - raw.min.z - 0.00001)
      expect(metadata.h).toBeGreaterThanOrEqual(raw.max.y - raw.min.y - 0.00001)
      expect(metadata.dimensionLabel).toContain('not manufacturer')
      expect(metadata.clearanceLabel).toContain('not a certified')
      for (const family of ['studio', 'container'] as const)
        for (const length of [20, 40] as const)
          for (const rotation of [0, 90] as const) {
            const c = empty(family, length)
            const item = { id: 'measured', sku, rotation, x: -length / 4, z: -0.04 }
            const envelope = occupiedEnvelope(item)
            const vertices = measureParts(
              parts,
              compose([item.x, FINISHED_FLOOR_Y, item.z], [0, (-rotation * Math.PI) / 180, 0]),
            )
            expect(containsBounds(envelope, vertices)).toBe(true)
            expect(footprint(item)).toEqual(equipmentFootprint(item))
            expect(footprint(item).offsetX + item.x).toBeCloseTo(
              (envelope.min.x + envelope.max.x) / 2,
            )
            expect(footprint(item).offsetZ + item.z).toBeCloseTo(
              (envelope.min.z + envelope.max.z) / 2,
            )
            expect(placementIssue(item, c)).toBe(placementIssues(item, c)[0]?.message ?? null)
            if (!placementIssue(item, c))
              expect(containsBounds(usableInterior(c), vertices)).toBe(true)
            const local = occupiedEnvelope({ ...item, x: 0, z: 0 })
            const outside = { ...item, x: usableInterior(c).max.x - local.max.x + 0.01 }
            expect(
              layoutDiagnostics({ ...c, items: [outside] }).some((issue) => issue.code === 'wall'),
            ).toBe(true)
          }
    },
  )
  it('rejects the formerly advertised 7.5ft rack in Container without shrinking its geometry', () => {
    const c = empty('container', 20)
    const rack = { id: 'legacy-rack', sku: 'rack' as const, x: -5, z: -0.8, rotation: 0 as const }
    expect(occupiedEnvelope(rack).max.y).toBeCloseTo(8.465)
    expect(usableInterior(c).max.y).toBe(8.4)
    expect(inspectDocument({ ...c, items: [rack] }).status).toBe('repair')
    expect(addEquipment(c, 'rack')).toBeNull()
    expect(changeFamily(DEFAULT_CONFIG, 'container')).toMatchObject({
      accepted: false,
      config: DEFAULT_CONFIG,
    })
  })
  it('labels entry policy separately and never uses illustrative working margins as physical occupancy', () => {
    const c = empty('studio', 20)
    const first = { id: 'one', sku: 'mat' as const, x: -5, z: -0.5, rotation: 0 as const }
    const second = { ...first, id: 'two', x: -2.8 }
    expect(workingEnvelope(first).max.x).toBeGreaterThan(occupiedEnvelope(second).min.x)
    expect(layoutIssues({ ...c, items: [first, second] })).toEqual([])
    const entry = { ...first, x: 0, z: 0 }
    expect(layoutDiagnostics({ ...c, items: [entry] })).toContainEqual(
      expect.objectContaining({ code: 'entry', category: 'access-guidance' }),
    )
    const overhead = { id: 'sauna', sku: 'sauna' as const, rotation: 0 as const, x: 5.8, z: -1.2 }
    expect(layoutDiagnostics({ ...empty('container', 20), items: [overhead] })).toContainEqual(
      expect.objectContaining({ code: 'overhead', category: 'physical' }),
    )
  })
})

describe('SPACE-05 family/options/additions/preset regression matrix', () => {
  for (const family of ['studio', 'container'] as const)
    for (const length of [20, 40] as const)
      it(`${family} ${length}: all presets under every supported opening/pose/addition/layout`, () => {
        for (const opening of family === 'container'
          ? CONTAINER_OPENINGS.map((o) => o.id)
          : (['roll-up'] as const))
          for (const concept of family === 'container'
            ? OPENING_CONCEPTS.map((o) => o.id)
            : (['standard'] as const))
            for (const openingPose of ['open', 'closed'] as const)
              for (let bits = 0; bits < 16; bits++) {
                const addons = {
                  deck: !!(bits & 1),
                  roof: !!(bits & 2),
                  stairs: !!(bits & 4),
                  gazebo: !!(bits & 8),
                }
                if ((addons.stairs && !addons.roof) || (family === 'container' && addons.gazebo))
                  continue
                for (const layout of family === 'studio'
                  ? STUDIO_LAYOUTS.map((l) => l.id)
                  : (['single'] as const))
                  for (const pack of PACKAGES) {
                    const c: Config = {
                      ...empty(family, length),
                      addons,
                      studioLayout: layout,
                      containerOpening: opening,
                      openingConcept: concept,
                      presentation: { openingPose, context: 'product' },
                      package: pack.id,
                    }
                    const preset = packageDefinition(pack.id, c)
                    const selected = { ...c, items: preset.items }
                    expect(preset.issues, JSON.stringify(selected)).toEqual([])
                    expect(preset.available).toBe(true)
                    expect(decodeConfig(encodeConfig(selected))).toEqual(selected)
                    expect(new Set(selected.items.map((i) => i.id)).size).toBe(
                      selected.items.length,
                    )
                  }
              }
      })
  it('makes the Container Strength selection explicit and never changes existing items', () => {
    const c = { ...empty('container', 20), items: DEFAULT_CONFIG.items }
    const before = structuredClone(c)
    const preset = packageDefinition('strength', c)
    expect(preset.label).toBe('Strength — bench + dumbbells')
    expect(preset.notice).toContain('never replaced automatically')
    expect(preset.items.map((item) => item.sku)).toEqual(['bench', 'weights'])
    expect(c).toEqual(before)
  })
  it('requires explicit roof/stair decisions, preserving legacy stairs-only designs for repair', () => {
    const c = empty('studio', 20)
    expect(setAddon(c, 'stairs').config).toBe(c)
    const roof = setAddon(c, 'roof').config
    const stairs = setAddon(roof, 'stairs').config
    expect(setAddon(stairs, 'roof').config).toBe(stairs)
    expect(inspectDocument({ ...c, addons: { ...c.addons, stairs: true } }).status).toBe('repair')
    expect(layoutIssues(setAddon(setAddon(stairs, 'stairs').config, 'roof').config)).toEqual([])
  })
  it('auto-adds only feasible equipment for both families, lengths and opening concepts', () => {
    for (const family of ['studio', 'container'] as const)
      for (const length of [20, 40] as const)
        for (const concept of family === 'container'
          ? OPENING_CONCEPTS.map((o) => o.id)
          : (['standard'] as const))
          for (const product of CATALOG) {
            const c = { ...empty(family, length), openingConcept: concept }
            const added = addEquipment(c, product.id)
            if (family === 'container' && product.id === 'rack') expect(added).toBeNull()
            else {
              expect(added, `${family}/${length}/${concept}/${product.id}`).not.toBeNull()
              expect(layoutIssues(added!)).toEqual([])
              expect(added!.items).toHaveLength(1)
            }
          }
  })
  it('reaches the 16-item editor cap where feasible without claiming working capacity', () => {
    let c = empty('container', 40)
    for (let n = 0; n < 16; n++) {
      const next = addEquipment(c, 'mat')
      expect(next, `mat ${n + 1}`).not.toBeNull()
      c = next!
    }
    expect(layoutIssues(c)).toEqual([])
    expect(addEquipment(c, 'mat')).toBeNull()
  })
})

describe('SPACE-06 / EDIT-07 all mutation paths share validation', () => {
  const state = (c: Config): EditState => ({
    past: [],
    present: c,
    future: [{ ...c, finish: 'chalk' }],
    notice: '',
    revision: 10,
  })
  it('rejects shrinking, incompatible family, opening pose, overlap, and edge rotation without losing history/redo', () => {
    const long: Config = { ...empty('studio', 40), items: packageItems('strength', 40) }
    const sauna = { id: 'sauna', sku: 'sauna' as const, rotation: 0 as const, x: -6, z: 1 }
    const closed: Config = {
      ...empty('container', 20),
      openingConcept: 'sectional-glazed',
      presentation: { openingPose: 'closed', context: 'product' },
      items: [sauna],
    }
    const mat = { id: 'mat', sku: 'mat' as const, rotation: 0 as const, x: 8, z: -0.5 }
    const edge = { ...empty('studio', 20), items: [mat] }
    const cases: [Config, Config][] = [
      [long, { ...long, length: 20 }],
      [DEFAULT_CONFIG, { ...DEFAULT_CONFIG, family: 'container' }],
      [closed, { ...closed, presentation: { ...closed.presentation, openingPose: 'open' } }],
      [edge, { ...edge, items: [{ ...mat, rotation: 90 }] }],
      [edge, { ...edge, items: [mat, { ...mat, id: 'overlap' }] }],
    ]
    for (const [base, candidate] of cases) {
      expect(inspectDocument(base).status).toBe('accepted')
      const before = state(base)
      const result = configReducer(before, { type: 'set', config: candidate })
      expect(result.result?.status).toBe('rejected')
      expect(result.present).toBe(base)
      expect(result.future).toBe(before.future)
      expect(result.past).toBe(before.past)
      expect(result.revision).toBe(10)
      const token = { id: 'rotation', baseRevision: 10 }
      const preview = configReducer(configReducer(before, { type: 'begin', token }), {
        type: 'preview',
        token,
        config: candidate,
      })
      expect(preview.present).toBe(base)
      const commit = configReducer(preview, { type: 'commit', token })
      expect(commit.result?.status).toBe('rejected')
      expect(commit.present).toBe(base)
      expect(commit.future).toBe(before.future)
    }
  })
  it('never treats an unguarded restore as an escape from validation', () => {
    const before = state(DEFAULT_CONFIG)
    const config = { ...DEFAULT_CONFIG, family: 'container' as const }
    expect(
      configReducer(before, { type: 'restore', config, expectedRevision: 10 }).result?.status,
    ).toBe('rejected')
    expect(
      configReducer(before, { type: 'restore', config, expectedRevision: 9, repairWorkspace: true })
        .result?.status,
    ).toBe('conflict')
  })
})
