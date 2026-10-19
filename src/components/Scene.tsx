import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { Euler, PerspectiveCamera, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { distance, productHeight, type Config, type Unit, type View } from '../lib/config'
import { effectiveLights } from '../lib/lighting'
import { CAMERA_PRESETS, exteriorFraming, interiorFraming } from '../lib/cameras'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'
import { RenderEffects } from './RenderEffects'
import { SceneRefresh } from './SceneRefresh'
import { Atmosphere } from './Atmosphere'
import { InteriorProbe } from './InteriorProbe'
import { backendOf, createRenderer, type Backend, type Quality } from '../render/renderer'
import { restoreTextures, setMaxAnisotropy } from '../render/materials'
import { sceneProgress } from '../render/progress'
import { SceneLoadingStatus } from './SceneLoading'

/** Renderer rebuilds after device loss before the scene gives up and offers the floor plan. */
const MAX_RENDERER_REBUILDS = 3
function DeviceUnstable(): never {
  throw new Error('The graphics device keeps getting lost.')
}

class GraphicsBoundary extends Component<
  { children: ReactNode; onFallback: () => void; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onFailure()
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
}: {
  config: Config
  view: View
  reset: number
  autoRotate: boolean
}) {
  const { camera, size, gl, invalidate } = useThree()
  // Only these inputs move the camera; a finish or flooring change must not re-frame the view.
  const framing = useMemo(
    () => ({ family: c.family, length: c.length, addons: c.addons }),
    [c.family, c.length, c.addons],
  )
  const controls = useRef<OrbitControlsImpl>(null)
  const targetPosition = useRef(new Vector3()),
    targetLook = useRef(new Vector3()),
    moving = useRef(false),
    stalled = useRef(0)
  const yaw = useRef(-1.25),
    pitch = useRef(0)
  useEffect(() => {
    const p = camera as PerspectiveCamera
    p.fov = view === 'interior' ? 68 : 32
    p.updateProjectionMatrix()
    if (view === 'interior') {
      const pose = interiorFraming(framing, 'interiorHero')
      targetPosition.current.set(...pose.position)
      targetLook.current.set(...pose.target)
      const direction = targetLook.current.clone().sub(targetPosition.current).normalize()
      yaw.current = Math.atan2(-direction.x, -direction.z)
      pitch.current = Math.asin(direction.y)
    } else {
      const pose = exteriorFraming(
        framing,
        p.fov,
        size.width / size.height,
        CAMERA_PRESETS.hero.direction!,
      )
      targetLook.current.set(...pose.target)
      targetPosition.current.set(...pose.position)
    }
    moving.current = true
    stalled.current = 0
    invalidate()
  }, [camera, size.width, size.height, framing, view, reset, invalidate])
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
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), [])
  useFrame((_, delta) => {
    if (!moving.current) return
    // R3F's first delta after an idle stretch is the whole idle time, which made a transition
    // jump in one frame instead of easing; a frame never advances it more than 1/30 s.
    const t = reducedMotion.matches ? 1 : 1 - Math.exp(-Math.min(delta, 1 / 30) * 5)
    const before = camera.position.distanceTo(targetPosition.current)
    camera.position.lerp(targetPosition.current, t)
    if (controls.current && view !== 'interior') {
      controls.current.target.lerp(targetLook.current, t)
      controls.current.update()
    } else camera.lookAt(targetLook.current)
    const after = camera.position.distanceTo(targetPosition.current)
    // Arrived, or the orbit limits (a framing distance beyond them on a narrow screen) or
    // auto-rotation kept the camera from making the progress the easing asked for: either way,
    // stop instead of rendering forever. Sliding around the minimum-distance sphere is progress
    // the straight-line measure undercounts, so it never counts as held.
    const pinned =
      !!controls.current &&
      view !== 'interior' &&
      controls.current.getDistance() <= controls.current.minDistance + 1e-3
    stalled.current = !pinned && after > before - 0.5 * t * before ? stalled.current + 1 : 0
    if (after < 0.015 || stalled.current >= 8) moving.current = false
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
/**
 * Memoized: the app shell re-renders for panel tabs, toasts, and dialogs, which never change the
 * scene; re-rendering it would still reconcile the whole 3D tree.
 */
export default memo(function Scene({
  active,
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
  onSlow,
}: {
  /** False while hidden under the floor plan: nothing renders until the scene shows again. */
  active: boolean
  config: Config
  view: View
  dimensions: boolean
  unit: Unit
  reset: number
  autoRotate: boolean
  quality: Quality
  onCaptureReady: (capture: (() => string) | null) => void
  onFallback: () => void
  onBackend?: (backend: Backend) => void
  onSlow?: () => void
}) {
  // The scene draws the lights as they are seen: always on by day, by choice after dark.
  const lights = effectiveLights(config)
  config = useMemo(() => ({ ...config, lights }), [config, lights])
  // A lost GPU device (driver reset, GPU process crash, the OS reclaiming memory) would leave a
  // frozen canvas. Rebuild the renderer instead, a few times per session at most.
  const [generation, setGeneration] = useState(0)
  // The scene stays mounted under the floor plan, so coming back from it would not remount a
  // failed 3D view the way it once did. Coming back starts a fresh attempt instead.
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(active)
  if (active !== shown) {
    setShown(active)
    if (active && (failed || generation > MAX_RENDERER_REBUILDS)) {
      setFailed(false)
      setGeneration(0)
      setAttempt(attempt + 1)
    }
  }
  // The renderer that is mounted, or null while the scene is torn down.
  const mounted = `${attempt}:${generation}`
  const live = useRef<string | null>(null)
  useEffect(() => {
    live.current = mounted
    return () => {
      live.current = null
    }
  }, [mounted])
  return (
    <GraphicsBoundary key={attempt} onFallback={onFallback} onFailure={() => setFailed(true)}>
      {generation > MAX_RENDERER_REBUILDS ? (
        <DeviceUnstable />
      ) : (
        <Canvas
          key={generation}
          shadows="percentage"
          // Temporal AA resolves edges, so screen-space GI need not pay for full Retina density.
          dpr={quality === 'lite' ? 1 : [1, 1.5]}
          frameloop={active ? 'demand' : 'never'}
          camera={{ position: [30, 18, 35], fov: 34, near: 0.1, far: 2000 }}
          gl={async ({ canvas }) => {
            // Scans uploaded by a previous renderer released their decoded pixels; R3F renders
            // nothing until this factory resolves, so no frame can see a released map.
            sceneProgress.set('renderer')
            // Only the live renderer recovers, never one that is being torn down.
            const rebuild = () => {
              if (live.current === mounted) setGeneration(generation + 1)
            }
            const [renderer] = await Promise.all([
              createRenderer(canvas as HTMLCanvasElement).then((renderer) => {
                // Watch for loss as soon as the renderer exists, not after the scans are restored.
                const report = renderer.onDeviceLost
                renderer.onDeviceLost = (info) => {
                  report.call(renderer, info)
                  rebuild()
                }
                return renderer
              }),
              restoreTextures(),
            ])
            // Lost while it was still being set up, before anything listened.
            if ((renderer as unknown as { _isDeviceLost?: boolean })._isDeviceLost) rebuild()
            setMaxAnisotropy(renderer.getMaxAnisotropy())
            // The first frame compiles every shader in view.
            sceneProgress.set('shaders')
            return renderer
          }}
          onCreated={({ gl }) => onBackend?.(backendOf(gl as unknown as WebGPURenderer))}
        >
          <Atmosphere config={config} quality={quality} view={view} />
          <Landscape config={config} quality={quality} />
          <StudioModel config={config} quality={quality} />
          {dimensions && <Dimensions config={config} unit={unit} />}
          <CameraRig config={config} view={view} reset={reset} autoRotate={autoRotate} />
          <InteriorProbe config={config} quality={quality} />
          <RenderEffects quality={quality} onCaptureReady={onCaptureReady} onSlow={onSlow} />
          <SceneRefresh
            active={active}
            config={config}
            view={view}
            dimensions={dimensions}
            unit={unit}
            quality={quality}
            autoRotate={autoRotate}
          />
        </Canvas>
      )}
      <SceneLoadingStatus />
    </GraphicsBoundary>
  )
})
