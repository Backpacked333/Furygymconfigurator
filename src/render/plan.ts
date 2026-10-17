import type { AngleId } from './gallery'

/**
 * The gallery's plan: which stills to render next, most wanted first. A pure function of what the
 * visitor looks at and what is there already, so StillSession can rebuild it only when one of
 * those changes, and the order can be tested on its own.
 *
 * What the stage shows comes first: the current angle's still (or its export, when a download
 * waits for it). Once that is in, every other angle gets a quick thumbnail for the filmstrip.
 * Once those are in too, and while a panel section is open, the current angle's still of each of
 * the section's siblings (the design with one option changed: prefetch.ts) is rendered ahead, so a
 * click on one finds it ready; the section open says the visitor's next click is an option there,
 * so these come before the other angles' stills, which wait for them. Those follow once the
 * visitor rests on the design, so clicking through the angles finds them ready too.
 */

/**
 * A still's quality: a thumbnail for the filmstrip, the still the stage shows, or the export a
 * download or a PDF takes.
 */
export type Tier = 'thumb' | 'still' | 'export'
export const TIER_RANK: Record<Tier, number> = { thumb: 0, still: 1, export: 2 }

export type PlanInput = {
  /** Every angle, in filmstrip order. */
  angles: readonly AngleId[]
  /** The angle on the stage. */
  current: AngleId
  /** Stored at this tier (or a better one) or in flight: not asked for again. */
  has: (angle: AngleId, tier: Tier) => boolean
  /** Stored at this tier or a better one, so finished. */
  stored: (angle: AngleId, tier: Tier) => boolean
  /** The design unchanged for IDLE_MS and the floor plan closed: the longer renders may start. */
  idle: boolean
  /** A download or a PDF waits for the current angle's export. */
  exportWanted: boolean
  /**
   * Sibling designs to prefetch the current angle's still of, most wanted first, when the session
   * allows prefetch now: `has` says one is stored or on its way (or cannot be prefetched),
   * `waiting` that one is still to come but holds nothing back (its scans are downloading, or the
   * scene could not be read for it yet), `room` how many more may be asked for.
   */
  prefetch?: {
    designs: readonly string[]
    has: (design: string) => boolean
    waiting?: (design: string) => boolean
    room: number
  }
}

export type PlannedJob = {
  angle: AngleId
  tier: Tier
  /** Sent to the server, 0 first; it orders its queue by it. */
  priority: number
  /** What the stage waits for: asked for at once, on a channel of its own. */
  focus: boolean
  /** A sibling design's still, prefetched at the current angle: the design (stillKey.ts configKey). */
  sibling?: string
}

/** How long the design must hold still before the other angles' stills are rendered. */
export const IDLE_MS = 3000
/** The server's lowest priority (render-server/fury_render/protocol.py). */
export const MAX_PRIORITY = 31
/** Where the thumbnails' and the other stills' priorities start, nearest angle first. */
const THUMBS_FROM = 2
const STILLS_FROM = 12
/**
 * The prefetch's priority: after every thumbnail, ahead of the other angles' stills. One is in
 * flight at a time (stills.ts), so they need no order among themselves on the server.
 */
export const PREFETCH_PRIORITY = 11
/** Prefetched stills in flight or planned at most. */
export const PREFETCH_MAX = 8

/**
 * The other angles, nearest the current one first: those of its own group (outside or inside)
 * by their distance along the filmstrip, the next one before the one behind; then the other
 * group in filmstrip order.
 */
export function aroundOrder(
  angles: readonly AngleId[],
  current: AngleId,
  group: (angle: AngleId) => string,
): AngleId[] {
  const at = angles.indexOf(current)
  const own = group(current)
  const near: { angle: AngleId; d: number; after: boolean }[] = []
  const far: AngleId[] = []
  angles.forEach((angle, i) => {
    if (angle === current) return
    if (group(angle) === own) near.push({ angle, d: Math.abs(i - at), after: i > at })
    else far.push(angle)
  })
  near.sort((a, b) => a.d - b.d || Number(b.after) - Number(a.after))
  return [...near.map((n) => n.angle), ...far]
}

/** The stills still to render, most wanted first. Stills the input `has` are left out. */
export function planStills(
  input: PlanInput,
  group: (angle: AngleId) => string = () => '',
): PlannedJob[] {
  const jobs: PlannedJob[] = []
  const add = (angle: AngleId, tier: Tier, priority: number, focus = false) => {
    if (input.has(angle, tier)) return
    jobs.push({ angle, tier, priority: Math.min(MAX_PRIORITY, priority), focus })
  }
  const { current } = input
  if (input.exportWanted) add(current, 'export', 0, true)
  add(current, 'still', input.exportWanted ? 1 : 0, true)
  // The rest wait for the stage's still: a visitor editing quickly never waits behind them.
  if (!input.stored(current, 'still')) return jobs
  const others = aroundOrder(input.angles, current, group)
  others.forEach((angle, i) => add(angle, 'thumb', THUMBS_FROM + i))
  // A section's siblings once the filmstrip is whole: never ahead of what the visitor sees.
  const prefetch = input.prefetch
  const filmstrip = others.every((angle) => input.stored(angle, 'thumb'))
  // Until the filmstrip is whole, its siblings are still to come.
  let prefetching = !!prefetch && !filmstrip
  if (prefetch && filmstrip) {
    const wanted = prefetch.designs.filter((design) => !prefetch.has(design))
    // Held back only for a sibling whose still is about to go to the GPU, not for one whose scans
    // are still downloading (they may never come).
    prefetching = wanted.some((design) => !prefetch.waiting?.(design))
    for (const design of wanted.slice(0, Math.max(0, prefetch.room)))
      jobs.push({
        angle: current,
        tier: 'still',
        priority: PREFETCH_PRIORITY,
        focus: false,
        sibling: design,
      })
  }
  // The other angles' stills wait for them: queued on the server meanwhile, one would go on the
  // GPU between two siblings, while the next one's request is on its way.
  if (input.idle && !prefetching) others.forEach((angle, i) => add(angle, 'still', STILLS_FROM + i))
  return jobs
}
