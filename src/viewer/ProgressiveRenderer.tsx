import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Matrix4, Vector2, type WebGPURenderer } from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import { keepDecodedTextures, onMaterialsChanged } from '../render/materials'
import { MotionShutter } from '../render/motionBlur'
import { PathTraceSession, loadTracerModule, lookKey, sceneSignature } from '../render/pathtrace'
import { createPipeline, type Pipeline, type PipelineExtras } from '../render/pipeline'
import { sceneProgress, textureProgress } from '../render/progress'
import { backendOf, beginFrame, FRAME_BEGIN, type Quality } from '../render/renderer'
import { FrameGuard } from './frameGuard'
import { liveProfile, traceScale } from './liveProfile'
import { createProgressivePresentation } from './presentation'

export type ViewerStatus = 'loading' | 'interactive' | 'refining' | 'settled' | 'raster-only'
const REST_MS = 150
/** Raster frames drawn after a change before tracing may start: the capture is a settled frame. */
const START_FRAMES = 6
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
}: {
  active: boolean
  revision: string
  look: SkyLook
  quality: Quality
  place: 'exterior' | 'interior'
  onReady: () => void
  onStatus: (status: ViewerStatus) => void
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
  } | null>(null)
  const props = useRef({ active, look, place, onReady, onStatus })
  useLayoutEffect(() => {
    props.current = { active, look, place, onReady, onStatus }
    if (state.current) {
      state.current.dirty = true
      if (!active) {
        state.current.tracer?.halt()
        state.current.tracing = false
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
    }
    state.current = runtime
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
      else if (!runtime.tracing && props.current.active) invalidate()
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
          const { maxBounces, clampDirect, clampIndirect, fadeMs } = liveProfile(quality)
          runtime.tracer = new PathTraceSession(renderer, modules, true, {
            multiView: true,
            maxBounces,
            clampDirect,
            clampIndirect,
            fadeMs,
            batchMs: 12,
            maxPasses: 8,
            // An edit of a finish or a floor keeps the orbit's views, seeding a little from them.
            keepHistoryAcrossSurfaces: true,
          })
          runtime.dirty = true
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
      if (
        tracer &&
        !current.failed &&
        !current.interacting &&
        now >= current.restAt &&
        current.drawn >= START_FRAMES &&
        textures.loaded >= textures.requested
      ) {
        try {
          current.present.capture(() => pipe.render())
          // A resize marks the view changed, so each start reads the canvas's size again.
          renderer.getDrawingBufferSize(drawingBuffer)
          const scale = traceScale(quality, drawingBuffer.x, drawingBuffer.y)
          // Its first start builds the tracer's BVH, the view's longest main-thread stall.
          const began = performance.now()
          tracer.begin(scene, camera, props.current.look, liveProfile(quality).samples, scale)
          timeline(() =>
            performance.measure('fury:trace-begin', { start: began, end: performance.now() }),
          )
          current.tracing = true
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
          (!current.failed && now < current.restAt))
      )
        invalidate()
    }
    if (current.tracing && tracer) {
      try {
        const developing = tracer.step()
        const view = tracer.view(now)
        if (view.t > 0) current.present.render(view)
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
