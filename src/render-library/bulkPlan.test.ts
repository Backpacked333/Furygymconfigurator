// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultDesign, parseDesign } from '../domain/design'
import { computeSetIdentity } from './identity'
import { planBulkRenders } from './bulkPlan'
import { CUSTOMER_CAMERA_REFS, viewDesign } from './views'

describe('unique-view bulk planning (no providers)', () => {
  const base = defaultDesign()
  const room = {
    ...base,
    config: {
      ...base.config,
      appearance: { ...base.config.appearance, floor: 'oak', interior: 'timber', mirror: true },
    },
  }

  it('defers the room-only grid instead of paying for nearly identical exterior sets', async () => {
    const plan = await planBulkRenders([base, room, room], [], [])
    expect(plan.summary).toMatchObject({
      jobs: 1,
      uniqueMissingImages: 5,
      sharedPlannedReferences: 0,
      deferredMissingImages: 3,
    })
    expect(plan.skipped).toEqual([
      { inputIndex: 1, reason: 'deferred-room-only-exterior-variant' },
      { inputIndex: 2, reason: 'duplicate-set' },
    ])
  })

  const savedViews = async (input: unknown) => {
    const design = parseDesign(input)
    const identity = await computeSetIdentity(design)
    return CUSTOMER_CAMERA_REFS.map((camera) => ({
      imageKey: identity.imageKeys[camera],
      recipeRelease: identity.recipeRelease,
      design: viewDesign(design, camera),
    }))
  }

  it('consults published coverage from earlier batches, not only this plan', async () => {
    const images = await savedViews(base)
    const plan = await planBulkRenders(
      [room],
      images.map((i) => i.imageKey),
      images,
    )
    expect(plan.jobs).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe('deferred-room-only-exterior-variant')
    // Deferral is not an image alias or a claim that the requested room is already saved.
    expect(plan.summary.deferredMissingImages).toBeGreaterThan(0)
    expect((await computeSetIdentity(room)).imageKeys['front-draft@1']).not.toBe(
      (await computeSetIdentity(base)).imageKeys['front-draft@1'],
    )
  })

  it('allows an interior-only job when no new exterior image will be rendered', async () => {
    const baseline = await savedViews(base)
    const roomExteriors = (await savedViews(room)).filter(
      (image) => image.design.presentation.cameraRef !== 'entry-draft@1',
    )
    const images = [...baseline, ...roomExteriors]
    const plan = await planBulkRenders(
      [room],
      images.map((i) => i.imageKey),
      baseline,
    )
    expect(plan.jobs).toHaveLength(1)
    expect(plan.jobs[0].newImageKeys).toEqual([
      (await computeSetIdentity(room)).imageKeys['entry-draft@1'],
    ])
  })

  it('finishes a partially saved representative without multiplying room variants', async () => {
    const images = (await savedViews(base)).filter(
      (image) => image.design.presentation.cameraRef === 'front-left-draft@1',
    )
    const plan = await planBulkRenders(
      [base, room],
      images.map((i) => i.imageKey),
      images,
    )
    expect(plan.jobs).toHaveLength(1)
    expect(plan.jobs[0].newImageKeys).toHaveLength(4)
    expect(plan.skipped[0].reason).toBe('deferred-room-only-exterior-variant')
  })

  it('keeps new finish, structure, size, pose, aspect and environment coverage', async () => {
    const images = await savedViews(base)
    const variants = [
      {
        ...room,
        config: { ...room.config, appearance: { ...room.config.appearance, finish: 'chalk' } },
      },
      {
        ...room,
        config: { ...room.config, structure: { ...room.config.structure, addons: ['deck'] } },
      },
      defaultDesign({ family: 'studio', lengthFt: 40 }),
      { ...room, presentation: { ...room.presentation, doorPose: 'open' } },
      { ...room, presentation: { ...room.presentation, aspect: 'tall' } },
      { ...room, presentation: { ...room.presentation, lookRef: 'courtyard-day-draft@1' } },
    ]
    const plan = await planBulkRenders(
      variants,
      images.map((i) => i.imageKey),
      images,
    )
    expect(plan.jobs).toHaveLength(variants.length)
    expect(plan.skipped).toEqual([])
  })

  it('rejects coverage entries that are only planned, not saved', async () => {
    await expect(planBulkRenders([room], [], await savedViews(base))).rejects.toThrow(
      'Coverage image is not actually saved',
    )
  })

  it('spends no extra job when all views are saved or already planned', async () => {
    const identity = await computeSetIdentity(base)
    const saved = await planBulkRenders([base], Object.values(identity.imageKeys), [])
    expect(saved.summary.uniqueMissingImages).toBe(0)
    expect(saved.jobs).toHaveLength(0)
    const unusedRail = {
      ...base,
      config: { ...base.config, structure: { ...base.config.structure, railing: 'cable' } },
    }
    const covered = await planBulkRenders([base, unusedRail], [], [])
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
    const plan = await planBulkRenders([night, campus, day, room], [saved], [])
    expect(plan.jobs.map((j) => j.inputIndex)).toEqual([3, 2, 0])
    expect(plan.jobs.map((j) => j.newImageKeys.length)).toEqual([4, 5, 5])
    expect(plan.skipped).toEqual([{ inputIndex: 1, reason: 'outside-priority-scenes' }])
    expect(plan.jobs[0].missingImageKeys).not.toContain(saved)
  })

  it('fails closed on invalid inputs instead of inventing a substitute scene', async () => {
    await expect(planBulkRenders([base], ['not-an-image-key'], [])).rejects.toThrow()
    await expect(
      planBulkRenders(
        [{ ...base, presentation: { ...base.presentation, lookRef: 'backyard-day-draft@1' } }],
        [],
        [],
      ),
    ).rejects.toThrow()
  })
})
