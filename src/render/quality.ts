/** Shell-safe policies; browser capability presence alone is not a benchmark. */
export type Quality = 'ultra' | 'high' | 'lite'
export type Backend = 'webgpu' | 'webgl2'
export type QualityMode = 'auto' | Quality
export type DeviceProfile = {
  backend?: Backend
  hardware: 'unknown' | 'software' | 'constrained' | 'capable'
  maxTextureSize: number
  memoryBudgetMB: number
}
const searchString = () => (typeof window === 'undefined' ? '' : window.location.search)

/** `?renderer=webgl` forces the WebGL 2 backend, useful for comparing or working around drivers. */
export function requestedBackend(search = searchString()): Backend | null {
  const value = new URLSearchParams(search).get('renderer')
  return value === 'webgl' || value === 'webgl2' ? 'webgl2' : value === 'webgpu' ? 'webgpu' : null
}

export function requestedQuality(search = searchString()): Quality | null {
  const value = new URLSearchParams(search).get('quality')
  return value === 'ultra' || value === 'high' || value === 'lite' ? value : null
}
export function initialAutoQuality(profile?: DeviceProfile): Quality {
  return profile?.backend && profile.hardware === 'capable' ? 'high' : 'lite'
}
/** The width argument remains for compatibility, but never selects GPU quality. */
export function defaultQuality(
  _width?: number,
  search = searchString(),
  profile?: DeviceProfile,
): Quality {
  return requestedQuality(search) ?? initialAutoQuality(profile)
}

export const QUALITY_DETAILS: Record<Quality, string> = {
  ultra: 'Explicit Ultra: screen-space global illumination, temporal anti-aliasing, AO and bloom.',
  high: 'Ambient occlusion, temporal anti-aliasing, and bloom on supported hardware.',
  lite: 'Conservative compatibility mode: multisampled direct rendering with reduced reflection budgets.',
}

export type QualityGovernor = {
  tier: Quality
  mode: QualityMode
  warmup: number
  samples: number[]
  slowWindows: number
  cooldownUntil: number
}
export function createQualityGovernor(tier: Quality, mode: QualityMode = 'auto'): QualityGovernor {
  return { tier, mode, warmup: 30, samples: [], slowWindows: 0, cooldownUntil: 0 }
}
export function resetQualitySampling(state: QualityGovernor): QualityGovernor {
  return { ...state, warmup: 30, samples: [], slowWindows: 0 }
}
/** Active delivered intervals only; no upshift until a separate measured policy is ratified. */
export function sampleQuality(
  state: QualityGovernor,
  ms: number,
  now: number,
  active = true,
): QualityGovernor {
  if (!active || !Number.isFinite(ms) || ms <= 0 || ms > 2000) return resetQualitySampling(state)
  if (state.mode !== 'auto' || state.tier === 'lite') return state
  if (state.warmup > 0) return { ...state, warmup: state.warmup - 1 }
  if (now < state.cooldownUntil) return state
  const samples = [...state.samples, ms]
  if (samples.length < 60) return { ...state, samples }
  const median = samples.sort((a, b) => a - b)[30]
  const slow = median > (state.tier === 'ultra' ? 34 : 45)
  const slowWindows = slow ? state.slowWindows + 1 : 0
  if (slowWindows < 3) return { ...state, samples: [], slowWindows }
  return {
    ...createQualityGovernor(state.tier === 'ultra' ? 'high' : 'lite', state.mode),
    cooldownUntil: now + 15000,
  }
}
