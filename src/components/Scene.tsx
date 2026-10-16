import {
  Component,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { skyLook } from '../lib/visuals'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'
import { RenderEffects, type Capture } from './RenderEffects'
import { SceneRefresh } from './SceneRefresh'
import { Atmosphere } from './Atmosphere'
import { InteriorProbe, SiteProbe } from './InteriorProbe'
import { deckFront, roofTop } from '../render/envelope'
import { backendOf, createRenderer, type Backend, type Quality } from '../render/renderer'
import { aspectClassOf, galleryCamera, type AngleId, type GalleryCamera } from '../render/gallery'
import { DAMPING, motionPixels, settleGlide } from '../render/motion'
import { ORBIT_LIMITS } from '../render/orbit'
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
function CameraRig({
  config: c,
  view,
  reset,
  direction,
  autoRotate,
  angle,
  gallery,
}: {
  config: Config
  view: View
  reset: number
  /** The direction of the front three-quarter view: the build's own. */
  direction: [number, number, number]
  autoRotate: boolean
  /**
   * The gallery angle on the stage, or last on it: the 360° view opens at its pose, and Reset view
   * returns there.
   */
  angle: AngleId
  /**
   * In the gallery the camera stands exactly where the angle's still is rendered from
   * (gallery.ts), and the controls rest; in the 360° view it moves freely from there.
   */
  gallery: boolean
}) {
  const { camera, size, gl, invalidate } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const targetPosition = useRef(new Vector3()),
    targetLook = useRef(new Vector3()),
    moving = useRef(false),
    stalled = useRef(0)
  const yaw = useRef(-1.25),
    pitch = useRef(0)
  const [dx, dy, dz] = direction
  const live = !gallery
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
  // The angle's pose: a pure function of the design, the angle and the stage's shape. The gallery
  // stands the camera there; the 360° view starts there and Reset view returns there.
  const aspect = aspectClassOf(size.width, size.height)
  const home = galleryCamera(c, angle, aspect, [dx, dy, dz])
  const homeRef = useRef(home)
  homeRef.current = home
  const poseKey = gallery ? JSON.stringify(home) : ''
  // Before the frame after the commit, so no frame of a new angle is drawn from the old pose.
  useLayoutEffect(() => {
    if (!poseKey) return
    const { position, target, fov } = JSON.parse(poseKey) as GalleryCamera
    const p = camera as PerspectiveCamera
    p.fov = fov
    p.updateProjectionMatrix()
    p.position.set(...position)
    p.lookAt(...target)
    p.updateMatrixWorld()
    controls.current?.target.set(...target)
    moving.current = false
    // Looking around inside carries on from this pose in the 360° view.
    const forward = new Vector3(...target).sub(p.position).normalize()
    yaw.current = Math.atan2(-forward.x, -forward.z)
    pitch.current = Math.asin(forward.y)
    invalidate()
  }, [camera, poseKey, invalidate])
  /** The 360° view has taken over the camera from the gallery's pose. */
  const entered = useRef(false)
  useEffect(() => {
    if (!live) {
      entered.current = false
      return
    }
    // Entering, the camera already stands at the still's pose and stays there: the 360° view
    // opens on exactly the picture the still showed.
    if (!entered.current) {
      entered.current = true
      return
    }
    // Reset view, a view switch, or a new silhouette (not every edit): back to the angle's pose.
    const { position, target, fov } = homeRef.current
    const p = camera as PerspectiveCamera
    p.fov = fov
    p.updateProjectionMatrix()
    targetPosition.current.set(...position)
    targetLook.current.set(...target)
    if (view === 'interior') {
      const direction = targetLook.current.clone().sub(targetPosition.current).normalize()
      yaw.current = Math.atan2(-direction.x, -direction.z)
      pitch.current = Math.asin(direction.y)
    }
    moving.current = true
    stalled.current = 0
    invalidate()
  }, [camera, framingKey, view, reset, invalidate, live])
  useEffect(() => {
    const el = gl.domElement
    // In the gallery the canvas is a picture: it takes no focus, and drags do nothing.
    el.tabIndex = live ? 0 : -1
    if (!live) return
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
  }, [camera, gl, view, invalidate, live])
  // Ends an orbit's damped glide once it is no longer visible, so the view comes to rest (and its
  // settle run ends) promptly. Runs after OrbitControls' own update.
  const glide = useRef({ dragging: false, position: new Vector3(), quaternion: new Quaternion() })
  useFrame(() => {
    if (!live) return
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
    if (!orbit?.enabled || last.dragging || moving.current || orbit.autoRotate) return
    if (pixels > 0 && settleGlide(orbit, pixels)) invalidate()
  })
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), [])
  useFrame((_, delta) => {
    if (!moving.current || !live) return
    // R3F's first delta after an idle stretch is the whole idle time, which made a transition
    // jump in one frame instead of easing; a frame never advances it more than 1/30 s.
    const t = reducedMotion.matches ? 1 : 1 - Math.exp(-Math.min(delta, 1 / 30) * 5)
    const before = camera.position.distanceTo(targetPosition.current)
    camera.position.lerp(targetPosition.current, t)
    const orbit = controls.current && view !== 'interior' ? controls.current : null
    if (orbit) orbit.target.lerp(targetLook.current, t)
    if (
      camera.position.distanceTo(targetPosition.current) < 0.015 &&
      (!orbit || orbit.target.distanceTo(targetLook.current) < 0.015)
    ) {
      // Land exactly, so the view is the same each time.
      camera.position.copy(targetPosition.current)
      orbit?.target.copy(targetLook.current)
      moving.current = false
    }
    if (orbit) orbit.update()
    else camera.lookAt(targetLook.current)
    // Measured after the controls' update, which is what holds the camera at the orbit limits.
    const after = camera.position.distanceTo(targetPosition.current)
    // The orbit limits (a framing distance beyond them on a narrow screen) or auto-rotation can
    // keep the camera from making the progress the easing asked for: stop instead of rendering
    // forever. Sliding around the minimum-distance sphere is progress the straight-line measure
    // undercounts, so it never counts as held.
    const pinned = !!orbit && orbit.getDistance() <= orbit.minDistance + 1e-3
    stalled.current = !pinned && after > before - 0.5 * t * before ? stalled.current + 1 : 0
    if (stalled.current >= 8) moving.current = false
    invalidate()
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={live && view !== 'interior'}
      enablePan={false}
      {...ORBIT_LIMITS}
      autoRotate={live && autoRotate && view === 'exterior'}
      autoRotateSpeed={0.45}
      dampingFactor={DAMPING}
      onStart={() => {
        moving.current = false
        glide.current.dragging = true
        if (controls.current) controls.current.dampingFactor = DAMPING
      }}
      onEnd={() => {
        glide.current.dragging = false
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
  camera = [0.48, 0.24, 0.84],
  autoRotate,
  quality,
  trace,
  mode,
  angle,
  covered,
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
  /** The direction of the front three-quarter view: the build's own. */
  camera?: [number, number, number]
  autoRotate: boolean
  quality: Quality
  /** Render path-traced stills, in the cloud or where WebGPU allows. */
  trace: boolean
  /** The gallery of stills (the canvas hidden under them), or the live 360° view. */
  mode: 'gallery' | 'live'
  /** The gallery angle on the stage: in the gallery the camera stands at its pose. */
  angle: AngleId
  /** A still covers the canvas: nothing need be drawn for the visitor. */
  covered: boolean
  /** Called with null when the scene can no longer capture (it unmounted or lost its renderer). */
  onCaptureReady: (capture: Capture | null) => void
  onFallback: () => void
  onBackend?: (backend: Backend) => void
  onSlow?: () => void
}) {
  const look = useMemo(
    () => skyLook(config.environment, config.time),
    [config.environment, config.time],
  )
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
          <CameraRig
            config={config}
            view={view}
            reset={reset}
            direction={camera}
            autoRotate={autoRotate}
            angle={angle}
            gallery={mode === 'gallery'}
          />
          <InteriorProbe config={config} quality={quality} />
          <SiteProbe config={config} quality={quality} />
          <RenderEffects
            active={active}
            quality={quality}
            trace={trace}
            look={look}
            config={config}
            view={view}
            dimensions={dimensions}
            mode={mode}
            angle={angle}
            hero={camera}
            covered={covered}
            onCaptureReady={onCaptureReady}
            onSlow={onSlow}
          />
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
