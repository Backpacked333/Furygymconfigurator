import { z } from 'zod'
import { designEnvelopeSchema, freezeDesignValue, parseDesign } from '../../domain/design'
import { createSceneDesignFixtures } from '../../domain/designFixtures'
import { preparePrototypeScene, type PreparationManifest } from './prepare'
import { digest } from './identity'
import { createStrictReferenceManifest, STRICT_REFERENCE_SETTINGS } from './strictReference'

export const prototypeFixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    role: z.enum(['family-size-baseline', 'difficult-interior', 'structural-stress']),
    status: z.literal('DRAFT'),
    approval: z.literal(false),
    design: designEnvelopeSchema,
  })
  .strict()
export type PrototypeFixture = z.infer<typeof prototypeFixtureSchema>

export function createPrototypeFixtures() {
  const candidates = createSceneDesignFixtures()
  const interior = candidates[4].design,
    structural = candidates[5].design
  return freezeDesignValue(
    [
      ...candidates
        .slice(0, 4)
        .map(({ id, design }) => ({ id, design, role: 'family-size-baseline' })),
      {
        id: 'studio-40-night-mirror-glass-interior',
        role: 'difficult-interior',
        design: parseDesign({
          ...interior,
          config: { ...interior.config, structure: { ...interior.config.structure, addons: [] } },
          presentation: { ...interior.presentation, cameraRef: 'centre-draft@1' },
        }),
      },
      {
        id: 'container-40-roof-stairs-overhead-opening',
        role: 'structural-stress',
        design: parseDesign({
          ...structural,
          presentation: {
            ...structural.presentation,
            lookRef: 'courtyard-day-draft@1',
            cameraRef: 'top-draft@1',
          },
        }),
      },
    ].map((fixture) =>
      prototypeFixtureSchema.parse({ ...fixture, status: 'DRAFT', approval: false }),
    ),
  )
}

export const G1_REVIEW_PROFILES = freezeDesignValue({
  reference: {
    id: 'strict-cycles-1024-reference-draft@1',
    usage: 'reference-only',
    approval: false,
    requiredCompletedSamplesPerPixel: 1024,
    adaptiveSampling: false,
    timeLimitSeconds: null,
    lowerTierFallbackAllowed: false,
    resolutionPx: STRICT_REFERENCE_SETTINGS.resolutionPx,
    finishing: 'pending-calibration',
    executionAllowed: false,
  },
  display: [
    {
      id: 'web-hero',
      version: 1,
      usage: 'display-only',
      approval: false,
      resolutionPx: null,
      executionAllowed: false,
    },
    {
      id: 'web-thumbnail',
      version: 1,
      usage: 'display-derivative-only',
      approval: false,
      resolutionPx: null,
      executionAllowed: false,
    },
  ],
})

/** Review cases, not submitted jobs and not evidence that 28 paid jobs cover G1. */
export function createG1ReviewBundle() {
  const fixtures = createPrototypeFixtures()
  const prepared: { fixture: (typeof fixtures)[number]; scene: PreparationManifest }[] = []
  for (const fixture of fixtures) {
    const resource = preparePrototypeScene(fixture.design)
    try {
      prepared.push({ fixture, scene: resource.manifest })
    } finally {
      resource.dispose()
    }
  }
  const caseScenes: { id: string; scene: PreparationManifest }[] = []
  const cases = prepared.flatMap(({ fixture }) => {
    const views = [
      'front-left',
      'entry',
      ...(fixture.role === 'structural-stress'
        ? ['top']
        : fixture.role === 'difficult-interior'
          ? ['centre']
          : []),
    ]
    return views.flatMap((view) =>
      (['wide', 'tall'] as const).map((aspect) => {
        const design = parseDesign({
          ...fixture.design,
          presentation: { ...fixture.design.presentation, cameraRef: `${view}-draft@1`, aspect },
        })
        const resource = preparePrototypeScene(design)
        let scene: PreparationManifest
        try {
          scene = resource.manifest
        } finally {
          resource.dispose()
        }
        const camera = scene.camera
        const id = `${fixture.id}--${view}--${aspect}`
        caseScenes.push({ id, scene })
        const binding = {
          preparationDigest: scene.preparationDigest,
          rendererInputDigest: scene.hashes.rendererInput,
          assetValidationDigest: scene.hashes.assetValidation,
          geometryDigest: scene.hashes.geometry,
          materialDigest: scene.hashes.material,
          assetsDigest: scene.hashes.assets,
          sourcesDigest: scene.hashes.sources,
          lookDigest: scene.hashes.look,
          cameraDigest: digest(camera),
        }
        return {
          id,
          fixtureId: fixture.id,
          view,
          aspect,
          framing:
            aspect === 'tall'
              ? 'portrait-provisional-independent-camera-no-crop-reuse-approved'
              : 'wide-provisional',
          design,
          camera,
          binding,
          compositionDigest: digest({ design, binding }),
          exposure: scene.rendererInput.lighting.exposure,
          sceneFile: `${id}.scene.json`,
          referenceProfile: G1_REVIEW_PROFILES.reference.id,
          displayProfile: 'web-hero',
          approval: false,
          productionAllowed: false,
          paidExecutionAllowed: false,
          artifactDigest: null,
        }
      }),
    )
  })
  const body = {
    contract: 'fury.g1-draft-review-manifest',
    contractVersion: 1,
    status: 'DRAFT',
    approval: false,
    productionAllowed: false,
    paidExecutionAllowed: false,
    rendererQualified: false,
    counts: {
      fixtures: fixtures.length,
      commonFixtureViews: 12,
      additionalViews: 2,
      namedCompositions: 14,
      aspects: 2,
      compositionCases: cases.length,
      approvedPaidJobs: 0,
    },
    profiles: G1_REVIEW_PROFILES,
    cases,
    executionPlan: {
      status: 'blocked-not-dispatchable',
      engineLanes: [
        'three-display-candidate',
        'unreal-display-candidate',
        'cycles-strict-reference',
      ],
      repetitionsPerLane: null,
      plannedPaidJobs: null,
      countingRule:
        'Every engine/reference/repetition is separate. 28 cases x 3 lanes x 1 repetition would be 84 executions before retries/exports/streams; none is authorized.',
      estimates: {
        resolution: 'pending-agreement',
        hostQuotes: 'pending-fresh-quotes',
        spendApproval: 'pending-fresh-itemized-approval',
        currency: null,
        costCeiling: null,
        runtime: null,
        startupIdleRetriesEgressStorageShutdownMargin: 'pending-itemization',
      },
    },
    holds: [
      'All product/arrangement/door/ceiling/access and engineering holds in the six scene manifests remain open.',
      'All environments, looks, cameras, materials, asset rights and responsive framing remain provisional.',
      'Missing visual effects and calibration in each scene manifest block capture parity and renderer qualification.',
      'Real hardware, minimum admission/watchdog controls, region/license/account prerequisites and fresh spend approval remain required.',
      'Historical imagery is not used; no current-design artifact or reuse authorization is inferred.',
    ],
  }
  return freezeDesignValue({
    fixtures: prepared,
    caseScenes,
    reference: createStrictReferenceManifest(cases),
    g1: { ...body, manifestDigest: digest(body) },
  })
}
export type G1ReviewBundle = ReturnType<typeof createG1ReviewBundle>
