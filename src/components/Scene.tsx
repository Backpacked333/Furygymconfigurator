import { memo, useCallback, useMemo } from 'react'
import { Html } from '@react-three/drei'
import type { WebGPURenderer } from 'three/webgpu'
import { TIERS, type Backend, type Quality, type Verdict } from '@fury/viewer360'
import {
  OrbitRig,
  RenderLoop,
  Viewer,
  backendOf,
  gpuKey,
  type CameraPose,
} from '@fury/viewer360/3d'
import { distance, productHeight, type Config, type Unit } from '../lib/config'
import { effectiveLights } from '../lib/lighting'
import { CAMERA_PRESETS, coverFov, stillPose, type AngleId } from '../lib/cameras'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'
import { SceneRefresh } from './SceneRefresh'
import { Atmosphere } from './Atmosphere'
import { InteriorProbe } from './InteriorProbe'
import { Prewarm } from './Prewarm'
import { TextureUpgrade } from './TextureUpgrade'
import { restoreTextures, setMaxAnisotropy } from '../render/materials'
import { SceneLoadingStatus } from './SceneLoading'

/** Orbit limits around a unit: never inside it, never below the ground. */
const LIMITS = {
  minDistance: 12,
  maxDistance: 170,
  minPolarAngle: 0.1,
  maxPolarAngle: Math.PI / 2 - 0.015,
}
const LABEL =
  'Interactive 360 view. Arrow keys rotate; plus and minus zoom. Inside: arrows look around.'

function GraphicsFallback({ onFallback }: { onFallback: () => void }) {
  return (
    <div className="graphics-fallback">
      <strong>Your design is still here.</strong>
      <p>
        3D graphics aren’t available in this browser. All configuration, pricing, and floor-plan
        tools still work.
      </p>
      <button className="primary" onClick={onFallback}>
        Open the floor plan
      </button>
    </div>
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
        <span className="dimension-label">{distance(productHeight(c), unit)} high</span>
      </Html>
    </group>
  )
}
/**
 * The Fury product on the viewer360 framework: the unit, its surroundings, and its lighting,
 * framed by the still presets. Memoized: the app shell re-renders for panel tabs, toasts, and
 * dialogs, which never change the scene; re-rendering it would still reconcile the whole 3D tree.
 */
export default memo(function Scene({
  active,
  config,
  angle,
  interactive,
  dimensions,
  unit,
  reset,
  autoRotate,
  quality,
  promote = false,
  onCaptureReady,
  onFallback,
  onBackend,
  onGpu,
  onVerdict,
  onUnavailable,
}: {
  /** False while hidden under the floor plan: nothing renders until the scene shows again. */
  active: boolean
  config: Config
  /** The still the camera starts from (and stays at, unless interactive). */
  angle: AngleId
  /** The 360 view: orbit outside, look around inside. Otherwise the camera holds the still. */
  interactive: boolean
  dimensions: boolean
  unit: Unit
  reset: number
  autoRotate: boolean
  quality: Quality
  /** Whether this device may be promoted to the next tier when it proves fast. */
  promote?: boolean
  onCaptureReady: (capture: (() => string) | null) => void
  onFallback: () => void
  onBackend?: (backend: Backend) => void
  /** This GPU's name, to remember the tier it settles on. */
  onGpu?: (key: string) => void
  onVerdict?: (verdict: Exclude<Verdict, null>) => void
  /** 3D graphics failed for good in this browser (no WebGPU or WebGL, or a lost device). */
  onUnavailable?: () => void
}) {
  const view = CAMERA_PRESETS[angle].view
  // The scene draws the lights as they are seen: always on by day, by choice after dark.
  const lights = effectiveLights(config)
  config = useMemo(() => ({ ...config, lights }), [config, lights])
  // Only these inputs move the camera; a finish or flooring change must not re-frame the view.
  const { family, length, addons } = config
  const pose = useMemo<CameraPose>(
    () => stillPose({ family, length, addons }, angle),
    [family, length, addons, angle],
  )
  const onRenderer = useCallback(
    (renderer: WebGPURenderer) => {
      setMaxAnisotropy(renderer.getMaxAnisotropy())
      onBackend?.(backendOf(renderer))
      onGpu?.(gpuKey(renderer))
    },
    [onBackend, onGpu],
  )
  return (
    <>
      <Viewer
        active={active}
        quality={quality}
        // Scans uploaded by a previous renderer released their decoded pixels; no frame may see
        // a released map, so they are restored before the first one.
        prepare={restoreTextures}
        onRenderer={onRenderer}
        onUnavailable={onUnavailable}
        fallback={<GraphicsFallback onFallback={onFallback} />}
      >
        <Atmosphere config={config} quality={quality} view={view} />
        <Landscape config={config} quality={quality} />
        <StudioModel config={config} quality={quality} />
        {dimensions && <Dimensions config={config} unit={unit} />}
        <OrbitRig
          pose={pose}
          mode={view === 'interior' ? 'look' : 'orbit'}
          interactive={interactive}
          reset={reset}
          autoRotate={autoRotate}
          limits={LIMITS}
          fitFov={coverFov}
          label={LABEL}
        />
        <InteriorProbe config={config} />
        <Prewarm config={config} />
        <TextureUpgrade enabled={interactive} />
        <RenderLoop
          quality={quality}
          spec={TIERS[quality]}
          interactive={interactive}
          promote={promote}
          onCaptureReady={onCaptureReady}
          onVerdict={onVerdict}
        />
        <SceneRefresh
          active={active}
          config={config}
          view={view}
          interactive={interactive}
          dimensions={dimensions}
          unit={unit}
          quality={quality}
          autoRotate={autoRotate}
        />
      </Viewer>
      <SceneLoadingStatus />
    </>
  )
})
