import { Component, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { WebGPURenderer } from 'three/webgpu'
import { distance, productHeight, type Config, type Unit, type View } from '../lib/config'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'
import { SceneRefresh } from './SceneRefresh'
import { Atmosphere } from './Atmosphere'
import { InteriorProbe, SiteProbe } from './InteriorProbe'
import { deckFront } from '../render/envelope'
import { GeometryReuse } from '../render/geometryReuse'
import { backendOf, createRenderer, type Backend, type Quality } from '../render/renderer'
import type { AngleId, GalleryCamera } from '../render/gallery'
import type { ArcWindow } from '../viewer/orbitWindow'
import { CameraRig } from './CameraRig'
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
/**
 * Memoized: the app shell re-renders for panel tabs, toasts, and dialogs, which never change the
 * scene; re-rendering it would still reconcile the whole 3D tree.
 */
export const SceneSurface = memo(function SceneSurface({
  active,
  config,
  view,
  dimensions,
  unit,
  reset,
  camera = [0.48, 0.24, 0.84],
  autoRotate,
  quality,
  mode,
  angle,
  effects,
  pose,
  reuseGeometry = false,
  arc,
  onFallback,
  onBackend,
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
  /** The gallery of stills (the canvas hidden under them), or the live 360° view. */
  mode: 'gallery' | 'live'
  /** The gallery angle on the stage: in the gallery the camera stands at its pose. */
  angle: AngleId
  effects: ReactNode
  /** Product adapter's exact saved-image camera, used on entry and reset. */
  pose?: GalleryCamera
  /**
   * Part lists share merged geometry across edits, so a finish or floor edit swaps materials on
   * the meshes it has (geometryReuse.ts). The live 360° view only; the stills keep rebuilding.
   */
  reuseGeometry?: boolean
  /** The live view's exterior orbit window (`?arc=`, viewer/arc.ts); the legacy route has none. */
  arc?: ArcWindow
  onFallback: () => void
  onBackend?: (backend: Backend) => void
}) {
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
            // The live view's loading screen says the scene is being built before the scene's
            // synchronous mount takes the main thread: one painted frame first.
            if (mode === 'live')
              await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
            return renderer
          }}
          onCreated={({ gl }) => onBackend?.(backendOf(gl as unknown as WebGPURenderer))}
        >
          <GeometryReuse.Provider value={reuseGeometry}>
            <Atmosphere config={config} quality={quality} view={view} />
            <Landscape config={config} quality={quality} />
            <StudioModel config={config} quality={quality} />
            {dimensions && <Dimensions config={config} unit={unit} />}
            <CameraRig
              active={active}
              pose={pose}
              arc={arc}
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
            {effects}
            <SceneRefresh
              active={active}
              config={config}
              view={view}
              dimensions={dimensions}
              unit={unit}
              quality={quality}
              autoRotate={autoRotate}
            />
          </GeometryReuse.Provider>
        </Canvas>
      )}
      <SceneLoadingStatus />
    </GraphicsBoundary>
  )
})
