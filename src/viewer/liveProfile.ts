import type { Quality } from '../render/quality'

/** How hard the 360° view refines a resting view, per quality tier. */
export type LiveProfile = {
  /** Samples per pixel a resting view refines toward. */
  samples: number
  /** Shaded vertices a path may have, the camera's hit included: Cycles' max_bounces + 1. */
  maxBounces: number
  /** Cycles' sample_clamp_direct and sample_clamp_indirect (0 disables either). */
  clampDirect: number
  clampIndirect: number
  /** Crossfade between successive denoised images, in milliseconds. */
  fadeMs: number
}

/**
 * The gallery's Cycles recipe (render-server/fury_render/blender.py _setup_render): its clamps,
 * named here rather than left to the tracer's defaults, which happen to be the same.
 */
const CYCLES_CLAMPS = { clampDirect: 0, clampIndirect: 10 } as const

/**
 * High and Ultra trace as deep as the gallery's Cycles images. Cycles' max_bounces of 6
 * (render-server/fury_render/protocol.py BOUNCES, every per-type limit the same) counts bounces
 * after the camera's hit: 0 is direct light alone. three-gpu-pathtracer counts the camera's hit as
 * bounce 0 and stops scattering once newBounce >= maxBounces, still lighting that last vertex
 * (node_modules/three-gpu-pathtracer/src/webgpu/compute/wavefront/MaterialKernel.js), so its 1 is
 * direct light alone and Cycles' 6 is its 7. The stills keep their own 6 (pathtrace.ts).
 *
 * Lite (phones, narrow windows) refines too, on a budget: four bounces (Cycles' 3), a quarter of
 * the pixels (traceScale) and fewer samples, so a resting view settles in seconds there.
 */
export function liveProfile(quality: Quality): LiveProfile {
  return quality === 'lite'
    ? { samples: 128, maxBounces: 4, ...CYCLES_CLAMPS, fadeMs: 260 }
    : { samples: 1024, maxBounces: 7, ...CYCLES_CLAMPS, fadeMs: 260 }
}

/**
 * A library image's pixels (public/native-library, 1920×1200): all the detail the Cycles image the
 * 360° view opens on holds.
 */
export const REFERENCE_PIXELS = 1920 * 1200

/**
 * `?traceScale=0.5`–`1` pins the live trace's scale on High and Ultra, to compare speed and
 * sharpness on a device. Anything else is ignored.
 */
export function requestedTraceScale(search = window.location.search): number | null {
  const raw = new URLSearchParams(search).get('traceScale')
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0.5 && value <= 1 ? value : null
}

/**
 * The traced resolution relative to a drawing buffer of `width` × `height`. Lite traces at half.
 * High and Ultra trace at the canvas's own resolution, up to the Cycles image's pixel count: past
 * it a trace resolves nothing that image holds, while costing the square of the scale more per
 * sample and leaving no room in the history budget (historyCache.ts) for the views it keeps.
 */
export function traceScale(
  quality: Quality,
  width: number,
  height: number,
  requested = requestedTraceScale(),
) {
  if (quality === 'lite') return 0.5
  if (requested !== null) return requested
  const pixels = width * height
  return pixels > REFERENCE_PIXELS ? Math.sqrt(REFERENCE_PIXELS / pixels) : 1
}
