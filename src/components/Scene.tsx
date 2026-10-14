import { Component, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  Environment,
  Html,
  Lightformer,
  OrbitControls,
  SoftShadows,
} from '@react-three/drei'
import { ACESFilmicToneMapping, BackSide, Color, Euler, PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { distance, type Config, type Unit, type View } from '../lib/config'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'
import { SurfaceProvider } from './SurfaceMaterial'
import { lightingAt } from '../lib/visuals'
import { RenderEffects } from './RenderEffects'

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
          <strong>Your studio is still here.</strong>
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
        <span className="dimension-label">{distance(10, unit)} high</span>
      </Html>
    </group>
  )
}
function CameraRig({
  config: c,
  view,
  reset,
  autoRotate,
}: {
  config: Config
  view: View
  reset: number
  autoRotate: boolean
}) {
  const { camera, size, gl, invalidate } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const targetPosition = useRef(new Vector3()),
    targetLook = useRef(new Vector3()),
    moving = useRef(false)
  const yaw = useRef(-1.25),
    pitch = useRef(0)
  useEffect(() => {
    const p = camera as PerspectiveCamera
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
        depth = c.addons.deck ? 17 : 10
      const v = (p.fov * Math.PI) / 360,
        h = Math.atan((Math.tan(v) * size.width) / size.height)
      const height = c.addons.roof ? 14 : 10
      const radius = Math.sqrt(width * width + depth * depth + height * height) / 2
      const d = (radius / Math.sin(Math.min(v, h))) * 0.94
      targetLook.current.set(
        c.addons.stairs ? 2 : 0,
        c.addons.roof ? 5 : 3.5,
        c.addons.deck ? 2.2 : 0,
      )
      targetPosition.current
        .copy(targetLook.current)
        .addScaledVector(new Vector3(0.48, 0.24, 0.84).normalize(), d)
    }
    moving.current = true
    invalidate()
  }, [
    camera,
    size.width,
    size.height,
    c.length,
    c.addons.deck,
    c.addons.roof,
    c.addons.stairs,
    view,
    reset,
    invalidate,
  ])
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
      'Interactive studio. Arrow keys rotate; plus and minus zoom. Interior view: arrows look around.',
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
  useFrame((_, delta) => {
    if (!moving.current) return
    const t = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 1
      : 1 - Math.exp(-delta * 5)
    camera.position.lerp(targetPosition.current, t)
    if (controls.current && view !== 'interior') {
      controls.current.target.lerp(targetLook.current, t)
      controls.current.update()
    } else camera.lookAt(targetLook.current)
    if (camera.position.distanceTo(targetPosition.current) < 0.015) moving.current = false
    invalidate()
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={view !== 'interior'}
      enablePan={false}
      minDistance={12}
      maxDistance={170}
      minPolarAngle={0.1}
      maxPolarAngle={Math.PI / 2 - 0.015}
      autoRotate={autoRotate && view === 'exterior'}
      autoRotateSpeed={0.45}
      onStart={() => {
        moving.current = false
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
  autoRotate,
  quality,
  onCaptureReady,
  onFallback,
}: {
  config: Config
  view: View
  dimensions: boolean
  unit: Unit
  reset: number
  autoRotate: boolean
  quality: 'high' | 'lite'
  onCaptureReady: (capture: () => string) => void
  onFallback: () => void
}) {
  const { daylight, warmth, elevation } = lightingAt(config.time)
  const bg = new Color('#333e51')
    .lerp(new Color(config.environment === 'desert' ? '#ded0ba' : '#d7ddd8'), daylight)
    .lerp(new Color('#d6bba0'), warmth * 0.35)
  const sunlight = new Color('#fff5df').lerp(new Color('#ffc084'), warmth)
  const sunAngle = ((config.time - 6) / 15) * Math.PI
  return (
    <GraphicsBoundary onFallback={onFallback}>
      <Canvas
        shadows={quality === 'high'}
        dpr={quality === 'high' ? [1, 2] : 1}
        frameloop="demand"
        camera={{ position: [30, 18, 35], fov: 34, near: 0.1, far: 350 }}
        gl={{
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
      >
        <color attach="background" args={[bg]} />
        <fog attach="fog" args={[bg, 65, 175]} />
        <hemisphereLight args={['#d8e7f1', '#777461', 0.3 + daylight * 0.55]} />
        {quality === 'high' && <SoftShadows size={18} samples={12} focus={0.4} />}
        <directionalLight
          position={[Math.cos(sunAngle) * 35, Math.max(8, elevation * 45), 26]}
          intensity={0.12 + daylight * 3.2}
          color={sunlight}
          castShadow
          shadow-mapSize={quality === 'high' ? [2048, 2048] : [512, 512]}
          shadow-camera-left={-config.length / 2 - 12}
          shadow-camera-right={config.length / 2 + 12}
          shadow-camera-top={28}
          shadow-camera-bottom={-24}
          shadow-camera-near={0.5}
          shadow-camera-far={130}
          shadow-normalBias={0.035}
          shadow-bias={-0.0001}
        />
        <Suspense fallback={null}>
          <Environment
            key={`${config.time}-${config.environment}-${quality}`}
            resolution={quality === 'high' ? 256 : 64}
            environmentIntensity={0.3 + daylight * 0.65}
          >
            <mesh>
              <sphereGeometry args={[90, 32, 16]} />
              <meshBasicMaterial side={BackSide} color="#a9b5bc" />
            </mesh>
            <mesh position={[0, -10, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[180, 180]} />
              <meshBasicMaterial color="#777869" />
            </mesh>
            <Lightformer
              intensity={1 + daylight}
              position={[0, 25, 0]}
              rotation={[Math.PI / 2, 0, 0]}
              scale={[50, 40, 1]}
            />
            <Lightformer
              intensity={0.4 + daylight * 1.5}
              position={[-25, 8, 10]}
              rotation={[0, Math.PI / 2, 0]}
              scale={[8, 18, 1]}
            />
            <Lightformer
              intensity={0.6 + daylight}
              color="#e6e9df"
              position={[0, 8, 30]}
              scale={[35, 6, 1]}
            />
          </Environment>
        </Suspense>
        <SurfaceProvider>
          <Landscape config={config} quality={quality} />
          <StudioModel config={config} quality={quality} />
        </SurfaceProvider>
        {quality === 'high' && (
          <ContactShadows
            key={`${config.length}-${JSON.stringify(config.addons)}-${config.environment}`}
            position={[0, 0.02, 0]}
            opacity={0.38}
            scale={config.length + 25}
            blur={2.8}
            far={16}
            resolution={1024}
            frames={1}
            color="#343629"
          />
        )}
        {dimensions && <Dimensions config={config} unit={unit} />}
        <CameraRig config={config} view={view} reset={reset} autoRotate={autoRotate} />
        <RenderEffects quality={quality} onCaptureReady={onCaptureReady} />
      </Canvas>
    </GraphicsBoundary>
  )
}
