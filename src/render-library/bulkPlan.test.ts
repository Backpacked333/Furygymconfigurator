// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultDesign } from '../domain/design'
import { computeSetIdentity } from './identity'
import { planBulkRenders } from './bulkPlan'

describe('unique-view bulk planning (no providers)', () => {
  const base = defaultDesign()
  const room = {
    ...base,
    config: {
      ...base.config,
      appearance: { ...base.config.appearance, floor: 'oak', interior: 'timber', mirror: true },
    },
  }

  it('counts nine new images, not ten, and records the shared rear dependency', async () => {
    const plan = await planBulkRenders([base, room, room], [])
    expect(plan.summary).toMatchObject({
      jobs: 2,
      uniqueMissingImages: 9,
      sharedPlannedReferences: 1,
    })
    expect(plan.jobs[1].newImageKeys).toHaveLength(4)
    expect(plan.jobs[1].dependsOnSets).toEqual([plan.jobs[0].identity.setKey])
    expect(plan.skipped).toEqual([{ inputIndex: 2, reason: 'duplicate-set' }])
  })

  it('spends no extra job when all views are saved or already planned', async () => {
    const identity = await computeSetIdentity(base)
    const saved = await planBulkRenders([base], Object.values(identity.imageKeys))
    expect(saved.summary.uniqueMissingImages).toBe(0)
    expect(saved.jobs).toHaveLength(0)
    const unusedRail = {
      ...base,
      config: { ...base.config, structure: { ...base.config.structure, railing: 'cable' } },
    }
    const covered = await planBulkRenders([base, unusedRail], [])
    expect(covered.jobs).toHaveLength(1)
    expect(covered.skipped[0].reason).toBe('covered-by-planned-views')
  })

  it('preserves actual keys, scene priority and the outdoor non-reuse boundary', async () => {
    const night = {
      ...room,
      presentation: { ...room.presentation, lookRef: 'courtyard-night-draft@1' },
    }
    const day = {
      ...room,
      presentation: { ...room.presentation, lookRef: 'courtyard-day-draft@1' },
    }
    const campus = {
      ...room,
      presentation: { ...room.presentation, lookRef: 'campus-day-draft@1' },
    }
    const saved = (await computeSetIdentity(base)).imageKeys['rear-left-draft@1']
    const plan = await planBulkRenders([night, campus, day, room], [saved])
    expect(plan.jobs.map((j) => j.inputIndex)).toEqual([3, 2, 0])
    expect(plan.jobs.map((j) => j.newImageKeys.length)).toEqual([4, 5, 5])
    expect(plan.skipped).toEqual([{ inputIndex: 1, reason: 'outside-priority-scenes' }])
    expect(plan.jobs[0].missingImageKeys).not.toContain(saved)
  })

  it('fails closed on invalid inputs instead of inventing a substitute scene', async () => {
    await expect(planBulkRenders([base], ['not-an-image-key'])).rejects.toThrow()
    await expect(
      planBulkRenders(
        [{ ...base, presentation: { ...base.presentation, lookRef: 'backyard-day-draft@1' } }],
        [],
      ),
    ).rejects.toThrow()
  })
})
