import { defaultDesign, parseDesign, type DesignEnvelope } from './design'
import { DRAFT_CAMERAS, DRAFT_LOOKS } from './presentation'

/** Four family/size fixtures are constructed from authority, never hand-maintained JSON copies. */
export function createDesignFixtures(): readonly DesignEnvelope[] {
  return Object.freeze(
    (['studio', 'container'] as const).flatMap((family) =>
      ([20, 40] as const).map((lengthFt) => defaultDesign({ family, lengthFt })),
    ),
  )
}

/** 196 wide or 392 wide+tall logical compositions. This is NOT a render submission/job list. */
export function createPresentationFixtures(includeTall = false): readonly DesignEnvelope[] {
  return Object.freeze(
    createDesignFixtures().flatMap((design) =>
      DRAFT_LOOKS.flatMap((look) =>
        DRAFT_CAMERAS.flatMap((camera) =>
          (includeTall ? (['wide', 'tall'] as const) : (['wide'] as const)).map((aspect) =>
            parseDesign({
              ...design,
              presentation: {
                ...design.presentation,
                lookRef: look.ref,
                cameraRef: camera.ref,
                aspect,
              },
            }),
          ),
        ),
      ),
    ),
  )
}

/** Six local fixture candidates for config-only scene preparation, not art/engineering approvals. */
export function createSceneDesignFixtures(): readonly Readonly<{
  id: string
  design: DesignEnvelope
}>[] {
  const base = createDesignFixtures()
  const studio = base[1]
  const container = base[3]
  return Object.freeze([
    ...base.map((design) =>
      Object.freeze({
        id: `${design.config.product.family}-${design.config.product.lengthFt}-baseline`,
        design,
      }),
    ),
    Object.freeze({
      id: 'studio-40-additions-mirror',
      design: parseDesign({
        ...studio,
        config: {
          ...studio.config,
          structure: {
            ...studio.config.structure,
            door: 'sliding',
            addons: ['deck', 'gazebo', 'roof', 'stairs'],
            railing: 'cable',
          },
          appearance: {
            ...studio.config.appearance,
            finish: 'chalk',
            accent: true,
            interior: 'slatted',
            floor: 'oak',
            mirror: true,
          },
        },
        presentation: {
          ...studio.presentation,
          lookRef: DRAFT_LOOKS[1].ref,
          cameraRef: DRAFT_CAMERAS[4].ref,
          doorPose: 'open',
        },
      }),
    }),
    Object.freeze({
      id: 'container-40-overhead-night',
      design: parseDesign({
        ...container,
        config: {
          ...container.config,
          structure: {
            ...container.config.structure,
            opening: 'full',
            infill: 'glass-overhead',
            integratedFinish: true,
            addons: ['canopy', 'deck', 'roof', 'stairs'],
            railing: 'cable',
          },
          appearance: {
            ...container.config.appearance,
            finish: 'cloud',
            interior: 'timber',
            floor: 'concrete',
            mirror: true,
          },
        },
        presentation: {
          ...container.presentation,
          lookRef: DRAFT_LOOKS[3].ref,
          cameraRef: DRAFT_CAMERAS[5].ref,
          doorPose: 'open',
        },
      }),
    }),
  ])
}
