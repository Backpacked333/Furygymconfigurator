import { describe, expect, it } from 'vitest'
import { GALLERY_ANGLES, galleryAngle, type AngleId } from './gallery'
import {
  MAX_PRIORITY,
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
})
