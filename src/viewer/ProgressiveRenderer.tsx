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
import { onMaterialsChanged } from '../render/materials'
import { warmBVHs } from '../render/bvhWarmup'
import { MotionShutter } from '../render/motionBlur'
import {
  PathTraceSession,
  loadTracerModule,
  lookKey,
  prepareEnvironment,
  sceneSignature,
  trimEnvironments,
} from '../render/pathtrace'
import { createPipeline, type Pipeline, type PipelineExtras } from '../render/pipeline'
import { dropPrefetched } from '../render/scanFiles'
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
import {
  LIGHT,
  MIN_BUDGET_SCALE,
  UPGRADE_REST_MS,
  cyclesSeed,
  deviceTier,
  earlyImages,
  liveProfile,
  liveSampler,
  requestedTraceScale,
  settleSamples,
  traceScale,
  upgradeTarget,
  type DeviceTier,
} from './liveProfile'
import { recordTraceCost, traceCost } from './traceRate'
import { createProgressivePresentation } from './presentation'
import { bootStats } from './bootStats'

export type ViewerStatus = 'loading' | 'interactive' | 'refining' | 'settled' | 'raster-only'
/**
 * How long the view must stay still before tracing may start. Not shorter: each start draws the
 * denoiser's guides, seeds from the views kept and queues a batch, and each stop stores the view,
 * so a start in every brief pause of a drag leaves the next move waiting on that work.
 */
export const REST_MS = 150
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
 * Longest the first start waits for its geometry BVHs and sky map to be built off the main thread
 * (bvhWarmup.ts, pathtrace.ts prepareEnvironment); whatever is not built by then the tracer builds
 * itself, as before.
 */
const WARM_TRACER_MS = 10000
/**
 * How long a closed view keeps everything, so a quick return to it is instant; then it frees what
 * it can make again behind the loading screen (PathTraceSession trim): about 300–500 MB.
 */
export const TRIM_AFTER_MS = 30000
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

/**
 * `?memStats=1` logs, at the first frame, a few seconds into the first trace and once a closed
 * view has been trimmed, the JavaScript heap (Chrome's performance.memory) and the GPU memory three
 * accounts for, to compare memory on a device.
 */
const MEM_STATS =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('memStats')

function logMemory(renderer: WebGPURenderer, moment: string) {
  if (!MEM_STATS) return
  const mb = (bytes: number | undefined) =>
    bytes === undefined ? '?' : (bytes / 2 ** 20).toFixed(0)
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  const gpu = (
    renderer as unknown as {
      info: { memory: Record<string, number> }
    }
  ).info.memory
  console.info(
    `[memory] ${moment}: JS heap ${mb(heap?.usedJSHeapSize)} MB; GPU ${mb(gpu.total)} MB ` +
      `(textures ${mb(gpu.texturesSize)}, storage ${mb(gpu.storageAttributesSize)}, ` +
      `attributes ${mb(gpu.attributesSize)}, render targets ${gpu.renderTargets})`,
  )
}

/** Compiles a pipeline's shaders asynchronously; one that never finishes holds nothing up. */
const warmed = (pipe: Pipeline) =>
  Promise.race([pipe.warm(), new Promise((resolve) => setTimeout(resolve, WARM_TIMEOUT_MS))])

/**
 * Records an entry in the browser's performance timeline (User Timing), where the Performance panel
 * and `performance.getEntriesByName` show it. Never throws: where User Timing is missing or refuses
 * the entry, the view goes on unrecorded.
 */
/** The GPU, as its adapter names it, for keying what a sample costs on it (traceRate.ts). */
function gpuName(renderer: WebGPURenderer) {
  const info = (
    renderer.backend as unknown as
      | {
          device?: {
            adapterInfo?: { vendor?: string; architecture?: string; description?: string }
          }
        }
      | undefined
  )?.device?.adapterInfo
  return [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' / ') || '?'
}

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
    /** Why the view was marked changed, for ?bootStats=1. */
    dirtyReason: string
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
    /**
     * This device's trace cost is stored under (traceRate.ts): its GPU and the quality tier, with
     * the depth traced appended.
     */
    costKey: string
    /** How the current view traces: its device's tier and the depth it traces to. */
    tier: DeviceTier
    bounces: number
    /** Starts so far: a pending upgrade belongs to the one it was planned for. */
    starts: number
    /** The current view's measured samples per second, and whether it has been upgraded. */
    rate: number | null
    upgraded: boolean
    upgradeTimer: ReturnType<typeof setTimeout> | null
    /** Megapixels the current view traces. */
    traceMegapixels: number
    /** The current view's rate has been measured and its settle target set. */
    fitted: boolean
    /** The view has started over once at the resolution its measured cost fits (first visit). */
    refitted: boolean
    /** The samples behind the last image ?bootStats=1 was told of. */
    reportedShown: number
    /** The scene's BVHs and sky map are being built in workers for the first start. */
    warmingTracer: boolean
    /** Frees the closed view's memory TRIM_AFTER_MS after it closed. */
    trimTimer: ReturnType<typeof setTimeout> | null
  } | null>(null)
  const props = useRef({ active, look, place, onReady, onStatus, entry })
  useLayoutEffect(() => {
    props.current = { active, look, place, onReady, onStatus, entry }
    state.current?.prepareSeed()
    const current = state.current
    if (current) {
      current.dirty = true
      current.dirtyReason = 'view props changed'
      if (current.trimTimer) clearTimeout(current.trimTimer)
      current.trimTimer = null
      if (!active) {
        current.tracer?.halt()
        current.tracing = false
        traceProgress.set({ phase: 'idle' })
        // Closed: kept for a quick return, then freed.
        current.trimTimer = setTimeout(() => {
          current.trimTimer = null
          current.tracer?.trim()
          current.seed?.dispose()
          trimEnvironments(props.current.look)
          dropPrefetched()
          setTimeout(() => logMemory(renderer, 'closed and trimmed'), 1000)
        }, TRIM_AFTER_MS)
      }
    }
    invalidate()
  }, [
    renderer,
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
    // A device known to be slow (traceRate.ts) traces light and draws the lean raster from the
    // start: the frame guard would shed to it anyway, rebuilding it mid-session (a ~1 s freeze).
    const costKey = `${gpuName(renderer)}|${quality}`
    const knownTier: DeviceTier =
      quality === 'lite'
        ? 'unknown'
        : deviceTier(traceCost(`${costKey}|${liveProfile(quality).maxBounces}`))
    const runtime = {
      pipe: createPipeline(
        renderer,
        scene,
        camera,
        quality,
        ...(knownTier === 'slow' ? [LEAN_RASTER] : []),
      ),
      present: createProgressivePresentation(renderer),
      tracer: null as PathTraceSession | null,
      failed: backendOf(renderer) !== 'webgpu',
      dirty: true,
      ready: false,
      tracing: false,
      dirtyReason: 'view opened',
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
      guard: quality === 'ultra' && knownTier !== 'slow' ? new FrameGuard() : null,
      shedDue: false,
      shed: () => {},
      lean: null as Pipeline | null,
      seed: null as EntrySeed | null,
      prepareSeed: () => {},
      begun: false,
      costKey,
      tier: knownTier,
      bounces: liveProfile(quality).maxBounces,
      starts: 0,
      rate: null as number | null,
      upgraded: false,
      upgradeTimer: null as ReturnType<typeof setTimeout> | null,
      traceMegapixels: 0,
      fitted: false,
      refitted: false,
      reportedShown: 0,
      warmingTracer: false,
      trimTimer: null as ReturnType<typeof setTimeout> | null,
    }
    state.current = runtime
    if (bootStats.running) {
      bootStats.step('renderer mounted')
      bootStats.context('quality', quality)
      bootStats.context('backend', backendOf(renderer))
      bootStats.context('gpu', gpuName(renderer))
      const scans = textureProgress.get()
      bootStats.step(`scans: ${scans.loaded} of ${scans.requested} loaded`)
    }
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
    let scansReported = false
    const texturesArrived = () => {
      runtime.dirty = true
      runtime.dirtyReason = 'scans arrived'
      const scans = textureProgress.get()
      if (!scansReported && scans.loaded >= scans.requested) {
        scansReported = true
        bootStats.step(`all scans loaded (${scans.loaded})`)
      }
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
      bootStats.step('raster shaders compiled')
      runtime.warming = false
      if (!disposed && props.current.active) invalidate()
    })
    const textures = textureProgress.subscribe(texturesArrived)
    const interrupt = () => {
      if (runtime.tracing) bootStats.restart('pointer or wheel')
      runtime.tracer?.halt()
      runtime.tracing = false
      runtime.dirty = true
      runtime.dirtyReason = 'pointer or wheel'
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
        if (runtime.tracing) bootStats.restart('tab hidden')
        runtime.tracer?.halt()
        runtime.tracing = false
      }
      runtime.dirty = true
      runtime.dirtyReason = 'tab shown'
      if (!document.hidden && props.current.active) invalidate()
    }
    document.addEventListener('visibilitychange', visibility)
    if (!runtime.failed)
      void loadTracerModule()
        .then((modules) => {
          if (disposed) return
          bootStats.step('path tracer code loaded')
          // The tracer packs the scans from their GPU copies (the atlas patch in patches/), so
          // their decoded pixels are freed after upload, as without it: none are kept.
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
          // The first start's longest work, its geometry BVHs and its sky map, done in workers
          // meanwhile.
          runtime.warmingTracer = true
          const started = performance.now()
          let prepared = false
          void Promise.race([
            Promise.all([
              warmBVHs(scene).then((geometries) =>
                timeline(() =>
                  performance.measure('fury:live-bvh-worker', {
                    start: started,
                    end: performance.now(),
                    detail: { geometries },
                  }),
                ),
              ),
              prepareEnvironment(props.current.look).then(() => bootStats.step('sky map ready')),
              // The denoiser's network too, behind the loading screen rather than after it.
              runtime.tracer.prepareDenoiser().then(() => bootStats.step('denoiser network ready')),
            ]).then(() => {
              prepared = true
              bootStats.step('tracer prepared (BVHs, sky, denoiser)')
            }),
            new Promise((resolve) => setTimeout(resolve, WARM_TRACER_MS)).then(() => {
              if (!prepared)
                bootStats.step(
                  `gave up waiting on tracer preparation at ${WARM_TRACER_MS / 1000} s`,
                )
            }),
          ]).finally(() => {
            runtime.warmingTracer = false
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
      if (runtime.trimTimer) clearTimeout(runtime.trimTimer)
      if (runtime.upgradeTimer) clearTimeout(runtime.upgradeTimer)
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
      if (status === 'settled') bootStats.settled()
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
      current.dirtyReason = 'scene changed'
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
      if (current.tracing)
        bootStats.restart(
          current.dirty ? current.dirtyReason : moved ? 'camera moved' : 'projection changed',
        )
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
        timeline(() => performance.mark('fury:live-first-frame'))
        logMemory(renderer, 'first frame')
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
        !(current.warmingTracer && !current.begun)
      ) {
        try {
          current.present.capture(() => pipe.render())
          // A resize marks the view changed, so each start reads the canvas's size again.
          renderer.getDrawingBufferSize(drawingBuffer)
          // The device's tier, from its full-depth cost: a slow one traces light (LIGHT).
          const fullDepth = liveProfile(quality).maxBounces
          const fullCost = traceCost(`${current.costKey}|${fullDepth}`)
          const tier: DeviceTier = quality === 'lite' ? 'unknown' : deviceTier(fullCost)
          const light = tier === 'slow'
          const bounces = light ? LIGHT.maxBounces : fullDepth
          // What a sample costs at that depth; at first for a light view, the full depth's (more).
          const cost = traceCost(`${current.costKey}|${bounces}`) ?? fullCost
          const scale = traceScale(
            quality,
            drawingBuffer.x,
            drawingBuffer.y,
            requestedTraceScale(),
            cost,
            light ? LIGHT.floor : MIN_BUDGET_SCALE,
          )
          current.tier = tier
          current.bounces = bounces
          current.starts++
          current.rate = null
          current.upgraded = false
          if (current.upgradeTimer) clearTimeout(current.upgradeTimer)
          current.upgradeTimer = null
          current.traceMegapixels =
            (Math.floor(drawingBuffer.x * scale) * Math.floor(drawingBuffer.y * scale)) / 1e6
          current.fitted = false
          current.reportedShown = 0
          bootStats.context(
            'trace',
            light ? `${tier}: light, ${bounces} bounces` : `${tier}: ${bounces} bounces`,
          )
          bootStats.context(
            'trace size',
            `${Math.round(drawingBuffer.x * scale)}×${Math.round(drawingBuffer.y * scale)} of a ${drawingBuffer.x}×${drawingBuffer.y} canvas`,
          )
          if (atEntry && seed!.state === 'ready') {
            seed!.used = true
            try {
              const stored = seed!.store(tracer, scene, entry!.pose, props.current.look, {
                count: liveProfile(quality).cyclesSeedSamples,
                ceiling: SEED_CEILING,
                scale,
                bounces,
              })
              if (stored) timeline(() => performance.mark('fury:trace-cycles-seed'))
            } catch {
              // The view starts unseeded, as without an image.
            }
            seed!.dispose()
          }
          // Its first start builds the tracer's BVH, the view's longest main-thread stall.
          const began = performance.now()
          tracer.begin(
            scene,
            camera,
            props.current.look,
            liveProfile(quality).samples,
            scale,
            bounces,
          )
          // A known cost settles the view at what SETTLE_MS buys from the start; a measured rate
          // refines it (below).
          if (cost !== null && quality !== 'lite')
            tracer.settleAt(
              settleSamples(
                1000 / (cost * current.traceMegapixels),
                light ? LIGHT.leastSettle : undefined,
              ),
            )
          timeline(() =>
            performance.measure('fury:trace-begin', { start: began, end: performance.now() }),
          )
          current.tracing = true
          current.begun = true
          setTimeout(() => logMemory(renderer, '5 s into the first trace'), 5000)
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
      // The loading screen leaves once the first batch has finished on the GPU, not at the start:
      // that batch builds the tracer's kernels, and the view stalls until it is done.
      if (tracer.started) {
        if (liveLoading.get() !== 'ready') bootStats.step('first batch finished on the GPU')
        liveLoading.set('ready')
      }
      // Once this view's rate is measured: keep its cost (under the depth it traces), settle at
      // what SETTLE_MS buys, and on a first visit start over once fitted to this GPU: at the
      // resolution its cost allows, and light if it is slow.
      const rate = current.fitted ? null : tracer.samplesPerSecond
      if (rate !== null && current.traceMegapixels > 0) {
        current.fitted = true
        current.rate = rate
        const cost = 1000 / rate / current.traceMegapixels
        recordTraceCost(`${current.costKey}|${current.bounces}`, cost)
        const light = current.tier === 'slow'
        if (quality !== 'lite')
          tracer.settleAt(settleSamples(rate, light ? LIGHT.leastSettle : undefined))
        bootStats.step(
          `measured ${rate.toFixed(1)} samples/s at ${current.traceMegapixels.toFixed(2)} MP, ${current.bounces} bounces (${Math.round(cost)} ms per MP-sample); settling at ${tracer.progress().target}`,
        )
        if (current.tier === 'unknown' && !current.refitted && quality !== 'lite') {
          const tier = deviceTier(cost)
          const slow = tier === 'slow'
          renderer.getDrawingBufferSize(drawingBuffer)
          const fitted = traceScale(
            quality,
            drawingBuffer.x,
            drawingBuffer.y,
            requestedTraceScale(),
            cost,
            slow ? LIGHT.floor : MIN_BUDGET_SCALE,
          )
          const fittedMegapixels =
            (Math.floor(drawingBuffer.x * fitted) * Math.floor(drawingBuffer.y * fitted)) / 1e6
          if (slow || fittedMegapixels < 0.8 * current.traceMegapixels) {
            current.refitted = true
            current.dirty = true
            current.dirtyReason = 'fitted to this GPU'
            if (slow && current.guard) {
              // The lean raster too, once, at the next rest.
              current.guard = null
              current.shedDue = true
            }
            bootStats.step(
              `this GPU is ${tier}: starting over${slow ? ' light' : ''} at ${fittedMegapixels.toFixed(2)} MP`,
            )
          }
        }
      }
      try {
        const developing = tracer.step()
        const view = tracer.view(now)
        if (view.t > 0) current.present.render(view)
        const { shown, target } = tracer.progress()
        if (bootStats.running && shown > current.reportedShown) {
          current.reportedShown = shown
          const { passes, latencyFloor } = tracer.pacing
          bootStats.step(
            `image at ${shown} of ${target} samples: ${passes} passes per batch, completion floor ${Number.isFinite(latencyFloor) ? Math.round(latencyFloor) : '?'} ms`,
          )
        }
        traceProgress.set(refineProgress(shown, target, !developing))
        report(developing ? 'refining' : 'settled')
        // Settled on a decent or fast GPU: after a short rest more, refine on (liveProfile.ts
        // upgradeTarget), once per view.
        if (!developing && !current.upgraded && !current.upgradeTimer) {
          const tier = deviceTier(
            traceCost(`${current.costKey}|${liveProfile(quality).maxBounces}`),
          )
          const more = quality === 'lite' ? null : upgradeTarget(tier, current.rate, target)
          if (more !== null) {
            const start = current.starts
            current.upgradeTimer = setTimeout(() => {
              current.upgradeTimer = null
              if (state.current !== current || current.starts !== start || !current.tracing) return
              if (!props.current.active || current.upgraded) return
              current.upgraded = true
              tracer.retarget(more)
              bootStats.step(`upgrading: refining on to ${more} samples`)
              invalidate()
            }, UPGRADE_REST_MS)
          }
        }
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
      options: { count: number; ceiling: number; scale: number; bounces: number },
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
        options.bounces,
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
