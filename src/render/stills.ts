import { Matrix4, Vector3, type Scene } from 'three/webgpu'
import { bakedRevision, bakedStill } from '../lib/bakedStills'
import { EXPORT_SAMPLES } from '../lib/stillsManifest'
import type { SkyLook } from '../lib/visuals'
import type { BakeJob } from './bake'
import {
  Busy,
  Full,
  Outdated,
  Superseded,
  captureScene,
  type CapturedScene,
  type CloudCamera,
  type CloudClient,
  type StillFrame,
} from './cloud'
import { bench } from './bench'
import { CUSTOMER_ANGLES } from '../render-library/views'
import {
  ASPECT_RATIO,
  galleryAngle,
  type AngleId,
  type AspectClass,
  type GalleryCamera,
} from './gallery'
import { fingerprint } from './hash'
import { lookKey } from './pathtrace'
import {
  MAX_PRIORITY,
  PREFETCH_MAX,
  TIER_RANK,
  planStills,
  type PlannedJob,
  type Tier,
} from './plan'
import { queueEstimate, renderRate } from './progress'
import type { AngleImages, StillProgress, StillsSnapshot } from './stillStatus'
import type { CloudWork } from './workProgress'

export type { Tier }

/**
 * The gallery's path-traced stills. Each gallery angle (gallery.ts) of the design on screen is
 * rendered as a finished still by the visitor's cloud GPU (render-server/), at three tiers: a
 * thumbnail for the filmstrip, the still the stage shows, and an export for downloads and the
 * PDF. The stage swaps a still in only once it is the real thing: nothing is asked for before
 * the scanned textures are in, so a still is never a stand-in that a better one replaces in front
 * of the visitor.
 *
 * What the stage waits for comes first (plan.ts): the current angle's still, on a channel of its
 * own; then a thumbnail of every other angle; then, once the visitor rests on the design, their
 * stills. The server finishes stills (exposure, bloom, tone mapping) and keeps them by content,
 * so a design anyone has viewed before comes back from its cache.
 *
 * Without a cloud (none configured, every GPU in use, or one that gave up for the page), the
 * page's own tracer renders the current angle's still where WebGPU allows (RenderEffects asks
 * `localJob` and hands the result to `deliverLocal`), and the same store keeps it.
 *
 * A still baked ahead of time (bakedStills.ts, found from the design's config key) counts as
 * stored at every tier: the stage shows it from first paint, and it is never rendered again. Every
 * still is exposed as the live view is (STILL_GAIN), so a still rendered for an edit matches the
 * baked one it replaces.
 *
 * While a panel section is open, the current angle's still of each of its siblings (the design
 * with that one option changed: prefetch.ts) is rendered ahead, one at a time, once the stage's
 * still and the filmstrip are in. A sibling's scene is captured from the live one with its
 * surfaces swapped in for the moment (siblings.ts), and its still is kept under the very key a
 * click on it gives the stage, so the click finds it and swaps it in at once. Prefetch runs only on
 * the visitor's own warm GPU, with the visitor at rest, never in the 360° view and never on this
 * device's tracer, within a budget per design and per session; a busy or full cloud stops it for a
 * minute. A prefetch once sent is never cut short: the GPU finishes it anyway, and a still a click
 * may wait for is not rendered twice.
 */

/** Render settings by tier. */
export const QUALITY: Record<Tier, Quality> = {
  thumb: { samples: 64, threshold: 0, timeLimit: 6 },
  still: { samples: 256, threshold: 0, timeLimit: 20 },
  export: { samples: EXPORT_SAMPLES, threshold: 0.01, timeLimit: 60 },
}
/**
 * The gain between the traced light and the finished still: none. A still is exposed at its part's
 * camera exposure (StillState `exposure`, visuals.ts exposureAt), as the live view is, and the
 * raster is tuned to the traced light rather than the still to the raster. Nothing is metered, so
 * a design gets the same still, and the same request to the server's cache, on every device and
 * tier.
 */
export const STILL_GAIN = 1
/** A thumbnail's width, in pixels. */
export const THUMB_WIDTH = 320
/** A stage still is rendered at the stage's size at up to this density, its long edge capped. */
export const STILL_MAX_DPR = 1.5
export const STILL_LONG_EDGE = 1920
/**
 * A stage grown this much past its still's size (full screen, a big resize) has the still rendered
 * again at the new size, swapped in with no status; a smaller stage keeps the larger still.
 */
export const STILL_GROWTH = 1.25
/** An export's long edge, whatever the screen. */
export const EXPORT_LONG_EDGE = 2400
/**
 * Requests kept open at once, besides what the stage waits for, which goes out at once. The
 * visitor's GPU renders one still at a time; a few more queued keep it busy across round trips.
 */
const IN_FLIGHT = 3
/** A busy server is asked again after this long, doubled each time in a row, up to the cap. */
const BUSY_MS = 2000
const BUSY_MAX_MS = 30_000
/** Every cloud GPU in use: this page renders on its own device and asks again after this long. */
const FULL_MS = 60_000
/**
 * The textures count as settled once every set asked for is in and none has been asked for in
 * this long: sets are asked for as surfaces are built and as edits call for new ones, so the
 * material library cannot say when the last one has been, and the loaded-versus-requested count
 * alone flips back with each one asked for.
 */
export const SETTLE_MS = 500
/**
 * A changed design's stills are named for it once its scene has held this long: the edit's
 * meshes, then their matrices, then what they set off land over a few frames, and a still kept
 * for the scene before must never be handed out as the new design's.
 */
export const QUIET_MS = 250
/**
 * A changed scene is taken up once its key has held for a frame (`take`); one that keeps
 * changing is taken as it is after this many frames held, rather than never.
 */
export const HOLD_FRAMES = 16
/** Keys kept for each part from the frames before: a key back within these is taken up. */
const RECENT_FRAMES = 4
/** Angles' stills kept, most recently used last (a design's nine angles at every tier ~ 3 MB). */
const KEEP = 90
/** Prefetch waits for the visitor to rest this long after an edit. */
export const PREFETCH_IDLE_MS = 1000
/**
 * Prefetch only while the visitor's own GPU has answered this lately: warm, not starting for it.
 * The shared warm renderer, which answers while it starts, is every arriving visitor's first GPU.
 */
export const WARM_MS = 4 * 60_000
/** A busy or full answer stops prefetch for this long. */
export const PREFETCH_PAUSE_MS = 60_000
/**
 * Prefetched stills in flight at once. The GPU renders one still at a time and cannot stop one
 * begun: with one, a click on an option not prefetched waits behind one prefetched still at most,
 * and one pointed at goes next.
 */
const PREFETCH_IN_FLIGHT = 1
/**
 * Prefetches sent for one design on the stage, whatever the section or angle: two sections' worth.
 * A visitor (or a script) pointing at every section from every angle renders no more than this
 * ahead of each design they come to.
 */
export const PREFETCH_PER_DESIGN = 12
/** Prefetches sent since a click last found one ready: past this many, prefetch stops for good. */
export const PREFETCH_UNUSED_MAX = 30
/**
 * A sibling the live scene could not be read for (it was between designs) is looked at again
 * this often, and left alone for this design once it has been unreadable this long.
 */
const SIBLING_RETRY_MS = 250
export const SIBLING_LATER_MS = 2000
/** Siblings' keys remembered, most recent last. */
const SIBLINGS_KEPT = 64
/** An evicted still's address stays valid this long, for an image still fading out. */
const REVOKE_AFTER_MS = 30_000

/** `?traceStats=1` logs each still's timing. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

type Quality = { samples: number; threshold: number; timeLimit: number }

/**
 * The scene as each part's angles see it (pathtrace.ts sceneSignature by part): outside, and in
 * the room. Either changing renders only that part's angles again.
 */
export type SceneKeys = { exterior: string; interior: string }
type Part = keyof SceneKeys
const PARTS: Part[] = ['exterior', 'interior']
const partOf = (angle: AngleId): Part => galleryAngle(angle).group
const ANGLES = CUSTOMER_ANGLES

const UP = new Vector3(0, 1, 0)
/** The camera the server renders a gallery angle with, looking at its target. */
export function cloudCamera(camera: GalleryCamera, near: number, far: number): CloudCamera {
  const eye = new Vector3(...camera.position)
  const matrix = new Matrix4().lookAt(eye, new Vector3(...camera.target), UP).setPosition(eye)
  return { matrix: Array.from(matrix.elements), fov: camera.fov, near, far }
}

/**
 * Where a still is kept: its part's scene (with the look), its angle key, the stage's shape and
 * its camera. A sibling's prefetched still is keyed the same way from its predicted scene.
 */
function stillKeyOf(
  part: Part,
  scene: string,
  angleKey: string,
  aspect: AspectClass,
  camera: CloudCamera,
) {
  return `${part[0]}|${scene}|${angleKey}|${aspect}|${lensOf(camera)}`
}

/** A still's size by tier: a fixed thumbnail, the stage's size, or a fixed export. */
export function stillSize(
  tier: Tier,
  aspect: AspectClass,
  stage: { width: number; height: number; dpr: number },
) {
  const ratio = ASPECT_RATIO[aspect]
  const sized = (width: number) => {
    const w = Math.max(64, Math.round(width))
    return { width: w, height: Math.max(1, Math.round(w / ratio)) }
  }
  if (tier === 'thumb') return sized(THUMB_WIDTH)
  if (tier === 'export') return sized(ratio >= 1 ? EXPORT_LONG_EDGE : EXPORT_LONG_EDGE * ratio)
  const width = Math.max(1, stage.width) * Math.min(STILL_MAX_DPR, Math.max(1, stage.dpr))
  return sized(Math.min(width, ratio >= 1 ? STILL_LONG_EDGE : STILL_LONG_EDGE * ratio))
}

/**
 * Whether a stage still `width` pixels wide still serves a stage that wants `wanted`: it does
 * unless the stage has grown more than STILL_GROWTH past it. Never the other way: a still is not
 * rendered again smaller.
 */
export const stillServes = (width: number, wanted: number) => wanted <= width * STILL_GROWTH

/**
 * A sibling's scene for its prefetch (siblings.ts), at the angle asked for: its fingerprints as a
 * click will sign them and its camera, learned cheaply, so a sibling whose still at this angle is
 * in already costs no capture and no download; with `take`, which captures its scene, to be called
 * at once if at all ('ready'), or `load`, which downloads its scans and says whether they came
 * ('unloaded'); or not now (the scene is between designs), or never from this design (it differs
 * by more than surfaces).
 */
export type SiblingShot =
  | {
      kind: 'ready'
      keys: SceneKeys
      take: () => Promise<CapturedScene>
      camera: CloudCamera
      angleKey: string
    }
  | {
      kind: 'unloaded'
      keys: SceneKeys
      camera: CloudCamera
      angleKey: string
      load: () => Promise<boolean>
    }
  | { kind: 'later' }
  | { kind: 'never' }
/**
 * A sibling design to prefetch (prefetch.ts): its config key, and how to capture its scene at an
 * angle, given the live scene's fingerprints as the session signed them.
 */
export type PrefetchSibling = {
  design: string
  capture: (angle: AngleId, expected: SceneKeys) => SiblingShot
}
/** The open panel section's siblings, most wanted first. */
export type PrefetchState = { section: string; siblings: readonly PrefetchSibling[] }

/** What the visitor looks at, and what to have ready next, as StillSession needs it. */
export type StillState = {
  /** The design the scene shows (stillKey.ts configKey of the config it renders). */
  design: string
  /** The angle on the stage, and the stage's shape. */
  angle: AngleId
  aspect: AspectClass
  /** The stage's CSS size and the screen's density: stills are rendered at its size. */
  stage: { width: number; height: number; dpr: number }
  /** Each angle's camera, and its key part (gallery.ts angleKey). */
  cameras: Record<AngleId, CloudCamera>
  angleKeys: Record<AngleId, string>
  /**
   * The camera's exposure outside and inside (visuals.ts exposureAt, the live view's too): from
   * the design's time of day alone, never from the device.
   */
  exposure: { exterior: number; interior: number }
  /** The design has held still a while and the floor plan is closed: the longer renders go out. */
  idle: boolean
  /** When the design last changed (performance.now()): prefetch waits for the visitor to rest. */
  editedAt?: number
  /** The open section's siblings to prefetch, or none (no section open, Lite, bake mode). */
  prefetch?: PrefetchState | null
}

/**
 * An angle's images by tier, the address each is shown at, the samples it was traced with, and
 * its width in pixels.
 */
type Stored = Partial<Record<Tier, { blob: Blob; url: string; samples: number; width: number }>>

/** The best tier stored, or null for none. */
const bestTier = (stored: Stored | undefined): Tier | null =>
  stored?.export ? 'export' : stored?.still ? 'still' : stored?.thumb ? 'thumb' : null

type Job = PlannedJob & {
  key: string
  /** The key and tier: one request at a time for each. */
  id: string
  part: Part
  camera: CloudCamera
  width: number
  height: number
  quality: Quality
  exposure: number
}
/** A request open: what drops it, when it went out, and what it should take (the estimate). */
type Open = {
  focus: boolean
  abort: AbortController
  sentAt: number
  estimateMs: number
  work?: CloudWork
}
/** A prefetch open: the sibling it is of, and its whole wait from when it went out. */
type PrefetchOpen = Open & { design: string; waitMs: number }
/** A still for this device's tracer to render: RenderEffects traces it and hands it back. */
export type LocalJob = { key: string; angle: AngleId; tier: Exclude<Tier, 'thumb'> }

/**
 * Where the session finds baked stills (bakedStills.ts), by the design's config key, the angle key
 * and the stage's shape; `revision` changes when a baked still is forgotten.
 */
export type BakedLookup = {
  /** A baked still, and its tier: 'export' when baked at the export tier, a quick bake's 'thumb'. */
  still: (
    design: string,
    angle: string,
    aspect: AspectClass,
  ) => { url: string; tier: 'export' | 'thumb' } | null
  revision: () => number
}
const BAKED: BakedLookup = { still: bakedStill, revision: bakedRevision }

/** Stills baked at once (bake mode): enough to keep the GPU busy across round trips. */
const BAKE_IN_FLIGHT = 2
/** A bake asks a busy server again this many times, waiting longer each time, then gives up. */
const BAKE_RETRIES = 8
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A request the browser cut short (the page unloading, or a signal of ours). */
const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === 'AbortError'

/** A camera's part of a still's key. */
const lensOf = (camera: CloudCamera) =>
  fingerprint(`${camera.matrix.map((v) => v.toFixed(3)).join(',')}|${camera.fov.toFixed(3)}`)

/** Keeps `key` most recent in `map`, the oldest dropped beyond SIBLINGS_KEPT. */
function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  if (map.size > SIBLINGS_KEPT) map.delete(map.keys().next().value!)
}

/**
 * Renders and keeps the gallery's stills for the design on screen, and says which are ready and
 * which are on their way (`snapshot`). Stills are exposed at a fixed camera exposure per part,
 * with no gain (STILL_GAIN): as on a camera on manual exposure, a finish change never shifts
 * brightness, and the same design always gets the same still, on every device and tier.
 */
export class StillSession {
  private readonly client: CloudClient | null
  private readonly onChange: () => void
  /**
   * One generation for each part's requests, raised when its design changes: the server drops
   * what is still queued under an older one (the requests themselves are aborted).
   */
  private generations: Record<Part, number> = { exterior: 0, interior: 0 }
  /** The still the stage waits for, and its channel's sequence, which rises with each new one. */
  private focused = ''
  private focusSeq = 0
  /** The export's channel's sequence. */
  private exportSeq = 0
  /** Cancels what outlives design changes (a bake's requests) when the session closes. */
  private readonly closed = new AbortController()
  /** The scene each part's stills are rendered for (with the lighting look). */
  private designs: SceneKeys = { exterior: '', interior: '' }
  /** Each part's key over the last RECENT_FRAMES frames, the latest last (`take`). */
  private recent: Record<Part, string[]> = { exterior: [], interior: [] }
  private holds: Record<Part, number> = { exterior: 0, interior: 0 }
  private alternating: Record<Part, string> = { exterior: '', interior: '' }
  /** The design the scene shows, and since when its scene has held still. */
  private design = ''
  private designSince = 0
  /** The design whose stills are handed out: its scene has held QUIET_MS (empty before). */
  private named = ''
  private quietTimer: ReturnType<typeof setTimeout> | undefined
  /** Each angle's key: its part's scene, its angle key, the stage's shape and its camera. */
  private keys = {} as Record<AngleId, string>
  private sceneKey = ''
  private captured: Promise<CapturedScene> | null = null
  private capturedSettled = false
  /** Whether the scene has its textures (the latch: held SETTLE_MS, see `latch`). */
  private settled = false
  private settledSince: number | null = null
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  private state: StillState | null = null
  /** Gallery mode: stills are worked on. In the 360° view nothing new is asked for. */
  private active = true
  /** Stored stills by angle key, most recently used last. */
  private readonly frames = new Map<string, Stored>()
  /** Requests open for each part, by job id (see `drop`). */
  private inFlight: Record<Part, Map<string, Open>> = { exterior: new Map(), interior: new Map() }
  private failures = 0
  private busyUntil = 0
  private busyStreak = 0
  private fullUntil = 0
  /** The cloud gave up for the page: an older server, or a run of errors. */
  private failed = false
  /** A download or a PDF waits for the current angle's export. */
  private exportWanted = false
  private planned: Job[] = []
  private planStamp = ''
  /** This device's tracer can render stills (WebGPU), and how far it is with one. */
  private localAvailable = false
  private localProgress: { key: string; fraction: number; remainingMs: number | null } | null = null
  private unloading = false
  private readonly baked: BakedLookup
  /** The lighting look of the scene on screen (pathtrace.ts lookKey). */
  private lighting = ''
  /** When the visitor's own GPU (or a server of its own) last answered: prefetch runs only warm. */
  private answeredAt = -Infinity
  /** Prefetches open, by the still key each is for. */
  private prefetchOpen = new Map<string, PrefetchOpen>()
  /** The section whose siblings are prefetched. */
  private prefetchSection = ''
  /** A busy or full cloud: no prefetch before then. */
  private prefetchPausedUntil = 0
  private prefetchTimer: ReturnType<typeof setTimeout> | undefined
  private prefetchWakeAt = Infinity
  /** Raised with every change to what the prefetch knows, for the plan's stamp. */
  private prefetchVersion = 0
  /** Siblings' still keys at an angle, learned at their capture (`siblingSlot`). */
  private readonly siblingStills = new Map<string, string>()
  /** Siblings' scenes, keyed as a click on one will sign it (`design|lighting`). */
  private readonly siblingScenes = new Map<string, SceneKeys>()
  /** Siblings that cannot be prefetched from a design (`design|sibling`). */
  private readonly unprefetchable = new Set<string>()
  /**
   * Siblings waiting for their scans (`design|sibling`): downloading them, or waiting their turn
   * while another's download (one at a time); looked at again once that is over.
   */
  private readonly siblingWaits = new Map<string, 'loading' | 'queued'>()
  /** Siblings the live scene could not be read for (`design|sibling`), and since when. */
  private readonly siblingLater = new Map<string, number>()
  /** Still keys that came by prefetch, so the bench can count the clicks that found one. */
  private readonly prefetched = new Set<string>()
  /** Prefetches sent for the design on the stage, and since a click last found one ready. */
  private prefetchSpent = { design: '', count: 0 }
  private prefetchUnused = 0

  constructor(client: CloudClient | null, onChange: () => void, baked: BakedLookup = BAKED) {
    this.client = client
    this.onChange = onChange
    this.baked = baked
    document.addEventListener('visibilitychange', this.resume)
    window.addEventListener('beforeunload', this.unload)
    window.addEventListener('pagehide', this.unload)
  }

  /** Rendering pauses while the page is hidden (stills in flight finish) and resumes here. */
  private readonly resume = () => {
    if (!document.hidden) this.pump()
  }

  /** The page is unloading: the browser cuts its fetches short, which is no failure. */
  private readonly unload = () => {
    this.unloading = true
  }

  /** Whether the cloud renders stills now (configured, not given up, a GPU free). */
  private get cloudUp() {
    return this.client !== null && !this.failed && performance.now() >= this.fullUntil
  }

  /**
   * The design, look and stage. Cheap to call every frame: work starts only when something that
   * determines the stills changed. `keys` fingerprint the scene outside and inside, so an edit in
   * the room renders the interior angles again and keeps the rest. `settled` says whether every
   * scanned texture asked for is in; nothing is rendered until that has held a moment.
   */
  sync(scene: Scene, look: SkyLook, keys: SceneKeys, state: StillState, settled = true) {
    this.state = state
    const now = performance.now()
    const lighting = lookKey(look)
    this.lighting = lighting
    const { designs, held } = this.take({
      exterior: `${keys.exterior}|${lighting}`,
      interior: `${keys.interior}|${lighting}`,
    })
    if (state.design !== this.design) {
      this.design = state.design
      this.designSince = now
    }
    const latched = this.latch(settled, now)
    const rendering = this.client !== null && !this.failed
    if (held) {
      this.designSince = now
      this.name(now)
      this.pump()
      return
    }
    const arrived = latched && !this.settled
    this.settled = latched
    const fresh = PARTS.filter((part) => designs[part] !== this.designs[part])
    if (fresh.length) this.designSince = now
    if (TRACE_STATS)
      for (const part of fresh)
        if (this.designs[part])
          console.info(`[stills] ${part} scene changed: ${this.designs[part]} → ${designs[part]}`)
    if (arrived) bench.mark('texturesSettled')
    // A part whose scene changed: its queued requests are for stills no longer wanted.
    for (const part of fresh) this.drop(part)
    if (fresh.length && !this.failed) this.failures = 0
    this.designs = designs
    const sceneKey = `${designs.exterior}|${designs.interior}`
    // Captured for a new scene, and again once its textures are in.
    if (
      rendering &&
      (sceneKey !== this.sceneKey || !this.captured || (latched && !this.capturedSettled))
    ) {
      this.sceneKey = sceneKey
      this.capturedSettled = latched
      this.captured = captureScene(scene, look)
      this.captured.then(
        () => bench.mark('sceneCaptured'),
        () => {},
      )
    }
    this.rekey(state)
    this.name(now)
    this.pump()
  }

  /** Each angle's key, from its part's scene, its angle key, the stage's shape and its camera. */
  private rekey(state: StillState) {
    for (const angle of ANGLES) {
      const part = partOf(angle)
      this.keys[angle] = stillKeyOf(
        part,
        this.designs[part],
        state.angleKeys[angle],
        state.aspect,
        state.cameras[angle],
      )
    }
  }

  /**
   * Names the design's stills once its scene has held QUIET_MS; a timer sees the wait through in
   * case no frame is drawn by then.
   */
  private name(now: number) {
    if (this.named === this.design) return
    clearTimeout(this.quietTimer)
    // A sibling prefetched before: its scene is known, and the one on screen is it, whole. Its
    // stills are handed out at once, so a click on it swaps the still in with no wait at all.
    const predicted = this.siblingScenes.get(`${this.design}|${this.lighting}`)
    if (
      predicted &&
      predicted.exterior === this.designs.exterior &&
      predicted.interior === this.designs.interior
    ) {
      this.named = this.design
      const key = this.state && this.keys[this.state.angle]
      if (key && this.prefetched.has(key) && this.storedKey(key, 'still')) {
        bench.prefetch('hits')
        this.prefetchUnused = 0
      }
      if (TRACE_STATS) console.info(`[stills] design ${this.design} named: prefetched before`)
      return
    }
    const left = this.designSince + QUIET_MS - now
    if (left <= 0) {
      this.named = this.design
      if (TRACE_STATS) console.info(`[stills] design ${this.design} named`)
      return
    }
    this.quietTimer = setTimeout(this.onChange, left + 1)
  }

  /**
   * The scene keys to render now, and whether one is held back: a part's new key is taken up once
   * it has held since the frame before. One edit lands as a run of keys (the new meshes, then
   * their world matrices, then what they set off), and taking each at once would drop the part's
   * requests as many times; the page's first key is taken at once. A key held back is seen again
   * next frame: a redraw is asked for in case nothing else brings one.
   *
   * A key that never holds still is not held forever: one back within RECENT_FRAMES is taken up,
   * one that keeps changing is taken after HOLD_FRAMES, and one that takes turns with the key in
   * hand from frame to frame is left alone, since taking it would only have the two trade places.
   */
  private take(designs: SceneKeys): { designs: SceneKeys; held: boolean } {
    const taken = { ...this.designs }
    let held = false
    for (const part of PARTS) {
      const design = designs[part]
      const current = this.designs[part]
      const recent = this.recent[part]
      const seen = recent[recent.length - 1]
      let holding = false
      if (design !== current) {
        if (!current || design === seen) taken[part] = design
        else if (this.holds[part] >= HOLD_FRAMES) {
          if (TRACE_STATS)
            console.info(`[stills] ${part} scene held ${this.holds[part]} frames: taken as it is`)
          taken[part] = design
        } else if (seen === current && recent[recent.length - 2] === design) {
          if (TRACE_STATS && this.alternating[part] !== design) {
            this.alternating[part] = design
            console.info(`[stills] ${part} scene alternates with ${design}: ${current} kept`)
          }
        } else if (recent.includes(design)) taken[part] = design
        else holding = held = true
      }
      this.holds[part] = holding ? this.holds[part] + 1 : 0
      recent.push(design)
      if (recent.length > RECENT_FRAMES) recent.shift()
    }
    if (held) this.onChange()
    return { designs: taken, held }
  }

  /**
   * Whether the textures have settled: `settled` (every set asked for is in) has held SETTLE_MS.
   * A timer sees the wait through, in case no frame is drawn by then.
   */
  private latch(settled: boolean, now: number) {
    if (!settled) {
      this.settledSince = null
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
      return false
    }
    if (this.settledSince === null) {
      this.settledSince = now
      this.settleTimer = setTimeout(this.onChange, SETTLE_MS + 1)
    }
    return now - this.settledSince >= SETTLE_MS
  }

  /**
   * Drops a part's open requests: each is aborted, a new generation has the server drop what is
   * still queued for them, and a new map keeps their bookkeeping from touching later requests.
   * The stage's channel starts over too, if what it waits for was of this part.
   */
  private drop(part: Part) {
    this.generations[part]++
    for (const open of this.inFlight[part].values()) open.abort.abort()
    this.inFlight[part] = new Map()
    if (this.state && partOf(this.state.angle) === part) this.focused = ''
  }

  /** Everything a still needs is in: the textures. */
  private get ready() {
    return this.settled
  }

  /** An angle's baked still for the design on screen, at the stage's shape, or null. */
  private bakedAt(angle: AngleId) {
    const state = this.state
    return state ? this.baked.still(state.design, state.angleKeys[angle], state.aspect) : null
  }

  /**
   * Whether an angle's still is stored at a tier or a better one. A still baked at the export tier
   * is the best; a quick bake counts as a thumbnail. A stage still counts only while the stage has
   * not grown well past it (stillServes): then it is rendered again at the stage's new size.
   */
  private storedAt(angle: AngleId, tier: Tier) {
    const baked = this.bakedAt(angle)
    if (baked && TIER_RANK[baked.tier] >= TIER_RANK[tier]) return true
    const key = this.keys[angle]
    if (!this.storedKey(key, tier)) return false
    const stored = this.frames.get(key)!
    if (tier !== 'still' || stored.export || !this.state) return true
    return stillServes(
      stored.still!.width,
      stillSize('still', this.state.aspect, this.state.stage).width,
    )
  }

  /** Whether a still is stored under a key at a tier or a better one. */
  private storedKey(key: string, tier: Tier) {
    const best = bestTier(this.frames.get(key))
    return best !== null && TIER_RANK[best] >= TIER_RANK[tier]
  }

  /** In flight: asked for, or prefetched while the design was a sibling (the visitor waits for it). */
  private inFlightFor(angle: AngleId, tier: Tier) {
    const key = this.keys[angle]
    return (
      this.inFlight[partOf(angle)].has(`${key}|${tier}`) ||
      (tier === 'still' && this.prefetchOpen.has(key))
    )
  }

  /** The live scene's fingerprints by part, as signed (without the look). */
  private sceneKeys(): SceneKeys {
    const raw = (key: string) => key.slice(0, Math.max(0, key.length - this.lighting.length - 1))
    return { exterior: raw(this.designs.exterior), interior: raw(this.designs.interior) }
  }

  /** Where a sibling's still key at the current angle and shape is remembered. */
  private siblingSlot(design: string, state: StillState) {
    return `${design}|${state.angleKeys[state.angle]}|${state.aspect}|${this.lighting}`
  }

  /**
   * A sibling that holds nothing back: its scans are downloading, or the live scene could not be
   * read for it yet. No still of it is on its way to the GPU, so the other angles' stills may go.
   */
  private siblingWaiting(design: string) {
    const pair = `${this.design}|${design}`
    return this.siblingWaits.has(pair) || this.siblingLater.has(pair)
  }

  /** A sibling stored, on its way, baked, or not to be prefetched from this design. */
  private siblingHas(design: string, state: StillState) {
    if (this.unprefetchable.has(`${this.design}|${design}`)) return true
    if (this.baked.still(design, state.angleKeys[state.angle], state.aspect)?.tier === 'export')
      return true
    const key = this.siblingStills.get(this.siblingSlot(design, state))
    return key !== undefined && (this.prefetchOpen.has(key) || this.storedKey(key, 'still'))
  }

  /**
   * The siblings to prefetch now, most wanted first; none while the guards hold it back: the
   * 360° view, a cloud that is not rendering or whose own GPU has not answered lately, a busy or
   * full one, a visitor still editing (a wake is booked for when they will have rested), or the
   * budget spent (for this design, or for the session once many went unused).
   */
  private prefetchNow(state: StillState, now: number): readonly PrefetchSibling[] {
    const siblings = state.prefetch?.siblings
    if (!siblings?.length || !this.active || !this.cloudUp) return []
    if (this.prefetchUnused >= PREFETCH_UNUSED_MAX) return []
    if (
      this.prefetchSpent.design === this.design &&
      this.prefetchSpent.count >= PREFETCH_PER_DESIGN
    )
      return []
    if (now < this.prefetchPausedUntil) {
      this.wakePrefetch(this.prefetchPausedUntil)
      return []
    }
    if (now - this.answeredAt > WARM_MS) return []
    const rested = now - (state.editedAt ?? -Infinity)
    if (rested < PREFETCH_IDLE_MS) {
      this.wakePrefetch(now + PREFETCH_IDLE_MS - rested)
      return []
    }
    return siblings
  }

  /** Looks at the prefetch again at `at`, in case nothing else does by then. */
  private wakePrefetch(at: number) {
    if (this.prefetchTimer !== undefined && this.prefetchWakeAt <= at) return
    clearTimeout(this.prefetchTimer)
    this.prefetchWakeAt = at
    this.prefetchTimer = setTimeout(
      () => {
        this.prefetchTimer = undefined
        this.prefetchWakeAt = Infinity
        this.onChange()
        this.pump()
      },
      Math.max(0, at - performance.now()) + 1,
    )
  }

  /** The stills still to render, most wanted first (plan.ts), with everything a request needs. */
  private plan(state: StillState, siblings: readonly PrefetchSibling[]): Job[] {
    return planStills(
      {
        angles: ANGLES,
        current: state.angle,
        has: (angle, tier) => this.storedAt(angle, tier) || this.inFlightFor(angle, tier),
        stored: (angle, tier) => this.storedAt(angle, tier),
        idle: state.idle,
        exportWanted: this.exportWanted,
        prefetch: siblings.length
          ? {
              designs: siblings.map((sibling) => sibling.design),
              has: (design) => this.siblingHas(design, state),
              waiting: (design) => this.siblingWaiting(design),
              room: PREFETCH_MAX - this.prefetchOpen.size,
            }
          : undefined,
      },
      (angle) => partOf(angle),
    ).map((planned) => this.job(state, planned))
  }

  private job(state: StillState, planned: PlannedJob): Job {
    // A sibling's key is learned from its capture, when it goes out (`prefetch`).
    const key = planned.sibling === undefined ? this.keys[planned.angle] : ''
    const part = partOf(planned.angle)
    return {
      ...planned,
      key,
      id: planned.sibling === undefined ? `${key}|${planned.tier}` : `sibling|${planned.sibling}`,
      part,
      camera: state.cameras[planned.angle],
      ...stillSize(planned.tier, state.aspect, state.stage),
      quality: QUALITY[planned.tier],
      exposure: state.exposure[part],
    }
  }

  /**
   * Asks at once for what the stage waits for, and keeps up to IN_FLIGHT other requests open, in
   * order of the plan.
   */
  private pump() {
    const state = this.state
    // Another section open (or none): its siblings are prefetched instead, one section at a time.
    // The last one's prefetch on its way is left to land: the GPU renders it whatever the page
    // does, a click may be waiting for it, and nothing new goes out before it settles.
    const section = state?.prefetch?.section ?? ''
    if (section !== this.prefetchSection) {
      this.prefetchSection = section
      this.prefetchVersion++
    }
    if (!state || !this.active || !this.cloudUp || !this.captured || this.failures >= 3) return
    if (this.closed.signal.aborted || document.hidden) return
    const now = performance.now()
    if (now < this.busyUntil) return
    // Only the design the scene has settled on, and only the real thing.
    if (this.named !== this.design || !this.ready) return
    const focusKey = `${this.keys[state.angle]}|${this.exportWanted}`
    if (focusKey !== this.focused) {
      // A new still for the stage: what is still queued for the one before is dropped.
      this.focused = focusKey
      this.focusSeq++
    }
    const siblings = this.prefetchNow(state, now)
    const flying = () => this.inFlight.exterior.size + this.inFlight.interior.size
    const stamp = (inFlight: number, version = this.prefetchVersion) =>
      [
        this.designs.exterior,
        this.designs.interior,
        focusKey,
        state.idle,
        state.aspect,
        `${state.stage.width}x${state.stage.height}@${state.stage.dpr}`,
        this.frames.size,
        inFlight,
        this.baked.revision(),
        siblings.map((sibling) => sibling.design).join(','),
        version,
      ].join('|')
    // What a pass learns of the siblings without sending one (one that cannot be prefetched, one
    // whose still is in already, one waiting for its scans) changes the plan it was made from: it
    // is made again at once, or the other angles' stills it held back for them would wait for
    // something else to happen. Each such pass settles a sibling, so this ends.
    for (let pass = 0; pass <= siblings.length + 1; pass++) {
      const learned = this.prefetchVersion
      if (stamp(flying()) !== this.planStamp) this.planned = this.plan(state, siblings)
      let open = 0
      for (const part of PARTS)
        for (const { focus } of this.inFlight[part].values()) if (!focus) open++
      // Siblings looked at in order until one's still goes out; one whose scans are not in starts
      // their download meanwhile, even while the GPU renders another's.
      let prefetchSent = false
      for (const job of this.planned) {
        if (job.sibling !== undefined) {
          if (!prefetchSent) prefetchSent = this.prefetch(job, state, now)
          continue
        }
        if (this.inFlight[job.part].has(job.id) || this.storedAt(job.angle, job.tier)) continue
        if (!job.focus && open >= IN_FLIGHT) break
        if (!job.focus) open++
        this.request(job)
      }
      // Stamped with what the plan knew of the siblings, not with what this pass learned.
      this.planStamp = stamp(flying(), learned)
      if (this.prefetchVersion === learned) break
    }
  }

  /**
   * Prefetches a sibling's still at the current angle: its scene captured from the live one with
   * its surfaces swapped in (siblings.ts), and rendered as a click on it would have it rendered,
   * under the key the click gives the stage. Whether its still went out (the pass looks at no
   * further sibling then).
   */
  private prefetch(job: Job, state: StillState, now: number): boolean {
    const design = job.sibling!
    const sibling = state.prefetch?.siblings.find((s) => s.design === design)
    if (!sibling || this.siblingHas(design, state)) return false
    const pair = `${this.design}|${design}`
    // Its scans are on their way: looked at again once they are in. The next sibling meanwhile.
    const waits = this.siblingWaits.get(pair)
    if (waits === 'loading') return false
    // Known and ready, while another's still is on the GPU: nothing to learn until that lands.
    const full = this.prefetchOpen.size >= PREFETCH_IN_FLIGHT
    if (full && !waits && this.siblingStills.has(this.siblingSlot(design, state))) return false
    const shot = sibling.capture(state.angle, this.sceneKeys())
    if (shot.kind === 'never') return this.unprefetchableNow(pair, design)
    if (shot.kind === 'later') {
      // The live scene is between designs: looked at again in a moment, and left alone if it
      // cannot be read for this sibling for long.
      const since = this.siblingLater.get(pair)
      if (since === undefined) {
        if (this.siblingLater.size > SIBLINGS_KEPT) this.siblingLater.clear()
        this.siblingLater.set(pair, now)
        this.prefetchVersion++
      } else if (now - since >= SIBLING_LATER_MS) {
        this.siblingLater.delete(pair)
        return this.unprefetchableNow(pair, design)
      }
      this.wakePrefetch(now + SIBLING_RETRY_MS)
      return false
    }
    if (this.siblingLater.delete(pair)) this.prefetchVersion++
    const lighting = this.lighting
    const scenes: SceneKeys = {
      exterior: `${shot.keys.exterior}|${lighting}`,
      interior: `${shot.keys.interior}|${lighting}`,
    }
    const part = partOf(state.angle)
    const key = stillKeyOf(part, scenes[part], shot.angleKey, state.aspect, shot.camera)
    remember(this.siblingScenes, `${design}|${lighting}`, scenes)
    const slot = this.siblingSlot(design, state)
    // A key learned is news to the plan; the same key looked at again is not.
    if (this.siblingStills.get(slot) !== key) this.prefetchVersion++
    remember(this.siblingStills, slot, key)
    // Its still at this angle is in already (a floor seen from outside is the design's own still),
    // or on its way: nothing to download or render.
    if (this.prefetchOpen.has(key) || this.storedKey(key, 'still')) return false
    if (this.inFlight[part].has(`${key}|still`) || this.inFlight[part].has(`${key}|export`))
      return false
    if (shot.kind === 'unloaded') {
      // Its scans download quietly, one sibling's at a time, while the pass goes on: a sibling
      // whose scans are in may go to the GPU meanwhile.
      const loading = [...this.siblingWaits.values()].includes('loading')
      if (loading) {
        if (!this.siblingWaits.has(pair)) {
          if (this.siblingWaits.size > SIBLINGS_KEPT)
            for (const [kept, wait] of this.siblingWaits)
              if (wait === 'queued') this.siblingWaits.delete(kept)
          this.siblingWaits.set(pair, 'queued')
          this.prefetchVersion++
        }
        return false
      }
      this.siblingWaits.set(pair, 'loading')
      this.prefetchVersion++
      const settle = (loaded: boolean) => {
        this.siblingWaits.delete(pair)
        // Scans that could not be loaded leave its surfaces plain: not this design's sibling then.
        if (!loaded) this.unprefetchable.add(pair)
        this.prefetchVersion++
        this.onChange()
        this.pump()
      }
      shot.load().then(settle, () => settle(false))
      return false
    }
    if (this.siblingWaits.delete(pair)) this.prefetchVersion++
    // One on the GPU at a time: looked at again once the one on its way has landed.
    if (full) return false
    this.requestPrefetch(design, key, shot, state, job.priority)
    return true
  }

  /** A sibling not to be prefetched from this design; the pass looks at the next one. */
  private unprefetchableNow(pair: string, design: string) {
    if (this.unprefetchable.size > 4 * SIBLINGS_KEPT) this.unprefetchable.clear()
    this.unprefetchable.add(pair)
    this.prefetchVersion++
    if (TRACE_STATS) console.info(`[stills] sibling ${design} cannot be prefetched`)
    return false
  }

  private requestPrefetch(
    design: string,
    key: string,
    shot: Extract<SiblingShot, { kind: 'ready' }>,
    state: StillState,
    priority: number,
  ) {
    const size = stillSize('still', state.aspect, state.stage)
    const quality = QUALITY.still
    const part = partOf(state.angle)
    const now = performance.now()
    const own = renderRate.estimateMs({ ...size, ...quality })
    const open: PrefetchOpen = {
      focus: false,
      abort: new AbortController(),
      sentAt: now,
      estimateMs: own,
      design,
      // What a click on it waits for: whatever renders ahead of it, then itself.
      waitMs: queueEstimate(own, this.ahead(false, now)),
    }
    const opened = this.prefetchOpen
    opened.set(key, open)
    // The plan's room, and what it has of the siblings: the pass looks at the rest again, for
    // a download to start beside this one's render.
    this.prefetchVersion++
    bench.prefetch('sent')
    if (this.prefetchSpent.design !== this.design)
      this.prefetchSpent = { design: this.design, count: 0 }
    this.prefetchSpent.count++
    this.prefetchUnused++
    const pair = `${this.design}|${design}`
    // Captured now, in this task, with the scene just as its keys were read.
    shot
      .take()
      .then((captured) =>
        this.client!.frame(
          captured,
          {
            camera: shot.camera,
            ...size,
            quality,
            priority,
            finish: { exposure: state.exposure[part], gain: STILL_GAIN },
            // One generation: a prefetch is never dropped for a newer one (one is open at a time).
            generation: 0,
            channel: 'p',
          },
          open.abort.signal,
          (work) => {
            if (open.abort.signal.aborted) return
            open.work = work
            if (this.state && this.keys[this.state.angle] === key) this.onChange()
          },
        ),
      )
      .then((frame) => {
        if (open.abort.signal.aborted) return
        if (TRACE_STATS)
          console.info(
            `[stills] prefetched ${design} ${state.angle}: ${frame.cached ? 'cached' : `render ${frame.renderMs} ms`}, ${Math.round(frame.totalMs)} ms in all`,
          )
        this.answered(frame)
        if (!frame.cached) renderRate.record(frame.renderMs, { ...size, ...quality })
        this.store(key, 'still', frame.image, quality.samples, size.width)
        if (this.prefetched.size > 4 * SIBLINGS_KEPT) this.prefetched.clear()
        this.prefetched.add(key)
        bench.prefetch('landed')
        this.onChange()
      })
      .catch((error) => {
        if (open.abort.signal.aborted) return
        if (this.unloading || isAbort(error)) return
        if (error instanceof Superseded) return
        if (error instanceof Busy) return void this.busy()
        if (error instanceof Full) return void this.full()
        if (error instanceof Outdated) return this.fail(error)
        // This sibling, from this design, is left alone; the stills themselves carry on.
        this.unprefetchable.add(pair)
        if (TRACE_STATS) console.info(`[stills] prefetch of ${design} failed`, error)
      })
      .finally(() => {
        if (opened.get(key) === open) opened.delete(key)
        this.prefetchVersion++
        if (!open.abort.signal.aborted) this.pump()
      })
  }

  /**
   * The open requests a new one waits behind on the GPU: the one under way (the oldest open), and
   * any the server ranks ahead of it (what the stage waits for, ahead of the rest).
   */
  private ahead(focus: boolean, now: number) {
    return [
      ...this.inFlight.exterior.values(),
      ...this.inFlight.interior.values(),
      ...this.prefetchOpen.values(),
    ]
      .sort((a, b) => a.sentAt - b.sentAt)
      .filter((open, i) => i === 0 || (open.focus && !focus))
      .map((open) => ({ estimateMs: open.estimateMs, elapsedMs: now - open.sentAt }))
  }

  private request(job: Job) {
    const inFlight = this.inFlight[job.part]
    const channel =
      job.tier === 'export' ? 'x' : job.focus ? 'f' : job.part === 'interior' ? 'i' : 's'
    const sequence =
      channel === 'x'
        ? this.exportSeq
        : channel === 'f'
          ? this.focusSeq
          : this.generations[job.part]
    const finish = { exposure: job.exposure, gain: STILL_GAIN }
    const now = performance.now()
    const own = renderRate.estimateMs({ ...job, ...job.quality })
    const open: Open = {
      focus: job.focus,
      abort: new AbortController(),
      sentAt: now,
      estimateMs: own,
    }
    inFlight.set(job.id, open)
    this.captured!.then((captured) => {
      bench.mark('firstRequest')
      return this.client!.frame(
        captured,
        {
          camera: job.camera,
          width: job.width,
          height: job.height,
          quality: job.quality,
          priority: job.priority,
          finish,
          generation: sequence,
          channel,
        },
        open.abort.signal,
        (work) => {
          if (open.abort.signal.aborted) return
          open.work = work
          if (job.tier !== 'thumb' && this.state && this.keys[this.state.angle] === job.key)
            this.onChange()
        },
      )
    })
      .then((frame) => {
        if (open.abort.signal.aborted) return
        if (TRACE_STATS)
          console.info(
            `[stills] ${job.angle} ${job.tier} ${job.width}x${job.height}: ${frame.cached ? 'cached' : `render ${frame.renderMs} ms`}, ${Math.round(frame.totalMs)} ms in all${frame.renderer ? `, ${frame.renderer} renderer` : ''}`,
          )
        this.answered(frame)
        if (!frame.cached) renderRate.record(frame.renderMs, { ...job, ...job.quality })
        this.store(job.key, job.tier, frame.image, job.quality.samples, job.width)
        this.failures = 0
        this.busyStreak = 0
        this.onChange()
      })
      .catch((error) => {
        if (open.abort.signal.aborted) return
        if (this.unloading || isAbort(error)) return
        // Dropped by the server for a newer still on its channel; asked for again if still wanted.
        if (error instanceof Superseded) return
        if (error instanceof Busy) return void this.busy()
        if (error instanceof Full) return void this.full()
        if (error instanceof Outdated || ++this.failures >= 3) this.fail(error)
      })
      .finally(() => {
        if (inFlight.get(job.id) === open) inFlight.delete(job.id)
        if (!open.abort.signal.aborted) this.pump()
      })
  }

  /**
   * The cloud answered a frame. Only the visitor's own GPU (or a server of its own, which names no
   * renderer) counts as warm for the prefetch: the shared renderer answers while their GPU starts,
   * and it is every arriving visitor's first GPU, never to be kept busy with speculative stills.
   */
  private answered(frame: { renderer: StillFrame['renderer'] }) {
    if (frame.renderer !== 'shared') this.answeredAt = performance.now()
  }

  /**
   * Keeps a still `width` pixels wide, replacing a lesser tier's address only once the stage has
   * moved on from it. A smaller one of the same tier (one sent before the stage grew) never
   * replaces a larger one.
   */
  private store(key: string, tier: Tier, blob: Blob, samples: number, width: number) {
    const stored = this.frames.get(key) ?? {}
    const before = stored[tier]
    if (before && before.width > width) return
    if (before) this.revoke(before.url)
    stored[tier] = { blob, url: URL.createObjectURL(blob), samples, width }
    this.frames.delete(key)
    this.frames.set(key, stored)
    if (tier === 'thumb') bench.mark('firstThumb')
    while (this.frames.size > KEEP) {
      const [oldest, evicted] = this.frames.entries().next().value!
      this.frames.delete(oldest)
      for (const kept of Object.values(evicted)) if (kept) this.revoke(kept.url)
    }
  }

  /** An image may still be fading out at an address: it is revoked a while later. */
  private revoke(url: string) {
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
  }

  /** Stops the prefetch for a while: the cloud said it is busy or full. */
  private pausePrefetch(now: number) {
    this.prefetchPausedUntil = now + PREFETCH_PAUSE_MS
  }

  /** Waits out a busy server, twice as long each time in a row; the wait in milliseconds. */
  private busy() {
    const now = performance.now()
    this.pausePrefetch(now)
    if (now < this.busyUntil) return this.busyUntil - now
    const delay = Math.min(BUSY_MAX_MS, BUSY_MS * 2 ** this.busyStreak)
    this.busyStreak++
    this.busyUntil = now + delay
    this.onChange()
    setTimeout(() => this.pump(), delay)
    return delay
  }

  /**
   * Every cloud GPU is in use by other visitors: this page's own tracer renders the stage's still
   * meanwhile, where it can, and the cloud is asked again in a minute.
   */
  private full() {
    const now = performance.now()
    this.pausePrefetch(now)
    if (now < this.fullUntil) return this.fullUntil - now
    this.fullUntil = now + FULL_MS
    bench.cloud('full')
    setTimeout(() => {
      this.onChange()
      this.pump()
    }, FULL_MS)
    this.onChange()
    return FULL_MS
  }

  /** Gives up on the cloud for this page: this device's tracer, or the live view, takes over. */
  private fail(error: unknown) {
    if (this.failed || this.unloading) return
    console.warn('The path-traced stills could not be rendered in the cloud.', error)
    this.failed = true
    this.failures = 3
    bench.cloud('failed')
    this.onChange()
  }

  /**
   * Gallery mode (true) or the 360° view (false), where nothing new is asked for. A prefetch on its
   * way lands all the same: the GPU finishes it anyway, and it may be clicked on coming back.
   */
  setActive(active: boolean) {
    if (active === this.active) return
    this.active = active
    this.pump()
  }

  /**
   * Whether the visitor rests on the design, told when no frame is drawn to say so: not resting
   * (the floor plan open), nothing is prefetched either.
   */
  setIdle(idle: boolean) {
    if (!this.state || (this.state.idle === idle && (idle || !this.state.prefetch))) return
    this.state = { ...this.state, idle, prefetch: idle ? this.state.prefetch : null }
    this.pump()
  }

  /** A download or a PDF waits for the current angle's export (or no longer does). */
  wantExport(wanted: boolean) {
    if (wanted === this.exportWanted) return
    this.exportWanted = wanted
    if (wanted) this.exportSeq++
    this.pump()
  }

  /**
   * The current angle's best image of the design on screen: the export once it is in, a baked
   * still (by its address), or the stage's still.
   */
  best(): { tier: Tier; blob: Blob } | { tier: 'export'; url: string } | null {
    const state = this.state
    if (!state || this.named !== this.design) return null
    const stored = this.frames.get(this.keys[state.angle])
    if (stored?.export) return { tier: 'export', blob: stored.export.blob }
    const baked = this.bakedAt(state.angle)
    if (baked?.tier === 'export') return { tier: 'export', url: baked.url }
    if (stored?.still) return { tier: 'still', blob: stored.still.blob }
    return null
  }

  /** This device's tracer can render the stage's still when the cloud does not. */
  setLocalAvailable(available: boolean) {
    if (available === this.localAvailable) return
    this.localAvailable = available
    this.onChange()
  }

  retry() {
    this.drop('exterior')
    this.drop('interior')
    for (const open of this.prefetchOpen.values()) open.abort.abort()
    this.prefetchOpen.clear()
    if (this.state) {
      const key = this.keys[this.state.angle]
      const stored = this.frames.get(key)
      if (stored) for (const image of Object.values(stored)) this.revoke(image.url)
      this.frames.delete(key)
    }
    this.failed = false
    this.failures = 0
    this.localProgress = null
    this.sceneKey = ''
    this.captured = null
    this.capturedSettled = false
    this.planStamp = ''
    this.onChange()
  }

  /**
   * The still this device's tracer should render: the stage's, when the cloud is not rendering,
   * once the design has settled and its textures are in. Null when there is none to render.
   */
  localJob(): LocalJob | null {
    const state = this.state
    if (!state || !this.active || !this.localAvailable || this.cloudUp) return null
    if (this.named !== this.design || !this.settled) return null
    const tier = this.exportWanted ? 'export' : 'still'
    if (this.storedAt(state.angle, tier)) return null
    return { key: this.keys[state.angle], angle: state.angle, tier }
  }

  /** How far this device's tracer is with a job: the status line's measured progress. */
  reportLocal(job: LocalJob, fraction: number, remainingMs: number | null) {
    this.localProgress = { key: job.key, fraction, remainingMs }
  }

  /** A still this device's tracer rendered; kept if it is still of the design on screen. */
  deliverLocal(job: LocalJob, blob: Blob, samples: number) {
    this.localProgress = null
    if (this.keys[job.angle] !== job.key || !this.state) return
    // Traced at the canvas, which fills the stage: the stage's size, as a cloud still's.
    const { width } = stillSize(job.tier, this.state.aspect, this.state.stage)
    this.store(job.key, job.tier, blob, samples, width)
    this.onChange()
  }

  /** The stills as the stage and the filmstrip see them (stillStatus.ts). */
  snapshot(now = performance.now()): StillsSnapshot {
    const state = this.state
    const source = this.cloudUp ? 'cloud' : this.localAvailable ? 'local' : null
    if (!state || this.named !== this.design || !this.design)
      return {
        source,
        design: '',
        aspect: state?.aspect ?? null,
        images: {},
        pending: {},
        progress: null,
      }
    const images: StillsSnapshot['images'] = {}
    const pending: StillsSnapshot['pending'] = {}
    for (const angle of ANGLES) {
      const stored = this.frames.get(this.keys[angle])
      const still = stored?.export ?? stored?.still
      const shown: AngleImages = {}
      if (stored?.thumb)
        shown.thumb = {
          tier: 'thumb',
          url: stored.thumb.url,
          samples: stored.thumb.samples,
          width: stored.thumb.width,
        }
      if (still)
        shown.still = {
          tier: stored?.export ? 'export' : 'still',
          url: still.url,
          samples: still.samples,
          width: still.width,
        }
      if (shown.thumb || shown.still) images[angle] = shown
      // The stage's angle waits for its still; the others for a thumbnail, from the cloud alone.
      // A baked still waits for nothing: the stage and the filmstrip take it from the manifest
      // (a quick bake only stands in on the stage, while its still renders).
      const baked = this.bakedAt(angle)
      if (angle === state.angle)
        pending[angle] = source !== null && !still && baked?.tier !== 'export'
      else pending[angle] = source === 'cloud' && !still && !stored?.thumb && !baked
    }
    return {
      source,
      design: this.design,
      aspect: state.aspect,
      images,
      pending,
      progress:
        pending[state.angle] ||
        (source === null &&
          !images[state.angle]?.still &&
          this.bakedAt(state.angle)?.tier !== 'export')
          ? this.progress(state, source, now)
          : null,
    }
  }

  /** Only observations: sample counts locally, request lifecycle in the cloud. */
  private progress(
    state: StillState,
    source: 'cloud' | 'local' | null,
    now: number,
  ): StillProgress {
    const key = this.keys[state.angle]
    if (source === 'local') {
      const local = this.localProgress
      if (local?.key !== key) return { kind: 'stage', stage: 'preparing' }
      const measured: StillProgress = {
        kind: 'measured',
        fraction: local.fraction,
        remainingMs: local.remainingMs,
      }
      return measured
    }
    if (now < this.busyUntil || now < this.fullUntil) return { kind: 'stage', stage: 'retrying' }
    if (!source) return { kind: 'stage', stage: 'unavailable' }
    const open =
      this.inFlight[partOf(state.angle)].get(`${key}|still`) ?? this.prefetchOpen.get(key)
    if (open) return { kind: 'stage', ...(open.work ?? { stage: 'preparing' }) }
    return { kind: 'stage', stage: 'preparing' }
  }

  /**
   * Bake mode (lib/bake.ts): whether the design's stills can be baked now ('ready': its scene is
   * captured with the textures in), not yet, or never (the cloud gave up on the page).
   */
  bakeState(): 'ready' | 'waiting' | 'failed' {
    if (this.failed || !this.client) return 'failed'
    const captured = this.captured && this.capturedSettled
    return captured && this.named === this.design && this.ready ? 'ready' : 'waiting'
  }

  /**
   * Bake mode: renders `jobs` (bake.ts, every angle at every stage shape) as the session renders
   * stills, a few at a time, and hands each finished frame to `onFrame`. A busy server is waited
   * out; any other failure fails the bake. Resolves with the lighting look and the gains it was
   * baked with (STILL_GAIN, for the manifest's record).
   */
  async bake(jobs: BakeJob[], onFrame: (job: BakeJob, frame: StillFrame) => void) {
    if (this.bakeState() !== 'ready') throw new Error('the design is not ready to bake')
    const captured = await this.captured!
    const gains = { exterior: STILL_GAIN, interior: STILL_GAIN }
    const { exposure } = this.state!
    const lighting = this.lighting
    const queue = jobs.map((job, i) => ({ job, priority: Math.min(MAX_PRIORITY, i) }))
    const render = async ({ job, priority }: (typeof queue)[number]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.client!.frame(
            captured,
            {
              camera: job.camera,
              width: job.width,
              height: job.height,
              quality: job.quality,
              finish: { exposure: exposure[job.part], gain: STILL_GAIN },
              priority,
              generation: 0,
              channel: 'b',
            },
            this.closed.signal,
          )
        } catch (error) {
          const busy = error instanceof Busy || error instanceof Superseded
          if (!(busy || error instanceof Full) || attempt >= BAKE_RETRIES) throw error
          await sleep(busy ? Math.min(BUSY_MAX_MS, BUSY_MS * 2 ** attempt) : FULL_MS)
        }
      }
    }
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift())
        onFrame(next.job, await render(next))
    }
    await Promise.all(Array.from({ length: Math.min(BAKE_IN_FLIGHT, jobs.length) }, worker))
    return { lighting, gains }
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.resume)
    window.removeEventListener('beforeunload', this.unload)
    window.removeEventListener('pagehide', this.unload)
    clearTimeout(this.settleTimer)
    clearTimeout(this.quietTimer)
    clearTimeout(this.prefetchTimer)
    for (const part of PARTS) this.drop(part)
    for (const open of this.prefetchOpen.values()) open.abort.abort()
    this.prefetchOpen = new Map()
    this.closed.abort()
    for (const stored of this.frames.values())
      for (const kept of Object.values(stored)) if (kept) URL.revokeObjectURL(kept.url)
    this.frames.clear()
  }
}
