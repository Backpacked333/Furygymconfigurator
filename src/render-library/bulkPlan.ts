import { parseDesign, type DesignEnvelope } from '../domain/design'
import {
  customerDesignSchema,
  imageKeySchema,
  recipeForDesign,
  recipeReleaseSchema,
  type ImageDescriptor,
  type SetIdentity,
} from './contracts'
import { canonicalJson, computeSetIdentity } from './identity'
import { CUSTOMER_CAMERA_REFS, VIEW_KEYING } from './views'

const priority = ['studio-day-draft@1', 'courtyard-day-draft@1', 'courtyard-night-draft@1'] as const
export const BULK_POLICY = 'exterior-coverage-first@1' as const

/** A scheduling category only. Never use this as an image/cache identity. */
export function bulkExteriorCoverageKey(design: DesignEnvelope): string {
  const appearance = {
    finish: design.config.appearance.finish,
    accent: design.config.appearance.accent,
  }
  const presentation = {
    aspect: design.presentation.aspect,
    lookRef: design.presentation.lookRef,
    doorPose: design.presentation.doorPose,
  }
  const structure = design.config.structure
  return canonicalJson({
    ...design,
    config: {
      ...design.config,
      appearance,
      structure: {
        ...structure,
        railing: structure.addons.some((addon) => addon === 'roof' || addon === 'stairs')
          ? structure.railing
          : 'glass',
      },
    },
    presentation,
    recipe: recipeForDesign(design),
  })
}

const roomKey = (design: DesignEnvelope) =>
  canonicalJson({
    interior: design.config.appearance.interior,
    floor: design.config.appearance.floor,
    mirror: design.config.appearance.mirror,
  })

type SavedCoverageImage = Pick<ImageDescriptor, 'imageKey' | 'recipeRelease'> & {
  design: DesignEnvelope
}

/** Read-only plan. Recheck API identities and coverage immediately before each admission. */
export async function planBulkRenders(
  inputs: readonly unknown[],
  savedImageKeys: readonly string[],
  savedImages: readonly SavedCoverageImage[],
) {
  if (!Array.isArray(savedImages)) throw new Error('Published-image coverage inventory required.')
  if (savedImageKeys.some((key) => !/^img_[a-f0-9]{64}$/.test(key)))
    throw new Error('Invalid saved image key.')
  const saved = new Set(savedImageKeys)
  const representatives = new Map<string, Set<string>>()
  const remember = (design: DesignEnvelope) => {
    const key = bulkExteriorCoverageKey(design)
    const rooms = representatives.get(key) ?? new Set<string>()
    rooms.add(roomKey(design))
    representatives.set(key, rooms)
  }
  for (const image of savedImages) {
    imageKeySchema.parse(image.imageKey)
    if (!saved.has(image.imageKey)) throw new Error('Coverage image is not actually saved.')
    const design = parseDesign(image.design)
    if (
      canonicalJson(recipeReleaseSchema.parse(image.recipeRelease)) !==
      canonicalJson(recipeForDesign(design))
    )
      throw new Error('Coverage image recipe mismatch.')
    // These cameras retain the requested room; canonical opaque views do not identify it.
    if (['front-left-draft@1', 'front-draft@1'].includes(design.presentation.cameraRef))
      remember(design)
  }
  const owned = new Map<string, string>()
  const seenSets = new Set<string>()
  const skipped: { inputIndex: number; reason: string }[] = []
  const jobs: {
    inputIndex: number
    design: ReturnType<typeof customerDesignSchema.parse>
    identity: SetIdentity
    missingImageKeys: string[]
    newImageKeys: string[]
    dependsOnSets: string[]
  }[] = []
  const candidates = inputs
    .map((input, inputIndex) => {
      const design = customerDesignSchema.parse(input)
      const rank = priority.findIndex((look) => look === design.presentation.lookRef)
      return { design, inputIndex, rank }
    })
    .sort((a, b) => a.rank - b.rank || a.inputIndex - b.inputIndex)
  let missingBeforeCrossSetReuse = 0
  const deferred = new Set<string>()
  for (const { design, inputIndex, rank } of candidates) {
    if (rank < 0) {
      skipped.push({ inputIndex, reason: 'outside-priority-scenes' })
      continue
    }
    const identity = await computeSetIdentity(design)
    if (seenSets.has(identity.setKey)) {
      skipped.push({ inputIndex, reason: 'duplicate-set' })
      continue
    }
    seenSets.add(identity.setKey)
    const missingImageKeys = CUSTOMER_CAMERA_REFS.map(
      (camera) => identity.imageKeys[camera],
    ).filter((key) => !saved.has(key))
    const newImageKeys = missingImageKeys.filter((key) => !owned.has(key))
    if (newImageKeys.length === 0) {
      skipped.push({
        inputIndex,
        reason: missingImageKeys.length ? 'covered-by-planned-views' : 'already-saved',
      })
      continue
    }
    const rooms = representatives.get(bulkExteriorCoverageKey(design))
    const spendsOnExterior = newImageKeys.some((key) => key !== identity.imageKeys['entry-draft@1'])
    if (spendsOnExterior && rooms && !rooms.has(roomKey(design))) {
      newImageKeys.forEach((key) => deferred.add(key))
      skipped.push({ inputIndex, reason: 'deferred-room-only-exterior-variant' })
      continue
    }
    missingBeforeCrossSetReuse += missingImageKeys.length
    const dependsOnSets = [
      ...new Set(
        missingImageKeys.flatMap((key) => {
          const owner = owned.get(key)
          return owner ? [owner] : []
        }),
      ),
    ]
    newImageKeys.forEach((key) => owned.set(key, identity.setKey))
    remember(design)
    jobs.push({ inputIndex, design, identity, missingImageKeys, newImageKeys, dependsOnSets })
  }
  return {
    bulkPolicy: BULK_POLICY,
    viewKeying: VIEW_KEYING,
    priority,
    jobs,
    skipped,
    summary: {
      inputBuilds: inputs.length,
      jobs: jobs.length,
      savedImageKeys: saved.size,
      uniqueMissingImages: owned.size,
      missingBeforeCrossSetReuse,
      sharedPlannedReferences: missingBeforeCrossSetReuse - owned.size,
      deferredMissingImages: [...deferred].filter((key) => !owned.has(key)).length,
    },
  }
}
