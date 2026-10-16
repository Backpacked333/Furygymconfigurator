import { describe, expect, it } from 'vitest'
import {
  ADMISSION_STEPS,
  IDLE_MS,
  MAX_PRIORITY,
  planJobs,
  type FrameRef,
  type PlanInput,
  type PlannedJob,
  type Tier,
} from './plan'

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  active: 'exterior',
  focus: { level: 1, azimuth: 5 },
  drift: 0,
  steps: 36,
  levels: 2,
  has: () => false,
  stored: () => false,
  idle: true,
  settled: true,
  exportWanted: false,
  ...over,
})
const name = (job: PlannedJob) =>
  `${job.ref.kind === 'interior' ? 'panorama' : `${job.ref.level}/${job.ref.azimuth}`} ${job.tier}`
const names = (jobs: PlannedJob[]) => jobs.map(name)
/** The previews of the ring the visitor is on, outward from azimuth 5, at rest. */
const outward = [
  6, 4, 7, 3, 8, 2, 9, 1, 10, 0, 11, 35, 12, 34, 13, 33, 14, 32, 15, 31, 16, 30, 17, 29, 18, 28, 19,
  27, 20, 26, 21, 25, 22, 24, 23,
]
/** The same ring while turning one way or the other: the side ahead leads by a step. */
const turning = {
  1: [
    6, 7, 4, 8, 3, 9, 2, 10, 1, 11, 0, 12, 35, 13, 34, 14, 33, 15, 32, 16, 31, 17, 30, 18, 29, 19,
    28, 20, 27, 21, 26, 22, 25, 23, 24,
  ],
  [-1]: [
    4, 3, 6, 2, 7, 1, 8, 0, 9, 35, 10, 34, 11, 33, 12, 32, 13, 31, 14, 30, 15, 29, 16, 28, 17, 27,
    18, 26, 19, 25, 20, 24, 21, 23, 22,
  ],
}
/** How many steps round an azimuth is from the visitor's (5): each preview's priority. */
const distance = (azimuth: number) => Math.min(Math.abs(azimuth - 5), 36 - Math.abs(azimuth - 5))
/** Previews within three steps of azimuth 5 on level 1, as a `stored` answer. */
const nearStored =
  (except: number[] = []) =>
  (ref: FrameRef, tier: Tier) =>
    ref.kind === 'exterior' &&
    ref.level === 1 &&
    tier === 'preview' &&
    Math.abs(ref.azimuth - 5) <= ADMISSION_STEPS &&
    !except.includes(ref.azimuth)

describe('the plan', () => {
  it("covers the visitor's ring first, outward from their frame, before anything longer", () => {
    const jobs = planJobs(input())
    expect(jobs[0]).toEqual({
      ref: { kind: 'exterior', level: 1, azimuth: 5 },
      tier: 'preview',
      priority: 0,
      focus: true,
    })
    expect(names(jobs.slice(1, 36))).toEqual(outward.map((a) => `1/${a} preview`))
    // Each angle's priority is its distance from the visitor's.
    expect(jobs.slice(1, 36).map((j) => j.priority)).toEqual(outward.map(distance))
    // Then the panorama, the other distance nearest first, and the panorama at good quality.
    expect(name(jobs[36])).toBe('panorama preview')
    expect(jobs[36].priority).toBe(5)
    expect(names(jobs.slice(37, 73))).toEqual([5, ...outward].map((a) => `0/${a} preview`))
    expect(jobs.slice(37, 73).map((j) => j.priority)).toEqual([
      8,
      ...jobs.slice(1, 36).map((j) => j.priority + 8),
    ])
    expect(jobs[73]).toMatchObject({ ref: { kind: 'interior' }, tier: 'good', priority: 19 })
    // No frame at good quality while the previews around the visitor are missing.
    expect(jobs).toHaveLength(74)
    expect(jobs.filter((j) => j.focus)).toHaveLength(1)
  })

  it('leads with the side the visitor is turning to, by one step', () => {
    for (const drift of [1, -1] as const) {
      const ring = turning[drift]
      const jobs = planJobs(input({ drift }))
      expect(name(jobs[0])).toBe('1/5 preview')
      // The whole ring, every angle once, the one past the half-way angle last; priorities are
      // still each angle's distance from the visitor's.
      expect(names(jobs.slice(1, 36))).toEqual(ring.map((a) => `1/${a} preview`))
      expect(jobs.slice(1, 36).map((j) => j.priority)).toEqual(ring.map(distance))
      expect(jobs[36]).toMatchObject({ ref: { kind: 'interior' }, tier: 'preview', priority: 5 })
      // The other distance follows the same way round.
      expect(names(jobs.slice(37, 73))).toEqual([5, ...ring].map((a) => `0/${a} preview`))
      expect(jobs.slice(37, 73).map((j) => j.priority)).toEqual([
        8,
        ...ring.map((a) => 8 + distance(a)),
      ])
      expect(jobs[73]).toMatchObject({ ref: { kind: 'interior' }, tier: 'good', priority: 19 })
      expect(jobs).toHaveLength(74)
    }
  })

  it('asks only for what the visitor looks at while they edit, or before the textures', () => {
    expect(names(planJobs(input({ idle: false })))).toEqual(['1/5 preview', 'panorama preview'])
    expect(names(planJobs(input({ settled: false })))).toEqual(['1/5 preview', 'panorama preview'])
    expect(IDLE_MS).toBe(3000)
  })

  it('admits a good frame only once every preview within three steps is finished', () => {
    // One of them missing: nothing at good quality.
    expect(names(planJobs(input({ stored: nearStored([3]) })))).not.toContain('1/5 good')
    // In flight (so not asked for again, but not finished either): still nothing.
    const flying = nearStored()
    const inFlight = planJobs(input({ has: flying, stored: nearStored([3]) }))
    expect(names(inFlight)).not.toContain('1/3 preview')
    expect(names(inFlight)).not.toContain('1/5 good')
    // All there: the visitor's frame at good quality after the previews, before the panorama,
    // and the neighbours at good quality last.
    const jobs = planJobs(input({ has: flying, stored: flying }))
    const list = names(jobs)
    expect(list.indexOf('1/5 good')).toBe(list.indexOf('panorama preview') - 1)
    expect(jobs[list.indexOf('1/5 good')].priority).toBe(4)
    expect(list.slice(-6)).toEqual([6, 4, 7, 3, 8, 2].map((a) => `1/${a} good`))
    expect(jobs.slice(-6).map((j) => j.priority)).toEqual([21, 21, 22, 22, 23, 23])
    expect(list.indexOf('panorama good')).toBeLessThan(list.indexOf('1/6 good'))
  })

  it('puts the full render first for an export, whatever else waits', () => {
    const jobs = planJobs(input({ exportWanted: true }))
    expect(jobs[0]).toEqual({
      ref: { kind: 'exterior', level: 1, azimuth: 5 },
      tier: 'final',
      priority: 0,
      focus: true,
    })
    // Even while the visitor edits, and with no preview around.
    expect(names(planJobs(input({ exportWanted: true, idle: false })))).toEqual([
      '1/5 final',
      '1/5 preview',
      'panorama preview',
    ])
    // Inside, the panorama's.
    expect(names(planJobs(input({ exportWanted: true, active: 'interior' })).slice(0, 2))).toEqual([
      'panorama final',
      'panorama preview',
    ])
  })

  it('leads with the panorama inside, the exterior following two priorities down', () => {
    const jobs = planJobs(input({ active: 'interior' }))
    expect(jobs.slice(0, 3)).toEqual([
      { ref: { kind: 'interior' }, tier: 'preview', priority: 0, focus: true },
      { ref: { kind: 'interior' }, tier: 'good', priority: 1, focus: false },
      {
        ref: { kind: 'exterior', level: 1, azimuth: 5 },
        tier: 'preview',
        priority: 2,
        focus: false,
      },
    ])
    expect(jobs.slice(3, 38).map((j) => j.priority)).toEqual(
      planJobs(input())
        .slice(1, 36)
        .map((j) => j.priority + 2),
    )
    // The panorama is listed once, and nothing else goes out on the visitor's channel.
    expect(names(jobs).filter((n) => n === 'panorama preview')).toHaveLength(1)
    expect(names(jobs).filter((n) => n === 'panorama good')).toHaveLength(1)
    expect(jobs.filter((j) => j.focus)).toHaveLength(1)
    // The exterior's good frame is admitted the same way.
    expect(names(jobs)).not.toContain('1/5 good')
    const admitted = planJobs(input({ active: 'interior', stored: nearStored() }))
    expect(admitted.find((j) => name(j) === '1/5 good')?.priority).toBe(6)
  })

  it("keeps priorities within the server's range", () => {
    const jobs = planJobs(input({ steps: 72 }))
    expect(Math.max(...jobs.map((j) => j.priority))).toBe(MAX_PRIORITY)
    expect(jobs.every((j) => j.priority >= 0 && j.priority <= 31)).toBe(true)
  })

  it('leaves out frames that are stored or in flight', () => {
    const has = (ref: FrameRef) => ref.kind === 'exterior' && ref.azimuth === 6
    const list = names(planJobs(input({ has })))
    expect(list).not.toContain('1/6 preview')
    expect(list).not.toContain('0/6 preview')
    expect(list).toContain('1/4 preview')
  })

  it('asks for the panorama alone until the exterior is framed', () => {
    const jobs = planJobs(input({ focus: null }))
    expect(names(jobs)).toEqual(['panorama preview'])
    expect(jobs[0]).toMatchObject({ priority: 5, focus: false })
  })
})
