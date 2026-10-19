// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  arrangementEquipment,
  arrangementFor,
  FIXED_ARRANGEMENTS,
} from '../../../domain/arrangements'
import {
  designProductionGate,
  designReviewHolds,
  parseDesign,
  projectDesignToConfig,
  resolveDesignManifest,
} from '../../../domain/design'
import { createSceneDesignFixtures } from '../../../domain/designFixtures'
import { designIdentity } from '../../../domain/designIdentity'
import { resolveLook } from '../../../domain/presentation'
import {
  createCaptureJob,
  createCaptureSamples,
  LOCAL_REVIEW_PROFILES,
  resolveCaptureCamera,
  type CaptureBuild,
} from './contract'
import {
  createG1CompositionIdentityAudit,
  createValidationFixtures,
  VALIDATION_SELECTIONS,
  validationCamera,
} from './validation'

// Exercise the EXISTING plan enumerator without importing/executing the CPU material hook or
// scene builders. Only its irrelevant preparation dependency is synthetic. No receipt is saved.
vi.mock('../prepare', async () => {
  const { resolvePrivateThreeSceneInput } = await import('../privateScene')
  return {
    preparePrototypeScene: vi.fn((design) => {
      const rendererInput = resolvePrivateThreeSceneInput(design)
      return {
        manifest: {
          preparationDigest: `sha256:${'a'.repeat(64)}`,
          camera: rendererInput.camera,
          rendererInput,
          hashes: Object.fromEntries(
            [
              'geometry',
              'material',
              'assets',
              'sources',
              'look',
              'rendererInput',
              'assetValidation',
            ].map((key) => [key, `sha256:${'a'.repeat(64)}`]),
          ),
        },
        dispose: vi.fn(),
      }
    }),
  }
})
import { createG1ReviewBundle, createPrototypeFixtures, G1_REVIEW_PROFILES } from '../fixtures'

const syntheticBuild: CaptureBuild = {
  sourceManifestDigest: `sha256:${'a'.repeat(64)}`,
  assetManifestDigest: `sha256:${'b'.repeat(64)}`,
  bundleDigest: `sha256:${'c'.repeat(64)}`,
  lockfileDigest: `sha256:${'d'.repeat(64)}`,
  threeRevision: '186',
}

describe('independent six-fixture authority audit (no rendering)', () => {
  it('matches existing private CPU fixture selection without preparing its scene', () => {
    const actual = createPrototypeFixtures()
    const oracle = createValidationFixtures()
    expect(oracle).toHaveLength(6)
    expect(actual.map(({ id, role, design }) => ({ id, role, design }))).toEqual(
      oracle.map(({ fixtureId, role, design }) => ({ id: fixtureId, role, design })),
    )
    expect(actual.every((fixture) => fixture.status === 'DRAFT' && !fixture.approval)).toBe(true)
    expect(oracle.slice(0, 4).map((fixture) => fixture.design.config.arrangementRef)).toEqual(
      FIXED_ARRANGEMENTS.map((arrangement) => arrangement.id),
    )
  })

  it.each(VALIDATION_SELECTIONS)(
    'binds $sampleId by named domain authority, not array position',
    (selection) => {
      const fixture = createValidationFixtures().find(
        (entry) => entry.fixtureId === selection.fixtureId,
      )!
      const sample = createCaptureSamples().find((entry) => entry.id === selection.sampleId)!
      const design = parseDesign({
        ...fixture.design,
        presentation: {
          ...fixture.design.presentation,
          cameraRef: `${selection.view}-draft@1`,
          aspect: selection.aspect,
        },
      })
      expect(sample.role).toBe(selection.role)
      expect(sample.request.design).toEqual(design)
      expect(sample.request.profileId).toBe(LOCAL_REVIEW_PROFILES[selection.aspect].id)
      expect(resolveCaptureCamera(design)).toEqual(validationCamera(design))
      expect(Object.isFrozen(sample.request.design.config.structure.addons)).toBe(true)

      const { family, lengthFt } = design.config.product
      const arrangement = arrangementFor(family, lengthFt)
      const projected = projectDesignToConfig(design)
      expect(projected.items).toEqual(arrangement.items)
      expect(projected.items).toHaveLength(lengthFt === 20 ? 3 : 6)
      expect(projected.items).not.toBe(arrangement.items)
      expect(projected).toMatchObject({
        environment: resolveLook(design.presentation.lookRef).preview.environment,
        time: resolveLook(design.presentation.lookRef).preview.time,
        lights: resolveLook(design.presentation.lookRef).preview.lights,
        doorsOpen: design.presentation.doorPose === 'open',
      })
      expect(arrangement.approval).toBe('draft')
      expect(designProductionGate(design)).toMatchObject({
        allowed: false,
        paidExecutionAllowed: false,
      })
      const holds = designReviewHolds(design)
      for (const hold of arrangement.reviewHolds) expect(holds).toContain(hold)
      expect(holds.some((hold) => hold.includes('Door sweeps'))).toBe(true)
      expect(holds.some((hold) => hold.includes('no product, rights or spend approval'))).toBe(true)
      if (family === 'container')
        expect(holds.some((hold) => hold.includes('slat ceiling'))).toBe(true)
    },
  )

  it('retains exact difficult-interior and structural stress options rather than hiding inventory', () => {
    const fixtures = createValidationFixtures()
    const night = fixtures[4].design
    const roof = fixtures[5].design
    expect(night.config.structure).toEqual({
      kind: 'studio',
      layout: 'single',
      door: 'sliding',
      addons: [],
      railing: 'cable',
    })
    expect(night.config.appearance).toEqual({
      finish: 'chalk',
      accent: true,
      interior: 'slatted',
      floor: 'oak',
      mirror: true,
    })
    expect(night.presentation).toMatchObject({
      lookRef: 'courtyard-night-draft@1',
      doorPose: 'open',
    })
    expect(roof.config.structure).toEqual({
      kind: 'container',
      opening: 'full',
      infill: 'glass-overhead',
      integratedFinish: true,
      addons: ['canopy', 'deck', 'roof', 'stairs'],
      railing: 'cable',
    })
    expect(roof.config.appearance).toEqual({
      finish: 'cloud',
      accent: false,
      interior: 'timber',
      floor: 'concrete',
      mirror: true,
    })
    expect(roof.presentation).toMatchObject({ lookRef: 'courtyard-day-draft@1', doorPose: 'open' })
    expect(projectDesignToConfig(night).items).toEqual(arrangementFor('studio', 40).items)
    expect(projectDesignToConfig(roof).items).toEqual(arrangementFor('container', 40).items)
    expect(arrangementEquipment('rack').occupiedWidthFt).toBeGreaterThan(
      arrangementEquipment('rack').widthFt,
    )
    // Selecting stress fixtures must not mutate the source candidates (which deliberately differ).
    const candidates = createSceneDesignFixtures()
    expect(candidates[4].design.config.structure.addons).toEqual([
      'deck',
      'gazebo',
      'roof',
      'stairs',
    ])
    expect(candidates[5].design.presentation.lookRef).toBe('campus-night-draft@1')
  })
})

describe('original G1 plan identity audit, not execution or rendered provenance', () => {
  it('matches all 28 actual plan cases using a synthetic preparation seam only', async () => {
    const audit = await createG1CompositionIdentityAudit()
    const plan = createG1ReviewBundle().g1
    expect(audit).toHaveLength(28)
    expect(plan.cases.map((entry) => entry.id)).toEqual(audit.map((entry) => entry.id))
    expect(new Set(audit.map((entry) => entry.logicalIdentity.requestDigest)).size).toBe(28)
    expect(new Set(audit.map((entry) => entry.logicalIdentity.designDigest)).size).toBe(6)
    expect(new Set(audit.map((entry) => `${entry.fixtureId}--${entry.view}`)).size).toBe(14)
    expect(audit.filter((entry) => entry.aspect === 'wide')).toHaveLength(14)
    expect(audit.filter((entry) => entry.aspect === 'tall')).toHaveLength(14)
    for (const [index, entry] of audit.entries()) {
      const actual = plan.cases[index]
      expect(actual.design).toEqual(entry.design)
      expect(await designIdentity(actual.design)).toEqual(entry.logicalIdentity)
      expect(actual.camera).toMatchObject({
        position: entry.camera.position,
        target: entry.camera.target,
        fov: entry.camera.fov,
      })
      // Clipping is checked only on the real capture contract, never on the synthetic CPU seam.
      expect(entry.camera).toMatchObject({ near: 0.1, far: 2000 })
      expect(resolveCaptureCamera(entry.design)).toEqual(entry.camera)
      expect(actual.artifactDigest).toBeNull()
      expect(entry.artifactDigest).toBeNull()
      expect(actual.approval || actual.productionAllowed || actual.paidExecutionAllowed).toBe(false)
      expect(Object.isFrozen(entry.logicalIdentity)).toBe(true)
      expect(resolveDesignManifest(entry.design).renderBinding.status).toBe('unbound')
    }
    expect(plan.counts).toEqual({
      fixtures: 6,
      commonFixtureViews: 12,
      additionalViews: 2,
      namedCompositions: 14,
      aspects: 2,
      compositionCases: 28,
      approvedPaidJobs: 0,
    })
    expect(plan.executionPlan.engineLanes).toEqual([
      'three-display-candidate',
      'unreal-display-candidate',
      'cycles-strict-reference',
    ])
    expect(audit.length * plan.executionPlan.engineLanes.length).toBe(84)
    expect(plan.executionPlan).toMatchObject({
      status: 'blocked-not-dispatchable',
      repetitionsPerLane: null,
      plannedPaidJobs: null,
      estimates: { currency: null, costCeiling: null, runtime: null },
    })
  })

  it('treats portrait as a different logical/camera composition rather than approved crop reuse', async () => {
    const audit = await createG1CompositionIdentityAudit()
    for (const wide of audit.filter((entry) => entry.aspect === 'wide')) {
      const tall = audit.find(
        (entry) =>
          entry.fixtureId === wide.fixtureId && entry.view === wide.view && entry.aspect === 'tall',
      )!
      expect(tall.logicalIdentity.designDigest).toBe(wide.logicalIdentity.designDigest)
      expect(tall.logicalIdentity.requestDigest).not.toBe(wide.logicalIdentity.requestDigest)
      expect(tall.logicalIdentity.presentationDigest).not.toBe(
        wide.logicalIdentity.presentationDigest,
      )
      expect(tall.camera).not.toEqual(wide.camera)
    }
  })

  it('admits only six pinned local jobs: the other 22 plan cases are not capture authorization', async () => {
    const audit = await createG1CompositionIdentityAudit()
    const samples = createCaptureSamples()
    let admitted = 0
    for (const [index, composition] of audit.entries()) {
      const selection = VALIDATION_SELECTIONS.find(
        (entry) => entry.fixtureId === composition.fixtureId,
      )!
      const sample = samples.find((entry) => entry.id === selection.sampleId)!
      const request = {
        ...sample.request,
        design: composition.design,
        profileId: LOCAL_REVIEW_PROFILES[composition.aspect].id,
      }
      const operation = createCaptureJob(`plan-audit-${index}`, sample.id, request, syntheticBuild)
      if (selection.view === composition.view && selection.aspect === composition.aspect) {
        await expect(operation).resolves.toMatchObject({ sampleId: sample.id })
        admitted++
      } else await expect(operation).rejects.toMatchObject({ code: 'invalid-input' })
    }
    expect(admitted).toBe(6)
  })

  it('keeps strict 1024 completed samples separate from raster frames, MSAA and display profiles', () => {
    expect(G1_REVIEW_PROFILES.reference).toEqual({
      id: 'strict-cycles-1024-reference-draft@1',
      usage: 'reference-only',
      approval: false,
      requiredCompletedSamplesPerPixel: 1024,
      adaptiveSampling: false,
      timeLimitSeconds: null,
      lowerTierFallbackAllowed: false,
      resolutionPx: { wide: { width: 1920, height: 1200 }, tall: { width: 1200, height: 1500 } },
      finishing: 'pending-calibration',
      executionAllowed: false,
    })
    for (const profile of G1_REVIEW_PROFILES.display) {
      expect(profile).toMatchObject({
        approval: false,
        resolutionPx: null,
        executionAllowed: false,
      })
      expect(profile).not.toHaveProperty('requiredCompletedSamplesPerPixel')
    }
    for (const profile of Object.values(LOCAL_REVIEW_PROFILES)) {
      expect(profile.pipeline).toBe('three-tsl-raster-lite')
      expect(profile.msaaSamples).toBe(4)
      expect(profile.minFrames).toBe(8)
      expect(profile).not.toHaveProperty('requiredCompletedSamplesPerPixel')
    }
  })
})
