import { customerDesignSchema, type SetIdentity } from './contracts'
import { computeSetIdentity } from './identity'
import { CUSTOMER_CAMERA_REFS, VIEW_KEYING } from './views'

const priority = ['studio-day-draft@1', 'courtyard-day-draft@1', 'courtyard-night-draft@1'] as const

/** Read-only plan. Recheck API identities and coverage immediately before each admission. */
export async function planBulkRenders(
  inputs: readonly unknown[],
  savedImageKeys: readonly string[],
) {
  if (savedImageKeys.some((key) => !/^img_[a-f0-9]{64}$/.test(key)))
    throw new Error('Invalid saved image key.')
  const saved = new Set(savedImageKeys)
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
    missingBeforeCrossSetReuse += missingImageKeys.length
    const newImageKeys = missingImageKeys.filter((key) => !owned.has(key))
    if (newImageKeys.length === 0) {
      skipped.push({
        inputIndex,
        reason: missingImageKeys.length ? 'covered-by-planned-views' : 'already-saved',
      })
      continue
    }
    const dependsOnSets = [
      ...new Set(
        missingImageKeys.flatMap((key) => {
          const owner = owned.get(key)
          return owner ? [owner] : []
        }),
      ),
    ]
    newImageKeys.forEach((key) => owned.set(key, identity.setKey))
    jobs.push({ inputIndex, design, identity, missingImageKeys, newImageKeys, dependsOnSets })
  }
  return {
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
    },
  }
}
