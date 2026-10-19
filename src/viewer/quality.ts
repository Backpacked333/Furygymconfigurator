/**
 * Rendering tiers, device detection, and backend selection. Deliberately free of three.js imports
 * so an app shell can use it without pulling the 3D bundle into the initial load.
 */
export type Quality = 'ultra' | 'high' | 'lite'
export type Backend = 'webgpu' | 'webgl2'

/** `?renderer=webgl` forces the WebGL 2 backend, useful for comparing or working around drivers. */
export function requestedBackend(search = window.location.search): Backend | null {
  const value = new URLSearchParams(search).get('renderer')
  return value === 'webgl' || value === 'webgl2' ? 'webgl2' : value === 'webgpu' ? 'webgpu' : null
}

/** `?quality=` pins a tier: the governor then never changes it. */
export function requestedQuality(search = window.location.search): Quality | null {
  const value = new URLSearchParams(search).get('quality')
  return value === 'ultra' || value === 'high' || value === 'lite' ? value : null
}

/** What the browser says about the device, before a single frame is drawn. */
export type DeviceSignals = {
  /** Primary pointer is coarse (a finger): phones and tablets. */
  coarsePointer: boolean
  /** Device memory in GB (Chromium only; rounded down, capped at 8). */
  memory?: number
  cores?: number
  saveData?: boolean
}

export function readDeviceSignals(): DeviceSignals {
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { saveData?: boolean }
  }
  return {
    coarsePointer:
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches &&
      !window.matchMedia('(any-pointer: fine)').matches,
    memory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    saveData: nav.connection?.saveData,
  }
}

/** A device that should never start above Lite: phones, tablets, and low-end laptops. */
export function isConstrained(d: DeviceSignals) {
  return (
    d.coarsePointer ||
    !!d.saveData ||
    (d.memory !== undefined && d.memory <= 4) ||
    (d.cores !== undefined && d.cores <= 4)
  )
}

/**
 * Starting tier: `?quality=` wins, otherwise the device decides, never the screen size. Ultra is
 * never a starting tier: it is chosen, or (where a product allows it) earned (see governor.ts).
 */
export function defaultQuality(
  device: DeviceSignals = readDeviceSignals(),
  search = window.location.search,
): Quality {
  return requestedQuality(search) ?? (isConstrained(device) ? 'lite' : 'high')
}

export const QUALITY_DETAILS: Record<Quality, string> = {
  ultra:
    'Ambient occlusion, global illumination, temporal anti-aliasing and bloom. Heavier to load and draw: for fast graphics cards.',
  high: 'Sharp multisampled rendering at up to 1.5× pixel density. Fast on any laptop or desktop.',
  lite: 'Multisampled rendering at native resolution, for phones, tablets and older devices.',
}
