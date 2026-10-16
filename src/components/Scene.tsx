import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { distance, productHeight, type Config, type Unit, type View } from '../lib/config'
import { skyLook } from '../lib/visuals'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'
import { RenderEffects, type Capture } from './RenderEffects'
import { SceneRefresh } from './SceneRefresh'
import { Atmosphere } from './Atmosphere'
import { InteriorProbe } from './InteriorProbe'
import { deckFront, roofTop } from '../render/addons'
import { backendOf, createRenderer, type Backend, type Quality } from '../render/renderer'
import { cameraFraming } from '../render/framing'
import { DAMPING, motionPixels, settleGlide } from '../render/motion'
import {
  ORBIT_LIMITS,
  blendPosition,
  poseAt,
  posePosition,
  snapPose,
  type GridPose,
} from '../render/orbit'
import { cloudUrl } from '../render/traceStatus'
import { setMaxAnisotropy } from '../render/materials'

class GraphicsBoundary extends Component<
  { children: ReactNode; onFallback: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
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
        </div>
      )
    return this.props.children
  }
}
function Dimensions({ config: c, unit }: { config: Config; unit: Unit }) {
  const z = c.addons.deck ? deckFront(c) + 1 : 6
  return (
    <group userData={{ pathTrace: false }}>
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
/** How long the camera takes to ease onto the orbit grid once it comes to rest. */
const SNAP_MS = 280

function CameraRig({
  config: c,
  view,
  reset,
  direction,
  autoRotate,
  snap,
}: {
  config: Config
  view: View
  reset: number
  direction: [number, number, number]
  autoRotate: boolean
  /** Rest the exterior camera on the orbit grid, whose views the cloud pre-renders (orbit.ts). */
  snap: boolean
}) {
  const { camera, size, gl, invalidate } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const targetPosition = useRef(new Vector3()),
    targetLook = useRef(new Vector3()),
    moving = useRef(false)
  const snapRef = useRef(snap)
  snapRef.current = snap && view === 'exterior'
  /** The ease onto a grid pose in progress, and the pose the camera last rested on. */
  const snapping = useRef<{ from: Vector3; pose: GridPose; start: number } | null>(null)
  const lastPose = useRef<GridPose | null>(null)
  const yaw = useRef(-1.25),
    pitch = useRef(0)
  const [dx, dy, dz] = direction
  // Framing depends only on what changes the build's silhouette, not on every edit.
  const framingKey = JSON.stringify([
    c.length,
    productHeight(c),
    c.addons.deck,
    c.addons.gazebo,
    c.addons.stairs,
    c.addons.canopy,
    c.addons.roof,
    c.addons.deck ? deckFront(c) : 0,
    c.addons.roof || c.addons.stairs ? roofTop(c) : 0,
  ])
  const framingConfig = useRef(c)
  framingConfig.current = c
  useEffect(() => {
    const p = camera as PerspectiveCamera
    const framing = cameraFraming(
      framingConfig.current,
      view,
      [dx, dy, dz],
      size.width / size.height,
    )
    p.fov = framing.fov
    p.updateProjectionMatrix()
    targetPosition.current.set(...framing.position)
    targetLook.current.set(...framing.target)
    snapping.current = null
    lastPose.current = null
    if (snapRef.current)
      posePosition(
        targetLook.current,
        snapPose(targetPosition.current, targetLook.current, null),
        targetPosition.current,
      )
    if (view === 'interior') {
      const direction = targetLook.current.clone().sub(targetPosition.current).normalize()
      yaw.current = Math.atan2(-direction.x, -direction.z)
      pitch.current = Math.asin(direction.y)
    }
    moving.current = true
    invalidate()
  }, [camera, size.width, size.height, framingKey, view, reset, dx, dy, dz, invalidate])
  useEffect(() => {
    const el = gl.domElement
    let drag = false,
      lastX = 0,
      lastY = 0
    const down = (e: PointerEvent) => {
      moving.current = false
      drag = true
      lastX = e.clientX
      lastY = e.clientY
    }
    const move = (e: PointerEvent) => {
      if (!drag || view !== 'interior') return
      yaw.current -= (e.clientX - lastX) * 0.005
      pitch.current = Math.max(-0.7, Math.min(0.7, pitch.current - (e.clientY - lastY) * 0.005))
      lastX = e.clientX
      lastY = e.clientY
      camera.quaternion.setFromEuler(new Euler(pitch.current, yaw.current, 0, 'YXZ'))
      invalidate()
    }
    const up = () => {
      drag = false
    }
    const key = (e: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(e.key))
        return
      e.preventDefault()
      moving.current = false
      snapping.current = null
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
    el.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('keydown', key)
    }
  }, [camera, gl, view, invalidate])
  // Ends an orbit's damped glide once it is no longer visible, so the view comes to rest (and the
  // path tracer starts) promptly. Runs after OrbitControls' own update.
  const glide = useRef({ dragging: false, position: new Vector3(), quaternion: new Quaternion() })
  useFrame(() => {
    const orbit = controls.current
    const last = glide.current
    const pixels = motionPixels(
      last.position,
      last.quaternion,
      camera.position,
      camera.quaternion,
      orbit ? camera.position.distanceTo(orbit.target) : 1,
      (camera as PerspectiveCamera).fov,
      size.height,
    )
    last.position.copy(camera.position)
    last.quaternion.copy(camera.quaternion)
    if (!orbit?.enabled || last.dragging || moving.current || orbit.autoRotate || !snapRef.current)
      snapping.current = null
    if (!orbit?.enabled || last.dragging || moving.current || orbit.autoRotate) return
    const easing = snapping.current
    if (easing) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const t = reduced ? 1 : Math.min(1, (performance.now() - easing.start) / SNAP_MS)
      if (t < 1)
        camera.position.copy(
          blendPosition(orbit.target, easing.from, easing.pose, 1 - (1 - t) ** 3),
        )
      else {
        posePosition(orbit.target, easing.pose, camera.position)
        snapping.current = null
        lastPose.current = easing.pose
      }
      orbit.update()
      invalidate()
      return
    }
    if (pixels > 0) {
      if (settleGlide(orbit, pixels)) invalidate()
      return
    }
    // At rest: ease onto the nearest grid pose, whose view the cloud may have pre-rendered.
    if (!snapRef.current) return
    const pose = poseAt(camera.position, orbit.target)
    if (pose) {
      lastPose.current = pose
      return
    }
    snapping.current = {
      from: camera.position.clone(),
      pose: snapPose(camera.position, orbit.target, lastPose.current),
      start: performance.now(),
    }
    invalidate()
  })
  useFrame((_, delta) => {
    if (!moving.current) return
    const t = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 1
      : 1 - Math.exp(-delta * 5)
    camera.position.lerp(targetPosition.current, t)
    const orbit = controls.current && view !== 'interior' ? controls.current : null
    if (orbit) orbit.target.lerp(targetLook.current, t)
    if (
      camera.position.distanceTo(targetPosition.current) < 0.015 &&
      (!orbit || orbit.target.distanceTo(targetLook.current) < 0.015)
    ) {
      // Land exactly, so the view is the same each time (and on the orbit grid when snapping).
      camera.position.copy(targetPosition.current)
      orbit?.target.copy(targetLook.current)
      moving.current = false
    }
    if (orbit) orbit.update()
    else camera.lookAt(targetLook.current)
    invalidate()
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={view !== 'interior'}
      enablePan={false}
      {...ORBIT_LIMITS}
      autoRotate={autoRotate && view === 'exterior'}
      autoRotateSpeed={0.45}
      dampingFactor={DAMPING}
      onStart={() => {
        moving.current = false
        snapping.current = null
        glide.current.dragging = true
        if (controls.current) controls.current.dampingFactor = DAMPING
      }}
      onEnd={() => {
        glide.current.dragging = false
      }}
    />
  )
}
export default function Scene({
  config,
  view,
  dimensions,
  unit,
  reset,
  camera = [0.48, 0.24, 0.84],
  autoRotate,
  quality,
  trace,
  onCaptureReady,
  onFallback,
  onBackend,
  onSlow,
}: {
  config: Config
  view: View
  dimensions: boolean
  unit: Unit
  reset: number
  camera?: [number, number, number]
  autoRotate: boolean
  quality: Quality
  /** Refine resting views with the path tracer where WebGPU allows. */
  trace: boolean
  onCaptureReady: (capture: Capture) => void
  onFallback: () => void
  onBackend?: (backend: Backend) => void
  onSlow?: () => void
}) {
  const look = useMemo(
    () => skyLook(config.environment, config.time),
    [config.environment, config.time],
  )
  // Cloud renders can be pre-rendered around the orbit, if resting views sit on its grid.
  const snap = useMemo(() => trace && cloudUrl() !== null, [trace])
  return (
    <GraphicsBoundary onFallback={onFallback}>
      <Canvas
        shadows="percentage"
        // Temporal AA resolves edges, so screen-space GI need not pay for full Retina density.
        dpr={quality === 'lite' ? 1 : [1, 1.5]}
        frameloop="demand"
        camera={{ position: [30, 18, 35], fov: 34, near: 0.1, far: 2000 }}
        gl={async ({ canvas }) => {
          const renderer = await createRenderer(canvas as HTMLCanvasElement)
          setMaxAnisotropy(renderer.getMaxAnisotropy())
          return renderer
        }}
        onCreated={({ gl }) => onBackend?.(backendOf(gl as unknown as WebGPURenderer))}
      >
        <Atmosphere config={config} quality={quality} view={view} />
        <Landscape config={config} quality={quality} />
        <StudioModel config={config} quality={quality} />
        {dimensions && <Dimensions config={config} unit={unit} />}
        <CameraRig
          config={config}
          view={view}
          reset={reset}
          direction={camera}
          autoRotate={autoRotate}
          snap={snap}
        />
        <InteriorProbe config={config} quality={quality} />
        <RenderEffects
          quality={quality}
          trace={trace}
          look={look}
          config={config}
          view={view}
          dimensions={dimensions}
          onCaptureReady={onCaptureReady}
          onSlow={onSlow}
        />
        <SceneRefresh
          config={config}
          view={view}
          dimensions={dimensions}
          unit={unit}
          quality={quality}
          autoRotate={autoRotate}
        />
      </Canvas>
    </GraphicsBoundary>
  )
}
