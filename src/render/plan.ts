/**
 * The spin's plan: which frames to render next, most wanted first. A pure function of what the
 * visitor looks at and what is there already, so SpinSession can rebuild it only when one of those
 * changes, and the order can be tested on its own.
 *
 * Coverage comes first: every angle of the ring the visitor is on gets a quick preview before any
 * frame is rendered at good quality, so turning anywhere shows a path-traced frame soon, and the
 * longer renders never hold a preview back. The full-quality tier is rendered only for an export.
 */

/** A frame's quality: a quick preview, good enough to rest on, or the full render for an export. */
export type Tier = 'preview' | 'good' | 'final'

/** A frame of the spin: an exterior pose, or the one interior panorama. */
export type FrameRef = { kind: 'exterior'; level: number; azimuth: number } | { kind: 'interior' }

export type PlanInput = {
  active: 'exterior' | 'interior'
  /** The exterior pose looked at (or last looked at); null until the exterior is framed. */
  focus: { level: number; azimuth: number } | null
  /** The way the visitor is turning: the sign of the last azimuth change, 0 at rest. */
  drift: -1 | 0 | 1
  steps: number
  levels: number
  /** Stored or in flight: not asked for again. */
  has: (ref: FrameRef, tier: Tier) => boolean
  /** Stored, so finished: what the admission rule counts (a frame in flight is still unfinished). */
  stored: (ref: FrameRef, tier: Tier) => boolean
  /**
   * Stored, but as a stand-in: rendered before the exposure was metered or the textures were in.
   * One for a view the visitor is not in waits to be rendered again until frames are fetched
   * ahead, like the ring; one with no frame at all goes out as soon as it is wanted.
   */
  standIn: (ref: FrameRef, tier: Tier) => boolean
  /** The design unchanged for IDLE_MS and the floor plan closed: frames may be fetched ahead. */
  idle: boolean
  /** The textures are in: good and final frames may be rendered. */
  settled: boolean
  /** A capture waits for the focus frame at full quality. */
  exportWanted: boolean
}

export type PlannedJob = {
  ref: FrameRef
  tier: Tier
  /** Sent to the server, 0 first; it orders its queue by it. */
  priority: number
  /** The frame the visitor looks at: asked for at once, on a channel of its own. */
  focus: boolean
}

/** How long the design must hold still before frames are fetched ahead of the visitor. */
export const IDLE_MS = 3000
/** The server's lowest priority (render-server/fury_render/protocol.py). */
export const MAX_PRIORITY = 31
/**
 * Previews this many steps either side of the focus must be finished before a longer render
 * starts: a good frame takes several seconds, and a visitor turning past it should not wait.
 */
export const ADMISSION_STEPS = 3

const wrap = (azimuth: number, steps: number) => ((azimuth % steps) + steps) % steps

/**
 * The azimuths around `center` by distance, nearest first, each with its distance: at rest the
 * two sides alternate; drifting, the side ahead leads by one step, so the frame after the next
 * one ahead comes before the one just behind.
 */
function outward(center: number, steps: number, drift: -1 | 0 | 1) {
  const half = Math.floor(steps / 2)
  const order: { azimuth: number; d: number }[] = []
  const seen = new Set<number>()
  const push = (offset: number, d: number) => {
    const azimuth = wrap(center + offset, steps)
    if (seen.has(azimuth)) return
    seen.add(azimuth)
    order.push({ azimuth, d })
  }
  const ahead = drift === 0 ? 1 : drift
  for (let d = 1; d <= half; d++) {
    push(ahead * d, d)
    if (drift === 0) push(-d, d)
    else if (d > 1) push(-ahead * (d - 1), d - 1)
  }
  if (drift !== 0) push(-ahead * half, half)
  return order
}

/** The frames still to render, most wanted first. Frames the input `has` are left out. */
export function planJobs(input: PlanInput): PlannedJob[] {
  const { focus, steps, drift } = input
  const jobs: PlannedJob[] = []
  const listed = new Set<string>()
  const add = (ref: FrameRef, tier: Tier, priority: number, focused = false) => {
    const id = ref.kind === 'interior' ? `i|${tier}` : `e|${ref.level}|${ref.azimuth}|${tier}`
    if (listed.has(id) || input.has(ref, tier)) return
    listed.add(id)
    jobs.push({ ref, tier, priority: Math.min(MAX_PRIORITY, priority), focus: focused })
  }
  const panorama: FrameRef = { kind: 'interior' }
  const exterior = (level: number, azimuth: number): FrameRef => ({
    kind: 'exterior',
    level,
    azimuth: wrap(azimuth, steps),
  })
  // Fetching ahead and the longer renders wait for the visitor to rest on a design (idle) and for
  // the textures (settled); only the previews of what they look at, or soon may, go out before.
  const ahead = input.idle && input.settled
  const inside = input.active === 'interior'
  // Inside, the panorama leads and the exterior list follows it, two priorities down.
  const shift = inside ? 2 : 0
  if (input.exportWanted) {
    if (inside) add(panorama, 'final', 0, true)
    else if (focus) add(exterior(focus.level, focus.azimuth), 'final', 0, true)
  }
  if (inside) {
    add(panorama, 'preview', 0, true)
    if (ahead) add(panorama, 'good', 1)
  }
  if (focus) {
    const own = exterior(focus.level, focus.azimuth)
    add(own, 'preview', shift, !inside)
    const around = outward(focus.azimuth, steps, drift)
    // A good frame is admitted only once every preview near the visitor is finished.
    const admitted =
      ahead &&
      input.stored(own, 'preview') &&
      around.every(
        ({ azimuth, d }) =>
          d > ADMISSION_STEPS || input.stored(exterior(focus.level, azimuth), 'preview'),
      )
    if (ahead)
      for (const { azimuth, d } of around) add(exterior(focus.level, azimuth), 'preview', shift + d)
    if (admitted) add(own, 'good', shift + 4)
    if (ahead || !input.standIn(panorama, 'preview')) add(panorama, 'preview', shift + 5)
    if (ahead) {
      for (let level = 0; level < input.levels; level++) {
        if (level === focus.level) continue
        add(exterior(level, focus.azimuth), 'preview', shift + 8)
        for (const { azimuth, d } of around) add(exterior(level, azimuth), 'preview', shift + 8 + d)
      }
      add(panorama, 'good', shift + 19)
      if (admitted)
        for (const { azimuth, d } of around)
          if (d <= ADMISSION_STEPS) add(exterior(focus.level, azimuth), 'good', shift + 20 + d)
    }
  } else add(panorama, 'preview', shift + 5)
  return jobs
}
