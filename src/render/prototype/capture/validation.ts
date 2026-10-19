import {
  freezeDesignValue,
  parseDesign,
  projectDesignToConfig,
  type DesignEnvelope,
} from '../../../domain/design'
import { createSceneDesignFixtures } from '../../../domain/designFixtures'
import { designIdentity } from '../../../domain/designIdentity'
import { resolveCamera } from '../../../domain/presentation'
import { galleryCamera } from '../../gallery'

/** Independent review oracle, not a product catalog, capture dispatcher or renderer receipt. */
export const VALIDATION_SELECTIONS = freezeDesignValue([
  {
    fixtureId: 'studio-20-baseline',
    candidateId: 'studio-20-baseline',
    sampleId: 'studio-20-front-left-wide',
    role: 'family-size-baseline',
    view: 'front-left',
    aspect: 'wide',
  },
  {
    fixtureId: 'studio-40-baseline',
    candidateId: 'studio-40-baseline',
    sampleId: 'studio-40-entry-tall',
    role: 'family-size-baseline',
    view: 'entry',
    aspect: 'tall',
  },
  {
    fixtureId: 'container-20-baseline',
    candidateId: 'container-20-baseline',
    sampleId: 'container-20-front-left-wide',
    role: 'family-size-baseline',
    view: 'front-left',
    aspect: 'wide',
  },
  {
    fixtureId: 'container-40-baseline',
    candidateId: 'container-40-baseline',
    sampleId: 'container-40-front-left-tall',
    role: 'family-size-baseline',
    view: 'front-left',
    aspect: 'tall',
  },
  {
    fixtureId: 'studio-40-night-mirror-glass-interior',
    candidateId: 'studio-40-additions-mirror',
    sampleId: 'studio-40-night-centre-wide',
    role: 'difficult-interior',
    view: 'centre',
    aspect: 'wide',
  },
  {
    fixtureId: 'container-40-roof-stairs-overhead-opening',
    candidateId: 'container-40-overhead-night',
    sampleId: 'container-40-roof-top-wide',
    role: 'structural-stress',
    view: 'top',
    aspect: 'wide',
  },
] as const)

/** Match authority by stable ID, independently of the capture contract's positional selection. */
export function createValidationFixtures() {
  const candidates = createSceneDesignFixtures()
  return freezeDesignValue(
    VALIDATION_SELECTIONS.map((selection) => {
      const matches = candidates.filter((candidate) => candidate.id === selection.candidateId)
      if (matches.length !== 1) throw new Error('Expected one authoritative fixture candidate.')
      let design = matches[0].design
      if (selection.role === 'difficult-interior')
        design = parseDesign({
          ...design,
          config: { ...design.config, structure: { ...design.config.structure, addons: [] } },
          presentation: { ...design.presentation, cameraRef: 'centre-draft@1' },
        })
      if (selection.role === 'structural-stress')
        design = parseDesign({
          ...design,
          presentation: {
            ...design.presentation,
            lookRef: 'courtyard-day-draft@1',
            cameraRef: 'top-draft@1',
          },
        })
      return { ...selection, design }
    }),
  )
}

/** Independent gallery calculation, not an observation of a mounted browser camera. */
export function validationCamera(design: DesignEnvelope) {
  return freezeDesignValue({
    ...galleryCamera(
      projectDesignToConfig(design),
      resolveCamera(design.presentation.cameraRef).previewAngle,
      design.presentation.aspect,
    ),
    up: [0, 1, 0] as const,
    near: 0.1,
    far: 2000,
    units: 'feet',
  })
}

/**
 * Section 6's 28 logical cases only. No source/geometry/artifact hash is invented here.
 * These are not the CPU manifest's source-bound compositionDigest or dispatch permission.
 */
export async function createG1CompositionIdentityAudit() {
  const compositions = createValidationFixtures().flatMap((fixture) => {
    const views = [
      'front-left',
      'entry',
      ...(fixture.role === 'difficult-interior'
        ? ['centre']
        : fixture.role === 'structural-stress'
          ? ['top']
          : []),
    ]
    return views.flatMap((view) =>
      (['wide', 'tall'] as const).map((aspect) => {
        const design = parseDesign({
          ...fixture.design,
          presentation: { ...fixture.design.presentation, cameraRef: `${view}-draft@1`, aspect },
        })
        return {
          id: `${fixture.fixtureId}--${view}--${aspect}`,
          fixtureId: fixture.fixtureId,
          view,
          aspect,
          design,
          camera: validationCamera(design),
          approval: false as const,
          productionAllowed: false as const,
          paidExecutionAllowed: false as const,
          artifactDigest: null,
        }
      }),
    )
  })
  return freezeDesignValue(
    await Promise.all(
      compositions.map(async (composition) => ({
        ...composition,
        logicalIdentity: await designIdentity(composition.design),
      })),
    ),
  )
}
