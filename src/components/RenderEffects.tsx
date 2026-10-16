import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Matrix4, type WebGPURenderer } from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Config, View } from '../lib/config'
import type { SkyLook } from '../lib/visuals'
import {
  createPipeline,
  createTracePresent,
  type Pipeline,
  type TracePresent,
} from '../render/pipeline'
import { CloudSession, cloudUrl } from '../render/cloud'
import { onMaterialsChanged } from '../render/materials'
import {
  EXPORT_SAMPLES,
  EXPORT_TIMEOUT_MS,
  PathTraceSession,
  REST_SAMPLES,
  loadTracerModule,
} from '../render/pathtrace'
import type { Quality } from '../render/quality'
import { backendOf } from '../render/renderer'
import { TraceSession } from '../render/session'
import { setPrerenderProgress, setTraceStatus } from '../render/traceStatus'

/** Median frame time (ms) of a settle run above which a tier is too heavy for this device. */
const SLOW_FRAME_MS: Record<Quality, number> = { ultra: 50, high: 75, lite: Infinity }
/**
 * Tracing starts once the view has held still for this many raster frames and REST_MS more. The
 * traced image replaces the raster one, so it need not wait for the raster settle run to finish.
 */
const TRACE_AFTER_FRAMES = 6
const REST_MS = 150
/** `?denoise=0` shows the raw accumulation, for comparing against the denoised image. */
const denoise = new URLSearchParams(window.location.search).get('denoise') !== '0'

export type Capture = () => Promise<string>
type PendingCapture = { deadline: number; resolve: (image: string) => void }

/**
 * Drives the frame. While the camera moves, the TSL raster pipeline renders on demand and keeps
 * drawing for a short settle window so temporal anti-aliasing, AO, and GI accumulate. Once the
 * view rests, path tracing takes over and crossfades in: on a cloud GPU when a render server is
 * configured, and progressively on this device where WebGPU is available (see TraceSession);
 * any camera or scene change hands back to the rasterizer.
 */
export function RenderEffects({
  quality,
  trace,
  look,
  config,
  view,
  dimensions,
  onCaptureReady,
  onSlow,
}: {
  quality: Quality
  /** Path-trace resting views (on a cloud GPU, or locally with WebGPU). */
  trace: boolean
  look: SkyLook
  config: Config
  view: View
  dimensions: boolean
  onCaptureReady: (capture: Capture) => void
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
  const lastView = useRef(new Matrix4())
  const lastProjection = useRef(new Matrix4())
  const changed = useRef(true)
  /** Whether the raster frame on screen (and in `hdr`) shows the current view. */
  const fresh = useRef(false)
  const rested = useRef(false)
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<PendingCapture | null>(null)
  const reported = useRef(0)
  const lookRef = useRef(look)
  const timing = useRef({ last: 0, samples: [] as number[], frames: 0, reported: false })
  useEffect(() => {
    lookRef.current = look
  }, [look])

  useEffect(() => {
    const created = createPipeline(renderer, scene, camera, quality)
    pipeline.current = created
    setRaster(created)
    settle.current = 0
    fresh.current = false
    mode.current = 'raster'
    timing.current = { last: 0, samples: [], frames: 0, reported: false }
    invalidate()
    return () => {
      pipeline.current = null
      created.dispose()
    }
  }, [renderer, scene, camera, quality, invalidate])

  // The local tracer loads on demand, and only where WebGPU compute is available. With a cloud
  // renderer, light devices leave all tracing to it.
  const remote = useMemo(() => cloudUrl(), [])
  const cloudAvailable = trace && remote !== null
  const localAvailable = webgpu && trace && (quality !== 'lite' || !cloudAvailable)
  useEffect(() => {
    if (!localAvailable && !cloudAvailable) return
    let active = true
    let created: TraceSession | null = null
    const local = localAvailable
      ? loadTracerModule()
          .then((module) => new PathTraceSession(renderer, module, denoise))
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

  // Any edit to the design hands the frame back to the rasterizer and re-captures before tracing.
  useEffect(() => {
    changed.current = true
    invalidate()
  }, [config, view, dimensions, invalidate])

  useEffect(
    () =>
      onMaterialsChanged((change) => {
        settle.current = 0
        if (change === 'textures') {
          changed.current = true
          session?.invalidate()
        }
        invalidate()
      }),
    [invalidate, session],
  )

  useEffect(() => {
    onCaptureReady(() => {
      if (!session || !present.current) {
        pipeline.current?.render()
        return Promise.resolve(renderer.domElement.toDataURL('image/png'))
      }
      return new Promise<string>((resolve) => {
        pending.current = { deadline: performance.now() + EXPORT_TIMEOUT_MS, resolve }
        if (mode.current !== 'trace') rested.current = true
        invalidate()
      })
    })
  }, [renderer, session, onCaptureReady, invalidate])

  useEffect(
    () => () => {
      if (restTimer.current) clearTimeout(restTimer.current)
    },
    [],
  )

  useFrame(() => {
    const active = pipeline.current
    if (!active) return
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
    const moved =
      !lastView.current.equals(camera.matrixWorld) ||
      !lastProjection.current.equals(camera.projectionMatrix)
    if (moved || changed.current) {
      lastView.current.copy(camera.matrixWorld)
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
      const refining = tracer.step()
      const traced = tracer.view(now)
      // Until the first traced image is ready the canvas keeps the last raster frame.
      if (traced.from || traced.t > 0) present.current!.render(traced)
      const capture = pending.current
      if (capture && (tracer.ready(EXPORT_SAMPLES) || now > capture.deadline)) {
        pending.current = null
        capture.resolve(renderer.domElement.toDataURL('image/png'))
      }
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
      tracer.begin(scene, camera, lookRef.current, active.hdr, REST_SAMPLES, orbit)
      report(true)
      invalidate()
      return
    }

    // Raster rendering with a settle run after every change.
    const chained = settle.current > 0
    if (settle.current <= 0) settle.current = active.settleFrames
    active.render()
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
      const capture = pending.current
      pending.current = null
      capture.resolve(renderer.domElement.toDataURL('image/png'))
    }
    // Back-to-back settle frames measure what this GPU can sustain at this tier. The first frames
    // after a pipeline is built include shader compilation and are ignored.
    const t = timing.current
    t.frames++
    if (chained && t.last && t.frames > 8 && !t.reported) {
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
