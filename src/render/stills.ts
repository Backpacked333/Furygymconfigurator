import { Matrix4, Vector3, type Scene } from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import {
  Busy,
  Full,
  Outdated,
  Superseded,
  captureScene,
  type CapturedScene,
  type CloudCamera,
  type CloudClient,
} from './cloud'
import { bench } from './bench'
import {
  ASPECT_RATIO,
  GALLERY_ANGLES,
  galleryAngle,
  type AngleId,
  type AspectClass,
  type GalleryCamera,
} from './gallery'
import { fingerprint } from './hash'
import { lookKey } from './pathtrace'
import { TIER_RANK, planStills, type PlannedJob, type Tier } from './plan'
import { FIRST_FRAME_MS, queueEstimate, renderRate } from './progress'
import type { AngleImages, StillProgress, StillsSnapshot } from './stillStatus'

export type { Tier }

/**
 * The gallery's path-traced stills. Each gallery angle (gallery.ts) of the design on screen is
 * rendered as a finished still by the visitor's cloud GPU (render-server/), at three tiers: a
 * thumbnail for the filmstrip, the still the stage shows, and an export for downloads and the
 * PDF. The stage swaps a still in only once it is the real thing: nothing is asked for before
 * the scanned textures are in and the exposure is metered, so a still is never a stand-in that
 * a better one replaces in front of the visitor.
 *
 * What the stage waits for comes first (plan.ts): the current angle's still, on a channel of its
 * own; then a thumbnail of every other angle; then, once the visitor rests on the design, their
 * stills. The server finishes stills (exposure, bloom, tone mapping) and keeps them by content,
 * so a design anyone has viewed before comes back from its cache.
 *
 * Without a cloud (none configured, every GPU in use, or one that gave up for the page), the
 * page's own tracer renders the current angle's still where WebGPU allows (RenderEffects asks
 * `localJob` and hands the result to `deliverLocal`), and the same store keeps it.
 */

/** Render settings by tier. */
export const QUALITY: Record<Tier, Quality> = {
  thumb: { samples: 64, threshold: 0, timeLimit: 6 },
  still: { samples: 256, threshold: 0, timeLimit: 20 },
  export: { samples: 1024, threshold: 0.01, timeLimit: 60 },
}
/** The exposure meter's frame: denoised, its mean brightness settles within a few samples. */
const METER = { samples: 16, threshold: 0, timeLimit: 4 }
/** The meter's frame keeps the raster's full size: a much smaller frame reads brighter. */
const METER_MAX_EDGE = 3200
/** A thumbnail's width, in pixels. */
export const THUMB_WIDTH = 320
/** A stage still is rendered at the stage's size at up to this density, its long edge capped. */
export const STILL_MAX_DPR = 1.5
export const STILL_LONG_EDGE = 1920
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
/** The exposure is metered once the design has held still this long (a slider drag is many). */
export const METER_DEBOUNCE_MS = 400
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
/** An evicted still's address stays valid this long, for an image still fading out. */
const REVOKE_AFTER_MS = 30_000

/** `?traceStats=1` logs the exposure match and each still's timing. */
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
const ANGLES = GALLERY_ANGLES.map((a) => a.id)

const UP = new Vector3(0, 1, 0)
/** The camera the server renders a gallery angle with, looking at its target. */
export function cloudCamera(camera: GalleryCamera, near: number, far: number): CloudCamera {
  const eye = new Vector3(...camera.position)
  const matrix = new Matrix4().lookAt(eye, new Vector3(...camera.target), UP).setPosition(eye)
  return { matrix: Array.from(matrix.elements), fov: camera.fov, near, far }
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
  /** The renderer's exposure outside and inside (a camera inside opens up for the dimmer room). */
  exposure: { exterior: number; interior: number }
  /** The design has held still a while and the floor plan is closed: the longer renders go out. */
  idle: boolean
}

/** The raster frame's brightness (mean log luminance), and the camera and size it was seen at. */
export type RasterMeter = { key: number; camera: CloudCamera; width: number; height: number }
/** Meters the raster frame at a camera, for StillSession. */
export type MeterRaster = (camera: CloudCamera) => Promise<RasterMeter>
/** Exposure gains, one for each part: the raster interior is lit more generously than outside. */
type Gains = { exterior: number; interior: number }

/** An angle's images by tier, and the address each is shown at. */
type Stored = Partial<Record<Tier, { blob: Blob; url: string }>>

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
type Open = { focus: boolean; abort: AbortController; sentAt: number; estimateMs: number }
/** A still for this device's tracer to render: RenderEffects traces it and hands it back. */
export type LocalJob = { key: string; angle: AngleId; tier: Exclude<Tier, 'thumb'> }

/** A request the browser cut short (the page unloading, or a signal of ours). */
const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === 'AbortError'

/**
 * Renders and keeps the gallery's stills for the design on screen, and says which are ready and
 * which are on their way (`snapshot`). The exposure gains are metered once per lighting look, at
 * fixed angles, so a finish change never shifts brightness, as a camera on manual exposure would
 * not, and the same design always gets the same still.
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
  /** Cancels metering, which outlives design changes, when the session closes. */
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
  /** The gains for the look, or null until its meter answers. */
  private gain: Gains | null = null
  private gainSettled = false
  private readonly gains = new Map<string, { gains: Gains; settled: boolean }>()
  private metering = 0
  private meteredBefore = false
  private meterTimer: ReturnType<typeof setTimeout> | undefined
  private meterAbort: AbortController | null = null
  private meterHeld = false
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
  /**
   * When the still the stage waits for became wanted, and how long it should take in all: the
   * status line's estimate. Updated, not restarted, when its request goes out.
   */
  private wait: { key: string; startedAt: number; expectedMs: number } | null = null
  /** This device's tracer can render stills (WebGPU), and how far it is with one. */
  private localAvailable = false
  private localProgress: { key: string; fraction: number; remainingMs: number | null } | null = null
  private unloading = false

  constructor(client: CloudClient | null, onChange: () => void) {
    this.client = client
    this.onChange = onChange
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
  sync(
    scene: Scene,
    look: SkyLook,
    keys: SceneKeys,
    state: StillState,
    rasterKey: MeterRaster,
    settled = true,
  ) {
    this.state = state
    const now = performance.now()
    const lighting = lookKey(look)
    const { designs, held } = this.take({
      exterior: `${keys.exterior}|${lighting}`,
      interior: `${keys.interior}|${lighting}`,
    })
    if (state.design !== this.design) {
      this.design = state.design
      this.designSince = now
    }
    const latched = this.latch(settled, now)
    const metered = this.client !== null && !this.failed
    if (held) {
      // A scene on its way to a new key: a meter under way would read a scene about to change.
      if (metered) this.holdMeter()
      this.designSince = now
      this.name(now)
      this.pump()
      return
    }
    const restart = this.meterHeld && metered
    this.meterHeld = false
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
    if (fresh.length) {
      if (!this.failed) this.failures = 0
      this.stopMeter()
    }
    this.designs = designs
    const sceneKey = `${designs.exterior}|${designs.interior}`
    // Captured for a new scene, and again once its textures are in.
    if (
      metered &&
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
    // Metered once per look, with the textures in: nothing is rendered before they are, so a
    // meter without them would cost the GPU a frame for nothing.
    if (fresh.length) {
      const known = this.gains.get(lighting)
      this.gain = known?.gains ?? null
      this.gainSettled = known?.settled ?? false
      if (metered && latched && !known?.settled) this.startMeter(lighting, rasterKey)
    } else if (metered && latched && (restart || (arrived && !this.gainSettled))) {
      // The textures came in under the same scene: they change its brightness. Once per look.
      this.startMeter(lighting, rasterKey)
    }
    this.rekey(state)
    this.name(now)
    this.pump()
  }

  /** Each angle's key, from its part's scene, its angle key, the stage's shape and its camera. */
  private rekey(state: StillState) {
    for (const angle of ANGLES) {
      const camera = state.cameras[angle]
      const lens = fingerprint(
        `${camera.matrix.map((v) => v.toFixed(3)).join(',')}|${camera.fov.toFixed(3)}`,
      )
      const part = partOf(angle)
      this.keys[angle] =
        `${part[0]}|${this.designs[part]}|${state.angleKeys[angle]}|${state.aspect}|${lens}`
    }
  }

  /**
   * Names the design's stills once its scene has held QUIET_MS; a timer sees the wait through in
   * case no frame is drawn by then.
   */
  private name(now: number) {
    if (this.named === this.design) return
    clearTimeout(this.quietTimer)
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

  /**
   * Meters the gain for a look. The page's first design is metered at once; a changed design
   * once it has held still for a moment, since a slider drag is a run of designs. The design must
   * hold still meanwhile too, so the traced render and the raster frame show the same scene; if
   * it changes, the meter is dropped and the next design meters again. Metered before the
   * textures, it is metered again once they are in.
   */
  private startMeter(lighting: string, rasterKey: MeterRaster) {
    const delay = this.meteredBefore ? METER_DEBOUNCE_MS : 0
    this.meteredBefore = true
    this.stopMeter()
    const token = this.metering
    this.meterTimer = setTimeout(() => {
      this.meterTimer = undefined
      this.runMeter(token, lighting, rasterKey)
    }, delay)
  }

  /** Stops a meter waiting or under way while the scene is on its way to a new key (`take`). */
  private holdMeter() {
    if (this.meterTimer === undefined && this.meterAbort === null) return
    this.stopMeter()
    this.meterHeld = true
  }

  /** Drops the metering waiting or under way; whatever it answers is ignored. */
  private stopMeter() {
    this.metering++
    clearTimeout(this.meterTimer)
    this.meterTimer = undefined
    this.meterAbort?.abort()
    this.meterAbort = null
  }

  private runMeter(token: number, lighting: string, rasterKey: MeterRaster) {
    if (token !== this.metering || this.closed.signal.aborted) return
    const settled = this.settled
    const controller = new AbortController()
    this.meterAbort = controller
    const settle = (gains: Gains | null) => {
      if (token !== this.metering || this.closed.signal.aborted) return
      this.meterAbort = null
      if (gains) this.gains.set(lighting, { gains, settled })
      this.gain = gains ?? { exterior: 1, interior: 1 }
      this.gainSettled = settled
      this.onChange()
      this.pump()
    }
    this.meterParts(rasterKey, controller.signal).then(settle, (error) => {
      if (token !== this.metering || this.closed.signal.aborted) return
      if (this.unloading || isAbort(error)) return
      if (error instanceof Outdated) return this.fail(error)
      const delay = error instanceof Busy ? this.busy() : error instanceof Full ? this.full() : 0
      if (delay > 0) {
        this.meterAbort = null
        this.meterTimer = setTimeout(() => {
          this.meterTimer = undefined
          this.runMeter(token, lighting, rasterKey)
        }, delay)
        return
      }
      console.warn('The path-traced exposure could not be metered.', error)
      settle(null)
    })
  }

  /**
   * Both parts' gains, metered at fixed angles (the front three-quarter view outside, the entry
   * inside): the same design always gets the same gain, so its stills match the server's cache.
   */
  private async meterParts(rasterKey: MeterRaster, signal: AbortSignal): Promise<Gains> {
    const captured = await this.captured!
    signal.throwIfAborted()
    const { cameras } = this.state!
    const exterior = await this.meter(
      captured,
      rasterKey,
      cameras['front-left'],
      'exterior',
      signal,
    )
    const interior = await this.meter(captured, rasterKey, cameras.entry, 'interior', signal)
    return { exterior, interior }
  }

  /**
   * The exposure gain that matches the raster frame's brightness: a quick traced frame of the
   * same view, at the same camera and size, metered the same way by the server.
   */
  private async meter(
    captured: CapturedScene,
    rasterKey: MeterRaster,
    camera: CloudCamera,
    part: Part,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    const raster = await rasterKey(camera)
    signal.throwIfAborted()
    const scale = Math.min(1, METER_MAX_EDGE / Math.max(raster.width, raster.height))
    bench.mark('firstRequest')
    const frame = await this.client!.frame(
      captured,
      {
        camera: raster.camera,
        width: Math.max(1, Math.round(raster.width * scale)),
        height: Math.max(1, Math.round(raster.height * scale)),
        quality: METER,
        finish: { exposure: 1, gain: 1 },
        priority: 0,
        generation: 0,
        channel: 'm',
      },
      signal,
    )
    const traced = frame.tracedKey
    const ratio = Math.exp(raster.key - traced)
    if (!Number.isFinite(ratio)) throw new Error(`no exposure reading (${raster.key}, ${traced})`)
    const gain = Math.min(4, Math.max(0.5, ratio))
    if (TRACE_STATS)
      console.info(
        `[stills] ${part} exposure for ${this.designs[part]}: raster key ${raster.key.toFixed(3)}, traced key ${traced.toFixed(3)}, gain ${gain.toFixed(3)}`,
      )
    return gain
  }

  /** Everything a still needs is in: the textures, and the exposure metered with them. */
  private get ready() {
    return this.gain !== null && this.settled && this.gainSettled
  }

  /** Whether an angle's still is stored at a tier or a better one. */
  private storedAt(angle: AngleId, tier: Tier) {
    const best = bestTier(this.frames.get(this.keys[angle]))
    return best !== null && TIER_RANK[best] >= TIER_RANK[tier]
  }

  private inFlightFor(angle: AngleId, tier: Tier) {
    return this.inFlight[partOf(angle)].has(`${this.keys[angle]}|${tier}`)
  }

  /** The stills still to render, most wanted first (plan.ts), with everything a request needs. */
  private plan(state: StillState): Job[] {
    return planStills(
      {
        angles: ANGLES,
        current: state.angle,
        has: (angle, tier) => this.storedAt(angle, tier) || this.inFlightFor(angle, tier),
        stored: (angle, tier) => this.storedAt(angle, tier),
        idle: state.idle,
        exportWanted: this.exportWanted,
      },
      (angle) => partOf(angle),
    ).map((planned) => this.job(state, planned))
  }

  private job(state: StillState, planned: PlannedJob): Job {
    const key = this.keys[planned.angle]
    const part = partOf(planned.angle)
    return {
      ...planned,
      key,
      id: `${key}|${planned.tier}`,
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
    const flying = () => this.inFlight.exterior.size + this.inFlight.interior.size
    const stamp = (inFlight: number) =>
      [
        this.designs.exterior,
        this.designs.interior,
        focusKey,
        state.idle,
        state.aspect,
        `${state.stage.width}x${state.stage.height}@${state.stage.dpr}`,
        this.frames.size,
        inFlight,
      ].join('|')
    if (stamp(flying()) !== this.planStamp) this.planned = this.plan(state)
    let open = 0
    for (const part of PARTS)
      for (const { focus } of this.inFlight[part].values()) if (!focus) open++
    for (const job of this.planned) {
      if (this.inFlight[job.part].has(job.id) || this.storedAt(job.angle, job.tier)) continue
      if (!job.focus && open >= IN_FLIGHT) break
      if (!job.focus) open++
      this.request(job)
    }
    this.planStamp = stamp(flying())
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
    const gains = this.gain ?? { exterior: 1, interior: 1 }
    const finish = { exposure: job.exposure, gain: gains[job.part] }
    const now = performance.now()
    const own = renderRate.estimateMs({ ...job, ...job.quality })
    // The GPU renders one still at a time: the one under way (the oldest open) finishes first,
    // and anything the server ranks ahead of this one.
    const ahead = [...this.inFlight.exterior.values(), ...this.inFlight.interior.values()]
      .sort((a, b) => a.sentAt - b.sentAt)
      .filter((open, i) => i === 0 || (open.focus && !job.focus))
      .map((open) => ({ estimateMs: open.estimateMs, elapsedMs: now - open.sentAt }))
    const open: Open = {
      focus: job.focus,
      abort: new AbortController(),
      sentAt: now,
      estimateMs: own,
    }
    inFlight.set(job.id, open)
    // The status line's estimate: from when the still became wanted, its wait from here on.
    if (job.focus && job.tier === 'still') {
      const startedAt = this.wait?.key === job.key ? this.wait.startedAt : now
      this.wait = {
        key: job.key,
        startedAt,
        expectedMs: now - startedAt + queueEstimate(own, ahead),
      }
    }
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
      )
    })
      .then((frame) => {
        if (open.abort.signal.aborted) return
        if (TRACE_STATS)
          console.info(
            `[stills] ${job.angle} ${job.tier} ${job.width}x${job.height}: ${frame.cached ? 'cached' : `render ${frame.renderMs} ms`}, ${Math.round(frame.totalMs)} ms in all${frame.renderer ? `, ${frame.renderer} renderer` : ''}`,
          )
        if (!frame.cached) renderRate.record(frame.renderMs, { ...job, ...job.quality })
        this.store(job.key, job.tier, frame.image)
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

  /** Keeps a still, replacing a lesser tier's address only once the stage has moved on from it. */
  private store(key: string, tier: Tier, blob: Blob) {
    const stored = this.frames.get(key) ?? {}
    const before = stored[tier]
    if (before) this.revoke(before.url)
    stored[tier] = { blob, url: URL.createObjectURL(blob) }
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

  /** Waits out a busy server, twice as long each time in a row; the wait in milliseconds. */
  private busy() {
    const now = performance.now()
    if (now < this.busyUntil) return this.busyUntil - now
    const delay = Math.min(BUSY_MAX_MS, BUSY_MS * 2 ** this.busyStreak)
    this.busyStreak++
    this.busyUntil = now + delay
    setTimeout(() => this.pump(), delay)
    return delay
  }

  /**
   * Every cloud GPU is in use by other visitors: this page's own tracer renders the stage's still
   * meanwhile, where it can, and the cloud is asked again in a minute.
   */
  private full() {
    const now = performance.now()
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

  /** Gallery mode (true) or the 360° view (false), where nothing new is asked for. */
  setActive(active: boolean) {
    if (active === this.active) return
    this.active = active
    this.pump()
  }

  /** Whether the visitor rests on the design, told when no frame is drawn to say so. */
  setIdle(idle: boolean) {
    if (!this.state || this.state.idle === idle) return
    this.state = { ...this.state, idle }
    this.pump()
  }

  /** A download or a PDF waits for the current angle's export (or no longer does). */
  wantExport(wanted: boolean) {
    if (wanted === this.exportWanted) return
    this.exportWanted = wanted
    if (wanted) this.exportSeq++
    this.pump()
  }

  /** The current angle's best image of the design on screen (the export, once it is in). */
  best(): { tier: Tier; blob: Blob } | null {
    const state = this.state
    if (!state || this.named !== this.design) return null
    const stored = this.frames.get(this.keys[state.angle])
    const tier = bestTier(stored)
    if (!stored || !tier || tier === 'thumb') return null
    return { tier, blob: stored[tier]!.blob }
  }

  /** This device's tracer can render the stage's still when the cloud does not. */
  setLocalAvailable(available: boolean) {
    if (available === this.localAvailable) return
    this.localAvailable = available
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
  deliverLocal(job: LocalJob, blob: Blob) {
    this.localProgress = null
    if (this.keys[job.angle] !== job.key) return
    this.store(job.key, job.tier, blob)
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
      if (stored?.thumb) shown.thumb = { tier: 'thumb', url: stored.thumb.url }
      if (still) shown.still = { tier: stored?.export ? 'export' : 'still', url: still.url }
      if (shown.thumb || shown.still) images[angle] = shown
      // The stage's angle waits for its still; the others for a thumbnail, from the cloud alone.
      if (angle === state.angle) pending[angle] = source !== null && !still
      else pending[angle] = source === 'cloud' && !still && !stored?.thumb
    }
    return {
      source,
      design: this.design,
      aspect: state.aspect,
      images,
      pending,
      progress: pending[state.angle] ? this.progress(state, source, now) : null,
    }
  }

  /** How far the stage's still is: measured on this device, estimated for the cloud. */
  private progress(state: StillState, source: 'cloud' | 'local' | null, now: number) {
    const key = this.keys[state.angle]
    if (source === 'local') {
      const local = this.localProgress
      const measured: StillProgress = {
        kind: 'measured',
        fraction: local?.key === key ? local.fraction : 0,
        remainingMs: local?.key === key ? local.remainingMs : null,
      }
      return measured
    }
    if (this.wait?.key !== key) {
      // Not asked for yet: the textures, and the meter's two frames, come first.
      const own = renderRate.estimateMs({
        ...stillSize('still', state.aspect, state.stage),
        ...QUALITY.still,
      })
      const meter = this.gain === null ? 2 * renderRate.estimateMs({ ...state.stage, ...METER }) : 0
      const first = renderRate.learned() ? 0 : FIRST_FRAME_MS
      this.wait = {
        key,
        startedAt: now,
        expectedMs: own + meter + first + (this.settled ? 0 : SETTLE_MS),
      }
    }
    const estimate: StillProgress = {
      kind: 'estimate',
      startedAt: this.wait.startedAt,
      expectedMs: this.wait.expectedMs,
    }
    return estimate
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.resume)
    window.removeEventListener('beforeunload', this.unload)
    window.removeEventListener('pagehide', this.unload)
    clearTimeout(this.settleTimer)
    clearTimeout(this.quietTimer)
    this.stopMeter()
    for (const part of PARTS) this.drop(part)
    this.closed.abort()
    for (const stored of this.frames.values())
      for (const kept of Object.values(stored)) if (kept) URL.revokeObjectURL(kept.url)
    this.frames.clear()
  }
}
