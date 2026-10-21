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
  /** The first image's crossfade from the raster frame: short, so the first gain shows at once. */
  firstFadeMs: number
  /**
   * GPU time per submitted batch of samples, and the most passes one may hold: `batchMs` while a
   * view is new, `rest` once it has traced `rest.afterMs` undisturbed (null: never larger).
   */
  batchMs: number
  maxPasses: number
  rest: { afterMs: number; batchMs: number; maxPasses: number } | null
  /**
   * Samples a pixel of the design's own Cycles image stands for, where the view opens on it
   * (ProgressiveRenderer `entry`). Few: real samples outweigh them within a second, so whatever
   * the image and the trace disagree on fades instead of persisting.
   */
  cyclesSeedSamples: number
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
  const pacing = { fadeMs: 260, firstFadeMs: 120, batchMs: 12, maxPasses: 8 }
  return quality === 'lite'
    ? // Phones keep their batches small throughout: a long trace there is a warm one.
      { samples: 128, maxBounces: 4, ...CYCLES_CLAMPS, ...pacing, rest: null, cyclesSeedSamples: 8 }
    : {
        samples: 1024,
        maxBounces: 7,
        ...CYCLES_CLAMPS,
        ...pacing,
        // A pass is one bounce of up to 262144 paths: a fast GPU does many in a frame's time, and
        // the batch's time, not its passes, is what keeps a press answered.
        maxPasses: 32,
        // After a second at rest the raster draws nothing, so batches may take two frames' time:
        // a press then waits at most that one batch, about 24 ms, before the view answers.
        rest: { afterMs: 1000, batchMs: 24, maxPasses: 64 },
        cyclesSeedSamples: 16,
      }
}

/**
 * `?firstImage=8` denoises a resting view's first image at 8 samples, as before early images, to
 * compare the two on a device. Anything else keeps the early ones (pathtrace.ts EARLY_MILESTONES).
 */
export function earlyImages(search = window.location.search) {
  return new URLSearchParams(search).get('firstImage') !== '8'
}

/**
 * The live trace's random numbers: Sobol scrambled per pixel (pathtrace.ts `random`), or
 * `?sampler=blue` for the tracer's default blue-noise dither, to compare.
 */
export function liveSampler(search = window.location.search): 'blue' | 'sobol' {
  return new URLSearchParams(search).get('sampler') === 'blue' ? 'blue' : 'sobol'
}

/** `?cyclesSeed=0` starts the first trace without the design's Cycles image, to compare. */
export function cyclesSeed(search = window.location.search) {
  return new URLSearchParams(search).get('cyclesSeed') !== '0'
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
  msPerMegapixelSample: number | null = null,
  floor = MIN_BUDGET_SCALE,
) {
  if (quality === 'lite') return 0.5
  if (requested !== null) return requested
  const pixels = width * height
  const cap = Math.min(REFERENCE_PIXELS, budgetPixels(msPerMegapixelSample))
  return pixels > cap ? Math.max(floor, Math.sqrt(cap / pixels)) : 1
}

/**
 * "Fast and stable": a resting view shows a clean image (CLEAN_SAMPLES, denoised) within
 * CLEAN_MS of starting, and stops changing within about SETTLE_MS. A device's measured cost of a
 * sample sets the pixels traced so the first holds (budgetPixels), and its measured rate the
 * samples it settles at (settleSamples). Fast GPUs keep the full Cycles resolution and target.
 */
export const CLEAN_SAMPLES = 16
export const CLEAN_MS = 2500
export const SETTLE_MS = 12000
/** Never below half the canvas's resolution across: past that the denoiser cannot hide it. */
export const MIN_BUDGET_SCALE = 0.5

/** The most pixels a device that takes `msPerMegapixelSample` can trace CLEAN_SAMPLES of in CLEAN_MS. */
export function budgetPixels(msPerMegapixelSample: number | null) {
  if (!msPerMegapixelSample || !Number.isFinite(msPerMegapixelSample) || msPerMegapixelSample <= 0)
    return Infinity
  return (CLEAN_MS / CLEAN_SAMPLES / msPerMegapixelSample) * 1e6
}

/** Samples a view gaining `samplesPerSecond` settles at: what SETTLE_MS buys, within `least`–1024. */
export function settleSamples(samplesPerSecond: number, least = 64) {
  return Math.min(1024, Math.max(least, Math.floor(samplesPerSecond * (SETTLE_MS / 1000))))
}

/**
 * How a device traces, from what a sample costs it at full depth (7 bounces, ms per
 * megapixel-sample, traceRate.ts), measured at the Cycles cap (REFERENCE_PIXELS):
 * - fast: a clean image (CLEAN_SAMPLES) there within CLEAN_MS;
 * - decent: within DECENT_CLEAN_MS;
 * - slow: slower, so it traces light (LIGHT);
 * - unknown: not measured yet (a first visit).
 */
export type DeviceTier = 'fast' | 'decent' | 'slow' | 'unknown'
export const DECENT_CLEAN_MS = 20000

export function deviceTier(fullDepthCost: number | null): DeviceTier {
  if (fullDepthCost === null || !Number.isFinite(fullDepthCost) || fullDepthCost <= 0)
    return 'unknown'
  const clean = (fullDepthCost * REFERENCE_PIXELS * CLEAN_SAMPLES) / 1e6
  return clean <= CLEAN_MS ? 'fast' : clean <= DECENT_CLEAN_MS ? 'decent' : 'slow'
}

/**
 * Light budget mode, for slow GPUs: four bounces (Cycles' 3) instead of seven, down to 0.35 of the
 * canvas across, settling at what SETTLE_MS buys even if that is only 16 samples. Stable within
 * seconds there, at somewhat softer light.
 */
export const LIGHT = { maxBounces: 4, floor: 0.35, leastSettle: 16 } as const

/**
 * The quality upgrade, for fast and decent GPUs: once a view has settled (at what SETTLE_MS buys)
 * and rested UPGRADE_REST_MS more, it refines on to what UPGRADE_MS more buys at the rate it was
 * gaining, up to 1024 samples, crossfading each sharper image in as before. Only where that at
 * least doubles its samples; slow GPUs stay settled and idle.
 */
export const UPGRADE_REST_MS = 1000
export const UPGRADE_MS = 45000

/** The samples a settled view refines on to, or null where the upgrade is not worth it. */
export function upgradeTarget(tier: DeviceTier, samplesPerSecond: number | null, settled: number) {
  if ((tier !== 'fast' && tier !== 'decent') || !samplesPerSecond || settled >= 1024) return null
  const target = Math.min(1024, settled + Math.floor(samplesPerSecond * (UPGRADE_MS / 1000)))
  return target >= 2 * settled ? target : null
}
