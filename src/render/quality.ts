/**
 * Rendering tiers and backend selection. Deliberately free of three.js imports so the app shell
 * can use it without pulling the 3D bundle into the initial load.
 */
export type Quality = 'ultra' | 'high' | 'lite'
export type Backend = 'webgpu' | 'webgl2'

/** `?renderer=webgl` forces the WebGL 2 backend, useful for comparing or working around drivers. */
export function requestedBackend(search = window.location.search): Backend | null {
  const value = new URLSearchParams(search).get('renderer')
  return value === 'webgl' || value === 'webgl2' ? 'webgl2' : value === 'webgpu' ? 'webgpu' : null
}

/**
 * Starting tier: `?quality=` wins, otherwise the viewport and device decide. Ultra (screen-space
 * GI) is opt-in: a wide window says nothing about the GPU behind it, and starting integrated
 * graphics on Ultra made the view stutter and lose the GPU device. Users can change it later.
 */
export function defaultQuality(
  width = window.innerWidth,
  search = window.location.search,
  memoryGB = (navigator as { deviceMemory?: number }).deviceMemory,
): Quality {
  const requested = new URLSearchParams(search).get('quality')
  if (requested === 'ultra' || requested === 'high' || requested === 'lite') return requested
  if (memoryGB !== undefined && memoryGB < 4) return 'lite'
  return width >= 700 ? 'high' : 'lite'
}

export const QUALITY_DETAILS: Record<Quality, string> = {
  ultra: 'Screen-space global illumination, ambient occlusion, temporal anti-aliasing, bloom.',
  high: 'Ambient occlusion, temporal anti-aliasing, and bloom.',
  lite: 'Multisampled direct rendering for older or battery-powered devices.',
}
