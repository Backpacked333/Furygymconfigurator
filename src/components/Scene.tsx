import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { distance, productHeight, type Config, type Unit, type View } from '../lib/config'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'
import { RenderEffects } from './RenderEffects'
import { SceneRefresh } from './SceneRefresh'
import { Atmosphere } from './Atmosphere'
import { InteriorProbe } from './InteriorProbe'
import {
  backendOf,
  createRenderer,
  deviceProfile,
  type Backend,
  type Quality,
} from '../render/renderer'
import { setMaxAnisotropy } from '../render/materials'
import { canRestoreCamera, transitionFraction, type CameraMemoryRef } from '../lib/camera'
import {
  createPresentationStore,
  type AssetReadiness,
  type PresentationState,
  type PresentationStore,
} from '../lib/presentation'
import type { CaptureRegistration } from '../lib/capture'
import type { DeviceProfile, QualityMode } from '../render/quality'

class GraphicsBoundary extends Component<
  {
    children: ReactNode
    onFallback: () => void
    onError: (error: unknown) => void
    onRetry?: () => void
  },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error) {
    this.props.onError(error)
  }
  render() {
    if (this.state.failed)
      return (
        <div className="graphics-fallback">
          <strong>Your design is still here.</strong>
          <p>
            3D graphics aren’t available in this browser. All configuration, pricing, and floor-plan
            tools still work.
          </p>
          <button className="primary" onClick={this.props.onFallback}>
            Open the floor plan
          </button>
          {this.props.onRetry && (
            <button onClick={this.props.onRetry}>Retry with WebGL / Lite</button>
          )}
        </div>
      )
    return this.props.children
  }
}
function Dimensions({ config: c, unit }: { config: Config; unit: Unit }) {
  const z = c.addons.deck ? 14 : 6
  return (
    <group>
      <mesh position={[0, 0.06, z]}>
        <boxGeometry args={[c.length, 0.035, 0.035]} />
        <meshBasicMaterial color="#505d43" />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * c.length) / 2, 0.06, z]}>
          <boxGeometry args={[0.035, 0.035, 0.65]} />
          <meshBasicMaterial color="#505d43" />
        </mesh>
      ))}
      <Html position={[0, 0.1, z + 0.4]} center>
        <span className="dimension-label">{distance(c.length, unit)}</span>
      </Html>
      <mesh position={[-c.length / 2 - 1, 0.06, 0]}>
        <boxGeometry args={[0.035, 0.035, 8]} />
        <meshBasicMaterial color="#505d43" />
      </mesh>
      <Html position={[-c.length / 2 - 1.6, 0.1, 0]} center>
        <span className="dimension-label">{distance(8, unit)}</span>
      </Html>
      <Html position={[c.length / 2 + 0.3, 6, -4]} center>
        <span className="dimension-label">{distance(productHeight(c), unit)} high</span>
      </Html>
    </group>
  )
}
function CameraRig({
  config: c,
  view,
  reset,
  autoRotate,
  memory,
  presentation,
}: {
  config: Config
  view: View
  reset: number
  autoRotate: boolean
  memory: CameraMemoryRef
  presentation: PresentationStore
}) {
  const { camera, size, gl, invalidate } = useThree()
  const shellHeight = productHeight(c)
  const hasOutdoor = c.addons.deck || c.addons.gazebo || c.addons.stairs
  const controls = useRef<OrbitControlsImpl>(null)
  const targetPosition = useRef(new Vector3()),
    targetLook = useRef(new Vector3()),
    moving = useRef(false)
  const yaw = useRef(-1.25),
    pitch = useRef(0)
  const pointer = useRef<number | null>(null)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const start = useRef({
    position: new Vector3(),
    target: new Vector3(),
    quaternion: new Quaternion(),
    elapsed: 0,
  })
  const bounds = `${c.family}:${c.length}:${shellHeight}:${c.addons.deck}:${c.addons.gazebo}:${c.addons.roof}:${c.addons.stairs}`
  const viewport = useRef(size)
  viewport.current = size
  const save = useCallback(() => {
    if (presentation.capturing || view === 'plan') return
    const p = camera as PerspectiveCamera
    const target =
      view === 'interior' ? targetLook.current : (controls.current?.target ?? targetLook.current)
    memory.current[view] = {
      position: p.position.toArray(),
      quaternion: p.quaternion.toArray(),
      target: target.toArray(),
      fov: p.fov,
      bounds,
      reset,
    }
    const token = [
      ...p.position.toArray(),
      ...p.quaternion.toArray(),
      ...target.toArray(),
      p.fov,
      p.aspect,
    ].join(',')
    const state = presentation.get()
    const animating =
      moving.current ||
      pointer.current !== null ||
      (autoRotate && !reducedMotion && view === 'exterior')
    if (state.token.camera !== token || state.animating !== animating)
      presentation.set({ ...state, token: { ...state.token, camera: token }, animating })
  }, [camera, view, memory, bounds, reset, presentation, autoRotate, reducedMotion])
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => {
      setReducedMotion(media.matches)
      invalidate()
    }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [invalidate])
  useEffect(() => {
    const restoreView = () => {
      const p = camera as PerspectiveCamera
      const cached = view === 'plan' ? undefined : memory.current[view]
      if (canRestoreCamera(cached, bounds, reset) && cached) {
        p.position.fromArray(cached.position)
        p.quaternion.fromArray(cached.quaternion)
        p.fov = cached.fov
        targetLook.current.fromArray(cached.target)
        controls.current?.target.fromArray(cached.target)
        const euler = new Euler().setFromQuaternion(p.quaternion, 'YXZ')
        yaw.current = euler.y
        pitch.current = euler.x
        moving.current = false
        p.updateProjectionMatrix()
        saveRef.current()
        invalidate()
        return
      }
      p.fov = view === 'interior' ? 68 : 32
      p.updateProjectionMatrix()
      if (view === 'interior') {
        targetPosition.current.set(c.length / 2 - 2.2, 5.8, 1.4)
        targetLook.current.set(-c.length / 4, 4.6, -0.7)
        const direction = targetLook.current.clone().sub(targetPosition.current).normalize()
        yaw.current = Math.atan2(-direction.x, -direction.z)
        pitch.current = Math.asin(direction.y)
      } else {
        const width = c.length + (c.addons.stairs ? 6 : 2),
          depth = hasOutdoor ? 17 : 10
        const v = (p.fov * Math.PI) / 360,
          h = Math.atan((Math.tan(v) * viewport.current.width) / viewport.current.height)
        const height = c.addons.roof || c.addons.stairs || c.addons.gazebo ? 14 : shellHeight
        const radius = Math.sqrt(width * width + depth * depth + height * height) / 2
        const d = (radius / Math.sin(Math.min(v, h))) * 0.94
        targetLook.current.set(
          c.addons.stairs ? 2 : 0,
          c.addons.roof ? 5 : 3.5,
          hasOutdoor ? 2.2 : 0,
        )
        targetPosition.current
          .copy(targetLook.current)
          .addScaledVector(new Vector3(0.48, 0.24, 0.84).normalize(), d)
      }
      start.current = {
        position: camera.position.clone(),
        target: controls.current?.target.clone() ?? targetLook.current.clone(),
        quaternion: camera.quaternion.clone(),
        elapsed: 0,
      }
      if (view === 'interior') camera.position.copy(targetPosition.current)
      moving.current = true
      presentation.reset()
      invalidate()
    }
    if (presentation.capturing) {
      const stop = presentation.subscribe(() => {
        if (!presentation.capturing) {
          stop()
          restoreView()
        }
      })
      return stop
    }
    restoreView()
  }, [
    camera,
    c.length,
    shellHeight,
    hasOutdoor,
    c.addons.roof,
    c.addons.gazebo,
    c.addons.stairs,
    view,
    reset,
    invalidate,
    bounds,
    memory,
    presentation,
  ])
  useEffect(() => {
    const el = gl.domElement
    let lastX = 0,
      lastY = 0
    const down = (e: PointerEvent) => {
      if (pointer.current !== null || !e.isPrimary || e.button !== 0) return
      moving.current = false
      pointer.current = e.pointerId
      if (view === 'interior') {
        const euler = new Euler().setFromQuaternion(camera.quaternion, 'YXZ')
        yaw.current = euler.y
        pitch.current = euler.x
      }
      if (view === 'interior') el.setPointerCapture(e.pointerId)
      lastX = e.clientX
      lastY = e.clientY
      const state = presentation.get()
      presentation.set({ ...state, animating: true })
    }
    const move = (e: PointerEvent) => {
      if (pointer.current !== e.pointerId || view !== 'interior' || presentation.capturing) return
      yaw.current -= (e.clientX - lastX) * 0.005
      pitch.current = Math.max(-0.7, Math.min(0.7, pitch.current - (e.clientY - lastY) * 0.005))
      lastX = e.clientX
      lastY = e.clientY
      camera.quaternion.setFromEuler(new Euler(pitch.current, yaw.current, 0, 'YXZ'))
      save()
      invalidate()
    }
    const up = (e?: PointerEvent) => {
      if (e && pointer.current !== e.pointerId) return
      const id = pointer.current
      pointer.current = null
      if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id)
      save()
      invalidate()
    }
    const key = (e: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(e.key))
        return
      e.preventDefault()
      moving.current = false
      if (presentation.capturing) {
        presentation.set({ ...presentation.get(), animating: true })
        return
      }
      if (view === 'interior') {
        yaw.current += e.key === 'ArrowLeft' ? 0.12 : e.key === 'ArrowRight' ? -0.12 : 0
        pitch.current = Math.max(
          -0.7,
          Math.min(
            0.7,
            pitch.current + (e.key === 'ArrowUp' ? 0.08 : e.key === 'ArrowDown' ? -0.08 : 0),
          ),
        )
        camera.quaternion.setFromEuler(new Euler(pitch.current, yaw.current, 0, 'YXZ'))
      } else if (controls.current) {
        const offset = camera.position.clone().sub(controls.current.target)
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
          offset.applyAxisAngle(new Vector3(0, 1, 0), e.key === 'ArrowLeft' ? 0.1 : -0.1)
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown')
          offset.y = Math.max(2, offset.y + (e.key === 'ArrowUp' ? 2 : -2))
        if (e.key === '+' || e.key === '=') offset.multiplyScalar(0.92)
        if (e.key === '-') offset.multiplyScalar(1.08)
        camera.position.copy(controls.current.target).add(offset)
        controls.current.update()
      }
      save()
      invalidate()
    }
    el.tabIndex = 0
    el.setAttribute(
      'aria-label',
      'Interactive gym. Arrow keys rotate; plus and minus zoom. Interior view: arrows look around.',
    )
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    el.addEventListener('lostpointercapture', up)
    const blur = () => up()
    window.addEventListener('blur', blur)
    el.addEventListener('keydown', key)
    return () => {
      save()
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      el.removeEventListener('lostpointercapture', up)
      window.removeEventListener('blur', blur)
      pointer.current = null
      el.removeEventListener('keydown', key)
    }
  }, [camera, gl, view, invalidate, save, presentation])
  useFrame((_, delta) => {
    if (presentation.capturing) return
    if (moving.current) {
      start.current.elapsed += delta
      const t = transitionFraction(start.current.elapsed, reducedMotion)
      if (view !== 'interior')
        camera.position.lerpVectors(start.current.position, targetPosition.current, t)
      if (controls.current && view !== 'interior') {
        controls.current.target.lerpVectors(start.current.target, targetLook.current, t)
        controls.current.update()
      } else {
        const desired = new Quaternion().setFromEuler(
          new Euler(pitch.current, yaw.current, 0, 'YXZ'),
        )
        camera.quaternion.slerpQuaternions(start.current.quaternion, desired, t)
      }
      if (t === 1) moving.current = false
      invalidate()
    } else if (
      autoRotate &&
      !reducedMotion &&
      view === 'exterior' &&
      pointer.current === null &&
      controls.current
    ) {
      const offset = camera.position.clone().sub(controls.current.target)
      offset.applyAxisAngle(
        new Vector3(0, 1, 0),
        ((-Math.PI * 2) / 60) * 0.45 * Math.min(delta, 0.1),
      )
      camera.position.copy(controls.current.target).add(offset)
      controls.current.update()
      invalidate()
    }
    save()
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={view !== 'interior'}
      enablePan={false}
      enableDamping={false}
      minDistance={12}
      maxDistance={170}
      minPolarAngle={0.1}
      maxPolarAngle={Math.PI / 2 - 0.015}
      autoRotate={false}
      onStart={() => {
        moving.current = false
      }}
    />
  )
}
export type SceneProps = {
  config: Config
  view: View
  dimensions: boolean
  unit: Unit
  reset: number
  autoRotate: boolean
  quality: Quality
  onCaptureReady?: (capture: () => string) => void
  onFallback: () => void
  onBackend?: (backend: Backend) => void
  onDeviceProfile?: (profile: DeviceProfile) => void
  onSlow?: () => void
  revision?: number
  isPreviewing?: boolean
  cameraMemory?: CameraMemoryRef
  assets?: AssetReadiness
  qualityMode?: QualityMode
  onCaptureProvider?: CaptureRegistration
  onPresentation?: (state: PresentationState) => void
  onRendererGeneration?: (generation: number) => void
  onGraphicsStatus?: (
    status: 'initializing' | 'ready' | 'lost' | 'retrying',
    reason?: string,
  ) => void
}

function SceneCanvas({
  config,
  view,
  dimensions,
  unit,
  reset,
  autoRotate,
  quality,
  onCaptureReady,
  onFallback,
  onBackend,
  onDeviceProfile,
  onSlow,
  revision,
  isPreviewing = false,
  cameraMemory,
  assets,
  qualityMode,
  onCaptureProvider,
  onPresentation,
  onRendererGeneration,
  onGraphicsStatus,
  generation,
  forceWebGL,
  onError,
  onRetry,
}: SceneProps & {
  cameraMemory: CameraMemoryRef
  generation: number
  forceWebGL: boolean
  onError: (error: unknown) => void
  onRetry?: () => void
}) {
  const [presentation] = useState(() =>
    createPresentationStore({
      token: {
        revision: revision ?? 0,
        generation,
        view,
        camera: '',
        material: assets?.revision ?? '',
        presentation: '',
        quality,
        preview: isPreviewing,
      },
      stage: 'initializing',
      reasons: [],
      animating: false,
      rendered: { width: 0, height: 0 },
    }),
  )
  const legacyRevision = useRef({ config, revision: 0 })
  const initialization = useRef<AbortController | null>(null)
  const fail = useCallback(
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : 'Graphics unavailable'
      presentation.set({ ...presentation.get(), stage: 'lost', reasons: [reason] })
      onGraphicsStatus?.('lost', reason)
      onError(error)
    },
    [presentation, onError, onGraphicsStatus],
  )
  useLayoutEffect(() => {
    if (legacyRevision.current.config !== config)
      legacyRevision.current = { config, revision: legacyRevision.current.revision + 1 }
    const state = presentation.get()
    presentation.set({
      ...state,
      stage: state.stage === 'initializing' ? 'initializing' : 'refining',
      token: {
        ...state.token,
        revision: revision ?? legacyRevision.current.revision,
        view,
        quality,
        preview: isPreviewing,
        material: assets?.revision ?? '',
        presentation: `${view}:${dimensions}:${unit}:${reset}`,
      },
    })
    presentation.reset()
  }, [
    config,
    revision,
    view,
    quality,
    isPreviewing,
    assets?.revision,
    dimensions,
    unit,
    reset,
    presentation,
  ])
  useEffect(() => {
    onPresentation?.(presentation.get())
    return presentation.subscribe(() => onPresentation?.(presentation.get()))
  }, [presentation, onPresentation])
  useEffect(() => {
    if (presentation.get().stage === 'lost')
      presentation.set({ ...presentation.get(), stage: 'initializing', reasons: [] })
    return () => {
      initialization.current?.abort()
      presentation.set({ ...presentation.get(), stage: 'lost', reasons: ['Canvas unmounted'] })
    }
  }, [presentation])
  return (
    <GraphicsBoundary onFallback={onFallback} onError={fail} onRetry={onRetry}>
      <Canvas
        shadows="percentage"
        dpr={quality === 'lite' ? 1 : [1, 2]}
        frameloop="demand"
        camera={{ position: [30, 18, 35], fov: 34, near: 0.1, far: 2000 }}
        gl={async ({ canvas }) => {
          const controller = new AbortController()
          initialization.current = controller
          onGraphicsStatus?.('initializing')
          try {
            const renderer = await createRenderer(canvas as HTMLCanvasElement, {
              forceWebGL,
              signal: controller.signal,
            })
            onRendererGeneration?.(generation)
            setMaxAnisotropy(renderer.getMaxAnisotropy())
            return renderer
          } catch (error) {
            if (!controller.signal.aborted) fail(error)
            throw error
          }
        }}
        onCreated={({ gl }) => {
          onBackend?.(backendOf(gl as unknown as WebGPURenderer))
          onDeviceProfile?.(deviceProfile(gl as unknown as WebGPURenderer))
          onGraphicsStatus?.('ready')
        }}
      >
        <Atmosphere config={config} quality={quality} view={view} />
        <Landscape config={config} quality={quality} />
        <StudioModel config={config} quality={quality} />
        {dimensions && <Dimensions config={config} unit={unit} />}
        <CameraRig
          config={config}
          view={view}
          reset={reset}
          autoRotate={autoRotate}
          memory={cameraMemory}
          presentation={presentation}
        />
        <InteriorProbe
          config={config}
          quality={quality}
          presentation={presentation}
          assets={assets}
          onError={fail}
        />
        <RenderEffects
          quality={quality}
          qualityMode={qualityMode}
          assets={assets}
          presentation={presentation}
          onCaptureProvider={onCaptureProvider}
          onCaptureReady={onCaptureReady}
          onSlow={onSlow}
          onError={fail}
        />
        <SceneRefresh
          config={config}
          view={view}
          dimensions={dimensions}
          unit={unit}
          quality={quality}
          autoRotate={autoRotate}
          onReset={() => presentation.reset()}
        />
      </Canvas>
    </GraphicsBoundary>
  )
}

let nextGeneration = 0
export default function Scene(props: SceneProps) {
  const localMemory = useRef({})
  const [generation, setGeneration] = useState(() => ++nextGeneration)
  const [retried, setRetried] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const fail = useCallback(
    (error: unknown) => setFailure(error instanceof Error ? error.message : 'Graphics unavailable'),
    [],
  )
  const retry = () => {
    if (retried) return
    props.onGraphicsStatus?.('retrying')
    setRetried(true)
    setFailure(null)
    setGeneration(++nextGeneration)
  }
  if (failure)
    return (
      <div className="graphics-fallback" role="status">
        <strong>Your design is still here.</strong>
        <p>3D graphics stopped. Configuration and the editable floor plan remain available.</p>
        {!retried && <button onClick={retry}>Retry with WebGL / Lite</button>}
        <button className="primary" onClick={props.onFallback}>
          Open the floor plan
        </button>
      </div>
    )
  return (
    <SceneCanvas
      key={generation}
      {...props}
      quality={retried ? 'lite' : props.quality}
      cameraMemory={props.cameraMemory ?? localMemory}
      generation={generation}
      forceWebGL={retried}
      onError={fail}
      onRetry={retried ? undefined : retry}
    />
  )
}
