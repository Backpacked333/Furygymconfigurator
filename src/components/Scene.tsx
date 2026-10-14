import { Component, Suspense, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, Html, Lightformer, OrbitControls } from '@react-three/drei'
import { Color, Euler, InstancedMesh, Object3D, PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { distance, type Config, type Unit, type View } from '../lib/config'
import { StudioModel } from './StudioModel'

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
function Tree({
  x,
  z,
  size = 1,
  desert,
}: {
  x: number
  z: number
  size?: number
  desert: boolean
}) {
  const leaves = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    if (!leaves.current) return
    const obj = new Object3D()
    for (let i = 0; i < 460; i++) {
      const a = i * 2.39996,
        t = ((i * 47) % 461) / 461,
        y = 4.3 + t * (desert ? 2.7 : 4.1)
      const radius =
        Math.sqrt(1 - (t * 2 - 1) ** 2) * (desert ? 3.2 : 2.6) * Math.sqrt(((i * 71) % 461) / 461)
      obj.position.set(Math.cos(a) * radius, y, Math.sin(a) * radius)
      obj.scale.set(0.38 + (i % 3) * 0.12, 0.22 + (i % 4) * 0.06, 0.48)
      obj.rotation.set(i * 0.4, i * 0.3, 0)
      obj.updateMatrix()
      leaves.current.setMatrixAt(i, obj.matrix)
      leaves.current.setColorAt(
        i,
        new Color(
          desert
            ? ['#85875f', '#7e8056', '#9d9d75'][i % 3]
            : ['#606b43', '#778154', '#849064'][i % 3],
        ),
      )
    }
    leaves.current.instanceMatrix.needsUpdate = true
    if (leaves.current.instanceColor) leaves.current.instanceColor.needsUpdate = true
  }, [desert])
  return (
    <group position={[x, 0, z]} scale={size}>
      <mesh castShadow position={[0, 3.1, 0]}>
        <cylinderGeometry args={[0.13, 0.24, 6.2, 9]} />
        <meshStandardMaterial color="#746550" roughness={1} />
      </mesh>
      {[0, 1, 2, 3, 4].map((i) => (
        <group key={i} rotation={[0, i * 2.4, 0]}>
          <mesh castShadow position={[0.65, 4.3 + i * 0.35, 0]} rotation={[0, 0, -0.7]}>
            <cylinderGeometry args={[0.04, 0.1, 2.8, 6]} />
            <meshStandardMaterial color="#746550" roughness={1} />
          </mesh>
        </group>
      ))}
      <instancedMesh ref={leaves} args={[undefined, undefined, 460]} castShadow>
        <icosahedronGeometry args={[1, 0]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>
    </group>
  )
}
function Landscaping({ config: c }: { config: Config }) {
  const desert = c.environment === 'desert',
    L = c.length
  if (c.environment === 'studio')
    return (
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[300, 300]} />
        <meshStandardMaterial color="#b5b7af" roughness={1} />
      </mesh>
    )
  return (
    <group>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.15, 0]}>
        <planeGeometry args={[300, 300]} />
        <meshStandardMaterial color={desert ? '#c0aa87' : '#a3aa8f'} roughness={1} />
      </mesh>
      <mesh receiveShadow position={[0, -0.11, 3]}>
        <boxGeometry args={[L + 12, 0.2, 30]} />
        <meshStandardMaterial color={desert ? '#c8b394' : '#c1c1b3'} roughness={0.95} />
      </mesh>
      {Array.from({ length: 7 }, (_, i) => (
        <mesh key={i} receiveShadow position={[0, 0.008, 15 + i * 2.6]}>
          <boxGeometry args={[4.5, 0.1, 1.9]} />
          <meshStandardMaterial color="#d2d0c2" roughness={0.85} />
        </mesh>
      ))}
      <mesh position={[0, 2.25, -11]} castShadow receiveShadow>
        <boxGeometry args={[L + 18, 4.5, 0.5]} />
        <meshStandardMaterial color={desert ? '#b4a68d' : '#727d63'} roughness={1} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side}>
          <Tree x={side * (L / 2 + 5)} z={-9} size={1.7} desert={desert} />
          <Tree x={side * (L / 2 + 10)} z={-14} size={2.1} desert={desert} />
          <mesh position={[side * (L / 2 + 3.8), 0.35, 5]} castShadow>
            <boxGeometry args={[2, 0.7, 10]} />
            <meshStandardMaterial color="#8c917e" />
          </mesh>
          {Array.from({ length: 8 }, (_, i) => (
            <mesh
              key={i}
              position={[side * (L / 2 + 3.8), 1.1 + Math.sin(i) * 0.1, 1 + i * 1.2]}
              scale={[0.7, 1, 0.65]}
              castShadow
            >
              <sphereGeometry args={[0.85, 8, 6]} />
              <meshStandardMaterial color={desert ? '#8d9271' : '#747f4d'} roughness={1} />
            </mesh>
          ))}
        </group>
      ))}
      <mesh position={[-L / 2 - 1.6, 1.05, 10.2]} castShadow>
        <cylinderGeometry args={[0.85, 0.58, 2.1, 20]} />
        <meshStandardMaterial color="#767c69" roughness={0.85} />
      </mesh>
      <Tree x={-L / 2 - 1.6} z={10.2} size={0.55} desert={desert} />
    </group>
  )
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
    p.fov = view === 'interior' ? 72 : 34
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
        .addScaledVector(new Vector3(0.52, 0.3, 0.8).normalize(), d)
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
function Capture({ onCaptureReady }: { onCaptureReady: (capture: () => string) => void }) {
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    onCaptureReady(() => {
      gl.render(scene, camera)
      return gl.domElement.toDataURL('image/png')
    })
  }, [gl, scene, camera, onCaptureReady])
  return null
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
  const night = config.time >= 19,
    sunset = config.time >= 17 && !night
  const bg = night
    ? '#373f43'
    : sunset
      ? '#c8baaa'
      : config.environment === 'desert'
        ? '#d2c3ae'
        : '#c7ccc2'
  const sunAngle = ((config.time - 6) / 15) * Math.PI
  return (
    <GraphicsBoundary onFallback={onFallback}>
      <Canvas
        shadows={quality === 'high'}
        dpr={quality === 'high' ? [1, 1.6] : 1}
        frameloop="demand"
        camera={{ position: [30, 18, 35], fov: 34, near: 0.1, far: 350 }}
        gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={[bg]} />
        <fog attach="fog" args={[bg, 85, 190]} />
        <hemisphereLight args={[night ? '#93a2bd' : '#f1f2e4', '#5b6450', night ? 0.75 : 1.2]} />
        <directionalLight
          position={[Math.cos(sunAngle) * 35, Math.max(8, Math.sin(sunAngle) * 45), 24]}
          intensity={night ? 0.5 : sunset ? 3 : 3.5}
          color={sunset ? '#ffce92' : '#fff4d9'}
          castShadow
          shadow-mapSize={quality === 'high' ? [2048, 2048] : [512, 512]}
          shadow-camera-left={-45}
          shadow-camera-right={45}
          shadow-camera-top={40}
          shadow-camera-bottom={-30}
          shadow-normalBias={0.06}
          shadow-bias={-0.0001}
        />
        <Suspense fallback={null}>
          <Environment resolution={128}>
            <Lightformer
              intensity={2}
              position={[0, 20, 0]}
              rotation={[Math.PI / 2, 0, 0]}
              scale={[40, 30, 1]}
            />
            <Lightformer
              intensity={1.5}
              position={[-15, 10, 8]}
              rotation={[0, Math.PI / 2, 0]}
              scale={[15, 20, 1]}
            />
          </Environment>
        </Suspense>
        <Landscaping config={config} />
        <StudioModel config={config} />
        {quality === 'high' && (
          <ContactShadows
            key={`${config.length}-${JSON.stringify(config.addons)}`}
            position={[0, 0.02, 0]}
            opacity={0.32}
            scale={100}
            blur={2.5}
            far={16}
            resolution={512}
            frames={1}
            color="#303724"
          />
        )}
        {dimensions && <Dimensions config={config} unit={unit} />}
        <CameraRig config={config} view={view} reset={reset} autoRotate={autoRotate} />
        <Capture onCaptureReady={onCaptureReady} />
      </Canvas>
    </GraphicsBoundary>
  )
}
