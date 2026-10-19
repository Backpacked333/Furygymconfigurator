/**
 * viewer360, light entry: everything an app shell needs before (or without) 3D. Free of three.js,
 * so importing it never pulls the 3D bundle into the first load. The renderer, pipelines, and
 * React components live in `@fury/viewer360/3d`, meant to be loaded lazily.
 */
export {
  QUALITY_DETAILS,
  defaultQuality,
  isConstrained,
  readDeviceSignals,
  requestedBackend,
  requestedQuality,
  type Backend,
  type DeviceSignals,
  type Quality,
} from './quality'
export { STILL_TIER, TIERS, type TierSpec } from './tiers'
export {
  DEMOTE_ABOVE,
  FrameGovernor,
  PROMOTE_BELOW,
  lower,
  tierMemory,
  type FrameKind,
  type Verdict,
} from './governor'
export { Convergence } from './convergence'
export {
  sceneChanges,
  sceneProgress,
  sceneWork,
  textureProgress,
  viewerMotion,
  type SceneChange,
  type ScenePhase,
} from './progress'
export { whenIdle } from './idle'
export { useAdaptiveQuality, type QualityChange } from './useAdaptiveQuality'
export { preloadViewer } from './preload'
export { perf, perfEnabled, type PerfSnapshot } from './perf'
export { PerfHud } from './PerfHud'
