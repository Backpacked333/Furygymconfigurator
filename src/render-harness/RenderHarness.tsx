import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera } from 'three'
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu'
import { pass } from 'three/tsl'
import { CAMERA_PRESETS, stillPose } from '../lib/cameras'
import { productHeight, type Config } from '../lib/config'
import { effectiveLights } from '../lib/lighting'
import { Atmosphere } from '../components/Atmosphere'
import { InteriorProbe } from '../components/InteriorProbe'
import { Landscape } from '../components/Landscape'
import { StudioModel } from '../components/StudioModel'
import { FLOOR_Y, interiorBounds } from '../render/architecture'
import {
  onMaterialsChanged,
  restoreTextures,
  setMaxAnisotropy,
  loadFullResolutionTextures,
} from '../render/materials'
import { STILL_TIER, TIERS, sceneWork, textureProgress, type TierSpec } from '@fury/viewer360'
import {
  FRAME_BEGIN,
  TierProvider,
  backendOf,
  beginFrame,
  createPipeline,
  createRenderer,
  invalidateShadows,
  refreshShadows,
  type Pipeline,
} from '@fury/viewer360/3d'
import { MATTE_GREY, type HarnessApi, type RenderCapture, type RenderJob } from './job'

// Published stills use every scan at full resolution.
loadFullResolutionTextures()

/** Stills drawn at Ultra get every knob at its best: time is free offline. */
const stillSpec = (job: RenderJob): TierSpec =>
  job.quality === 'ultra' ? STILL_TIER : TIERS[job.quality]

/** Consecutive ready frames before accumulation starts (environment and probe captures land). */
const READY_FRAMES = 3

type Pending = { job: RenderJob; resolve: (c: RenderCapture) => void; started: number }

/**
 * A box filling the room, unlit and untouched by fog, light, and shadow. Black, it stands in for
 * the interior in the shell layer; black then grey, it measures how much of the room shows
 * through each pixel.
 */
function Backstop({ config, mesh }: { config: Config; mesh: React.RefObject<Mesh | null> }) {
  const b = interiorBounds(config)
  const top = Math.min(b.ceiling, productHeight(config))
  const geometry = useMemo(
    () => new BoxGeometry(b.halfWidth * 2 + 0.2, top - FLOOR_Y + 0.1, b.front - b.back),
    [b.halfWidth, b.front, b.back, top],
  )
  const material = useMemo(
    () => new MeshBasicMaterial({ color: 0x000000, fog: false, toneMapped: false }),
    [],
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      position={[0, (FLOOR_Y + top) / 2, (b.front + b.back) / 2]}
      visible={false}
      userData={{ noProbe: true }}
    />
  )
}

function StillCamera({ job }: { job: RenderJob }) {
  const { camera, invalidate } = useThree()
  useEffect(() => {
    const p = camera as PerspectiveCamera
    const pose = stillPose(job.config, job.angle, job.width / job.height)
    p.fov = pose.fov
    p.aspect = job.width / job.height
    p.near = 0.1
    p.far = 2000
    p.position.set(...pose.position)
    p.lookAt(...pose.target)
    p.updateProjectionMatrix()
    p.updateMatrixWorld()
    invalidate()
  }, [camera, job, invalidate])
  return null
}

/**
 * Draws one job: waits until every texture, the ground, and the interior probe are in, starts a
 * fresh pipeline so temporal history begins at zero, accumulates a fixed number of frames, then
 * captures the color and, for layered stills, the two mattes.
 */
function StillDriver({
  pending,
  backstop,
  onDone,
}: {
  pending: Pending
  backstop: React.RefObject<Mesh | null>
  onDone: (capture: RenderCapture) => void
}) {
  const { gl, scene, camera, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const pipeline = useRef<Pipeline | null>(null)
  const phase = useRef<{ name: 'wait' | 'accumulate' | 'done'; frames: number }>({
    name: 'wait',
    frames: 0,
  })
  const { job } = pending

  useEffect(() => {
    phase.current = { name: 'wait', frames: 0 }
    invalidateShadows(scene)
    invalidate()
  }, [pending, scene, invalidate])
  useEffect(
    () =>
      onMaterialsChanged(() => {
        invalidateShadows(scene)
        if (phase.current.name === 'accumulate') phase.current = { name: 'wait', frames: 0 }
        invalidate()
      }),
    [scene, invalidate],
  )
  useEffect(() => {
    pipeline.current = createPipeline(renderer, scene, camera, stillSpec(job))
    return () => {
      pipeline.current?.dispose()
      pipeline.current = null
    }
  }, [renderer, scene, camera, job])

  useEffect(() => {
    window.__fury!.debug = () => ({
      phase: phase.current,
      textures: textureProgress.get(),
      work: sceneWork.pending(),
    })
  }, [])

  useFrame(() => beginFrame(renderer), FRAME_BEGIN)
  useFrame(() => {
    const p = phase.current
    if (p.name === 'done' || !pipeline.current) return
    const stop = backstop.current
    if (stop) {
      stop.visible = job.kind === 'shell'
      ;(stop.material as MeshBasicMaterial).color.setScalar(0)
    }
    if (p.name === 'wait') {
      const { requested, loaded } = textureProgress.get()
      const ready = loaded >= requested && sceneWork.idle()
      p.frames = ready ? p.frames + 1 : 0
      refreshShadows(scene)
      pipeline.current.render()
      if (p.frames >= READY_FRAMES) {
        // A fresh pipeline: temporal AA and GI history start from this job's first frame.
        pipeline.current.dispose()
        pipeline.current = createPipeline(renderer, scene, camera, stillSpec(job))
        invalidateShadows(scene)
        phase.current = { name: 'accumulate', frames: 0 }
        window.__fury!.state = 'accumulating'
      }
      // Waiting on downloads: check again shortly instead of spinning the GPU.
      if (ready) invalidate()
      else setTimeout(invalidate, 50)
      return
    }
    refreshShadows(scene)
    pipeline.current.render()
    p.frames++
    if (p.frames < job.frames) {
      invalidate()
      return
    }
    // Read the canvas in the same task as the frame that drew it.
    const capture: RenderCapture = {
      color: renderer.domElement.toDataURL('image/png'),
      backend: backendOf(renderer),
      ms: Math.round(performance.now() - pending.started),
    }
    if (job.kind !== 'full' && stop) {
      const matte = new RenderPipeline(renderer)
      matte.outputColorTransform = false
      const scenePass = pass(scene, camera, { samples: 4 })
      matte.outputNode = scenePass
      const fill = stop.material as MeshBasicMaterial
      stop.visible = true
      try {
        fill.color.setScalar(0)
        beginFrame(renderer)
        matte.render()
        capture.matteBlack = renderer.domElement.toDataURL('image/png')
        fill.color.setScalar(MATTE_GREY)
        beginFrame(renderer)
        matte.render()
        capture.matteGrey = renderer.domElement.toDataURL('image/png')
      } finally {
        fill.color.setScalar(0)
        stop.visible = job.kind === 'shell'
        matte.dispose()
        scenePass.dispose()
      }
    }
    phase.current = { name: 'done', frames: 0 }
    onDone(capture)
  }, 1)
  return null
}

function HarnessScene({
  pending,
  onDone,
}: {
  pending: Pending
  onDone: (capture: RenderCapture) => void
}) {
  const { job } = pending
  const config = useMemo(
    () => ({ ...job.config, lights: effectiveLights(job.config) }),
    [job.config],
  )
  const backstop = useRef<Mesh | null>(null)
  const interiorView = CAMERA_PRESETS[job.angle].view === 'interior'
  return (
    <TierProvider quality={job.quality} spec={stillSpec(job)}>
      <Atmosphere
        config={config}
        quality={job.quality}
        view={interiorView ? 'interior' : 'exterior'}
      />
      <Landscape config={config} quality={job.quality} />
      <StudioModel config={config} quality={job.quality} glazing={job.kind !== 'interior'} />
      <Backstop config={config} mesh={backstop} />
      <InteriorProbe config={config} debounce={0} />
      <StillCamera job={job} />
      <StillDriver pending={pending} backstop={backstop} onDone={onDone} />
    </TierProvider>
  )
}

/**
 * The page the render worker drives: a bare canvas of exactly the requested size and a
 * `window.__fury` API that renders one still layer per call. The page stays open between calls,
 * so shaders compile once per worker.
 */
export default function RenderHarness() {
  const [pending, setPending] = useState<Pending | null>(null)
  const queue = useRef<Pending[]>([])
  const api = useMemo<HarnessApi>(() => ({ state: 'booting', run: () => Promise.reject() }), [])

  useEffect(() => {
    api.run = (job) =>
      new Promise<RenderCapture>((resolve) => {
        const entry = { job, resolve, started: performance.now() }
        queue.current.push(entry)
        api.state = 'loading'
        setPending((current) => current ?? queue.current.shift()!)
      })
    window.__fury = api
    const fail = (e: ErrorEvent | PromiseRejectionEvent) => {
      api.state = 'error'
      api.error = String('reason' in e ? e.reason : e.message)
    }
    window.addEventListener('error', fail)
    window.addEventListener('unhandledrejection', fail)
    return () => {
      window.removeEventListener('error', fail)
      window.removeEventListener('unhandledrejection', fail)
    }
  }, [api])

  const done = (capture: RenderCapture) => {
    pending?.resolve(capture)
    const next = queue.current.shift() ?? null
    api.state = next ? 'loading' : 'idle'
    setPending(next)
  }

  const job = pending?.job
  return (
    <div
      style={{
        width: job?.width ?? 1280,
        height: job?.height ?? 720,
        position: 'fixed',
        inset: 0,
        background: '#000',
      }}
    >
      <Canvas
        shadows="percentage"
        dpr={job?.scale ?? 1}
        frameloop="demand"
        camera={{ position: [30, 18, 35], fov: 32, near: 0.1, far: 2000 }}
        gl={async ({ canvas }) => {
          const [renderer] = await Promise.all([
            createRenderer(canvas as HTMLCanvasElement),
            restoreTextures(),
          ])
          setMaxAnisotropy(renderer.getMaxAnisotropy())
          api.backend = backendOf(renderer)
          if (api.state === 'booting') api.state = 'idle'
          renderer.onDeviceLost = (info) => {
            api.state = 'error'
            api.error = `Graphics device lost: ${info.message}`
          }
          return renderer
        }}
      >
        {pending && <HarnessScene pending={pending} onDone={done} />}
      </Canvas>
    </div>
  )
}
