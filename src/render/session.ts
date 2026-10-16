import type { Camera, Scene, Texture } from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import type { CloudSession, OrbitContext } from './cloud'
import { REST_SAMPLES, type PathTraceSession, type TraceView } from './pathtrace'
import type { TraceSource, TraceState } from './traceStatus'

/** How long a warm cloud GPU gets before this device starts tracing as well. */
export const LOCAL_AFTER_MS = 6000

/**
 * Path traces resting views with whatever is available: a cloud GPU (render-server/), this
 * device's GPU, or both.
 *
 * - A cloud GPU that answered in the last few minutes is probably still on, so it gets a head
 *   start of LOCAL_AFTER_MS before this device spends any effort.
 * - Otherwise (it may be starting from cold, or failed) the local tracer starts at once and the
 *   cloud image crossfades over whatever it has reached.
 * - Once the cloud image is on screen the local tracer stops, keeping its samples for reuse.
 * - A view the cloud has already rendered (orbit.ts) is shown without tracing locally at all.
 */
export class TraceSession {
  readonly local: PathTraceSession | null
  readonly cloud: CloudSession | null
  private args: [Scene, Camera, SkyLook, Texture, number] | null = null
  private began = 0
  private localStarted = false
  /** Frozen while the cloud image fades in from the local one. */
  private localPaused = false

  constructor(local: PathTraceSession | null, cloud: CloudSession | null) {
    this.local = local
    this.cloud = cloud
    if (cloud) cloud.onArrive = () => this.handover()
  }

  /** A texture to build the presenter with; every frame passes its own. */
  get texture(): Texture {
    return this.local?.tracer.target ?? this.cloud!.view().to
  }

  /** `orbit` is where the exterior camera orbits, for views pre-rendered in the cloud. */
  begin(
    scene: Scene,
    camera: Camera,
    look: SkyLook,
    raster: Texture,
    target = REST_SAMPLES,
    orbit: OrbitContext = null,
  ) {
    this.args = [scene, camera, look, raster, target]
    this.began = performance.now()
    this.localStarted = false
    this.localPaused = false
    const cached = this.cloud?.hasCached(scene, camera, look, orbit) ?? false
    this.cloud?.begin(scene, camera, look, raster, orbit)
    if (!this.cloud || (!this.cloud.client.warm && !cached)) this.startLocal()
  }

  private startLocal() {
    if (!this.local || this.localStarted || !this.args) return
    this.localStarted = true
    this.local.begin(...this.args)
  }

  /** The cloud image fades from what the local tracer shows, which holds still meanwhile. */
  private handover(): Texture | null {
    if (!this.local || !this.localStarted) return null
    this.localPaused = true
    const shown = this.local.view()
    return shown.t > 0 ? shown.to : null
  }

  private get localRunning() {
    return this.localStarted && !this.localPaused
  }

  /** Advances the view. Returns true while it is still developing. */
  step() {
    const cloud = this.cloud
    let refining = false
    if (cloud) {
      refining = cloud.step()
      const late = !cloud.arrived && performance.now() - this.began > LOCAL_AFTER_MS
      if (!this.localStarted && (cloud.failed || late)) this.startLocal()
      if (cloud.arrived && cloud.state === 'converged' && this.localStarted) {
        // The cloud image is fully on screen: keep the local samples for the next view.
        this.local!.halt()
        this.localStarted = false
      }
    }
    if (this.localRunning) refining = this.local!.step() || refining
    return refining
  }

  view(now = performance.now()): TraceView {
    if (this.cloud?.arrived) return this.cloud.view(now)
    if (this.localStarted) return this.local!.view(now)
    return { from: null, to: this.texture, t: 0, gain: 1 }
  }

  /** True once the image on screen is final enough for an export of `samples`. */
  ready(samples: number) {
    if (this.cloud?.arrived) return this.cloud.view().t >= 1
    return this.localRunning && this.local!.ready(samples)
  }

  halt() {
    this.cloud?.halt()
    if (this.localStarted) this.local!.halt()
    this.localStarted = false
    this.localPaused = false
  }

  invalidate() {
    this.local?.invalidate()
  }

  get source(): TraceSource {
    if (this.cloud && (this.cloud.arrived || !this.localStarted)) return 'cloud'
    return 'local'
  }

  get state(): TraceState {
    if (this.cloud?.arrived) return this.cloud.state
    if (this.localStarted) return this.local!.state
    return this.cloud?.state ?? 'off'
  }

  get samples() {
    return this.source === 'local' ? (this.local?.samples ?? 0) : 0
  }

  get target() {
    return this.local?.target ?? REST_SAMPLES
  }

  dispose() {
    this.cloud?.dispose()
    this.local?.dispose()
  }
}
