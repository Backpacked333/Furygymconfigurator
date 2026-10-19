import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Matrix4,
  Quaternion,
  Vector3,
  type PerspectiveCamera,
  type WebGPURenderer,
} from 'three/webgpu'
import { BAKE, reportBake, type BakeResult } from '../lib/bake'
import { onBakedChange } from '../lib/bakedStills'
import type { Config, View } from '../lib/config'
import { RENDER_VERSION, configKey } from '../lib/stillKey'
import { exposureAt, type SkyLook } from '../lib/visuals'
import {
  createPipeline,
  createStillFinish,
  type Pipeline,
  type StillFinish,
} from '../render/pipeline'
import { CloudClient, cloudUrl, type CloudCamera } from '../render/cloud'
import { bench } from '../render/bench'
import {
  GALLERY_ANGLES,
  angleKey,
  aspectClassOf,
  galleryAngle,
  galleryCamera,
  type AngleId,
} from '../render/gallery'
import { IDLE_MS } from '../render/plan'
import { bakeJobs } from '../render/bake'
import {
  StillSession,
  cloudCamera,
  type BakedLookup,
  type LocalJob,
  type PrefetchState,
  type SceneKeys,
  type StillState,
} from '../render/stills'
import { prefetchOn, prefetchSiblings, usePrefetchIntent } from '../render/prefetch'
import {
  captureSibling,
  deriveSibling,
  siblingKeys,
  siblingLoaded,
  whenSiblingLoaded,
  type Derivation,
} from '../render/siblings'
import { keepDecodedTextures, onMaterialsChanged } from '../render/materials'
import {
  EXPORT_SAMPLES,
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
import { invalidateShadows, refreshShadows } from '../render/shadows'
import { measuredProgress, sceneProgress, textureProgress } from '../render/progress'
import { setStills, setStillRetry } from '../render/stillStatus'
import { MotionShutter } from '../render/motionBlur'
import { liveSettled, setFreezer, type LivePose } from '../render/liveView'

/**
 * Camera motion below OrbitControls' own change threshold (squared distance and quaternion terms of
 * 1e-6) is not motion: its damping keeps nudging the camera by such amounts for hundreds of frames
 * after an orbit, and restarting the settle run for each nudge kept the GPU busy long after
 * anything visibly moved.
 */
const STILL = 1e-6
/** Median frame time (ms) of a settle run above which a tier is too heavy for this device. */
const SLOW_FRAME_MS: Record<Quality, number> = { ultra: 50, high: 75, lite: Infinity }
/**
 * How long a download or a PDF waits for the current angle's export (the cloud's takes up to a
 * minute on the GPU) before it takes the still on the stage.
 */
const EXPORT_WAIT_MS = 75_000
/** `?denoise=0` shows the raw accumulation, for comparing against the denoised image. */
const denoise = new URLSearchParams(window.location.search).get('denoise') !== '0'
/** `?traceStats=1` logs which fingerprint of which part of the scene an edit changed. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'
const SCENE_PARTS: ScenePart[] = ['exterior', 'interior']
/** Bake mode renders every still afresh. */
const BAKE_LOOKUP: BakedLookup = { still: () => null, revision: () => 0 }
/** In bake mode, how often the frame loop looks again whether the design is ready to bake. */
const BAKE_POLL_MS = 500
/** Siblings' derivations kept (siblings.ts): a few sections' worth. */
const DERIVATIONS_KEPT = 48

export type Capture = () => Promise<string>
/** Requests made while an image is on its way share it. An empty image means none was made. */
type PendingCapture = { deadline: number; resolvers: ((image: string) => void)[] }

/** A data URL's bytes as a Blob, read at once (the canvas it came from changes next frame). */
function dataUrlBlob(url: string) {
  const [head, body] = url.split(',')
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: /data:([^;]+)/.exec(head)?.[1] ?? 'image/png' })
}

/** A still as a PNG data URL, which the PDF and a download both take (a baked one by address). */
async function pngOf(image: Blob | string) {
  const blob = typeof image === 'string' ? await (await fetch(image)).blob() : image
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.toDataURL('image/png')
}

/**
 * Drives the frame. In the 360° view (`mode` live) the TSL raster pipeline renders on demand and
 * keeps drawing for a short settle window after each change, so temporal anti-aliasing, AO and GI
 * accumulate; no tracer runs there. While its camera moves, High and Ultra blur each frame along
 * its motion (motionBlur.ts); the frame it settles on has no blur at all.
 *
 * In the gallery the stage shows path-traced stills (stills.ts) over this canvas, which stays
 * mounted, hidden, and draws only what the stills need: the view this device's tracer starts from
 * when it renders the stage's still itself (WebGPU, with no cloud to do it). That still is traced
 * offscreen and handed to the stage finished as the cloud's are, so its progressive samples are
 * never seen. Stills and the live view share one exposure (visuals.ts exposureAt): nothing about a
 * still depends on this device or its tier. Until the stage has a still to show (a design never
 * rendered before, or no tracer at all) the canvas shows the live view at the angle's camera.
 */
export function RenderEffects({
  active,
  quality,
  trace,
  look,
  config,
  view,
  dimensions,
  mode,
  angle,
  hero,
  covered,
  onCaptureReady,
  onSlow,
}: {
  /** False while hidden under the floor plan: no frame runs, and the visitor is editing. */
  active: boolean
  quality: Quality
  /** Render path-traced stills (in the cloud, or on this device with WebGPU). */
  trace: boolean
  look: SkyLook
  config: Config
  view: View
  dimensions: boolean
  /** The gallery of stills, or the live 360° view. */
  mode: 'gallery' | 'live'
  /** The gallery angle on the stage, and the direction of its front three-quarter view. */
  angle: AngleId
  hero: [number, number, number]
  /** A still covers the canvas: in the gallery, nothing need be drawn for the visitor. */
  covered: boolean
  /** Null once this scene is gone: a capture must never read the canvas of a renderer that is. */
  onCaptureReady: (capture: Capture | null) => void
  /** Called once per tier when consecutive frames are consistently slow. */
  onSlow?: () => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  const width = useThree((state) => state.size.width)
  const height = useThree((state) => state.size.height)
  const renderer = gl as unknown as WebGPURenderer
  const webgpu = backendOf(renderer) === 'webgpu'
  const pipeline = useRef<Pipeline | null>(null)
  /** Where the camera stands, for the pipeline's ambient occlusion. */
  const place = useRef<'exterior' | 'interior'>('exterior')
  const [tracer, setTracer] = useState<PathTraceSession | null>(null)
  const present = useRef<StillFinish | null>(null)
  const settle = useRef(0)
  const lastView = useRef({ position: new Vector3(Infinity, 0, 0), quaternion: new Quaternion() })
  const lastProjection = useRef(new Matrix4())
  const changed = useRef(true)
  /**
   * Something the live view shows changed (an edit, the camera, a texture, a probe capture): in
   * the gallery the view is drawn only then, not for the stills' own redraws.
   */
  const dirty = useRef(true)
  /** Whether the raster frame on screen shows the current view, settled. */
  const fresh = useRef(false)
  const pending = useRef<PendingCapture | null>(null)
  /** Redraws when a capture's wait runs out, in case nothing else does by then. */
  const captureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lookRef = useRef(look)
  const modeRef = useRef(mode)
  /** The 360° view's motion blur, from the camera's motion frame to frame. */
  const shutter = useRef(new MotionShutter()).current
  /** Canvases waiting for the live view's next frame (liveView.ts freezeLiveView). */
  const freezes = useRef<{ target: HTMLCanvasElement; resolve: (pose: LivePose | null) => void }[]>(
    [],
  )
  /** When the design last changed: the other angles' stills wait for it to hold still a while. */
  const lastChange = useRef(performance.now())
  /** A redraw booked for a moment no event brings (the design turning idle). */
  const wake = useRef<{ at: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  /** Bake mode: the bake has started (or failed to). */
  const baking = useRef(false)
  const timing = useRef({
    last: 0,
    samples: [] as number[],
    frames: 0,
    reported: false,
    eventful: false,
  })
  useEffect(() => {
    lookRef.current = look
    modeRef.current = mode
  }, [look, mode])
  const deliver = (image: string) => {
    const capture = pending.current
    pending.current = null
    if (captureTimer.current) clearTimeout(captureTimer.current)
    captureTimer.current = null
    capture?.resolvers.forEach((resolve) => resolve(image))
  }
  /** Redraws at `at` (the earliest asked for), so the stills learn what time alone changes. */
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
    created.setPlace(place.current)
    pipeline.current = created
    invalidateShadows(scene)
    settle.current = 0
    fresh.current = false
    dirty.current = true
    timing.current = { last: 0, samples: [], frames: 0, reported: false, eventful: false }
    invalidate()
    return () => {
      pipeline.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  // The design's key, and every gallery angle's camera for it at this stage's shape.
  const design = useMemo(() => configKey(config), [config])
  // The stills' exposure: the live view's, from the time of day alone.
  const exposure = useMemo(() => exposureAt(config.time), [config.time])
  const aspect = aspectClassOf(width, height)
  const heroKey = hero.join(',')
  const { near, far } = camera as PerspectiveCamera
  const lenses = useMemo(() => {
    const direction = heroKey.split(',').map(Number) as [number, number, number]
    const cameras = {} as Record<AngleId, CloudCamera>
    const angleKeys = {} as Record<AngleId, string>
    for (const { id } of GALLERY_ANGLES) {
      cameras[id] = cloudCamera(galleryCamera(config, id, aspect, direction), near, far)
      angleKeys[id] = angleKey(id, direction)
    }
    return { cameras, angleKeys }
  }, [config, aspect, heroKey, near, far])

  // This device's tracer loads on demand, and only where WebGPU compute is available. With a
  // cloud renderer, light devices leave all tracing to it; others keep it ready for when every
  // cloud GPU is in use.
  const remote = useMemo(() => cloudUrl(), [])

  // The prefetch (stills.ts): the open panel section's siblings, the option pointed at first, each
  // captured from the live scene with its surfaces swapped in for the moment (siblings.ts). Only
  // from the cloud, and never on Lite or in bake mode.
  const intent = usePrefetchIntent()
  const derivations = useRef(new Map<string, Derivation | null>())
  const prefetch = useMemo((): PrefetchState | null => {
    if (!prefetchOn(quality, remote !== null, !!BAKE)) return null
    const found = prefetchSiblings(config, intent)
    if (!found?.options.length) return null
    const direction = heroKey.split(',').map(Number) as [number, number, number]
    return {
      section: found.field,
      siblings: found.options.map(({ config: sibling }) => {
        const key = configKey(sibling)
        return {
          design: key,
          capture: (at, expected) => {
            const pair = `${design}|${key}`
            const kept = derivations.current
            let derivation = kept.get(pair)
            if (derivation === undefined) {
              derivation = deriveSibling(config, sibling)
              kept.set(pair, derivation)
              if (kept.size > DERIVATIONS_KEPT) kept.delete(kept.keys().next().value!)
            }
            if (!derivation) return { kind: 'never' }
            const lens = {
              camera: cloudCamera(galleryCamera(sibling, at, aspect, direction), near, far),
              angleKey: angleKey(at, direction),
            }
            // Its keys first, which need no scans and no capture: a sibling whose still at this
            // angle is in already costs neither.
            const keys = siblingKeys(scene, lookRef.current, derivation, expected)
            if (!keys) return { kind: 'later' }
            if (!siblingLoaded(derivation)) {
              const load = () => whenSiblingLoaded(derivation)
              return { kind: 'unloaded', keys, load, ...lens }
            }
            const take = () => {
              const shot = captureSibling(scene, lookRef.current, derivation, expected)
              return shot ? shot.captured : Promise.reject(new Error('the scene has changed'))
            }
            return { kind: 'ready', keys, take, ...lens }
          },
        }
      }),
    }
  }, [config, design, intent, quality, remote, scene, aspect, heroKey, near, far])
  // A section opened, or an option pointed at: the plan is looked at again.
  useEffect(() => invalidate(), [prefetch, invalidate])
  const localAvailable = webgpu && trace && (quality !== 'lite' || remote === null)
  useEffect(() => {
    if (!localAvailable) return
    let active = true
    let created: PathTraceSession | null = null
    loadTracerModule()
      .then(async (module) => {
        // The tracer reads the scans' decoded pixels, which are otherwise freed after upload.
        await keepDecodedTextures(true)
        return new PathTraceSession(renderer, module, denoise)
      })
      .catch((error) => {
        console.warn('Path tracing is unavailable on this device.', error)
        return null
      })
      .then((loaded) => {
        if (!active) {
          loaded?.dispose()
          return
        }
        created = loaded
        setTracer(loaded)
      })
    return () => {
      active = false
      created?.dispose()
      setTracer(null)
      void keepDecodedTextures(false)
      local.current = null
      invalidate()
    }
  }, [renderer, localAvailable, invalidate])

  useEffect(() => {
    if (!tracer) return
    const created = createStillFinish(renderer, tracer.tracer.target!)
    present.current = created
    invalidate()
    return () => {
      present.current = null
      created.dispose()
    }
  }, [renderer, tracer, invalidate])

  // The stills' session.
  const stills = useRef<{ session: StillSession } | null>(null)
  /** The still this device's tracer is on: settling the raster view it starts from, or tracing. */
  const local = useRef<{ job: LocalJob; phase: 'settle' | 'trace'; began: number } | null>(null)
  /** Each part's fingerprints as last signed, to name what an edit changed (`?traceStats=1`). */
  const sceneHashes = useRef<Record<ScenePart, SceneParts | null>>({
    exterior: null,
    interior: null,
  })
  const stillsOn = trace && (remote !== null || localAvailable)
  useEffect(() => {
    if (!stillsOn) {
      setStills(null)
      return
    }
    const created = {
      session: new StillSession(
        remote ? new CloudClient(remote) : null,
        invalidate,
        BAKE ? BAKE_LOOKUP : undefined,
      ),
    }
    stills.current = created
    setStillRetry(() => {
      local.current = null
      created.session.retry()
    })
    invalidate()
    return () => {
      stills.current = null
      setStillRetry(null)
      created.session.dispose()
      setStills(null)
      changed.current = true
      invalidate()
    }
  }, [stillsOn, remote, invalidate])
  useEffect(() => {
    stills.current?.session.setLocalAvailable(tracer !== null)
  }, [tracer, stillsOn])
  // Bake mode with no cloud to render on (`?trace=0`, or a renderer turned off): the script hears
  // at once rather than when its wait runs out.
  useEffect(() => {
    if (BAKE && !BAKE.list && (!trace || remote === null))
      reportBake({ state: 'failed', error: 'There is no cloud renderer to bake with.' })
  }, [trace, remote])
  // A baked still that failed to load is rendered instead: the plan is looked at again.
  useEffect(() => onBakedChange(invalidate), [invalidate])
  // The 360° view stands the stills down: nothing new is asked for, and the canvas is redrawn.
  // Its camera was placed there, not moved: no blur on its first frames. Bake mode renders only
  // what it bakes.
  useEffect(() => {
    stills.current?.session.setActive(mode === 'gallery' && !BAKE)
    shutter.cut()
    changed.current = true
    invalidate()
  }, [mode, stillsOn, invalidate, shutter])

  // Inside, the ambient occlusion reaches less far than outside (pipeline.ts AO_REACH).
  useEffect(() => {
    place.current = view === 'interior' ? 'interior' : 'exterior'
    pipeline.current?.setPlace(place.current)
  }, [view])
  // Any edit to the design redraws the view, from the start of a settle run.
  useEffect(() => {
    changed.current = true
    invalidate()
  }, [config, view, dimensions, covered, invalidate])
  // The design alone: a view switch or the dimensions are no edit.
  useEffect(() => {
    lastChange.current = performance.now()
  }, [config])
  // Under the floor plan no frame runs to tell the stills the visitor is editing: told here.
  useEffect(() => {
    if (!active) stills.current?.session.setIdle(false)
  }, [active])

  // Streamed textures change surfaces, and each interior probe capture redraws shadow maps with
  // foliage and glazing hidden, so both also refresh the shadows.
  useEffect(
    () =>
      onMaterialsChanged((change) => {
        invalidateShadows(scene)
        settle.current = 0
        dirty.current = true
        if (change === 'textures') {
          changed.current = true
          tracer?.invalidate()
        }
        invalidate()
      }),
    [scene, invalidate, tracer],
  )

  useEffect(() => {
    onCaptureReady(() => {
      const producer = stills.current
      // The live view, or a gallery with nothing to render stills: the raster frame is the image.
      if (
        modeRef.current !== 'gallery' ||
        !producer ||
        producer.session.snapshot().source === null
      ) {
        const pipe = pipeline.current
        if (pipe?.shutter) pipe.shutter.value = 0
        beginFrame(renderer)
        refreshShadows(scene)
        pipe?.render()
        return Promise.resolve(renderer.domElement.toDataURL('image/png'))
      }
      // The current angle's export once it is in; the still on the stage when the wait runs out.
      return new Promise<string>((resolve) => {
        if (pending.current) pending.current.resolvers.push(resolve)
        else {
          pending.current = { deadline: performance.now() + EXPORT_WAIT_MS, resolvers: [resolve] }
          captureTimer.current = setTimeout(invalidate, EXPORT_WAIT_MS + 50)
        }
        invalidate()
      })
    })
    // A capture must never read the canvas of a renderer that is gone.
    return () => onCaptureReady(null)
  }, [renderer, scene, onCaptureReady, invalidate])

  // Leaving the 360° view holds its last frame while the still it returns to is on its way.
  useEffect(() => {
    const waiting = freezes.current
    setFreezer(
      (target) =>
        new Promise<LivePose | null>((resolve) => {
          waiting.push({ target, resolve })
          invalidate()
        }),
    )
    return () => {
      setFreezer(null)
      waiting.splice(0).forEach(({ resolve }) => resolve(null))
    }
  }, [invalidate])

  useEffect(
    () => () => {
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

  useFrame((state) => {
    // Not `active`: that is the prop, which the stills' idle gate below reads.
    const pipe = pipeline.current
    if (!pipe) return
    const now = performance.now()
    const cam = camera as PerspectiveCamera
    // Controls move the camera without refreshing its world matrix.
    camera.updateMatrixWorld()
    // Shadow maps are redrawn on demand (shadows.ts), by the first scene render after a change,
    // which marks that frame as eventful for the timing below.
    let eventful = false
    const gallery = mode === 'gallery'
    const producer = gallery ? stills.current : null
    const usable = tracer && present.current ? tracer : null
    let job: LocalJob | null = null

    if (producer) {
      const session = producer.session
      // Fingerprinted on every frame drawn (a few hundred objects: cheap), not only after an edit
      // is told of: a part mounted on its own a moment later (the mirror's glass, once its
      // reflector exists) would otherwise be signed only with the next edit. The fingerprints read
      // world matrices, which nothing refreshes before this frame's render.
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
        if (differing.length) console.info(`[stills] scene ${part} changed: ${differing.join('/')}`)
        sceneHashes.current[part] = parts
      }
      const textures = textureProgress.get()
      const idle = active && now - lastChange.current >= IDLE_MS
      if (active && !idle) wakeAt(lastChange.current + IDLE_MS)
      const stillState: StillState = {
        design,
        angle,
        aspect,
        stage: {
          width: state.size.width,
          height: state.size.height,
          dpr: window.devicePixelRatio || 1,
        },
        cameras: lenses.cameras,
        angleKeys: lenses.angleKeys,
        exposure,
        idle,
        editedAt: lastChange.current,
        prefetch: active ? prefetch : null,
      }
      session.sync(
        scene,
        lookRef.current,
        keys,
        stillState,
        // Scanned materials still streaming in: the stills wait for them (each arrival redraws).
        textures.loaded >= textures.requested,
      )
      session.wantExport(pending.current !== null)
      if (BAKE && !baking.current) {
        const ready = session.bakeState()
        if (ready === 'waiting') wakeAt(now + BAKE_POLL_MS)
        else {
          baking.current = true
          if (ready === 'failed')
            reportBake({ state: 'failed', error: 'The cloud renderer is not available.' })
          else {
            const jobs = bakeJobs({
              config,
              hero,
              aspects: BAKE.aspects,
              near: cam.near,
              far: cam.far,
              quick: BAKE.quick,
            })
            const results: BakeResult[] = []
            reportBake({ state: 'rendering', version: RENDER_VERSION, design, total: jobs.length })
            session
              .bake(jobs, (job, frame) => {
                results.push({
                  key: job.key,
                  angle: job.angle,
                  angleKey: job.angleKey,
                  aspect: job.aspect,
                  width: job.width,
                  height: job.height,
                  samples: job.quality.samples,
                  renderMs: frame.renderMs,
                  cached: frame.cached,
                  image: frame.image,
                })
                reportBake({ results: [...results] })
              })
              .then(({ lighting, gains }) => reportBake({ state: 'done', lighting, gains }))
              .catch((error: unknown) =>
                reportBake({
                  state: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
          }
        }
      }
      job = usable ? session.localJob() : null
    }

    // This device's tracer: a job that changed (another angle, another design) starts over.
    const current = local.current
    if (current && (!job || current.job.key !== job.key || current.job.tier !== job.tier)) {
      if (current.phase === 'trace') usable?.halt()
      local.current = null
    }
    if (job && usable && !local.current) local.current = { job, phase: 'settle', began: 0 }

    const last = lastView.current
    const travelled =
      last.position.distanceToSquared(camera.position) > STILL ||
      8 * (1 - Math.abs(last.quaternion.dot(camera.quaternion))) > STILL
    const reframed = !lastProjection.current.equals(camera.projectionMatrix)
    const moved = travelled || reframed
    // A new lens or a resized canvas, with the camera where it was, is a cut, not motion.
    if (reframed && !travelled) shutter.cut()
    if (moved || changed.current) {
      last.position.copy(camera.position)
      last.quaternion.copy(camera.quaternion)
      lastProjection.current.copy(camera.projectionMatrix)
      changed.current = false
      dirty.current = true
      settle.current = 0
      fresh.current = false
      if (local.current?.phase === 'trace') {
        usable?.halt()
        local.current.phase = 'settle'
      }
    }
    // The 360° view's shutter: open on a frame the camera moved for, then let go. Never in the
    // gallery, whose frames are the meter's and the tracer's starting points.
    if (pipe.shutter) pipe.shutter.value = gallery ? 0 : shutter.frame(now, travelled)

    const tracing = local.current
    if (tracing && usable && producer) {
      const target = tracing.job.tier === 'export' ? EXPORT_SAMPLES : REST_SAMPLES
      // Traced from the raster view at the job's camera, once that view has settled.
      const at = lenses.cameras[tracing.job.angle].matrix
      const posed = camera.matrixWorld.elements.every((v, i) => Math.abs(v - at[i]) < 1e-3)
      if (tracing.phase === 'settle' && fresh.current && settle.current <= 0 && posed) {
        usable.begin(scene, camera, lookRef.current, target)
        tracing.phase = 'trace'
        tracing.began = now
      }
      if (tracing.phase === 'trace') {
        // Offscreen: the tracer renders into its own targets, and nothing of it is presented
        // until the image is done.
        usable.step()
        const elapsed = now - tracing.began
        const fraction = measuredProgress(usable.samples, target)
        producer.session.reportLocal(
          tracing.job,
          fraction,
          fraction > 0.05 ? (elapsed / fraction) * (1 - fraction) : null,
        )
        if (usable.ready(target)) {
          // The finished image, finished as the cloud finishes its stills (pipeline.ts
          // stillFinish) at its part's exposure, read off the canvas in this task; the raster view
          // is drawn again at once, so the visitor never sees it here.
          present.current!.render(
            usable.view(now).to,
            exposure[galleryAngle(tracing.job.angle).group],
          )
          const blob = dataUrlBlob(renderer.domElement.toDataURL('image/webp', 0.92))
          usable.halt()
          local.current = null
          producer.session.deliverLocal(tracing.job, blob, target)
          beginFrame(renderer)
          pipe.render()
        }
        invalidate()
      }
    }

    // The live view's next frame for the stage to hold, drawn sharp, with where the camera stands.
    if (freezes.current.length) {
      if (pipe.shutter) pipe.shutter.value = 0
      beginFrame(renderer)
      refreshShadows(scene)
      pipe.render()
      const canvas = renderer.domElement
      const forward = camera.getWorldDirection(new Vector3())
      const pose: LivePose = {
        position: [camera.position.x, camera.position.y, camera.position.z],
        forward: [forward.x, forward.y, forward.z],
      }
      for (const { target, resolve } of freezes.current.splice(0)) {
        target.width = canvas.width
        target.height = canvas.height
        const context = target.getContext('2d')
        if (!context) {
          resolve(null)
          continue
        }
        context.drawImage(canvas, 0, 0)
        resolve(pose)
      }
    }

    if (producer) {
      // A download or a PDF: the export once it is in, the stage's still when the wait runs out.
      const capture = pending.current
      const best = producer.session.best()
      if (capture && (best?.tier === 'export' || now > capture.deadline)) {
        pending.current = null
        if (captureTimer.current) clearTimeout(captureTimer.current)
        captureTimer.current = null
        const answer = (image: string) => capture.resolvers.forEach((resolve) => resolve(image))
        if (best)
          pngOf('blob' in best ? best.blob : best.url).then(answer, () =>
            answer(renderer.domElement.toDataURL('image/png')),
          )
        else {
          beginFrame(renderer)
          refreshShadows(scene)
          pipe.render()
          answer(renderer.domElement.toDataURL('image/png'))
        }
      }
      setStills(producer.session.snapshot(now))
    }

    // Under a still the canvas is hidden: nothing is drawn but what the local tracer starts from.
    if (gallery && covered && local.current?.phase !== 'settle') return

    // In the gallery the live view is drawn only for a reason: the stills' own redraws (a still
    // landing, a timer) and the tracer's every frame would otherwise start settle runs for nothing.
    if (gallery && !dirty.current && settle.current <= 0) return
    dirty.current = false
    // Raster rendering with a settle run after every change.
    const chained = settle.current > 0
    if (settle.current <= 0) settle.current = pipe.settleFrames
    // A frame right after a change, a streamed texture, or a probe capture also compiles shaders,
    // uploads textures, and redraws shadows: one-off work, not the cost of the tier.
    if (refreshShadows(scene)) eventful = true
    pipe.render()
    sceneProgress.drawn()
    bench.mark('firstRaster', now)
    settle.current--
    // A frame still blurred is not the frame the view rests on: one more, until the blur is gone.
    if (settle.current <= 0 && (pipe.shutter?.value ?? 0) > 0) settle.current = 1
    if (settle.current > 0) invalidate()
    else {
      fresh.current = true
      liveSettled()
      // The local tracer starts from the settled view, on the next frame.
      if (local.current) invalidate()
    }
    if (!producer && settle.current <= 0 && pending.current)
      deliver(renderer.domElement.toDataURL('image/png'))
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
