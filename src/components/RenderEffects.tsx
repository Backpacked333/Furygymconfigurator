import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  DataTexture,
  HalfFloatType,
  Matrix3,
  Matrix4,
  Quaternion,
  RGBAFormat,
  RenderTarget,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Config, View } from '../lib/config'
import type { SkyLook } from '../lib/visuals'
import {
  createExposureMeter,
  createPipeline,
  createSpinPresent,
  createTracePresent,
  type Pipeline,
  type TracePresent,
} from '../render/pipeline'
import {
  CloudClient,
  CloudSession,
  cameraRecord,
  cloudUrl,
  type CloudCamera,
} from '../render/cloud'
import { bench } from '../render/bench'
import { EXTERIOR_FOV, cameraFraming } from '../render/framing'
import { IDLE_MS } from '../render/plan'
import {
  DRIFT_MS,
  SpinSession,
  spinDrift,
  spinView,
  type Decoded,
  type RasterMeter,
  type SceneKeys,
  type SpinState,
} from '../render/spin'
import { INTERIOR_EXPOSURE } from './Atmosphere'
import { keepDecodedTextures, onMaterialsChanged } from '../render/materials'
import {
  EXPORT_SAMPLES,
  EXPORT_TIMEOUT_MS,
  PathTraceSession,
  REST_SAMPLES,
  loadTracerModule,
  lookKey,
  partsSignature,
  sceneParts,
  type ScenePart,
  type SceneParts,
} from '../render/pathtrace'
import type { Quality } from '../render/quality'
import { FRAME_BEGIN, backendOf, beginFrame } from '../render/renderer'
import { TraceSession } from '../render/session'
import { invalidateShadows, refreshShadows } from '../render/shadows'
import { sceneProgress, textureProgress } from '../render/progress'
import { setPrerenderProgress, setSpinStatus, setTraceStatus } from '../render/traceStatus'

/**
 * Camera motion below OrbitControls' own change threshold (squared distance and quaternion terms of
 * 1e-6) is not motion: its damping keeps nudging the camera by such amounts for hundreds of frames
 * after an orbit, and restarting the settle run (and the rest before tracing) for each nudge kept
 * the GPU busy and delayed the converged image long after anything visibly moved.
 */
const STILL = 1e-6
/** Median frame time (ms) of a settle run above which a tier is too heavy for this device. */
const SLOW_FRAME_MS: Record<Quality, number> = { ultra: 50, high: 75, lite: Infinity }
/**
 * Tracing starts once the view has held still for this many raster frames and REST_MS more. The
 * traced image replaces the raster one, so it need not wait for the raster settle run to finish.
 */
const TRACE_AFTER_FRAMES = 6
const REST_MS = 150
/** Samples at which a local trace on screen counts as the bench's good frame (the spin's good tier). */
const GOOD_SAMPLES = 256
/**
 * Raster frames drawn at each camera the exposure meter reads, fewest and most, by tier: enough
 * for the tier's temporal effects to settle, and no more than a settle run on a device that is
 * already slow (Lite has no temporal effects: its first frame is the frame).
 */
const METER_FRAMES: Record<Quality, [least: number, most: number]> = {
  lite: [1, 8],
  high: [4, 16],
  ultra: [4, 16],
}
/** `?denoise=0` shows the raw accumulation, for comparing against the denoised image. */
const denoise = new URLSearchParams(window.location.search).get('denoise') !== '0'
/** `?traceStats=1` logs which fingerprint of which part of the scene an edit changed. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'
const SCENE_PARTS: ScenePart[] = ['exterior', 'interior']

export type Capture = () => Promise<string>
/** Requests made while an image is rendering share it. An empty image means none was made. */
type PendingCapture = { deadline: number; resolvers: ((image: string) => void)[] }

/**
 * Drives the frame. While the camera moves, the TSL raster pipeline renders on demand and keeps
 * drawing for a short settle window so temporal anti-aliasing, AO, and GI accumulate. Once the
 * view rests, path tracing takes over and crossfades in: on a cloud GPU when a render server is
 * configured, and progressively on this device where WebGPU is available (see TraceSession);
 * any camera or scene change hands back to the rasterizer.
 *
 * With `spin`, the exterior steps through the path-traced spin's frames and the interior is a
 * 360° panorama (spin.ts), each frame drawn over the live view as it lands. A pose with no frame
 * yet shows the live view, rested and traced on this device as without a cloud, until its frame
 * arrives; the live view is never held back for one.
 */
export function RenderEffects({
  active,
  quality,
  trace,
  look,
  config,
  view,
  dimensions,
  spin,
  onCaptureReady,
  onSlow,
}: {
  /** False while hidden under the floor plan: no frame runs, and the visitor is editing. */
  active: boolean
  quality: Quality
  /** Path-trace resting views (on a cloud GPU, or locally with WebGPU). */
  trace: boolean
  look: SkyLook
  config: Config
  view: View
  dimensions: boolean
  /** Show the cloud's path-traced spin and panorama (spin.ts). */
  spin: boolean
  /** Null once this scene is gone: a capture must never read the canvas of a renderer that is. */
  onCaptureReady: (capture: Capture | null) => void
  /** Called once per tier when consecutive frames are consistently slow. */
  onSlow?: () => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  // The exterior OrbitControls (CameraRig): their target is the centre of pre-rendered orbits.
  const controls = useThree((state) => state.controls) as unknown as OrbitControlsImpl | null
  const renderer = gl as unknown as WebGPURenderer
  const webgpu = backendOf(renderer) === 'webgpu'
  const pipeline = useRef<Pipeline | null>(null)
  const [raster, setRaster] = useState<Pipeline | null>(null)
  const [session, setSession] = useState<TraceSession | null>(null)
  const present = useRef<TracePresent | null>(null)
  const mode = useRef<'raster' | 'trace'>('raster')
  const settle = useRef(0)
  /** Raster frames drawn since the view last changed. */
  const still = useRef(0)
  const lastView = useRef({ position: new Vector3(Infinity, 0, 0), quaternion: new Quaternion() })
  const lastProjection = useRef(new Matrix4())
  const changed = useRef(true)
  /** Whether the raster frame on screen (and in `hdr`) shows the current view. */
  const fresh = useRef(false)
  const rested = useRef(false)
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<PendingCapture | null>(null)
  /** Redraws when a capture's wait runs out, in case nothing else does by then. */
  const captureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reported = useRef(0)
  const lookRef = useRef(look)
  const spinSize = useRef(new Vector2()).current
  const meterMatrix = useRef(new Matrix4()).current
  const meterEye = useRef(new Vector3()).current
  const meterTarget = useRef(new Vector3()).current
  const spinRotation = useRef(new Matrix3()).current
  /** When the design last changed: the spin fetches frames ahead once it has held still a while. */
  const lastChange = useRef(performance.now())
  /** A redraw booked for a moment no event brings (the design turning idle, a drift ending). */
  const wake = useRef<{ at: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const timing = useRef({
    last: 0,
    samples: [] as number[],
    frames: 0,
    reported: false,
    eventful: false,
  })
  useEffect(() => {
    lookRef.current = look
  }, [look])
  const deliver = (image: string) => {
    const capture = pending.current
    pending.current = null
    if (captureTimer.current) clearTimeout(captureTimer.current)
    captureTimer.current = null
    capture?.resolvers.forEach((resolve) => resolve(image))
  }
  /** Redraws at `at` (the earliest asked for), so the spin learns what time alone changes. */
  const wakeAt = (at: number) => {
    const booked = wake.current
    if (booked && booked.at <= at) return
    if (booked) clearTimeout(booked.timer)
    wake.current = {
      at,
      timer: setTimeout(
        () => {
          wake.current = null
          invalidate()
        },
        Math.max(0, at - performance.now()) + 1,
      ),
    }
  }

  useEffect(() => {
    const created = createPipeline(renderer, scene, camera, quality)
    pipeline.current = created
    setRaster(created)
    invalidateShadows(scene)
    settle.current = 0
    fresh.current = false
    mode.current = 'raster'
    timing.current = { last: 0, samples: [], frames: 0, reported: false, eventful: false }
    invalidate()
    return () => {
      pipeline.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  // The local tracer loads on demand, and only where WebGPU compute is available. With a cloud
  // renderer, light devices leave all tracing to it, under the spin too: a pose with no frame yet
  // shows the live view until its frame lands. The governor steps a device down to Lite for being
  // slow, and a path tracer would slow it further.
  const remote = useMemo(() => cloudUrl(), [])
  // The spin replaces the one-view-at-a-time cloud session; the local tracer refines whatever
  // pose has no spin frame yet.
  const cloudAvailable = trace && remote !== null && !spin
  const localAvailable = webgpu && trace && (quality !== 'lite' || remote === null)
  useEffect(() => {
    if (!localAvailable && !cloudAvailable) return
    let active = true
    let created: TraceSession | null = null
    const local = localAvailable
      ? loadTracerModule()
          .then(async (module) => {
            // The tracer reads the scans' decoded pixels, which are otherwise freed after upload.
            await keepDecodedTextures(true)
            return new PathTraceSession(renderer, module, denoise)
          })
          .catch((error) => {
            console.warn('Path tracing is unavailable on this device.', error)
            return null
          })
      : Promise.resolve(null)
    local.then((tracer) => {
      if (!active) {
        tracer?.dispose()
        return
      }
      const cloud = cloudAvailable ? new CloudSession(renderer, remote!) : null
      if (cloud) cloud.onProgress = setPrerenderProgress
      if (!tracer && !cloud) return
      created = new TraceSession(tracer, cloud)
      setSession(created)
    })
    return () => {
      active = false
      created?.dispose()
      setSession(null)
      if (localAvailable) void keepDecodedTextures(false)
      // Hand the canvas straight back to the rasterizer.
      mode.current = 'raster'
      changed.current = true
      invalidate()
      setTraceStatus({ state: 'off', source: 'local', samples: 0, target: 0, exporting: false })
      setPrerenderProgress(null)
    }
  }, [renderer, localAvailable, cloudAvailable, remote, invalidate])

  useEffect(() => {
    if (!session || !raster) return
    const created = createTracePresent(renderer, raster.hdr, session.texture)
    present.current = created
    // A view that settled before the tracer finished loading starts refining now.
    rested.current = true
    invalidate()
    return () => {
      present.current = null
      created.dispose()
    }
  }, [renderer, session, raster, invalidate])

  // The spin: its session, the pass that shows its frames, and a meter for the raster frame's
  // brightness, which the spin's exposure matches once per lighting look.
  const spinner = useRef<{
    session: SpinSession
    present: ReturnType<typeof createSpinPresent>
    meter: ReturnType<typeof createExposureMeter>
    /** Where the meter's frames are drawn: a target nothing presents (see the frame loop). */
    offscreen: RenderTarget
  } | null>(null)
  /** What the spin shows: a frame, and the one it fades from. */
  const spinShown = useRef<{
    frame: Decoded | null
    mode: 'exterior' | 'interior'
    from: Texture | null
    start: number
  }>({ frame: null, mode: 'exterior', from: null, start: 0 })
  /** The scene outside and inside, fingerprinted apart so an edit in the room keeps the ring. */
  const sceneKeys = useRef<SceneKeys>({ exterior: '', interior: '' })
  /** Each part's fingerprints as last signed, to name what an edit changed (`?traceStats=1`). */
  const sceneHashes = useRef<Record<ScenePart, SceneParts | null>>({
    exterior: null,
    interior: null,
  })
  /** Waiting for the raster frame's brightness at a camera, which the next frame measures. */
  const meterWanted = useRef<
    { camera: CloudCamera | null; resolve: (meter: Promise<RasterMeter>) => void }[]
  >([])
  useEffect(() => {
    if (!spin || !remote) return
    const placeholder = new DataTexture(new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType)
    const created = {
      session: new SpinSession(new CloudClient(remote), invalidate),
      present: createSpinPresent(renderer),
      meter: createExposureMeter(renderer, placeholder),
      offscreen: new RenderTarget(4, 4, { depthBuffer: false }),
    }
    spinner.current = created
    invalidate()
    return () => {
      spinner.current = null
      spinShown.current = { frame: null, mode: 'exterior', from: null, start: 0 }
      created.session.dispose()
      created.present.dispose()
      created.meter.dispose()
      created.offscreen.dispose()
      placeholder.dispose()
      setSpinStatus(null)
      changed.current = true
      invalidate()
    }
  }, [spin, remote, renderer, invalidate])

  // Any edit to the design hands the frame back to the rasterizer and re-captures before tracing.
  useEffect(() => {
    changed.current = true
    invalidate()
  }, [config, view, dimensions, invalidate])
  // The design alone: a view switch or the dimensions are no edit, so they keep the spin's pace.
  useEffect(() => {
    lastChange.current = performance.now()
  }, [config])
  // Under the floor plan no frame runs to tell the spin the visitor is editing: told here.
  useEffect(() => {
    if (!active) spinner.current?.session.setIdle(false)
  }, [active])

  // Streamed textures change surfaces, and each interior probe capture redraws shadow maps with
  // foliage and glazing hidden, so both also refresh the shadows.
  useEffect(
    () =>
      onMaterialsChanged((change) => {
        invalidateShadows(scene)
        settle.current = 0
        if (change === 'textures') {
          changed.current = true
          session?.invalidate()
        }
        invalidate()
      }),
    [scene, invalidate, session],
  )

  useEffect(() => {
    onCaptureReady(() => {
      if (!spinner.current && (!session || !present.current)) {
        beginFrame(renderer)
        refreshShadows(scene)
        pipeline.current?.render()
        return Promise.resolve(renderer.domElement.toDataURL('image/png'))
      }
      // The spin's full-quality frame once it is on screen, or a converged local trace of a pose
      // the spin has no frame for yet; whatever is on screen when the wait runs out.
      return new Promise<string>((resolve) => {
        if (pending.current) pending.current.resolvers.push(resolve)
        else {
          pending.current = {
            deadline: performance.now() + EXPORT_TIMEOUT_MS,
            resolvers: [resolve],
          }
          // A pose the spin never brings a frame for, on a device without a tracer, would
          // otherwise wait forever: the end of the wait redraws, and delivers what is on screen.
          captureTimer.current = setTimeout(invalidate, EXPORT_TIMEOUT_MS + 50)
        }
        if (mode.current !== 'trace') rested.current = true
        invalidate()
      })
    })
    // A capture must never read the canvas of a renderer that is gone.
    return () => onCaptureReady(null)
  }, [renderer, scene, session, onCaptureReady, invalidate])

  useEffect(
    () => () => {
      if (restTimer.current) clearTimeout(restTimer.current)
      if (captureTimer.current) clearTimeout(captureTimer.current)
      if (wake.current) clearTimeout(wake.current.timer)
      // An export never waits on a scene that is gone.
      const capture = pending.current
      pending.current = null
      capture?.resolvers.forEach((resolve) => resolve(''))
    },
    [],
  )

  // Before every other frame subscriber: camera controls, environment and probe captures, the pipeline.
  useFrame(() => beginFrame(renderer), FRAME_BEGIN)

  useFrame(() => {
    // Not `active`: that is the prop, which the spin's idle gate below reads.
    const pipe = pipeline.current
    if (!pipe) return
    const now = performance.now()
    const tracer = session && present.current ? session : null
    const report = (force = false) => {
      if (!force && now - reported.current < 200) return
      reported.current = now
      setTraceStatus({
        state: tracer && mode.current === 'trace' ? tracer.state : 'off',
        source: tracer?.source ?? 'local',
        samples: tracer?.samples ?? 0,
        target: tracer?.target ?? 0,
        exporting: pending.current !== null,
      })
    }
    // Controls move the camera without refreshing its world matrix, and while tracing nothing
    // renders through it, so refresh it before checking for movement.
    camera.updateMatrixWorld()
    // Shadow maps are redrawn on demand (shadows.ts), by the first scene render after a change,
    // which marks that frame as eventful for the timing below.
    let eventful = false
    /** The exposure meter drew the view at another camera this frame (the spin). */
    let metered = false

    // The path-traced spin and panorama.
    const spinning = spinner.current
    if (spinning) {
      const cam = camera as PerspectiveCamera
      const size = renderer.getDrawingBufferSize(spinSize)
      const aspect = size.x / size.y
      const inside = cameraFraming(config, 'interior', [0, 0, 0], aspect)
      // The panorama has about the screen's pixel density at the interior's field of view.
      const across = 2 * Math.atan(Math.tan((inside.fov * Math.PI) / 360) * aspect)
      const panoramaWidth = Math.round((size.x * 2 * Math.PI) / across / 16) * 16
      const outside = renderer.toneMappingExposure / (view === 'interior' ? INTERIOR_EXPOSURE : 1)
      // Fingerprinted on every frame drawn (a few hundred objects: cheap), not only after an edit
      // is told of: a part mounted on its own a moment later (the mirror's glass, once its
      // reflector exists) would otherwise be signed only with the next edit. The fingerprints
      // read world matrices, which nothing refreshes before this frame's render: a dragged bench
      // would otherwise be signed where it was, and the panorama kept.
      scene.updateMatrixWorld()
      const key = lookKey(lookRef.current)
      const keys: SceneKeys = { exterior: '', interior: '' }
      for (const part of SCENE_PARTS) {
        const parts = sceneParts(scene, part)
        keys[part] = String(partsSignature(parts, key))
        if (!TRACE_STATS) continue
        const before = sceneHashes.current[part]
        const differing = (Object.keys(parts) as (keyof SceneParts)[]).filter(
          (hash) => before !== null && parts[hash] !== before[hash],
        )
        if (differing.length) console.info(`[spin] design ${part} changed: ${differing.join('/')}`)
        sceneHashes.current[part] = parts
      }
      sceneKeys.current = keys
      const looking = view === 'interior' ? 'interior' : 'exterior'
      const textures = textureProgress.get()
      // Both pass with time alone, so a redraw is booked for when they do.
      const drift = spinDrift(now)
      const idle = active && now - lastChange.current >= IDLE_MS
      if (drift !== 0) wakeAt(spinView.turned + DRIFT_MS)
      if (active && !idle) wakeAt(lastChange.current + IDLE_MS)
      const state: SpinState = {
        active: looking,
        width: size.x,
        height: size.y,
        dpr: renderer.getPixelRatio(),
        exterior:
          spinView.spec && spinView.pose
            ? {
                spec: spinView.spec,
                pose: spinView.pose,
                lens: { fov: EXTERIOR_FOV, near: cam.near, far: cam.far },
              }
            : null,
        interior: {
          eye: new Vector3(...inside.position),
          width: Math.min(8192, Math.max(2048, panoramaWidth)),
          lens: { fov: inside.fov, near: cam.near, far: cam.far },
          view: {
            matrix: meterMatrix
              .lookAt(
                meterEye.set(...inside.position),
                meterTarget.set(...inside.target),
                camera.up,
              )
              .setPosition(meterEye)
              .toArray(),
            fov: inside.fov,
            near: cam.near,
            far: cam.far,
          },
        },
        exposure: { exterior: outside, interior: outside * INTERIOR_EXPOSURE },
        drift,
        idle,
      }
      spinning.session.sync(
        scene,
        lookRef.current,
        sceneKeys.current,
        state,
        (at) =>
          new Promise<RasterMeter>((resolve) => {
            meterWanted.current.push({ camera: at, resolve })
            invalidate()
          }),
        // Scanned materials still streaming in: the spin waits for them (each arrival is redrawn).
        textures.loaded >= textures.requested,
      )
      // The full render is made only for an export: of the frame the visitor looks at, while a
      // capture waits for it.
      const focus = spinning.session.focusKey()
      spinning.session.wantFinal(pending.current && focus ? focus : null)
      if (meterWanted.current.length) {
        // The raster frame for this look at each camera asked for (the interior's while the
        // visitor is outside: only the camera and exposure differ between views), rendered a few
        // times so its temporal effects settle, and measured. The camera is put back, and the
        // view drawn again below.
        eventful = true
        refreshShadows(scene)
        const position = cam.position.clone()
        const quaternion = cam.quaternion.clone()
        const fov = cam.fov
        const [least, most] = METER_FRAMES[quality]
        const frames = Math.min(most, Math.max(least, pipe.settleFrames))
        // Each render is a frame of its own (the pipeline's passes draw once per frame), and
        // none reaches the canvas: the meter reads the pipeline's `hdr` texture, not the output,
        // and the output of these frames, another camera's view, would otherwise be presented,
        // now that no opaque gate hides the canvas while the spin loads.
        const draw = () => {
          beginFrame(renderer)
          pipe.render()
        }
        renderer.setRenderTarget(spinning.offscreen)
        try {
          for (const { camera: at, resolve } of meterWanted.current.splice(0)) {
            if (at) {
              metered = true
              meterMatrix.fromArray(at.matrix).decompose(cam.position, cam.quaternion, meterEye)
              cam.fov = at.fov
              cam.updateProjectionMatrix()
              cam.updateMatrixWorld()
            }
            for (let i = 0; i < frames; i++) draw()
            const record = at ?? cameraRecord(cam)
            resolve(
              spinning.meter
                .measure(pipe.hdr, false)
                .then((key) => ({ key, camera: record, width: size.x, height: size.y })),
            )
            cam.position.copy(position)
            cam.quaternion.copy(quaternion)
            cam.fov = fov
            cam.updateProjectionMatrix()
            cam.updateMatrixWorld()
          }
          if (metered && mode.current === 'trace') {
            // The meter left another camera's frame in `hdr`. Tracing, nothing else redraws the
            // view, and the first traced image fades in from `hdr`, so draw it again here, for
            // as many frames as the meter had (a full settle run would be the tier's whole
            // settle window in one frame; the traced image replaces it soon anyway).
            for (let i = 0; i < frames; i++) draw()
          }
        } finally {
          renderer.setRenderTarget(null)
        }
        // The pipeline's passes draw once per frame, and the meter's draws advanced it: a new
        // frame here, or the view's render below would present the last meter camera's frame
        // from `hdr` without drawing the scene again (the canvas still shows the frame before;
        // with the camera moved, the raster path below draws the view, from the start of a
        // settle run, since the temporal effects' history is now the meter camera's).
        beginFrame(renderer)
        if (metered) {
          settle.current = 0
          still.current = 0
          if (mode.current !== 'trace') fresh.current = false
        }
      }
      const frame = spinning.session.texture()
      const shown = spinShown.current
      if (frame && frame !== shown.frame) {
        // A better image of the same frame, or the first one after a design change, fades in;
        // stepping to the next frame of the spin cuts to it.
        const fades =
          shown.frame &&
          shown.mode === looking &&
          (frame.key === shown.frame.key || frame.design !== shown.frame.design)
        spinShown.current = {
          frame,
          mode: looking,
          from: fades ? shown.frame!.texture : null,
          start: now,
        }
      } else if (!frame && shown.frame && shown.frame.key !== spinning.session.focusKey()) {
        // Nothing decoded for this pose. The frame on screen stays only while it is for the pose
        // the visitor looks at now (its replacement for a changed design still rendering); turned
        // to a pose with no frame yet, the live view shows instead of a frozen one.
        spinShown.current = { frame: null, mode: looking, from: null, start: 0 }
      }
      const current = spinShown.current
      // Until the next frame is decoded the last one stays, in the same view only.
      if (current.frame && current.mode === looking) {
        if (mode.current === 'trace') {
          // The frame takes over from the local tracer, which keeps its samples for later.
          mode.current = 'raster'
          tracer?.halt()
          report(true)
        }
        const t = current.from ? Math.min(1, (now - current.start) / 300) : 1
        spinning.present.render({
          from: t < 1 ? current.from : null,
          to: current.frame.texture,
          t,
          panorama:
            looking === 'interior'
              ? {
                  rotation: spinRotation.setFromMatrix4(camera.matrixWorld),
                  tanHalfFov: Math.tan((cam.fov * Math.PI) / 360),
                  aspect: cam.aspect,
                }
              : null,
        })
        sceneProgress.drawn()
        bench.mark('firstPreview', now)
        if (current.frame.tier !== 'preview') bench.mark('firstGood', now)
        spinning.session.hold(
          t < 1 && current.from ? [current.frame.texture, current.from] : [current.frame.texture],
        )
        if (t < 1) invalidate()
        const capture = pending.current
        // The full-quality frame of the view itself: not the nearest one standing in for it, nor
        // the previous design's, kept at this pose while its replacement renders.
        const exact =
          current.frame.tier === 'final' &&
          spinning.session.isCurrent(current.frame) &&
          spinning.session.isFocus(current.frame)
        if (capture && (exact || now > capture.deadline))
          deliver(renderer.domElement.toDataURL('image/png'))
        else if (capture) invalidate()
        setSpinStatus({
          active: true,
          ...spinning.session.progress,
          panorama: looking === 'interior',
          showing: true,
        })
        return
      }
      spinning.session.hold([])
      setSpinStatus({
        active: true,
        ...spinning.session.progress,
        panorama: looking === 'interior',
        showing: false,
      })
      // Nothing path traced to show for this pose yet: the live view, rested and traced on this
      // device as without a cloud, which the exposure meter also reads.
    }
    const last = lastView.current
    const moved =
      last.position.distanceToSquared(camera.position) > STILL ||
      8 * (1 - Math.abs(last.quaternion.dot(camera.quaternion))) > STILL ||
      !lastProjection.current.equals(camera.projectionMatrix)
    if (moved || changed.current) {
      last.position.copy(camera.position)
      last.quaternion.copy(camera.quaternion)
      lastProjection.current.copy(camera.projectionMatrix)
      changed.current = false
      if (restTimer.current) clearTimeout(restTimer.current)
      restTimer.current = null
      rested.current = pending.current !== null
      settle.current = 0
      still.current = 0
      fresh.current = false
      if (mode.current === 'trace') {
        mode.current = 'raster'
        tracer?.halt()
        report(true)
      }
    }

    // Path-traced refinement of a resting view.
    if (mode.current === 'trace' && tracer) {
      // A capture asked for while the view traces: it carries on past the resting target.
      if (pending.current) tracer.retarget(EXPORT_SAMPLES)
      const refining = tracer.step()
      const traced = tracer.view(now)
      // Until the first traced image is ready the canvas keeps the last raster frame.
      if (traced.from || traced.t > 0) {
        present.current!.render(traced)
        sceneProgress.drawn()
        bench.mark('firstPreview', now)
        if (tracer.ready(GOOD_SAMPLES)) bench.mark('firstGood', now)
      }
      const capture = pending.current
      if (capture && (tracer.ready(EXPORT_SAMPLES) || now > capture.deadline))
        deliver(renderer.domElement.toDataURL('image/png'))
      report(!refining)
      if (refining || pending.current) invalidate()
      return
    }

    if (rested.current && tracer && fresh.current) {
      rested.current = false
      mode.current = 'trace'
      // Resting exterior views sit on the orbit grid (CameraRig snaps to it), so they can be
      // pre-rendered; not while auto-rotating.
      const orbit =
        view === 'exterior' && controls && !controls.autoRotate
          ? { target: controls.target.clone() }
          : null
      // A capture already waiting takes the export's target from the start.
      const target = pending.current ? EXPORT_SAMPLES : REST_SAMPLES
      tracer.begin(scene, camera, lookRef.current, pipe.hdr, target, orbit)
      report(true)
      invalidate()
      return
    }

    // Raster rendering with a settle run after every change.
    const chained = settle.current > 0
    if (settle.current <= 0) settle.current = pipe.settleFrames
    // A frame right after a change, a streamed texture, or a probe capture also compiles shaders,
    // uploads textures, and redraws shadows: one-off work, not the cost of the tier.
    if (refreshShadows(scene)) eventful = true
    pipe.render()
    // The view drawn again in the meter's own frame: the scene itself, not only the output pass
    // over the meter camera's frame, which would show on the canvas until the next frame.
    if (metered && TRACE_STATS) {
      const draws = renderer.info.render.drawCalls
      console[draws > 1 ? 'info' : 'warn'](
        `[spin] view drawn again after the meter: ${draws} draw call${draws === 1 ? '' : 's'}`,
      )
    }
    sceneProgress.drawn()
    bench.mark('firstRaster', now)
    fresh.current = true
    settle.current--
    still.current++
    if (settle.current > 0) invalidate()
    if (tracer) {
      if (!restTimer.current && (settle.current <= 0 || still.current >= TRACE_AFTER_FRAMES))
        restTimer.current = setTimeout(() => {
          rested.current = true
          invalidate()
        }, REST_MS)
    } else if (settle.current <= 0 && pending.current) {
      // Without a tracer the settled raster frame is the export, unless the spin may still bring
      // the frame itself before the wait runs out (captureTimer redraws then).
      if (!spinner.current || now > pending.current.deadline)
        deliver(renderer.domElement.toDataURL('image/png'))
    }
    // Back-to-back settle frames measure what this GPU can sustain at this tier. The first frames
    // after a pipeline is built, and eventful frames with the one after them (whose interval
    // still carries their GPU work), are ignored.
    const t = timing.current
    t.frames++
    const steady = !eventful && !t.eventful
    t.eventful = eventful
    if (chained && steady && t.last && t.frames > 8 && !t.reported) {
      t.samples.push(now - t.last)
      if (t.samples.length >= 16) {
        const sorted = [...t.samples].sort((a, b) => a - b)
        if (sorted[sorted.length >> 1] > SLOW_FRAME_MS[quality]) {
          t.reported = true
          onSlow?.()
        }
        t.samples = []
      }
    }
    t.last = now
  }, 1)
  return null
}
