/**
 * viewer360, 3D entry: the renderer, pipelines, and the React Three Fiber components. Load it
 * lazily (behind `React.lazy` or a dynamic import); the light entry has everything before that.
 */
export {
  FRAME_BEGIN,
  FRAME_ENVIRONMENT,
  backendOf,
  beginFrame,
  createRenderer,
  gpuKey,
  shareInstancedShaders,
  stopIdleLoop,
} from './renderer'
export { createMotionPipeline, createPipeline, type Pipeline } from './pipeline'
export { invalidateShadows, refreshShadows, shadowsPending } from './shadows'
export { TierProvider, Viewer } from './Viewer'
export { useTier, type TierContext } from './tierContext'
export { RenderLoop, REFINE_AFTER_MS } from './RenderLoop'
export { OrbitRig, DAMPING, type CameraPose, type OrbitLimits, type Vec3 } from './OrbitRig'
export { CubeProbe } from './CubeProbe'
export { cubeSize, reusable } from './cube'
