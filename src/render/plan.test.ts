import { describe, expect, it } from 'vitest'
import { GALLERY_ANGLES, galleryAngle, type AngleId } from './gallery'
import {
  MAX_PRIORITY,
  PREFETCH_MAX,
  PREFETCH_PRIORITY,
  aroundOrder,
  planStills,
  type PlanInput,
  type PlannedJob,
  type Tier,
} from './plan'

const ANGLES = GALLERY_ANGLES.map((a) => a.id)
const group = (angle: AngleId) => galleryAngle(angle).group
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  angles: ANGLES,
  current: 'front-left',
  has: () => false,
  stored: () => false,
  idle: true,
  exportWanted: false,
  ...over,
})
const names = (jobs: PlannedJob[]) => jobs.map((job) => `${job.angle} ${job.tier}`)
/** Stored (and so had) at these tiers, by angle. */
const storedAt =
  (stored: Partial<Record<AngleId, Tier>>) =>
  (angle: AngleId, tier: Tier): boolean => {
    const at = stored[angle]
    const rank = { thumb: 0, still: 1, export: 2 }
    return at !== undefined && rank[at] >= rank[tier]
  }

describe('the still plan', () => {
  it("asks for the stage's still first, alone, on its own channel", () => {
    const jobs = planStills(input(), group)
    expect(jobs).toEqual([{ angle: 'front-left', tier: 'still', priority: 0, focus: true }])
  })

  it('then thumbnails of the other angles, nearest first, and their stills once the visitor rests', () => {
    const has = storedAt({ 'front-left': 'still' })
    const busy = planStills(input({ has, stored: has, idle: false }), group)
    expect(names(busy)).toEqual([
      'front thumb',
      'left thumb',
      'rear-left thumb',
      'rear thumb',
      'top thumb',
      'entry thumb',
      'centre thumb',
      'back thumb',
    ])
    expect(busy.map((job) => job.priority)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
    expect(busy.every((job) => !job.focus)).toBe(true)
    const resting = planStills(input({ has, stored: has }), group)
    expect(names(resting.slice(8))).toEqual(
      ['front', 'left', 'rear-left', 'rear', 'top', 'entry', 'centre', 'back'].map(
        (angle) => `${angle} still`,
      ),
    )
    expect(resting.slice(8).map((job) => job.priority)).toEqual([12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('leaves out what is stored or in flight, at that tier or a better one', () => {
    const stored = storedAt({ 'front-left': 'still', left: 'still', rear: 'thumb' })
    const flying = (angle: AngleId, tier: Tier) => angle === 'top' && tier === 'thumb'
    const jobs = planStills(
      input({ stored, has: (angle, tier) => stored(angle, tier) || flying(angle, tier) }),
      group,
    )
    expect(names(jobs)).not.toContain('front-left still')
    expect(names(jobs)).not.toContain('left thumb')
    expect(names(jobs)).not.toContain('left still')
    expect(names(jobs)).not.toContain('rear thumb')
    expect(names(jobs)).toContain('rear still')
    expect(names(jobs)).not.toContain('top thumb')
  })

  it('waits for the stage still to land, not just to be asked for', () => {
    const flying = (angle: AngleId, tier: Tier) => angle === 'front-left' && tier === 'still'
    expect(planStills(input({ has: flying }), group)).toEqual([])
  })

  it('puts an export the visitor waits for ahead of everything', () => {
    const jobs = planStills(input({ exportWanted: true }), group)
    expect(jobs).toEqual([
      { angle: 'front-left', tier: 'export', priority: 0, focus: true },
      { angle: 'front-left', tier: 'still', priority: 1, focus: true },
    ])
    // An export stored is a still too.
    const has = storedAt({ 'front-left': 'export' })
    const after = planStills(input({ exportWanted: true, has, stored: has }), group)
    expect(names(after)[0]).toBe('front thumb')
  })

  it('works outward from an angle inside, the room before the outside', () => {
    expect(aroundOrder(ANGLES, 'centre', group)).toEqual([
      'back',
      'entry',
      'front-left',
      'front',
      'left',
      'rear-left',
      'rear',
      'top',
    ])
    expect(aroundOrder(ANGLES, 'rear', group).slice(0, 5)).toEqual([
      'top',
      'rear-left',
      'left',
      'front',
      'front-left',
    ])
  })

  it('never asks below the server’s lowest priority', () => {
    const many = Array.from({ length: 40 }, (_, i) => `a${i}` as AngleId)
    const has = (angle: AngleId) => angle === many[0]
    const jobs = planStills(input({ angles: many, current: many[0], has, stored: has }), () => 'x')
    expect(Math.max(...jobs.map((job) => job.priority))).toBe(MAX_PRIORITY)
  })

  describe('with a panel section open', () => {
    const siblings = ['graphite', 'espresso', 'bronze']
    const prefetch = (over: Partial<NonNullable<PlanInput['prefetch']>> = {}) => ({
      designs: siblings,
      has: () => false,
      room: PREFETCH_MAX,
      ...over,
    })
    const named = (jobs: PlannedJob[]) =>
      jobs.map((job) => (job.sibling ? `${job.sibling} ${job.angle}` : `${job.angle} ${job.tier}`))

    it("renders the siblings' stills at the current angle after the filmstrip, then the other angles' stills", () => {
      const has = storedAt({
        'front-left': 'still',
        front: 'thumb',
        left: 'thumb',
        'rear-left': 'thumb',
        rear: 'thumb',
        top: 'thumb',
        entry: 'thumb',
        centre: 'thumb',
        back: 'thumb',
      })
      const jobs = planStills(input({ has, stored: has, prefetch: prefetch() }), group)
      // The other angles' stills wait for the siblings: none is queued between two of them.
      expect(named(jobs)).toEqual([
        'graphite front-left',
        'espresso front-left',
        'bronze front-left',
      ])
      const done = planStills(
        input({ has, stored: has, prefetch: prefetch({ has: () => true }) }),
        group,
      )
      expect(names(done)[0]).toBe('front still')
      const prefetched = jobs.filter((job) => job.sibling)
      // Low priority: after every thumbnail (2 to 9), ahead of the other angles' stills (12 on).
      expect(prefetched.every((job) => job.priority === PREFETCH_PRIORITY)).toBe(true)
      expect(PREFETCH_PRIORITY).toBeGreaterThan(9)
      expect(PREFETCH_PRIORITY).toBeLessThan(12)
      expect(prefetched.every((job) => job.tier === 'still' && !job.focus)).toBe(true)
    })

    it("holds the other angles' stills back until the siblings are done", () => {
      const stage = storedAt({ 'front-left': 'still' })
      const flying = (angle: AngleId, tier: Tier) => stage(angle, tier) || tier === 'thumb'
      // Thumbnails on their way: the siblings come next, not the other angles' stills.
      const jobs = planStills(input({ has: flying, stored: stage, prefetch: prefetch() }), group)
      expect(jobs).toEqual([])
      expect(names(planStills(input({ has: flying, stored: stage }), group))).toContain(
        'front still',
      )
    })

    it('holds nothing back for siblings whose scans are still downloading', () => {
      const all = storedAt(
        Object.fromEntries(
          ANGLES.map((angle) => [angle, angle === 'front-left' ? 'still' : 'thumb']),
        ),
      )
      const plan = (waiting: (design: string) => boolean) =>
        named(planStills(input({ has: all, stored: all, prefetch: prefetch({ waiting }) }), group))
      // One sibling about to go to the GPU: the other angles' stills wait for it.
      expect(plan((design) => design !== 'bronze')).toEqual([
        'graphite front-left',
        'espresso front-left',
        'bronze front-left',
      ])
      // Every sibling left is downloading its scans (which may never come): the stills go, and the
      // siblings stay planned, so each is looked at again.
      const jobs = plan(() => true)
      expect(jobs.slice(0, 3)).toEqual([
        'graphite front-left',
        'espresso front-left',
        'bronze front-left',
      ])
      expect(jobs.slice(3, 5)).toEqual(['front still', 'left still'])
    })

    it('waits for the stage still and for every thumbnail to land, not just to be asked for', () => {
      expect(planStills(input({ prefetch: prefetch() }), group).some((job) => job.sibling)).toBe(
        false,
      )
      const stage = storedAt({ 'front-left': 'still', front: 'thumb' })
      const flying = (angle: AngleId, tier: Tier) => stage(angle, tier) || tier === 'thumb'
      const jobs = planStills(input({ has: flying, stored: stage, prefetch: prefetch() }), group)
      expect(jobs.some((job) => job.sibling)).toBe(false)
    })

    it('leaves out the siblings stored, on their way, or not to be prefetched, and keeps to its room', () => {
      const all = storedAt(
        Object.fromEntries(
          ANGLES.map((angle) => [angle, angle === 'front-left' ? 'still' : 'thumb']),
        ),
      )
      const plan = (over: Partial<NonNullable<PlanInput['prefetch']>>) =>
        planStills(input({ has: all, stored: all, idle: false, prefetch: prefetch(over) }), group)
          .filter((job) => job.sibling)
          .map((job) => job.sibling)
      expect(plan({ has: (design) => design === 'espresso' })).toEqual(['graphite', 'bronze'])
      // At most PREFETCH_MAX in flight or planned: with seven out, one more.
      expect(plan({ room: 1 })).toEqual(['graphite'])
      expect(plan({ room: 0 })).toEqual([])
      const many = Array.from({ length: 12 }, (_, i) => `d${i}`)
      expect(plan({ designs: many })).toHaveLength(PREFETCH_MAX)
    })
  })
})
