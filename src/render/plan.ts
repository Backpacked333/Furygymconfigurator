import type { AngleId } from './gallery'

/**
 * The gallery's plan: which stills to render next, most wanted first. A pure function of what the
 * visitor looks at and what is there already, so StillSession can rebuild it only when one of
 * those changes, and the order can be tested on its own.
 *
 * What the stage shows comes first: the current angle's still (or its export, when a download
 * waits for it). Once that is in, every other angle gets a quick thumbnail for the filmstrip, and
 * once the visitor rests on the design, its full still, so clicking through the angles finds
 * them ready.
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
}

export type PlannedJob = {
  angle: AngleId
  tier: Tier
  /** Sent to the server, 0 first; it orders its queue by it. */
  priority: number
  /** What the stage waits for: asked for at once, on a channel of its own. */
  focus: boolean
}

/** How long the design must hold still before the other angles' stills are rendered. */
export const IDLE_MS = 3000
/** The server's lowest priority (render-server/fury_render/protocol.py). */
export const MAX_PRIORITY = 31
/** Where the thumbnails' and the other stills' priorities start, nearest angle first. */
const THUMBS_FROM = 2
const STILLS_FROM = 12

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
  if (input.idle) others.forEach((angle, i) => add(angle, 'still', STILLS_FROM + i))
  return jobs
}
