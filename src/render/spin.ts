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
import { ORBIT_LIMITS } from './orbit'
import { lookKey } from './pathtrace'
import { GATE_MAX_MS } from './traceStatus'

export { GATE_MAX_MS }

/**
 * The path-traced spin. With a cloud renderer the exterior steps through a ring of pre-rendered,
 * path-traced frames, 72 angles (every 5°) at three distances, like a 360° product spin. The
 * interior is one 360° panorama, so looking around it stays path traced at any angle.
 *
 * The live view is never held back: the real-time renderer draws first (and the local path tracer
 * refines it where it can), and the frames arrive over it as they are rendered. Each visitor has
 * one GPU of their own. It renders what the visitor sees first, as a quick preview and then at
 * full quality, then the angles either side of it, then the rest of the ring nearest first, and
 * then the other distances. The plan follows the visitor: wherever they turn to is rendered next.
 * The server finishes frames (exposure, bloom, tone mapping) and keeps them, so a design someone
 * has viewed before comes back from its cache.
 */

export const SPIN_STEPS = 72
const STEP = (Math.PI * 2) / SPIN_STEPS
/** Closer and lower, the framed view, farther and higher: distance factor and polar offset. */
export const SPIN_LEVELS = [
  { radius: 0.72, polar: 0.06 },
  { radius: 1, polar: 0 },
  { radius: 1.45, polar: -0.14 },
] as const
export const DEFAULT_LEVEL = 1

/** Frame quality: a quick preview, then the full render (cloud.ts CLOUD_QUALITY). */
const PREVIEW = { samples: 64, threshold: 0, timeLimit: 4 }
/** The exposure meter's frame: denoised, its mean brightness settles within a few samples. */
const METER = { samples: 16, threshold: 0, timeLimit: 4 }
const FINAL = { samples: 1024, threshold: 0.01, timeLimit: 15 }
/** A panorama has many more pixels; the gateway allows it a longer time limit. */
const PANORAMA_FINAL = { samples: 1024, threshold: 0.01, timeLimit: 60 }
/** Longest edge of a spin frame; larger canvases scale it up. */
const MAX_EDGE = 3200
/**
 * Requests kept open at once, besides those for what the visitor looks at, which go out at once.
 * The visitor's GPU renders one frame at a time; two more queued keep it busy across round trips.
 */
const IN_FLIGHT = 3
/**
 * Angles on each side of the visitor's that are rendered first, as previews (about 1.5 s each),
 * so turning a few steps either way shows a path-traced frame at once.
 */
const NEAR = 4
/** A busy server is asked again after this long, without counting as a failure. */
const BUSY_MS = 2000
/** Decoded frames kept as textures: the current one and its neighbours. */
const DECODED = 12

/** `?traceStats=1` logs the exposure match and each frame's timing. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

/** The ring: where the camera orbits, at what distance and height for the framed view. */
export type SpinSpec = { target: Vector3; radius: number; polar: number }
/** A frame of the spin: a distance level and one of 72 azimuths. */
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
export const spinView: { spec: SpinSpec | null; pose: SpinPose | null } = { spec: null, pose: null }

type Lens = { fov: number; near: number; far: number }

/** What the visitor is looking at, and what to have ready next, as SpinSession needs it. */
export type SpinState = {
  active: 'exterior' | 'interior'
  /** The exterior spin; null until CameraRig has framed it. */
  exterior: { spec: SpinSpec; pose: SpinPose; width: number; height: number; lens: Lens } | null
  /**
   * The interior panorama (equirectangular, twice as wide as high), from the interior's eye, and
   * the interior's framed view, at which its exposure is metered.
   */
  interior: { eye: Vector3; width: number; lens: Lens; view: CloudCamera }
  /** The renderer's exposure outside and inside (a camera inside opens up for the dimmer room). */
  exposure: { exterior: number; interior: number }
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
  /** Of those, at full quality. */
  final: number
  /** The cloud answered an image in the last few minutes: its GPU is probably still on. */
  warm: boolean
  /** Milliseconds since the session first had a design to render: the gate's clock. */
  gateMs: number
  failed: boolean
}

/** A frame's quality: a preview rendered before the textures, a preview, or the full render. */
type Tier = { final: boolean; provisional: boolean }
const tier = (t: Tier) => (t.final ? 2 : t.provisional ? 0 : 1)
/** A frame's images, and whether the best of them was rendered before the scene settled. */
type Stored = { preview?: Blob; final?: Blob; provisional: boolean }
type Job = {
  key: string
  final: boolean
  priority: number
  camera: CloudCamera & { panorama?: boolean }
  width: number
  height: number
  quality: { samples: number; threshold: number; timeLimit: number }
  exposure: number
  inside: boolean
  /**
   * The frame the visitor looks at: asked for at once, on a channel of its own, so the server drops
   * what is still queued for an angle they have since turned past.
   */
  focus: boolean
}
/** A decoded frame: which frame of which design, at which tier. */
export type Decoded = Tier & { texture: Texture; key: string; design: string }
/** A decode under way, and the tier it will give. */
type Decoding = Tier & { work: Promise<Decoded | null> }

/**
 * Renders and keeps the spin's frames and the interior panorama for the current design, and hands
 * RenderEffects the texture to show. The exposure gains are metered once per lighting look, so a
 * finish change never shifts brightness, as a camera on manual exposure would not.
 */
export class SpinSession {
  private readonly client: CloudClient
  private readonly onChange: () => void
  private generation = 0
  /** The angle the visitor looks at, and its requests' sequence number, which rises with each turn. */
  private focused = ''
  private focusSeq = 0
  /** Cancels frame requests no longer wanted (the view or design changed). */
  private abort = new AbortController()
  /** Cancels metering, which outlives view changes, when the session closes. */
  private readonly closed = new AbortController()
  /** The design and look: frames change with either. */
  private design = ''
  /** The exterior ring and the panorama as they are framed and sized now. */
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
  /** The metering under way, so a superseded one is dropped when it lands. */
  private metering = 0
  private readonly frames = new Map<string, Stored>()
  /** Decoded frames, most recently used last, and the decodes under way. */
  private readonly decoded = new Map<string, Decoded>()
  private readonly decoding = new Map<string, Decoding>()
  /** Textures on screen (or fading out); disposing them waits until they are not. */
  private held = new Set<Texture>()
  private readonly doomed = new Set<Texture>()
  private inFlight = new Set<string>()
  private failures = 0
  private busyUntil = 0
  /** When the session first had a design to render; a later design change does not reset it. */
  private started: number | null = null
  private timeout: ReturnType<typeof setTimeout> | undefined
  progress: SpinProgress = {
    loading: true,
    ready: 0,
    total: SPIN_STEPS,
    final: 0,
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
   * determines the frames changed. `rasterKey` meters the raster frame, once per look. The design
   * is the scene as it is now, textures or not: while it is not `settled` (textures still
   * arriving) only the frame the visitor looks at is rendered, as a preview, and once they are in
   * the exposure is metered again and that preview rendered again.
   */
  sync(
    scene: Scene,
    look: SkyLook,
    sceneKey: string,
    state: SpinState,
    rasterKey: MeterRaster,
    settled = true,
  ) {
    this.state = state
    const lighting = lookKey(look)
    const design = `${sceneKey}|${lighting}`
    if (this.started === null) {
      this.started = performance.now()
      // Nothing else may redraw when the gate's time runs out.
      this.timeout = setTimeout(this.onChange, GATE_MAX_MS + 50)
    }
    const arrived = settled && !this.settled
    this.settled = settled
    const ext = state.exterior
    const views = {
      exterior: ext
        ? [
            ...ext.spec.target.toArray().map((v) => v.toFixed(2)),
            ext.spec.radius.toFixed(2),
            ext.spec.polar.toFixed(3),
            `${ext.width}x${ext.height}`,
            ext.lens.fov.toFixed(2),
            state.exposure.exterior.toFixed(3),
          ].join(',')
        : '',
      interior: [
        ...state.interior.eye.toArray().map((v) => v.toFixed(2)),
        state.interior.width,
        state.exposure.interior.toFixed(3),
      ].join(','),
    }
    const fresh = design !== this.design
    const changed = views.exterior !== this.views.exterior || views.interior !== this.views.interior
    if (!fresh && !changed && !arrived) {
      this.pump()
      return
    }
    if (fresh || changed) {
      // Queued requests are for frames no longer wanted: drop them, here and on the server.
      this.generation++
      this.focused = ''
      this.abort.abort()
      this.abort = new AbortController()
      this.inFlight = new Set()
      this.failures = 0
    }
    if (fresh) {
      this.design = design
      this.frames.clear()
      for (const d of this.decoded.values()) this.doom(d.texture)
      this.decoded.clear()
      this.decoding.clear()
      this.progress = { ...this.progress, loading: true, failed: false }
    }
    // Captured for a new scene, and again once its textures are in.
    if (sceneKey !== this.sceneKey || !this.captured || (settled && !this.capturedSettled)) {
      this.sceneKey = sceneKey
      this.capturedSettled = settled
      this.captured = captureScene(scene, look)
    }
    if (fresh) {
      const known = this.gains.get(lighting)
      this.gain = known?.gains ?? null
      this.gainSettled = known?.settled ?? false
      if (!known || (settled && !known.settled)) this.startMeter(lighting, rasterKey)
    } else if (arrived && !this.gainSettled) {
      // The textures came in under the same design: they change its brightness.
      this.startMeter(lighting, rasterKey)
    }
    // A view framed or sized anew: forget its old frames.
    for (const kind of ['exterior', 'interior'] as const)
      if (views[kind] !== this.views[kind])
        for (const key of [...this.frames.keys()])
          if (key.startsWith(`${kind[0]}|${this.views[kind]}|`)) this.frames.delete(key)
    this.views = views
    this.pump()
  }

  /**
   * Meters the gain for a look, once. The design must hold still meanwhile, so the traced render
   * and the raster frame show the same scene; if it changes, the next design meters again. The
   * gain then holds however the view changes. Metered before the textures, it serves until they
   * are in and is metered again then.
   */
  private startMeter(lighting: string, rasterKey: MeterRaster) {
    const design = this.design
    const settled = this.settled
    const token = ++this.metering
    const settle = (gains: Gains | null) => {
      if (this.metering !== token) return
      this.metering = 0
      if (design !== this.design || this.closed.signal.aborted) return
      if (gains) this.gains.set(lighting, { gains, settled })
      this.gain = gains ?? { exterior: 1, interior: 1 }
      this.gainSettled = settled
      // The first answer also tells the gate whether the cloud is warm.
      this.onChange()
      this.pump()
    }
    this.meterViews(rasterKey).then(settle, (error) => {
      if (error instanceof Outdated || error instanceof Full) return this.fail(error)
      if (this.metering === token && !this.closed.signal.aborted)
        console.warn('The path-traced exposure could not be metered.', error)
      // Not kept: the next design with this look meters again.
      settle(null)
    })
  }

  /** Both views' gains: outside at the visitor's spin frame, inside at the interior's view. */
  private async meterViews(rasterKey: MeterRaster): Promise<Gains> {
    const captured = await this.captured!
    const state = this.state!
    const ext = state.exterior
    const outside = ext ? spinCamera(ext.spec, ext.pose, ext.lens) : null
    // One at a time: the raster frame is rendered at each camera in turn.
    const exterior = await this.meter(captured, rasterKey, outside, 'exterior')
    const interior = await this.meter(captured, rasterKey, state.interior.view, 'interior')
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
  ) {
    const raster = await rasterKey(camera)
    const scale = Math.min(1, MAX_EDGE / Math.max(raster.width, raster.height))
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
      this.closed.signal,
    )
    const traced = frame.tracedKey
    const ratio = Math.exp(raster.key - traced)
    if (!Number.isFinite(ratio)) throw new Error(`no exposure reading (${raster.key}, ${traced})`)
    const gain = Math.min(4, Math.max(0.5, ratio))
    if (TRACE_STATS)
      console.info(
        `[spin] ${label} exposure for ${this.design}: raster key ${raster.key.toFixed(3)}, traced key ${traced.toFixed(3)}, gain ${gain.toFixed(3)}`,
      )
    return gain
  }

  private exteriorKey(pose: SpinPose) {
    return `e|${this.views.exterior}|${pose.level}|${pose.azimuth}`
  }

  private interiorKey() {
    return `i|${this.views.interior}|`
  }

  /**
   * Frames rendered now are stand-ins: the textures are still arriving, or the exposure was
   * metered without them. They are rendered again once the scene has settled.
   */
  private get provisional() {
    return !this.settled || !this.gainSettled
  }

  /** The frames still to render, most wanted first. */
  private jobs(): Job[] {
    const state = this.state
    if (!state) return []
    const outside: Job[][] = [[], [], [], [], [], [], []]
    const ext = state.exterior
    if (ext) {
      const scale = Math.min(1, MAX_EDGE / Math.max(ext.width, ext.height))
      const width = Math.max(1, Math.round(ext.width * scale))
      const height = Math.max(1, Math.round(ext.height * scale))
      const job = (pose: SpinPose, final: boolean, focus = false): Job => ({
        key: this.exteriorKey(pose),
        final,
        priority: 0,
        camera: spinCamera(ext.spec, pose, ext.lens),
        width,
        height,
        quality: final ? FINAL : PREVIEW,
        exposure: state.exposure.exterior,
        inside: false,
        focus,
      })
      // Around wherever the visitor has turned to, so that is what renders next.
      const focus = ext.pose
      const ring = (level: number) =>
        ringOrder(focus.azimuth).map((azimuth) => ({ level, azimuth }))
      const around = ring(focus.level)
      const near = around.slice(1, 1 + 2 * NEAR)
      const rest = around.slice(1 + 2 * NEAR)
      const others = SPIN_LEVELS.map((_, l) => l).filter((l) => l !== focus.level)
      // The visitor's frame; the angles near it as previews, then at full quality; the rest of
      // the ring the same way; then the other distances.
      const looking = state.active === 'exterior'
      outside[0] = [job(focus, false, looking), job(focus, true, looking)]
      outside[1] = near.map((p) => job(p, false))
      outside[2] = near.map((p) => job(p, true))
      outside[3] = rest.map((p) => job(p, false))
      outside[4] = rest.map((p) => job(p, true))
      outside[5] = others.flatMap((l) => ring(l).map((p) => job(p, false)))
      outside[6] = others.flatMap((l) => ring(l).map((p) => job(p, true)))
    }
    const int = state.interior
    const width = Math.round(int.width / 16) * 16
    const panorama = (final: boolean): Job => ({
      key: this.interiorKey(),
      final,
      priority: 0,
      camera: {
        ...int.lens,
        matrix: Array.from(new Matrix4().setPosition(int.eye).elements),
        panorama: true,
      },
      width,
      height: width / 2,
      quality: final ? PANORAMA_FINAL : PREVIEW,
      exposure: state.exposure.interior,
      inside: true,
      focus: false,
    })
    // Before the textures: only what the visitor looks at, as a preview; the rest once they are in.
    if (this.provisional)
      return state.active === 'interior' ? [panorama(false)] : outside[0].slice(0, 1)
    // Outside, the panorama's preview comes once the near angles are done, so stepping inside
    // soon shows a path-traced view too.
    const groups =
      state.active === 'interior'
        ? [[panorama(false), panorama(true)], ...outside]
        : [outside[0], outside[1], [panorama(false)], ...outside.slice(2), [panorama(true)]]
    return groups.flatMap((group, priority) => group.map((job) => ({ ...job, priority })))
  }

  /**
   * Asks for what the visitor looks at at once, and keeps up to IN_FLIGHT other frame requests
   * open, in order of the job list.
   */
  private pump() {
    if (this.gain === null || !this.captured || this.failures >= 3) return
    if (this.closed.signal.aborted || document.hidden) return
    if (performance.now() < this.busyUntil) return
    const ext = this.state?.active === 'exterior' ? this.state.exterior : null
    const focused = ext ? this.exteriorKey(ext.pose) : ''
    if (focused !== this.focused) {
      // Turned: what is still queued for the angle before is dropped once this one is asked for.
      this.focused = focused
      this.focusSeq++
    }
    for (const job of this.jobs()) {
      const stored = this.frames.get(job.key)
      const have = job.final ? stored?.final : stored?.preview || stored?.final
      // A frame rendered before the scene settled is rendered again once it has.
      if (have && (!stored!.provisional || this.provisional)) continue
      const id = `${job.key}|${job.final}`
      if (this.inFlight.has(id)) continue
      if (!job.focus && this.inFlight.size >= IN_FLIGHT) break
      this.request(job, id)
    }
  }

  private request(job: Job, id: string) {
    const generation = this.generation
    const provisional = this.provisional
    const sequence = job.focus ? { generation: this.focusSeq, channel: 'f' } : { generation }
    const inFlight = this.inFlight
    const finish = {
      exposure: job.exposure,
      gain: job.inside ? this.gain!.interior : this.gain!.exterior,
    }
    inFlight.add(id)
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
          ...sequence,
        },
        this.abort.signal,
      ),
    )
      .then((frame) => {
        if (generation !== this.generation) return
        if (TRACE_STATS)
          console.info(
            `[spin] ${job.key.split('|').slice(-2).join('/') || 'panorama'} ${job.final ? 'final' : 'preview'}${provisional ? ' (before the textures)' : ''} ${job.width}x${job.height}: ${frame.cached ? 'cached' : `render ${frame.renderMs} ms`}, ${Math.round(frame.totalMs)} ms in all${frame.renderer ? `, ${frame.renderer} renderer` : ''}`,
          )
        const stored = this.frames.get(job.key) ?? { provisional: false }
        // Rendered before the textures and landing after a frame rendered with them: not wanted.
        if (provisional && (stored.final || (stored.preview && !stored.provisional))) return
        stored[job.final ? 'final' : 'preview'] = frame.image
        stored.provisional = provisional
        this.frames.set(job.key, stored)
        this.failures = 0
        this.onChange()
      })
      .catch((error) => {
        if (generation !== this.generation || this.abort.signal.aborted) return
        // The visitor turned past it before it rendered; whatever is wanted now is asked for next.
        if (error instanceof Superseded) return
        if (error instanceof Busy) {
          this.busyUntil = performance.now() + BUSY_MS
          setTimeout(() => this.pump(), BUSY_MS)
          return
        }
        // A server that cannot render frames will not start to, nor will GPUs others are using
        // free up soon: no point asking twice more.
        if (error instanceof Outdated || error instanceof Full || ++this.failures >= 3)
          this.fail(error)
      })
      .finally(() => {
        inFlight.delete(id)
        if (generation === this.generation) this.pump()
      })
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

  private count() {
    const state = this.state
    if (!state) return
    let ready = 0,
      final = 0,
      total = 1
    if (state.active === 'interior') {
      const p = this.frames.get(this.interiorKey())
      ready = p ? 1 : 0
      final = p?.final ? 1 : 0
    } else if (state.exterior) {
      total = SPIN_STEPS
      const { level } = state.exterior.pose
      for (let azimuth = 0; azimuth < SPIN_STEPS; azimuth++) {
        const f = this.frames.get(this.exteriorKey({ level, azimuth }))
        if (f) ready++
        if (f?.final) final++
      }
    }
    // Loading only until the frame the visitor looks at is decoded, at whatever tier.
    const focus = this.focusKey()
    const loading = !this.progress.failed && !(focus !== null && this.decoded.has(focus))
    this.progress = {
      loading,
      ready,
      total,
      final,
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

  /** The design (and look) the frames are rendered for now. */
  currentDesign() {
    return this.design
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
    const near = ringOrder(azimuth)
      .map((a) => this.exteriorKey({ level, azimuth: a }))
      .find((key) => this.frames.has(key))
    const shown = this.decode(near ?? outside)
    for (const d of [1, -1, 2, -2])
      this.decode(this.exteriorKey({ level, azimuth: wrap(azimuth + d) }))
    this.decode(this.interiorKey())
    // The frame turned to is still decoding: the nearest one decoded stands in meanwhile, rather
    // than the live view for the moment the decode takes. Decoded frames are all of this design,
    // so a changed design still shows none of the one before.
    return (
      shown ??
      ringOrder(azimuth)
        .map((a) => this.decoded.get(this.exteriorKey({ level, azimuth: a })))
        .find((d) => d !== undefined) ??
      null
    )
  }

  /** Whether a frame is the one for what the visitor looks at, not the nearest stand-in for it. */
  isFocus(frame: Decoded) {
    return frame.key === this.focusKey()
  }

  /**
   * The decoded frame, at the best tier decoded so far. A better tier stored (the full render
   * after its preview, a preview rendered with the textures after one without) is decoded on top,
   * even while a lesser one is still decoding, and replaces it when it lands.
   */
  private decode(key: string): Decoded | null {
    const current = this.decoded.get(key)
    if (current) {
      // Most recently used last.
      this.decoded.delete(key)
      this.decoded.set(key, current)
    }
    const stored = this.frames.get(key)
    if (!stored) return current ?? null
    const want: Tier = { final: !!stored.final, provisional: stored.provisional }
    if (current && tier(current) >= tier(want)) return current
    const pending = this.decoding.get(key)
    if (pending && tier(pending) >= tier(want)) return current ?? null
    const blob = stored.final ?? stored.preview!
    const design = this.design
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
    this.generation++
    this.abort.abort()
    this.closed.abort()
    for (const d of this.decoded.values()) d.texture.dispose()
    for (const texture of this.doomed) texture.dispose()
    this.decoded.clear()
    this.decoding.clear()
    this.doomed.clear()
  }
}
