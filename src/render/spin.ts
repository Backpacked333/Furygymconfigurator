import {
  LinearFilter,
  Matrix4,
  RepeatWrapping,
  Spherical,
  Texture,
  Vector3,
  type Scene,
} from 'three/webgpu'
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
import { ORBIT_LIMITS } from './orbit'
import { lookKey } from './pathtrace'
import { planJobs, type FrameRef, type PlannedJob, type Tier } from './plan'
import { GATE_MAX_MS } from './traceStatus'

export { GATE_MAX_MS }
export type { Tier }

/**
 * The path-traced spin. With a cloud renderer the exterior steps through a ring of pre-rendered,
 * path-traced frames, 36 angles (every 10°) at two distances, like a 360° product spin. The
 * interior is one 360° panorama, so looking around it stays path traced at any angle. (A second
 * pass over the 5° angles in between, once the ring is covered, is deferred.)
 *
 * The live view is never held back: the real-time renderer draws first (and the local path tracer
 * refines it where it can), and the frames arrive over it as they are rendered. Each visitor has
 * one GPU of their own. Coverage comes first (plan.ts): the frame the visitor looks at as a quick
 * preview, then the rest of the ring outward from it, so that wherever they turn a frame is soon
 * there; good quality follows once the previews around them are done, and the full render is made
 * only for an export. The server finishes frames (exposure, bloom, tone mapping) and keeps them,
 * so a design someone has viewed before comes back from its cache.
 */

export const SPIN_STEPS = 36
const STEP = (Math.PI * 2) / SPIN_STEPS
/** Closer and lower, and the framed view: distance factor and polar offset. */
export const SPIN_LEVELS = [
  { radius: 0.72, polar: 0.06 },
  { radius: 1, polar: 0 },
] as const
export const DEFAULT_LEVEL = 1

/** Render settings by tier: a quick preview, good enough to rest on, the full render (exports). */
const QUALITY: Record<Tier, Quality> = {
  preview: { samples: 64, threshold: 0, timeLimit: 4 },
  good: { samples: 256, threshold: 0, timeLimit: 6 },
  final: { samples: 1024, threshold: 0.01, timeLimit: 15 },
}
/** A panorama has many more pixels; the gateway allows it a longer time limit. */
const PANORAMA_QUALITY: Record<Tier, Quality> = {
  preview: QUALITY.preview,
  good: { samples: 256, threshold: 0, timeLimit: 20 },
  final: { samples: 1024, threshold: 0.01, timeLimit: 60 },
}
/** The exposure meter's frame: denoised, its mean brightness settles within a few samples. */
const METER = { samples: 16, threshold: 0, timeLimit: 4 }
/**
 * Longest edge of a frame by tier. Previews are rendered at the screen's CSS size (the present
 * pass stretches them to the viewport), the other tiers at its device size.
 */
const LONG_EDGE: Record<Tier, number> = { preview: 1200, good: 1920, final: 3200 }
/** The meter's frame keeps the raster's full size: a much smaller frame reads brighter. */
const METER_MAX_EDGE = 3200
const TIER_RANK: Record<Tier, number> = { preview: 0, good: 1, final: 2 }
/**
 * Requests kept open at once, besides those for what the visitor looks at, which go out at once.
 * The visitor's GPU renders one frame at a time; a few more queued keep it busy across round trips.
 */
const IN_FLIGHT = 3
/** A busy server is asked again after this long, doubled each time in a row, up to the cap. */
const BUSY_MS = 2000
const BUSY_MAX_MS = 30_000
/** Every cloud GPU in use: this page renders on its own device and asks again after this long. */
const FULL_MS = 60_000
/** The exposure is metered once the design has held still this long (a slider drag is many). */
export const METER_DEBOUNCE_MS = 400
/** Decoded frames kept as textures: the current one and its neighbours. */
const DECODED = 12
/** How long after a turn the spin counts as still drifting that way. */
export const DRIFT_MS = 500

/** `?traceStats=1` logs the exposure match and each frame's timing. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

type Quality = { samples: number; threshold: number; timeLimit: number }

/** The ring: where the camera orbits, at what distance and height for the framed view. */
export type SpinSpec = { target: Vector3; radius: number; polar: number }
/** A frame of the spin: a distance level and one of 36 azimuths. */
export type SpinPose = { level: number; azimuth: number }

const spherical = new Spherical()
const offset = new Vector3()
const wrap = (a: number) => ((a % SPIN_STEPS) + SPIN_STEPS) % SPIN_STEPS

/** The ring for a framed exterior view. */
export function specFrom(position: Vector3, target: Vector3): SpinSpec {
  spherical.setFromVector3(offset.copy(position).sub(target))
  return { target: target.clone(), radius: spherical.radius, polar: spherical.phi }
}

/** A level's distance and polar angle, kept within the exterior orbit's limits. */
export function levelOrbit(spec: SpinSpec, level: number) {
  const l = SPIN_LEVELS[level]
  return {
    radius: Math.min(
      ORBIT_LIMITS.maxDistance,
      Math.max(ORBIT_LIMITS.minDistance, spec.radius * l.radius),
    ),
    polar: Math.min(
      ORBIT_LIMITS.maxPolarAngle,
      Math.max(ORBIT_LIMITS.minPolarAngle, spec.polar + l.polar),
    ),
  }
}

export function spinPosition(spec: SpinSpec, pose: SpinPose, out = new Vector3()) {
  const { radius, polar } = levelOrbit(spec, pose.level)
  spherical.set(radius, polar, pose.azimuth * STEP)
  return out.setFromSpherical(spherical).add(spec.target)
}

/** The frame nearest a camera position: the closest azimuth, and the level nearest in distance. */
export function nearestSpinPose(spec: SpinSpec, position: Vector3): SpinPose {
  spherical.setFromVector3(offset.copy(position).sub(spec.target))
  const { theta, phi, radius } = spherical
  let level = DEFAULT_LEVEL,
    best = Infinity
  for (let l = 0; l < SPIN_LEVELS.length; l++) {
    const o = levelOrbit(spec, l)
    const d = (Math.log(radius / o.radius) / Math.log(1.2)) ** 2 + ((phi - o.polar) / 0.12) ** 2
    if (d < best) [best, level] = [d, l]
  }
  return { level, azimuth: wrap(Math.round(theta / STEP)) }
}

/** The camera the server renders a frame with, looking at the target as OrbitControls does. */
export function spinCamera(
  spec: SpinSpec,
  pose: SpinPose,
  lens: { fov: number; near: number; far: number },
): CloudCamera {
  const eye = spinPosition(spec, pose)
  const matrix = new Matrix4().lookAt(eye, spec.target, new Vector3(0, 1, 0)).setPosition(eye)
  return { matrix: Array.from(matrix.elements), ...lens }
}

/** The azimuths of a ring, nearest to `center` first, alternating sides. */
export function ringOrder(center: number) {
  const order = [wrap(center)]
  for (let d = 1; order.length < SPIN_STEPS; d++) {
    order.push(wrap(center + d))
    if (order.length < SPIN_STEPS) order.push(wrap(center - d))
  }
  return order
}

/** The shorter way around from one azimuth to another: 1 ahead, -1 behind, 0 for the same. */
export function turnDirection(from: number, to: number): -1 | 0 | 1 {
  const step = wrap(to - from)
  return step === 0 ? 0 : step <= SPIN_STEPS / 2 ? 1 : -1
}

/**
 * Where a panorama pixel looks, for a camera with no rotation (measured from Cycles'
 * equirectangular camera): u = 0.5 + atan2(x, -z) / 2π, v = acos(y) / π from the top.
 */
export function panoramaUV(direction: Vector3) {
  const d = direction.clone().normalize()
  return {
    u: 0.5 + Math.atan2(d.x, -d.z) / (2 * Math.PI),
    v: Math.acos(Math.min(1, Math.max(-1, d.y))) / Math.PI,
  }
}

/** The exterior spin as CameraRig set it this frame, for RenderEffects (both in one Canvas). */
export const spinView: {
  spec: SpinSpec | null
  pose: SpinPose | null
  /** The way the visitor last turned, and when: that side of the ring renders first for a while. */
  drift: -1 | 0 | 1
  turned: number
} = { spec: null, pose: null, drift: 0, turned: 0 }

/** The way the visitor is turning now: the last turn's, until DRIFT_MS still. */
export function spinDrift(now: number): -1 | 0 | 1 {
  return now - spinView.turned < DRIFT_MS ? spinView.drift : 0
}

type Lens = { fov: number; near: number; far: number }

/**
 * The scene as each view's frames see it (pathtrace.ts sceneSignature by part): the exterior
 * ring's, and the panorama's. Either changing renders only that view again.
 */
export type SceneKeys = { exterior: string; interior: string }
/** A view of the spin, which keeps its frames and requests on its own: `e|` keys or `i|` keys. */
type Part = keyof SceneKeys
const PARTS: Part[] = ['exterior', 'interior']
/** The view a frame key (or a job id, which starts with one) belongs to. */
const partOf = (key: string): Part => (key.startsWith('i|') ? 'interior' : 'exterior')

/** What the visitor is looking at, and what to have ready next, as SpinSession needs it. */
export type SpinState = {
  active: 'exterior' | 'interior'
  /** The drawing buffer, and its device pixels per CSS pixel: previews are rendered at CSS size. */
  width: number
  height: number
  dpr: number
  /** The exterior spin; null until CameraRig has framed it. */
  exterior: { spec: SpinSpec; pose: SpinPose; lens: Lens } | null
  /**
   * The interior panorama (equirectangular, twice as wide as high) from the interior's eye, its
   * width at the screen's density, and the interior's framed view, at which its exposure is
   * metered.
   */
  interior: { eye: Vector3; width: number; lens: Lens; view: CloudCamera }
  /** The renderer's exposure outside and inside (a camera inside opens up for the dimmer room). */
  exposure: { exterior: number; interior: number }
  /** The way the visitor is turning (spinDrift): that side of the ring renders first. */
  drift: -1 | 0 | 1
  /** The design has held still a while and the floor plan is closed: frames are fetched ahead. */
  idle: boolean
}

/** The raster frame's brightness (mean log luminance), and the camera and size it was seen at. */
export type RasterMeter = { key: number; camera: CloudCamera; width: number; height: number }
/** Meters the raster frame at a camera (null: the camera as it is), for SpinSession. */
export type MeterRaster = (camera: CloudCamera | null) => Promise<RasterMeter>
/** Exposure gains, one for each view: the raster interior is lit more generously than outside. */
type Gains = { exterior: number; interior: number }

/** Progress for the first-open gate (App.tsx SpinLoading) and the status badge. */
export type SpinProgress = {
  /** The frame the visitor looks at (the panorama inside) is not on screen yet, at any tier. */
  loading: boolean
  /** Frames of the current ring ready, at least as previews (the panorama counts as one). */
  ready: number
  total: number
  /** Of those, at good quality or better (the full render is made only for an export). */
  good: number
  /** The cloud answered an image in the last few minutes: its GPU is probably still on. */
  warm: boolean
  /** Milliseconds since the session first had a design to render: the gate's clock. */
  gateMs: number
  failed: boolean
}

/** A frame's images by tier, the size each was rendered at, and whether they came early. */
export type Stored = {
  preview?: Blob
  good?: Blob
  final?: Blob
  /** Keys leave the pixel size out, so a resize keeps the frames; this says what each one is. */
  sizes: Partial<Record<Tier, { width: number; height: number }>>
  /**
   * Whether they were rendered before the scene settled (textures still arriving). All of them
   * were, or none: the first frame rendered with the textures in replaces the stand-ins.
   */
  provisional: boolean
}

/** The best tier a frame is stored at, or null for none. */
export function bestTier(stored: Stored): Tier | null {
  return stored.final ? 'final' : stored.good ? 'good' : stored.preview ? 'preview' : null
}

/** A frame's size by tier: the CSS size for a preview, the device size for the rest, capped. */
export function frameSize(tier: Tier, state: { width: number; height: number; dpr: number }) {
  const scale = tier === 'preview' ? 1 / Math.max(1, state.dpr) : 1
  const width = Math.max(1, state.width) * scale
  const height = Math.max(1, state.height) * scale
  const fit = Math.min(1, LONG_EDGE[tier] / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * fit)),
    height: Math.max(1, Math.round(height * fit)),
  }
}

/** The panorama's width by tier: the screen's panorama width at the tier's density, in 16s. */
function panoramaWidth(tier: Tier, state: SpinState) {
  const density = frameSize(tier, state).width / Math.max(1, state.width)
  return Math.max(16, Math.round((state.interior.width * density) / 16) * 16)
}

type Job = {
  ref: FrameRef
  tier: Tier
  key: string
  /** The key and tier: one request at a time for each. */
  id: string
  priority: number
  camera: CloudCamera & { panorama?: boolean }
  width: number
  height: number
  quality: Quality
  exposure: number
  /**
   * The frame the visitor looks at: asked for at once, on a channel of its own, so the server drops
   * what is still queued for an angle they have since turned past.
   */
  focus: boolean
}
/** A decoded frame: which frame of which design, at which tier. */
export type Decoded = {
  texture: Texture
  key: string
  design: string
  tier: Tier
  provisional: boolean
}
/** A decode under way, and the tier it will give. */
type Decoding = { work: Promise<Decoded | null>; tier: Tier; provisional: boolean }
/**
 * A frame rendered with the textures in outranks any rendered before them, whatever its tier: a
 * preview of the real materials over a full render of grey ones (an export asked for early).
 */
const rank = (t: { tier: Tier; provisional: boolean }) =>
  (t.provisional ? 0 : 3) + TIER_RANK[t.tier]

/**
 * Renders and keeps the spin's frames and the interior panorama for the current design, and hands
 * RenderEffects the texture to show. The exposure gains are metered once per lighting look, so a
 * finish change never shifts brightness, as a camera on manual exposure would not.
 */
export class SpinSession {
  private readonly client: CloudClient
  private readonly onChange: () => void
  /**
   * One generation for each view's requests, raised when its design or framing changes: a frame
   * of an older one is dropped when it lands, and the server drops what is still queued under it.
   */
  private generations: Record<Part, number> = { exterior: 0, interior: 0 }
  /** The angle the visitor looks at, and its requests' sequence number, which rises with each turn. */
  private focused = ''
  private focusSeq = 0
  /** Cancels a view's frame requests when they are no longer wanted (its view or design changed). */
  private aborts: Record<Part, AbortController> = {
    exterior: new AbortController(),
    interior: new AbortController(),
  }
  /** Cancels metering, which outlives view changes, when the session closes. */
  private readonly closed = new AbortController()
  /**
   * The design and look each view's frames are rendered for: the exterior ring sees the scene
   * outside, the panorama the room, so an edit inside costs the panorama alone.
   */
  private designs: SceneKeys = { exterior: '', interior: '' }
  /** The exterior ring and the panorama as they are framed now (not sized: a resize keeps frames). */
  private views = { exterior: '', interior: '' }
  private sceneKey = ''
  private captured: Promise<CapturedScene> | null = null
  /** Whether the capture was taken with the scanned textures in. */
  private capturedSettled = false
  /** Whether the scene has its textures: until then only the visitor's preview is rendered. */
  private settled = false
  private state: SpinState | null = null
  private gain: Gains | null = null
  /** Whether the gain in use was metered with the textures in. */
  private gainSettled = false
  /** Metered gains by lighting look, and whether they were metered with the textures in. */
  private readonly gains = new Map<string, { gains: Gains; settled: boolean }>()
  /** The metering waiting to start or under way; one started since is a newer number. */
  private metering = 0
  /** Whether a meter was started on this page: the next one waits for the design to hold still. */
  private meteredBefore = false
  private meterTimer: ReturnType<typeof setTimeout> | undefined
  private meterAbort: AbortController | null = null
  private readonly frames = new Map<string, Stored>()
  /** Decoded frames, most recently used last, and the decodes under way. */
  private readonly decoded = new Map<string, Decoded>()
  private readonly decoding = new Map<string, Decoding>()
  /** Textures on screen (or fading out); disposing them waits until they are not. */
  private held = new Set<Texture>()
  private readonly doomed = new Set<Texture>()
  /**
   * Requests open for each view, by job id, and whether each is for the frame the visitor looks
   * at. A view's map is replaced when its requests are dropped, so a dropped request finishing
   * late never takes a newer one's place out of the map.
   */
  private inFlight: Record<Part, Map<string, boolean>> = {
    exterior: new Map(),
    interior: new Map(),
  }
  private failures = 0
  private busyUntil = 0
  /** How many times in a row the server was busy: each wait is twice the last. */
  private busyStreak = 0
  private fullUntil = 0
  /** The frame an export waits for at full quality, or null. */
  private finalWanted: string | null = null
  /**
   * The plan, and the stamp of what it was built from: it is rebuilt only when that changes. The
   * stamp carries the sizes too, since the jobs are sized when the plan is made.
   */
  private planned: Job[] = []
  private planStamp = ''
  /** When the session first had a design to render; a later design change does not reset it. */
  private started: number | null = null
  private timeout: ReturnType<typeof setTimeout> | undefined
  progress: SpinProgress = {
    loading: true,
    ready: 0,
    total: SPIN_STEPS,
    good: 0,
    warm: false,
    gateMs: 0,
    failed: false,
  }

  constructor(client: CloudClient, onChange: () => void) {
    this.client = client
    this.onChange = onChange
    document.addEventListener('visibilitychange', this.resume)
  }

  /** Rendering pauses while the page is hidden (frames in flight finish) and resumes here. */
  private readonly resume = () => {
    if (!document.hidden) this.pump()
  }

  /**
   * The design, look and view. Cheap to call every frame: work starts only when something that
   * determines the frames changed. `keys` fingerprint the scene outside and inside, so an edit
   * in the room renders the panorama again and keeps the ring. `rasterKey` meters the raster
   * frame, once per look. The design is the scene as it is now, textures or not: while it is not
   * `settled` (textures still arriving) only the frame the visitor looks at is rendered, as a
   * preview, and once they are in the exposure is metered again and that preview rendered again.
   */
  sync(
    scene: Scene,
    look: SkyLook,
    keys: SceneKeys,
    state: SpinState,
    rasterKey: MeterRaster,
    settled = true,
  ) {
    this.state = state
    const lighting = lookKey(look)
    const designs: SceneKeys = {
      exterior: `${keys.exterior}|${lighting}`,
      interior: `${keys.interior}|${lighting}`,
    }
    const sceneKey = `${keys.exterior}|${keys.interior}`
    if (this.started === null) {
      this.started = performance.now()
      // Nothing else may redraw when the gate's time runs out.
      this.timeout = setTimeout(this.onChange, GATE_MAX_MS + 50)
    }
    const arrived = settled && !this.settled
    this.settled = settled
    const ext = state.exterior
    // The aspect, not the size: a resize at the same aspect (or a DPR change) keeps every frame.
    const aspect = (Math.max(1, state.width) / Math.max(1, state.height)).toFixed(3)
    const views = {
      exterior: ext
        ? [
            ...ext.spec.target.toArray().map((v) => v.toFixed(2)),
            ext.spec.radius.toFixed(2),
            ext.spec.polar.toFixed(3),
            ext.lens.fov.toFixed(2),
            aspect,
            state.exposure.exterior.toFixed(3),
          ].join(',')
        : '',
      interior: [
        ...state.interior.eye.toArray().map((v) => v.toFixed(2)),
        state.exposure.interior.toFixed(3),
      ].join(','),
    }
    const fresh = PARTS.filter((part) => designs[part] !== this.designs[part])
    const reframed = PARTS.filter((part) => views[part] !== this.views[part])
    if (!fresh.length && !reframed.length && !arrived) {
      this.pump()
      return
    }
    // A view whose design or framing changed: its queued requests are for frames no longer
    // wanted, so they are dropped, here and on the server. The other view's carry on.
    for (const part of PARTS) if (fresh.includes(part) || reframed.includes(part)) this.drop(part)
    // A run of errors is forgiven for a new design or framing, unless the spin gave up (fail),
    // which holds for the page.
    if (!this.progress.failed) this.failures = 0
    for (const part of fresh) {
      // Its frames and the textures decoded from them show the design before.
      this.forget(`${part[0]}|`, true)
      // A meter under way would read the design before this one.
      this.stopMeter()
    }
    // The gate watches the view the visitor is in.
    if (fresh.includes(state.active) && !this.progress.failed)
      this.progress = { ...this.progress, loading: true }
    this.designs = designs
    // Captured for a new scene, and again once its textures are in.
    if (sceneKey !== this.sceneKey || !this.captured || (settled && !this.capturedSettled)) {
      this.sceneKey = sceneKey
      this.capturedSettled = settled
      this.captured = captureScene(scene, look)
    }
    if (fresh.length) {
      const known = this.gains.get(lighting)
      this.gain = known?.gains ?? null
      this.gainSettled = known?.settled ?? false
      if (!known || (settled && !known.settled)) this.startMeter(lighting, rasterKey)
    } else if (arrived && !this.gainSettled) {
      // The textures came in under the same design: they change its brightness.
      this.startMeter(lighting, rasterKey)
    }
    // A view framed anew: forget its old frames.
    for (const part of reframed) this.forget(`${part[0]}|${this.views[part]}|`)
    this.views = views
    this.pump()
  }

  /**
   * Drops a view's open requests: a new generation, so a frame landing late is ignored and the
   * server drops what is still queued, and a new map, so their bookkeeping never touches the
   * requests made after them. The exterior's focus channel starts over too.
   */
  private drop(part: Part) {
    this.generations[part]++
    this.aborts[part].abort()
    this.aborts[part] = new AbortController()
    this.inFlight[part] = new Map()
    if (part === 'exterior') this.focused = ''
  }

  /**
   * Drops the stored frames whose keys start with `prefix`, and with `decoded` the textures
   * decoded from them (an older design's; a reframed view's stay until they fall out of use).
   */
  private forget(prefix: string, decoded = false) {
    for (const key of [...this.frames.keys()]) if (key.startsWith(prefix)) this.frames.delete(key)
    if (!decoded) return
    for (const [key, d] of [...this.decoded]) {
      if (!key.startsWith(prefix)) continue
      this.doom(d.texture)
      this.decoded.delete(key)
    }
    // A decode under way finds its entry gone when it lands, and disposes its texture.
    for (const key of [...this.decoding.keys()])
      if (key.startsWith(prefix)) this.decoding.delete(key)
  }

  /**
   * Meters the gain for a look. The page's first design is metered at once, so its first preview
   * is not held back; a changed design once it has held still for a moment, since a slider drag
   * is a run of designs, and a meter of one that is already gone would be wasted. The design must
   * hold still meanwhile too, so the traced render and the raster frame show the same scene; if
   * it changes, the meter is dropped and the next design meters again. The gain then holds
   * however the view changes. Metered before the textures, it serves until they are in and is
   * metered again then.
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
      // The first answer also tells the gate whether the cloud is warm.
      this.onChange()
      this.pump()
    }
    this.meterViews(rasterKey, controller.signal).then(settle, (error) => {
      if (token !== this.metering || this.closed.signal.aborted) return
      if (error instanceof Outdated) return this.fail(error)
      // A busy or full server is asked again later, as for a frame.
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
      // Not kept: the next design with this look meters again.
      settle(null)
    })
  }

  /** Both views' gains: outside at the visitor's spin frame, inside at the interior's view. */
  private async meterViews(rasterKey: MeterRaster, signal: AbortSignal): Promise<Gains> {
    const captured = await this.captured!
    const state = this.state!
    const ext = state.exterior
    const outside = ext ? spinCamera(ext.spec, ext.pose, ext.lens) : null
    // One at a time: the raster frame is rendered at each camera in turn.
    const exterior = await this.meter(captured, rasterKey, outside, 'exterior', signal)
    const interior = await this.meter(captured, rasterKey, state.interior.view, 'interior', signal)
    return { exterior, interior }
  }

  /**
   * The exposure gain that matches the raster frame's brightness: a quick traced frame of the
   * same view, at the same camera and size (a smaller one reads brighter: fine detail averages
   * away), metered the same way by the server.
   */
  private async meter(
    captured: CapturedScene,
    rasterKey: MeterRaster,
    camera: CloudCamera | null,
    label: string,
    signal: AbortSignal,
  ) {
    const raster = await rasterKey(camera)
    signal.throwIfAborted()
    const scale = Math.min(1, METER_MAX_EDGE / Math.max(raster.width, raster.height))
    const frame = await this.client.frame(
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
        `[spin] ${label} exposure for ${this.designs[label === 'interior' ? 'interior' : 'exterior']}: raster key ${raster.key.toFixed(3)}, traced key ${traced.toFixed(3)}, gain ${gain.toFixed(3)}`,
      )
    return gain
  }

  private exteriorKey(pose: SpinPose) {
    return `e|${this.views.exterior}|${pose.level}|${pose.azimuth}`
  }

  private interiorKey() {
    return `i|${this.views.interior}|`
  }

  private keyOf(ref: FrameRef) {
    return ref.kind === 'interior' ? this.interiorKey() : this.exteriorKey(ref)
  }

  /**
   * Frames rendered now are stand-ins: the textures are still arriving, or the exposure was
   * metered without them. They are rendered again once the scene has settled.
   */
  private get provisional() {
    return !this.settled || !this.gainSettled
  }

  /** Whether a frame is stored at a tier (or a better one), and still wanted at it. */
  private stored(ref: FrameRef, tier: Tier) {
    const stored = this.frames.get(this.keyOf(ref))
    const best = stored && bestTier(stored)
    if (!stored || !best || TIER_RANK[best] < TIER_RANK[tier]) return false
    // A frame rendered before the scene settled is rendered again once it has.
    return !stored.provisional || this.provisional
  }

  /** The frames still to render, most wanted first (plan.ts), with everything a request needs. */
  private plan(state: SpinState, exportWanted: boolean): Job[] {
    const ext = state.exterior
    const stored = (ref: FrameRef, tier: Tier) => this.stored(ref, tier)
    return planJobs({
      active: state.active,
      focus: ext ? ext.pose : null,
      drift: state.drift,
      steps: SPIN_STEPS,
      levels: SPIN_LEVELS.length,
      has: (ref, tier) =>
        stored(ref, tier) || this.inFlight[ref.kind].has(`${this.keyOf(ref)}|${tier}`),
      stored,
      idle: state.idle,
      settled: !this.provisional,
      exportWanted,
    }).map((planned) => this.job(state, planned))
  }

  private job(state: SpinState, { ref, tier, priority, focus }: PlannedJob): Job {
    const key = this.keyOf(ref)
    const base = { ref, tier, key, id: `${key}|${tier}`, priority, focus }
    if (ref.kind === 'interior') {
      const int = state.interior
      const width = panoramaWidth(tier, state)
      return {
        ...base,
        camera: {
          ...int.lens,
          matrix: Array.from(new Matrix4().setPosition(int.eye).elements),
          panorama: true,
        },
        width,
        height: width / 2,
        quality: PANORAMA_QUALITY[tier],
        exposure: state.exposure.interior,
      }
    }
    const ext = state.exterior!
    return {
      ...base,
      camera: spinCamera(ext.spec, ref, ext.lens),
      ...frameSize(tier, state),
      quality: QUALITY[tier],
      exposure: state.exposure.exterior,
    }
  }

  /**
   * Asks for what the visitor looks at at once, and keeps up to IN_FLIGHT other frame requests
   * open, in order of the plan.
   */
  private pump() {
    const state = this.state
    if (!state || this.gain === null || !this.captured || this.failures >= 3) return
    if (this.closed.signal.aborted || document.hidden) return
    const now = performance.now()
    if (now < this.busyUntil || now < this.fullUntil) return
    const ext = state.active === 'exterior' ? state.exterior : null
    const focused = ext ? this.exteriorKey(ext.pose) : ''
    if (focused !== this.focused) {
      // Turned: what is still queued for the angle before is dropped once this one is asked for.
      this.focused = focused
      this.focusSeq++
    }
    const focusKey = this.focusKey()
    const exportWanted = this.finalWanted !== null && this.finalWanted === focusKey
    const flying = () => this.inFlight.exterior.size + this.inFlight.interior.size
    // The plan is rebuilt only when something it is made from changed, not on every frame drawn.
    const stamp = (inFlight: number) =>
      [
        this.designs.exterior,
        this.designs.interior,
        this.views.exterior,
        this.views.interior,
        focusKey,
        state.drift,
        state.idle,
        this.provisional,
        exportWanted,
        `${state.width}x${state.height}@${state.dpr}`,
        state.interior.width,
        this.frames.size,
        inFlight,
      ].join('|')
    if (stamp(flying()) !== this.planStamp) this.planned = this.plan(state, exportWanted)
    let open = 0
    for (const part of PARTS) for (const focus of this.inFlight[part].values()) if (!focus) open++
    for (const job of this.planned) {
      // The plan may be a little older than the frames: what landed or went out since is skipped.
      if (this.inFlight[job.ref.kind].has(job.id) || this.stored(job.ref, job.tier)) continue
      if (!job.focus && open >= IN_FLIGHT) break
      if (!job.focus) open++
      this.request(job)
    }
    // The requests just made are the plan's own: they do not date it.
    this.planStamp = stamp(flying())
  }

  private request(job: Job) {
    const part = job.ref.kind
    const generation = this.generations[part]
    const provisional = this.provisional
    const inside = part === 'interior'
    // The panorama has a channel of its own, so only a newer panorama supersedes it; the frame the
    // visitor looks at has one too, whose sequence rises as they turn.
    const channel = inside ? 'p' : job.focus ? 'f' : 's'
    const sequence = channel === 'f' ? this.focusSeq : generation
    const inFlight = this.inFlight[part]
    const finish = {
      exposure: job.exposure,
      gain: inside ? this.gain!.interior : this.gain!.exterior,
    }
    inFlight.set(job.id, job.focus)
    this.captured!.then((captured) =>
      this.client.frame(
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
        this.aborts[part].signal,
      ),
    )
      .then((frame) => {
        if (generation !== this.generations[part]) return
        if (TRACE_STATS)
          console.info(
            `[spin] ${job.ref.kind === 'interior' ? 'panorama' : `${job.ref.level}/${job.ref.azimuth}`} ${job.tier}${provisional ? ' (before the textures)' : ''} ${job.width}x${job.height}: ${frame.cached ? 'cached' : `render ${frame.renderMs} ms`}, ${Math.round(frame.totalMs)} ms in all${frame.renderer ? `, ${frame.renderer} renderer` : ''}`,
          )
        const before = this.frames.get(job.key)
        // Rendered before the textures and landing after a frame rendered with them: not wanted.
        if (provisional && before && bestTier(before) && !before.provisional) return
        // Rendered with the textures in: the stand-ins rendered before them are done with, at
        // every tier, so a full render made for an export before them never outlives this frame
        // (its tier would otherwise pass for the real thing, and the export would get it).
        const stored =
          before && before.provisional === provisional ? before : { sizes: {}, provisional }
        stored[job.tier] = frame.image
        stored.sizes[job.tier] = { width: job.width, height: job.height }
        stored.provisional = provisional
        this.frames.set(job.key, stored)
        this.failures = 0
        this.busyStreak = 0
        this.onChange()
      })
      .catch((error) => {
        if (generation !== this.generations[part] || this.aborts[part].signal.aborted) return
        // The visitor turned past it before it rendered; whatever is wanted now is asked for next.
        if (error instanceof Superseded) return
        if (error instanceof Busy) return void this.busy()
        if (error instanceof Full) return void this.full()
        // A server that cannot render frames will not start to: no point asking twice more.
        if (error instanceof Outdated || ++this.failures >= 3) this.fail(error)
      })
      .finally(() => {
        inFlight.delete(job.id)
        if (generation === this.generations[part]) this.pump()
      })
  }

  /**
   * Waits out a busy server (or a frame that took too long to come: cloud.ts), twice as long each
   * time in a row; the wait in milliseconds. The frames of the whole page wait together.
   */
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
   * Every cloud GPU is in use by other visitors: this page renders on its own device meanwhile
   * (RenderEffects shows the live view, traced locally where it can) and asks again in a minute,
   * when one may have freed up. The wait in milliseconds.
   */
  private full() {
    const now = performance.now()
    if (now < this.fullUntil) return this.fullUntil - now
    this.fullUntil = now + FULL_MS
    bench.cloud('full')
    setTimeout(() => this.pump(), FULL_MS)
    return FULL_MS
  }

  /**
   * Gives up on the spin for this page: RenderEffects then renders resting views one at a time,
   * as with `?spin=0`, which an older server also supports.
   */
  private fail(error: unknown) {
    if (this.progress.failed) return
    console.warn('The path-traced spin could not be rendered.', error)
    this.failures = 3
    this.progress = { ...this.progress, loading: false, failed: true }
    bench.cloud('failed')
    this.onChange()
  }

  /** Disposes a texture once it is no longer on screen. */
  private doom(texture: Texture) {
    if (this.held.has(texture)) this.doomed.add(texture)
    else texture.dispose()
  }

  /** The textures RenderEffects has on screen, including one fading out. */
  hold(textures: Texture[]) {
    this.held = new Set(textures)
    for (const texture of this.doomed)
      if (!this.held.has(texture)) {
        texture.dispose()
        this.doomed.delete(texture)
      }
  }

  /**
   * The frame an export waits for at full quality (RenderEffects, while a capture is pending), or
   * null once none does. The full render is made for nothing else.
   */
  wantFinal(key: string | null) {
    if (key === this.finalWanted) return
    this.finalWanted = key
    this.pump()
  }

  /**
   * Whether the visitor rests on the design, told here when no frame is drawn to say so: with the
   * floor plan open the scene is inactive and `sync` is not called, and fetching ahead would go
   * on for a design being edited.
   */
  setIdle(idle: boolean) {
    if (!this.state || this.state.idle === idle) return
    this.state = { ...this.state, idle }
    this.pump()
  }

  private count() {
    const state = this.state
    if (!state) return
    let ready = 0,
      good = 0,
      total = 1
    const refined = (f: Stored | undefined) => !!f && (f.good || f.final) !== undefined
    if (state.active === 'interior') {
      const p = this.frames.get(this.interiorKey())
      ready = p ? 1 : 0
      good = refined(p) ? 1 : 0
    } else if (state.exterior) {
      total = SPIN_STEPS
      const { level } = state.exterior.pose
      for (let azimuth = 0; azimuth < SPIN_STEPS; azimuth++) {
        const f = this.frames.get(this.exteriorKey({ level, azimuth }))
        if (f) ready++
        if (refined(f)) good++
      }
    }
    // Loading only until the frame the visitor looks at is decoded, at whatever tier.
    const focus = this.focusKey()
    const loading = !this.progress.failed && !(focus !== null && this.decoded.has(focus))
    this.progress = {
      loading,
      ready,
      total,
      good,
      warm: this.client.warm,
      gateMs: this.started === null ? 0 : performance.now() - this.started,
      failed: this.progress.failed,
    }
  }

  /** The key of the frame the visitor looks at: the pose's outside, the panorama's inside. */
  focusKey(): string | null {
    const state = this.state
    if (!state) return null
    if (state.active === 'interior') return this.interiorKey()
    return state.exterior ? this.exteriorKey(state.exterior.pose) : null
  }

  /** The design (and look) a view's frames are rendered for now. */
  currentDesign(part: Part = 'exterior') {
    return this.designs[part]
  }

  /**
   * Whether a decoded frame is of the design its view is rendered for now, not one kept on
   * screen from the design before while its replacement renders.
   */
  isCurrent(frame: Decoded) {
    return frame.design === this.designs[partOf(frame.key)]
  }

  /**
   * The best texture for what the visitor is looking at, or null until one is decoded. Decoding
   * starts here, also for the neighbouring frames so turning shows them without a wait.
   */
  texture(): Decoded | null {
    const state = this.state
    if (!state) return null
    this.count()
    // The other view stays decoded too, so switching views shows it at once.
    const outside = state.exterior && this.exteriorKey(state.exterior.pose)
    if (state.active === 'interior') {
      const shown = this.decode(this.interiorKey())
      if (outside) this.decode(outside)
      return shown
    }
    if (!state.exterior || !outside) return null
    const { level, azimuth } = state.exterior.pose
    // Turned onto an angle not rendered yet: the nearest one that is, until it arrives.
    const near = this.nearest(level, azimuth, (key) => this.frames.has(key))
    const shown = this.decode(near ?? outside)
    for (const d of [1, -1, 2, -2])
      this.decode(this.exteriorKey({ level, azimuth: wrap(azimuth + d) }))
    this.decode(this.interiorKey())
    // The frame turned to is still decoding: the nearest one decoded stands in meanwhile, rather
    // than the live view for the moment the decode takes. Decoded frames are all of this design,
    // so a changed design still shows none of the one before.
    if (shown) return shown
    const decoded = this.nearest(level, azimuth, (key) => this.decoded.has(key))
    return decoded ? this.decoded.get(decoded)! : null
  }

  /**
   * The key of the frame nearest a pose (its own first, then either side outward, as ringOrder)
   * that `has`, or null. Runs on every frame drawn, so it stops at the first hit rather than
   * keying the whole ring.
   */
  private nearest(level: number, azimuth: number, has: (key: string) => boolean) {
    for (let d = 0; d <= SPIN_STEPS / 2; d++) {
      const ahead = this.exteriorKey({ level, azimuth: wrap(azimuth + d) })
      if (has(ahead)) return ahead
      if (d === 0) continue
      const behind = this.exteriorKey({ level, azimuth: wrap(azimuth - d) })
      if (has(behind)) return behind
    }
    return null
  }

  /** Whether a frame is the one for what the visitor looks at, not the nearest stand-in for it. */
  isFocus(frame: Decoded) {
    return frame.key === this.focusKey()
  }

  /**
   * The decoded frame, at the best tier decoded so far. A better tier stored (a good frame after
   * its preview, a preview rendered with the textures after one without) is decoded on top, even
   * while a lesser one is still decoding, and replaces it when it lands.
   */
  private decode(key: string): Decoded | null {
    const current = this.decoded.get(key)
    if (current) {
      // Most recently used last.
      this.decoded.delete(key)
      this.decoded.set(key, current)
    }
    const stored = this.frames.get(key)
    const best = stored && bestTier(stored)
    if (!stored || !best) return current ?? null
    const want = { tier: best, provisional: stored.provisional }
    if (current && rank(current) >= rank(want)) return current
    const pending = this.decoding.get(key)
    if (pending && rank(pending) >= rank(want)) return current ?? null
    const blob = stored[best]!
    const design = this.designs[partOf(key)]
    const work: Promise<Decoded | null> = createImageBitmap(blob).then((bitmap) => {
      // Shown as the server encoded it: display sRGB, with no conversion.
      const texture = new Texture(bitmap as never)
      texture.flipY = false
      // Shown at about the screen's density, so without mipmaps; a panorama's lookup also jumps
      // where it wraps around, which would pick the smallest mipmap there and draw a seam.
      texture.generateMipmaps = false
      texture.minFilter = LinearFilter
      // A panorama wraps around at its left and right edges.
      if (key.startsWith('i|')) texture.wrapS = RepeatWrapping
      texture.needsUpdate = true
      const decoded: Decoded = { texture, key, design, ...want }
      // Overtaken by a better tier, or the design changed: not wanted any more.
      if (this.decoding.get(key)?.work !== work) {
        texture.dispose()
        return decoded
      }
      this.decoding.delete(key)
      const old = this.decoded.get(key)
      if (old) this.doom(old.texture)
      this.decoded.delete(key)
      this.decoded.set(key, decoded)
      while (this.decoded.size > DECODED) {
        const [oldKey, evicted] = this.decoded.entries().next().value!
        this.decoded.delete(oldKey)
        this.doom(evicted.texture)
      }
      this.onChange()
      return decoded
    })
    // A frame that is not an image would otherwise be waited for forever.
    work.catch((error) => {
      if (this.decoding.get(key)?.work === work) this.decoding.delete(key)
      this.fail(error)
    })
    this.decoding.set(key, { work, ...want })
    return current ?? null
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.resume)
    clearTimeout(this.timeout)
    this.stopMeter()
    for (const part of PARTS) this.drop(part)
    this.closed.abort()
    for (const d of this.decoded.values()) d.texture.dispose()
    for (const texture of this.doomed) texture.dispose()
    this.decoded.clear()
    this.decoding.clear()
    this.doomed.clear()
  }
}
