import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Matrix4,
  NearestFilter,
  NoColorSpace,
  PerspectiveCamera,
  Texture,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import { loadAgxInverse } from '../render/agxInverse'
import type { GalleryCamera } from '../render/gallery'
import { keepDecodedTextures, onMaterialsChanged } from '../render/materials'
import { warmBVHs } from '../render/bvhWarmup'
import { MotionShutter } from '../render/motionBlur'
import { PathTraceSession, loadTracerModule, lookKey, sceneSignature } from '../render/pathtrace'
import { createPipeline, type Pipeline, type PipelineExtras } from '../render/pipeline'
import {
  liveLoading,
  refineProgress,
  sceneProgress,
  textureProgress,
  traceProgress,
} from '../render/progress'
import { backendOf, beginFrame, FRAME_BEGIN, type Quality } from '../render/renderer'
import { FrameGuard } from './frameGuard'
import { pixelsFromPose } from './entryPose'
import { ENTRY_TOLERANCE_PX } from './EntryWatch'
import { cyclesSeed, earlyImages, liveProfile, liveSampler, traceScale } from './liveProfile'
import { createProgressivePresentation } from './presentation'

export type ViewerStatus = 'loading' | 'interactive' | 'refining' | 'settled' | 'raster-only'
/**
 * How long the view must stay still before tracing may start. Short: a trace started in a brief
 * pause and then interrupted costs little, since what it traced is kept and seeds the next start.
 */
const REST_MS = 80
/** Raster frames drawn after a change before tracing may start: the capture is a settled frame. */
const START_FRAMES = 3
/**
 * Code values at or above which a pixel of the Cycles image seeds nothing: near white, a level of
 * an 8-bit image spans a large step of light (agxInverse.ts), past about 3.3× middle grey here.
 */
const SEED_CEILING = 0.94
/**
 * Longest the loading screen stays up once the scene is mounted: a design whose scans are slow (or
 * a tracer that never starts) opens as it is rather than keep the visitor waiting.
 */
const LOADING_LIMIT_MS = 15000
/**
 * Longest the first start waits for its geometry BVHs to be built off the main thread
 * (bvhWarmup.ts); any not built by then the tracer builds itself, as before.
 */
const BVH_WAIT_MS = 10000
/** Longest the first start at the entry pose waits for its Cycles image to decode. */
const SEED_WAIT_MS = 800
/** Longest the first frame waits for shaders to compile asynchronously before drawing anyway. */
const WARM_TIMEOUT_MS = 1500
const drawingBuffer = new Vector2()
/**
 * Ultra without its screen-space GI and reflections, for a device that cannot draw it while moving
 * (frameGuard.ts). Post-processing only: `quality`, which also decides what is in the scene, stays
 * Ultra, so the scene still matches the gallery's Cycles images.
 */
const LEAN_RASTER: PipelineExtras = { reflections: false, gi: false }

/** Compiles a pipeline's shaders asynchronously; one that never finishes holds nothing up. */
const warmed = (pipe: Pipeline) =>
  Promise.race([pipe.warm(), new Promise((resolve) => setTimeout(resolve, WARM_TIMEOUT_MS))])

/**
 * Records an entry in the browser's performance timeline (User Timing), where the Performance panel
 * and `performance.getEntriesByName` show it. Never throws: where User Timing is missing or refuses
 * the entry, the view goes on unrecorded.
 */
function timeline(record: () => void) {
  try {
    record()
  } catch {
    // Timing is a diagnostic only.
  }
}

/** Local-only rendering controller. Product geometry and configuration stay in the adapter. */
export function ProgressiveRenderer({
  active,
  revision,
  look,
  quality,
  place,
  onReady,
  onStatus,
  entry,
}: {
  active: boolean
  revision: string
  look: SkyLook
  quality: Quality
  place: 'exterior' | 'interior'
  onReady: () => void
  onStatus: (status: ViewerStatus) => void
  /**
   * The design's own Cycles image (`image`) and the camera it was rendered from (`pose`), where
   * the view opens on it: the first trace started there begins from that image's light, as from a
   * view already traced (PathTraceSession storeImage), rather than from nothing.
   */
  entry?: { pose: GalleryCamera; image: string }
}) {
  const { gl, scene, camera, invalidate, size, viewport } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const state = useRef<{
    pipe: Pipeline
    present: ReturnType<typeof createProgressivePresentation>
    tracer: PathTraceSession | null
    failed: boolean
    dirty: boolean
    ready: boolean
    tracing: boolean
    interacting: boolean
    warming: boolean
    restAt: number
    /** Raster frames drawn since the last change. */
    drawn: number
    view: Matrix4
    projection: Matrix4
    status: ViewerStatus
    shutter: MotionShutter
    signature: number | null
    /** Ultra's watch on its moving frames; null on other tiers and once it has tripped. */
    guard: FrameGuard | null
    /** The guard tripped: build the lean pipeline at the next rest. */
    shedDue: boolean
    shed: () => void
    /** The lean pipeline, compiled and waiting for a rest to take over. */
    lean: Pipeline | null
    /** The entry's Cycles image, decoding or decoded, until the first start at its pose. */
    seed: EntrySeed | null
    prepareSeed: () => void
    /** The first trace has started: the loading screen is done. */
    begun: boolean
    /** The scene's BVHs are being built in a worker for the first start. */
    warmingBVHs: boolean
  } | null>(null)
  const props = useRef({ active, look, place, onReady, onStatus, entry })
  useLayoutEffect(() => {
    props.current = { active, look, place, onReady, onStatus, entry }
    state.current?.prepareSeed()
    if (state.current) {
      state.current.dirty = true
      if (!active) {
        state.current.tracer?.halt()
        state.current.tracing = false
        traceProgress.set({ phase: 'idle' })
      }
    }
    invalidate()
  }, [
    active,
    revision,
    look,
    place,
    onReady,
    onStatus,
    invalidate,
    size.width,
    size.height,
    viewport.dpr,
    entry,
  ])

  useEffect(() => {
    let disposed = false
    const runtime = {
      pipe: createPipeline(renderer, scene, camera, quality),
      present: createProgressivePresentation(renderer),
      tracer: null as PathTraceSession | null,
      failed: backendOf(renderer) !== 'webgpu',
      dirty: true,
      ready: false,
      tracing: false,
      interacting: false,
      warming: true,
      restAt: 0,
      drawn: 0,
      view: new Matrix4(),
      projection: new Matrix4(),
      status: 'loading' as ViewerStatus,
      shutter: new MotionShutter(),
      signature: null as number | null,
      // Only Ultra carries passes it can do without; once per session, never touching `quality`.
      guard: quality === 'ultra' ? new FrameGuard() : null,
      shedDue: false,
      shed: () => {},
      lean: null as Pipeline | null,
      seed: null as EntrySeed | null,
      prepareSeed: () => {},
      begun: false,
      warmingBVHs: false,
    }
    state.current = runtime
    // The scene is mounted: what is left is its materials and light, then the tracer's start.
    liveLoading.set('materials')
    const loadingLimit = setTimeout(() => liveLoading.set('ready'), LOADING_LIMIT_MS)
    // The entry's image is on the stage already, so fetching it again reads the browser's cache;
    // it decodes off the main thread. Once per image: a reopened view whose history holds it
    // already, or a camera that left the pose first, has no use for it.
    runtime.prepareSeed = () => {
      const entry = props.current.entry
      if (!runtime.tracer || !entry || runtime.seed?.image === entry.image || !cyclesSeed()) return
      runtime.seed?.dispose()
      const seed = entrySeed(entry.image, performance.now() + SEED_WAIT_MS)
      runtime.seed = seed
      void seed.loaded.then(() => {
        if (!disposed && props.current.active) invalidate()
      })
    }
    // Building the lean graph is synchronous CPU work, so it starts at rest; the current pipeline
    // keeps drawing while the new one compiles, and the swap waits for a rest too.
    runtime.shed = () => {
      runtime.shedDue = false
      let next: Pipeline
      try {
        next = createPipeline(renderer, scene, camera, quality, LEAN_RASTER)
      } catch {
        return
      }
      timeline(() => performance.mark('fury:raster-shed'))
      void warmed(next).finally(() => {
        if (disposed) return next.dispose()
        runtime.lean = next
        if (props.current.active) invalidate()
      })
    }
    // Scans arriving swap maps on the materials the tracer holds: it reads the materials again on
    // its next start, keeping the meshes it captured and their BVH, and the views it traced
    // before seed a little (PathTraceSession texturesChanged).
    const texturesArrived = () => {
      runtime.dirty = true
      runtime.tracer?.texturesChanged()
      if (props.current.active) invalidate()
    }
    // Probe captures relight only the raster (the tracer lights the scene itself), so they redraw a
    // raster frame on screen but never restart a trace or rebuild its scene.
    const materials = onMaterialsChanged((change) => {
      if (change === 'textures') texturesArrived()
      else if (!runtime.tracing && props.current.active) {
        // Settle the temporal passes on the new light again, as after any change, but keep the
        // rest window: a probe is no move.
        runtime.drawn = 0
        invalidate()
      }
    })
    // Compile the pipeline's shaders asynchronously before its first frame, so opening the view
    // does not stall on synchronous compilation.
    void warmed(runtime.pipe).finally(() => {
      runtime.warming = false
      if (!disposed && props.current.active) invalidate()
    })
    const textures = textureProgress.subscribe(texturesArrived)
    const interrupt = () => {
      runtime.tracer?.halt()
      runtime.tracing = false
      runtime.dirty = true
      if (props.current.active) invalidate()
    }
    const down = () => {
      runtime.interacting = true
      interrupt()
    }
    const up = () => {
      if (!runtime.interacting) return
      runtime.interacting = false
      interrupt()
    }
    renderer.domElement.addEventListener('pointerdown', down)
    renderer.domElement.addEventListener('wheel', interrupt, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    const visibility = () => {
      if (document.hidden) {
        runtime.tracer?.halt()
        runtime.tracing = false
      }
      runtime.dirty = true
      if (!document.hidden && props.current.active) invalidate()
    }
    document.addEventListener('visibilitychange', visibility)
    let kept = false
    if (!runtime.failed)
      void loadTracerModule()
        .then(async (modules) => {
          if (disposed) return
          // The tracer packs the scans from their decoded pixels, which are otherwise freed after
          // upload: a released map would trace black.
          kept = true
          await keepDecodedTextures(true)
          if (disposed) return
          const profile = liveProfile(quality)
          runtime.tracer = new PathTraceSession(renderer, modules, true, {
            multiView: true,
            maxBounces: profile.maxBounces,
            clampDirect: profile.clampDirect,
            clampIndirect: profile.clampIndirect,
            fadeMs: profile.fadeMs,
            firstFadeMs: profile.firstFadeMs,
            earlyImages: earlyImages(),
            random: liveSampler(),
            batchMs: profile.batchMs,
            maxPasses: profile.maxPasses,
            restBatch: profile.rest ?? undefined,
            timeline: true,
            // An edit of a finish or a floor keeps the orbit's views, seeding a little from them.
            keepHistoryAcrossSurfaces: true,
          })
          runtime.dirty = true
          runtime.prepareSeed()
          // The first start's longest work, its geometry BVHs, done in a worker meanwhile.
          runtime.warmingBVHs = true
          const started = performance.now()
          void Promise.race([
            warmBVHs(scene).then((geometries) =>
              timeline(() =>
                performance.measure('fury:live-bvh-worker', {
                  start: started,
                  end: performance.now(),
                  detail: { geometries },
                }),
              ),
            ),
            new Promise((resolve) => setTimeout(resolve, BVH_WAIT_MS)),
          ]).finally(() => {
            runtime.warmingBVHs = false
            if (!disposed && props.current.active) invalidate()
          })
          if (props.current.active) invalidate()
        })
        .catch(() => {
          if (disposed) return
          runtime.failed = true
          invalidate()
        })
    invalidate()
    return () => {
      disposed = true
      clearTimeout(loadingLimit)
      traceProgress.set({ phase: 'idle' })
      state.current = null
      materials()
      textures()
      renderer.domElement.removeEventListener('pointerdown', down)
      renderer.domElement.removeEventListener('wheel', interrupt)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
      document.removeEventListener('visibilitychange', visibility)
      runtime.tracer?.dispose()
      runtime.seed?.dispose()
      if (kept) void keepDecodedTextures(false)
      runtime.present.dispose()
      runtime.pipe.dispose()
      runtime.lean?.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  useFrame(() => {
    if (props.current.active && !document.hidden) beginFrame(renderer)
  }, FRAME_BEGIN)
  useFrame(() => {
    const current = state.current
    if (!current || !props.current.active || document.hidden) return
    const report = (status: ViewerStatus) => {
      if (current.status === status) return
      current.status = status
      props.current.onStatus(status)
    }
    const now = performance.now()
    // A pipeline compiled in the background (the frame guard's lean one) runs TRAA's first update
    // outside a pipeline render, leaving its jitter, and the aspect of a target not sized yet, on
    // this camera. The live camera never carries an offset of its own (TRAA sets and clears one
    // within each render), so the view is put back as each render leaves it, at the drawing
    // buffer's aspect, before it is compared: else a still view would read as moved, and its trace
    // stop.
    const lens = camera as PerspectiveCamera
    if (lens.view?.enabled) {
      renderer.getDrawingBufferSize(drawingBuffer)
      lens.aspect = drawingBuffer.x / drawingBuffer.y
      lens.clearViewOffset()
    }
    camera.updateMatrixWorld()
    scene.updateMatrixWorld()
    const signature = sceneSignature(scene, lookKey(props.current.look))
    if (signature !== current.signature) {
      current.signature = signature
      current.dirty = true
    }
    const moved = !current.view.equals(camera.matrixWorld)
    const resting = !moved && !current.interacting
    // The guard measures frames of a steady move only: one that carries a change (an edit, scans, a
    // press) or stops a trace also pays for that work, not just for drawing.
    const steady = moved && !current.dirty && !current.tracing
    if (current.dirty) current.guard?.change()
    if (current.lean && resting) {
      // The lean pipeline takes over; its temporal passes settle again before a trace may start.
      current.pipe.dispose()
      current.pipe = current.lean
      current.lean = null
      current.drawn = 0
    }
    if (current.shedDue && resting) current.shed()
    const { pipe, tracer } = current
    if (current.dirty) current.shutter.cut()
    if (pipe.shutter) pipe.shutter.value = current.shutter.frame(now, moved && !current.dirty)
    if (current.dirty || moved || !current.projection.equals(camera.projectionMatrix)) {
      tracer?.halt()
      current.tracing = false
      current.dirty = false
      current.view.copy(camera.matrixWorld)
      current.projection.copy(camera.projectionMatrix)
      current.restAt = now + REST_MS
      current.drawn = 0
    }
    pipe.setPlace(props.current.place)
    if (current.warming) return
    if (!current.tracing) {
      traceProgress.set({ phase: 'idle' })
      pipe.render()
      if (current.guard?.frame(now, steady)) {
        current.guard = null
        current.shedDue = true
      }
      sceneProgress.drawn()
      if (!current.ready) {
        current.ready = true
        props.current.onReady()
      }
      report(current.failed ? 'raster-only' : 'interactive')
      current.drawn++
      const textures = textureProgress.get()
      // The loading screen: materials while scans arrive, then the tracer's first start, which
      // builds its scene in one long task. The screen says so at least the rest window (REST_MS)
      // ahead, so it is on screen before the main thread is busy with it: a scan's arrival
      // restarts that window.
      if (!current.begun) {
        if (current.failed) liveLoading.set('ready')
        else if (textures.loaded >= textures.requested) liveLoading.set('tracer')
      }
      // The first start at the entry's pose begins from its Cycles image: wait a little for it to
      // decode, never longer than SEED_WAIT_MS.
      const entry = props.current.entry
      const seed = current.seed
      const atEntry =
        !!entry &&
        !!seed &&
        seed.image === entry.image &&
        !seed.used &&
        seed.state !== 'failed' &&
        pixelsFromPose(
          camera as PerspectiveCamera,
          entry.pose,
          // The stage's height in CSS pixels, as EntryWatch measures it.
          renderer.domElement.clientHeight || renderer.getDrawingBufferSize(drawingBuffer).y,
        ) <= ENTRY_TOLERANCE_PX
      const awaitingSeed = atEntry && seed!.state === 'loading' && now < seed!.until
      if (
        tracer &&
        !current.failed &&
        !current.interacting &&
        now >= current.restAt &&
        current.drawn >= START_FRAMES &&
        textures.loaded >= textures.requested &&
        !awaitingSeed &&
        !(current.warmingBVHs && !current.begun)
      ) {
        try {
          current.present.capture(() => pipe.render())
          // A resize marks the view changed, so each start reads the canvas's size again.
          renderer.getDrawingBufferSize(drawingBuffer)
          const scale = traceScale(quality, drawingBuffer.x, drawingBuffer.y)
          if (atEntry && seed!.state === 'ready') {
            seed!.used = true
            try {
              const stored = seed!.store(tracer, scene, entry!.pose, props.current.look, {
                count: liveProfile(quality).cyclesSeedSamples,
                ceiling: SEED_CEILING,
                scale,
              })
              if (stored) timeline(() => performance.mark('fury:trace-cycles-seed'))
            } catch {
              // The view starts unseeded, as without an image.
            }
            seed!.dispose()
          }
          // Its first start builds the tracer's BVH, the view's longest main-thread stall.
          const began = performance.now()
          tracer.begin(scene, camera, props.current.look, liveProfile(quality).samples, scale)
          timeline(() =>
            performance.measure('fury:trace-begin', { start: began, end: performance.now() }),
          )
          current.tracing = true
          current.begun = true
          liveLoading.set('ready')
        } catch {
          tracer.halt()
          current.failed = true
          report('raster-only')
        }
      }
      // Keep drawing until the temporal passes have settled and, where tracing can follow, until the
      // start has been decided: the demand loop draws only frames that are asked for, so stopping
      // early (a pipeline that settles in one frame, on Lite) would never reach the start.
      if (
        !current.tracing &&
        (current.drawn < Math.max(START_FRAMES, pipe.settleFrames) ||
          (!current.failed && now < current.restAt) ||
          awaitingSeed)
      )
        invalidate()
    }
    if (current.tracing && tracer) {
      try {
        const developing = tracer.step()
        const view = tracer.view(now)
        if (view.t > 0) current.present.render(view)
        const { shown, target } = tracer.progress()
        traceProgress.set(refineProgress(shown, target, !developing))
        report(developing ? 'refining' : 'settled')
        if (developing) invalidate()
      } catch {
        tracer.halt()
        current.failed = true
        current.tracing = false
        current.dirty = true
        report('raster-only')
        invalidate()
      }
    }
  }, 1)
  return null
}

type EntrySeed = ReturnType<typeof entrySeed>

/**
 * The entry's Cycles image, fetched (from the browser's cache: it is on the stage) and decoded off
 * the main thread, with the inverse of its view transform (agxInverse.ts). Its code values are read
 * as they are: no colour conversion, no flip (rows top down, as the seed kernel reads them).
 */
function entrySeed(image: string, until: number) {
  let texture: Texture | null = null
  let table: Texture | null = null
  let bitmap: ImageBitmap | null = null
  let disposed = false
  const seed = {
    image,
    until,
    state: 'loading' as 'loading' | 'ready' | 'failed',
    used: false,
    loaded: Promise.resolve(),
    /** Keeps the image as a traced view of `scene` from `pose`; false if it is not ready. */
    store(
      tracer: PathTraceSession,
      scene: Parameters<PathTraceSession['storeImage']>[0],
      pose: GalleryCamera,
      look: SkyLook,
      options: { count: number; ceiling: number; scale: number },
    ) {
      if (!texture || !table || !bitmap) return false
      const lens = new PerspectiveCamera(pose.fov, bitmap.width / bitmap.height, 0.1, 2000)
      lens.position.set(...pose.position)
      lens.lookAt(...pose.target)
      lens.updateMatrixWorld()
      return tracer.storeImage(
        scene,
        lens,
        look,
        { image: texture, table, count: options.count, ceiling: options.ceiling },
        options.scale,
      )
    },
    dispose() {
      disposed = true
      texture?.dispose()
      bitmap?.close()
      texture = null
      bitmap = null
    },
  }
  seed.loaded = Promise.all([
    loadAgxInverse(),
    fetch(image)
      .then((response) => {
        if (!response.ok) throw new Error(`entry image: ${response.status}`)
        return response.blob()
      })
      .then((blob) =>
        createImageBitmap(blob, {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
          imageOrientation: 'none',
        }),
      ),
  ])
    .then(([lut, decoded]) => {
      if (disposed) return decoded.close()
      bitmap = decoded
      table = lut
      texture = new Texture(decoded)
      texture.flipY = false
      texture.colorSpace = NoColorSpace
      texture.generateMipmaps = false
      texture.minFilter = texture.magFilter = NearestFilter
      texture.needsUpdate = true
      seed.state = 'ready'
    })
    .catch(() => {
      seed.state = 'failed'
    })
  return seed
}
