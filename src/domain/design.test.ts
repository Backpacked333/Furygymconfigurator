import { describe, expect, it } from 'vitest'
import {
  ADDONS,
  DEFAULT_CONFIG,
  FINISHES,
  FLOORS,
  INTERIORS,
  RAILINGS,
  configSchema,
} from '../lib/config'
import { CONTAINER_OPENINGS, OPENING_INFILLS, STUDIO_DOORS } from '../lib/products'
import { arrangementFor } from './arrangements'
import {
  defaultDesign,
  deserializeDesign,
  designEnvelopeSchema,
  designProductionGate,
  INQUIRY_ONLY_STUDIO_LAYOUTS,
  parseDesign,
  projectDesignToConfig,
  resolveDesignManifest,
  serializeDesign,
} from './design'
import {
  createDesignFixtures,
  createPresentationFixtures,
  createSceneDesignFixtures,
} from './designFixtures'
import {
  canonicalDesign,
  canonicalPresentation,
  canonicalRequest,
  designIdentity,
} from './designIdentity'
import { applyDesignCommand, transitionDesign } from './designTransitions'
import {
  DRAFT_CAMERAS,
  DRAFT_LOOKS,
  defaultPresentation,
  deserializePresentation,
  serializePresentation,
} from './presentation'

function mutable(product = { family: 'studio', lengthFt: 20 }) {
  return designEnvelopeSchema.parse(defaultDesign(product))
}

describe('provisional v4 domain', () => {
  it('constructs four frozen family/size fixtures and explicitly projects every v3 field', () => {
    const fixtures = createDesignFixtures()
    expect(fixtures).toHaveLength(4)
    for (const design of fixtures) {
      const projected = projectDesignToConfig(design)
      expect(configSchema.safeParse(projected).success).toBe(true)
      expect(Object.keys(projected).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())
      expect(projected.items).toEqual(arrangementFor(projected.family, projected.length).items)
      expect(projected.package).toBe('custom')
      expect(Object.isFrozen(design.config.structure.addons)).toBe(true)
      expect(Object.isFrozen(design.presentation)).toBe(true)
      expect(deserializeDesign(serializeDesign(design))).toEqual(design)
      expect(designProductionGate(design).allowed).toBe(false)
      expect(designProductionGate(design).paidExecutionAllowed).toBe(false)
    }
  })

  it.each(['root', 'config', 'product', 'structure', 'appearance', 'presentation'])(
    'rejects unknown keys at %s',
    (location) => {
      const design = mutable()
      const targets: Record<string, object> = {
        root: design,
        config: design.config,
        product: design.config.product,
        structure: design.config.structure,
        appearance: design.config.appearance,
        presentation: design.presentation,
      }
      Object.assign(targets[location], { arbitrary: true })
      expect(() => parseDesign(design)).toThrow()
    },
  )

  it.each([null, [], {}, 'design', 4, true, { v: 3 }, DEFAULT_CONFIG])(
    'never converts malformed/legacy inputs: %j',
    (input) => {
      expect(() => parseDesign(input)).toThrow()
      expect(deserializeDesign(JSON.stringify(input))).toBeNull()
    },
  )

  it('rejects future catalog/schema/arrangement/presentation/profile and arbitrary renderer controls', () => {
    const base = mutable()
    for (const invalid of [
      { ...base, config: { ...base.config, schemaVersion: 5 } },
      { ...base, config: { ...base.config, catalogVersion: 'future' } },
      { ...base, config: { ...base.config, arrangementRef: 'studio-40-review@1' } },
      { ...base, config: { ...base.config, items: [] } },
      { ...base, presentation: { ...base.presentation, lookRef: 'retired@1' } },
      { ...base, presentation: { ...base.presentation, cameraRef: 'future@2' } },
      { ...base, presentation: { ...base.presentation, time: 17 } },
      { ...base, presentation: { ...base.presentation, position: [1, 2, 3] } },
      { ...base, outputProfile: 'strict-1024' },
      { ...base, samples: 1024 },
      { ...base, assetUrl: 'https://example.invalid/asset.glb' },
    ])
      expect(() => parseDesign(invalid)).toThrow()
    expect(deserializeDesign('{bad')).toBeNull()
    expect(deserializeDesign(' '.repeat(16385))).toBeNull()
    expect(deserializeDesign('界'.repeat(5500))).toBeNull()
  })

  it('retains inquiry-only choices as unmodeled catalog entries, never fake multi-unit geometry', () => {
    expect(INQUIRY_ONLY_STUDIO_LAYOUTS.map((entry) => entry.id)).toEqual([
      'connected',
      'double-wide',
      'multi-level',
      'stacked',
      'custom',
    ])
    for (const entry of INQUIRY_ONLY_STUDIO_LAYOUTS) {
      const design = mutable()
      expect(() =>
        parseDesign({
          ...design,
          config: { ...design.config, structure: { ...design.config.structure, layout: entry.id } },
        }),
      ).toThrow()
    }
    expect(resolveDesignManifest(defaultDesign()).geometryStatus).toBe('single-unit-concept-only')
  })

  it('rejects family/structure disagreement, unavailable additions and accent', () => {
    const studio = mutable()
    const container = mutable({ family: 'container', lengthFt: 40 })
    for (const invalid of [
      { ...studio, config: { ...studio.config, structure: container.config.structure } },
      {
        ...studio,
        config: { ...studio.config, structure: { ...studio.config.structure, addons: ['canopy'] } },
      },
      {
        ...container,
        config: {
          ...container.config,
          structure: { ...container.config.structure, addons: ['gazebo'] },
        },
      },
      {
        ...container,
        config: {
          ...container.config,
          appearance: { ...container.config.appearance, accent: true },
        },
      },
    ])
      expect(() => parseDesign(invalid)).toThrow()
  })

  it('normalizes addition ordering, rejects duplicates and does not mutate input', () => {
    const design = mutable()
    design.config.structure.addons = ['stairs', 'deck', 'roof']
    const parsed = parseDesign(design)
    expect(parsed.config.structure.addons).toEqual(['deck', 'roof', 'stairs'])
    expect(design.config.structure.addons).toEqual(['stairs', 'deck', 'roof'])
    expect(() =>
      parseDesign({
        ...design,
        config: {
          ...design.config,
          structure: { ...design.config.structure, addons: ['deck', 'deck'] },
        },
      }),
    ).toThrow()
  })

  it('covers all retained finish/floor/interior/mirror/accent fields without losing values', () => {
    for (const base of createDesignFixtures())
      for (const finish of FINISHES)
        for (const floor of FLOORS)
          for (const interior of INTERIORS) {
            const appearance = {
              finish: finish.id,
              floor: floor.id,
              interior: interior.id,
              mirror: true,
              accent: base.config.product.family === 'studio',
            }
            const design = parseDesign({ ...base, config: { ...base.config, appearance } })
            const projected = projectDesignToConfig(design)
            expect([
              projected.finish,
              projected.flooring,
              projected.interiorStyle,
              projected.mirror,
              projected.accent,
            ]).toEqual([finish.id, floor.id, interior.id, true, appearance.accent])
            expect(deserializeDesign(serializeDesign(design))).toEqual(design)
          }
  })

  it('covers every family-legal addition subset, door and railing without adding constraints', () => {
    for (const base of createDesignFixtures()) {
      const legal = ADDONS.filter((addon) =>
        (addon.families as readonly string[]).includes(base.config.product.family),
      )
      for (let mask = 0; mask < 1 << legal.length; mask++)
        for (const railing of RAILINGS) {
          const addons = legal.filter((_, index) => mask & (1 << index)).map((addon) => addon.id)
          const design = parseDesign({
            ...base,
            config: {
              ...base.config,
              structure: { ...base.config.structure, addons, railing: railing.id },
            },
          })
          const projected = projectDesignToConfig(design)
          expect(
            Object.entries(projected.addons)
              .filter(([, enabled]) => enabled)
              .map(([id]) => id)
              .sort(),
          ).toEqual([...addons].sort())
          expect(projected.railing).toBe(railing.id)
        }
      if (base.config.product.family === 'studio')
        for (const door of STUDIO_DOORS) {
          const design = parseDesign({
            ...base,
            config: { ...base.config, structure: { ...base.config.structure, door: door.id } },
          })
          expect(projectDesignToConfig(design).studioDoor).toBe(door.id)
        }
    }
  })

  it('exhausts Container openings, infills, integrated finish and door poses', () => {
    for (const lengthFt of [20, 40])
      for (const opening of CONTAINER_OPENINGS)
        for (const infill of OPENING_INFILLS)
          for (const integratedFinish of [false, true])
            for (const doorPose of ['open', 'closed']) {
              const base = defaultDesign({ family: 'container', lengthFt })
              const candidate = {
                ...base,
                config: {
                  ...base.config,
                  structure: {
                    ...base.config.structure,
                    opening: opening.id,
                    infill: infill.id,
                    integratedFinish,
                  },
                },
                presentation: { ...base.presentation, doorPose },
              }
              const invalid =
                (opening.id === 'roll-up' && infill.id !== 'none') ||
                (opening.id !== 'roll-up' && infill.id === 'none' && doorPose === 'open')
              expect(designEnvelopeSchema.safeParse(candidate).success).toBe(!invalid)
              if (!invalid) {
                const config = projectDesignToConfig(candidate)
                expect([
                  config.containerOpening,
                  config.openingInfill,
                  config.integratedFinish,
                  config.doorsOpen,
                ]).toEqual([opening.id, infill.id, integratedFinish, doorPose === 'open'])
              }
            }
  })

  it('supplies eight draft looks and seven cameras, with six scene fixtures', () => {
    expect(DRAFT_LOOKS).toHaveLength(8)
    expect(new Set(DRAFT_LOOKS.map((entry) => entry.preview.environment)).size).toBe(4)
    expect(DRAFT_CAMERAS).toHaveLength(7)
    expect(DRAFT_CAMERAS.filter((entry) => entry.group === 'exterior')).toHaveLength(5)
    for (const entry of [...DRAFT_LOOKS, ...DRAFT_CAMERAS]) {
      expect(entry.version).toBe(1)
      expect(entry.name).toMatch(/^DRAFT/)
      expect(entry.productionAllowed).toBe(false)
    }
    expect(createPresentationFixtures()).toHaveLength(224)
    const fixtures = createPresentationFixtures(true)
    expect(fixtures).toHaveLength(448)
    expect(new Set(fixtures.map(canonicalRequest)).size).toBe(448)
    for (const fixture of fixtures) {
      expect(deserializeDesign(serializeDesign(fixture))).toEqual(fixture)
      expect(designProductionGate(fixture).allowed).toBe(false)
    }
    expect(createSceneDesignFixtures()).toHaveLength(6)
    expect(deserializePresentation(serializePresentation(defaultPresentation()))).toEqual(
      defaultPresentation(),
    )
    expect(deserializePresentation('{"future":true}')).toBeNull()
  })

  it('resolves trusted fixed inventory and leaves all true render bindings explicitly absent', () => {
    const manifest = resolveDesignManifest(defaultDesign({ family: 'container', lengthFt: 20 }))
    expect(manifest.arrangement.items[0].sku).toBe('rack')
    expect(manifest.arrangement.items[0].dimensions.occupiedWidthFt).toBe(7.3)
    expect(manifest.renderBinding).toEqual({
      status: 'unbound',
      assetManifestDigest: null,
      rendererBuild: null,
      artifactDigest: null,
    })
    expect(manifest.productionGate.reviewHolds.join(' ')).toMatch(/ceiling/)
    const projection = projectDesignToConfig(manifest.design)
    projection.items[0].x = 100
    expect(resolveDesignManifest(manifest.design).arrangement.items[0].x).not.toBe(100)
  })
})

describe('atomic explained transitions and logical identity', () => {
  it('requires explicit confirmation before replacing family inventory/options and returns one full snapshot', () => {
    const base = defaultDesign()
    const studio = parseDesign({
      ...base,
      config: {
        ...base.config,
        structure: {
          ...base.config.structure,
          door: 'sliding',
          addons: ['gazebo', 'deck'],
          railing: 'cable',
        },
        appearance: { ...base.config.appearance, accent: true, mirror: true },
      },
    })
    const result = transitionDesign(studio, {
      type: 'set-product',
      product: { family: 'container', lengthFt: 40 },
    })
    expect(result.requiresConfirmation).toBe(true)
    expect(result.adjustments.join(' ')).toMatch(/gazebo/)
    expect(result.adjustments.join(' ')).toMatch(/sliding/)
    expect(result.changes.map((change) => change.path)).toContain('config.appearance.accent')
    expect(result.next.config.structure.addons).toEqual(['deck'])
    expect(result.next.config.structure.railing).toBe('cable')
    expect(result.next.config.appearance.mirror).toBe(true)
    expect(() => applyDesignCommand(studio, result.command)).toThrow(/confirmation/)
    expect(applyDesignCommand(studio, result.command, true)).toEqual(result.next)
    expect(result.previous).toEqual(studio)
    expect(designProductionGate(result.next).allowed).toBe(false)
    expect(
      transitionDesign(studio, {
        type: 'set-product',
        product: { family: 'container', lengthFt: 40 },
      }),
    ).toEqual(result)
  })

  it('reports infill and neutral pose adjustments, never silently approves compatibility', () => {
    const base = defaultDesign({ family: 'container', lengthFt: 20 })
    const glazed = parseDesign({
      ...base,
      config: {
        ...base.config,
        structure: { ...base.config.structure, opening: 'full', infill: 'glass-overhead' },
      },
      presentation: { ...base.presentation, doorPose: 'open' },
    })
    const rollup = transitionDesign(glazed, {
      type: 'update-structure',
      patch: { kind: 'container', opening: 'roll-up' },
    })
    expect(rollup.adjustments.join(' ')).toMatch(/infill/)
    expect(rollup.requiresConfirmation).toBe(true)
    const open = transitionDesign(glazed, {
      type: 'update-structure',
      patch: { kind: 'container', infill: 'none' },
    })
    expect(open.next.presentation.doorPose).toBe('closed')
    expect(open.adjustments.join(' ')).toMatch(/no door/)
    expect(() =>
      transitionDesign(glazed, {
        type: 'update-structure',
        patch: { kind: 'container', opening: 'roll-up', infill: 'awning' },
      }),
    ).toThrow()
    expect(() =>
      transitionDesign(base, {
        type: 'update-structure',
        patch: { kind: 'studio', door: 'sliding' },
      }),
    ).toThrow()
  })

  it('rejects stale confirmations, forged next states and unknown action keys', () => {
    const base = defaultDesign()
    const family = transitionDesign(base, {
      type: 'set-product',
      product: { family: 'container', lengthFt: 20 },
    })
    const newer = transitionDesign(base, { type: 'update-appearance', patch: { finish: 'chalk' } })
    expect(() => applyDesignCommand(newer.next, family.command, true)).toThrow(/changed/)
    expect(() => applyDesignCommand(base, { ...family.command, next: family.next }, true)).toThrow()
    expect(() =>
      transitionDesign(base, { type: 'update-appearance', patch: { unknown: true } }),
    ).toThrow()
    expect(() =>
      transitionDesign(base, { type: 'update-presentation', patch: { time: 12 } }),
    ).toThrow()
  })

  it('closes the transition matrix and keeps a no-op confirmation-free', () => {
    for (const from of createDesignFixtures())
      for (const to of createDesignFixtures()) {
        const transition = transitionDesign(from, {
          type: 'set-product',
          product: to.config.product,
        })
        expect(parseDesign(transition.next)).toEqual(transition.next)
        expect(transition.changed).toBe(from.config.arrangementRef !== to.config.arrangementRef)
        expect(transition.requiresConfirmation).toBe(transition.changed)
      }
    const base = defaultDesign()
    expect(
      transitionDesign(base, { type: 'update-structure', patch: { kind: 'studio' } })
        .requiresConfirmation,
    ).toBe(false)
  })

  it('separates design, presentation, output request and rendered artifact identities', async () => {
    const base = defaultDesign()
    const presentation = transitionDesign(base, {
      type: 'update-presentation',
      patch: { cameraRef: DRAFT_CAMERAS[6].ref },
    }).next
    const finish = transitionDesign(base, {
      type: 'update-appearance',
      patch: { finish: 'olive' },
    }).next
    const profile = transitionDesign(base, {
      type: 'set-output-profile',
      outputProfile: 'web-thumbnail',
    }).next
    const [a, b, c, d] = await Promise.all(
      [base, presentation, finish, profile].map(designIdentity),
    )
    expect(a.designDigest).toBe(b.designDigest)
    expect(a.presentationDigest).not.toBe(b.presentationDigest)
    expect(a.designDigest).not.toBe(c.designDigest)
    expect(a.presentationDigest).toBe(c.presentationDigest)
    expect(a.designDigest).toBe(d.designDigest)
    expect(a.presentationDigest).toBe(d.presentationDigest)
    expect(new Set([a.requestDigest, b.requestDigest, c.requestDigest, d.requestDigest]).size).toBe(
      4,
    )
    expect(a.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect('artifactDigest' in a).toBe(false)
    expect(canonicalDesign(base)).toBe(canonicalDesign(presentation))
    expect(canonicalPresentation(base)).toBe(canonicalPresentation(finish))
  })

  it('has semantic equality across property ordering, set ordering and JSON round trips', async () => {
    const base = defaultDesign()
    const a = parseDesign({
      outputProfile: base.outputProfile,
      presentation: base.presentation,
      config: { ...base.config, structure: { ...base.config.structure, addons: ['roof', 'deck'] } },
    })
    const b = parseDesign({
      ...a,
      config: { ...a.config, structure: { ...a.config.structure, addons: ['deck', 'roof'] } },
    })
    expect(canonicalRequest(a)).toBe(canonicalRequest(b))
    expect(await designIdentity(a)).toEqual(
      await designIdentity(deserializeDesign(serializeDesign(b))),
    )
  })
})
