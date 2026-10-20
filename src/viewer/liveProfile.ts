import type { Quality } from '../render/quality'

/** How hard the 360° view refines a resting view, per quality tier. */
export type LiveProfile = {
  /** Samples per pixel a resting view refines toward. */
  samples: number
  maxBounces: number
  /** Traced resolution relative to the canvas; the presentation filters it back up. */
  renderScale: number
  /** Crossfade between successive denoised images, in milliseconds. */
  fadeMs: number
}

/**
 * Six bounces is what the stills and the Cycles worker trace: ten added nothing a denoised image
 * shows, at about half again the cost of a sample. Lite (phones, narrow windows) refines too, on a
 * budget: a quarter of the pixels and fewer samples, so a resting view settles in seconds there.
 */
export function liveProfile(quality: Quality): LiveProfile {
  return quality === 'lite'
    ? { samples: 128, maxBounces: 4, renderScale: 0.5, fadeMs: 260 }
    : { samples: 1024, maxBounces: 6, renderScale: 1, fadeMs: 260 }
}
