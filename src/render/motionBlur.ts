/**
 * Motion blur in the 360° view (pipeline.ts, High and Ultra): while the camera moves, each frame
 * is blurred along the motion it recorded, as a film camera's 180° shutter would; once it rests,
 * the blur lets go within RELEASE_MS and is then exactly zero, so the resting frame is the
 * unblurred frame, pixel for pixel. Free of three.js imports, so the timing is tested on its own.
 */

/**
 * A 180° shutter: open for half of each frame, so a moving edge streaks over half the distance it
 * moved since the frame before.
 */
export const SHUTTER = 0.5
/** How long the blur takes to let go once the camera rests. */
export const RELEASE_MS = 120
/** Taps along each pixel's motion. */
export const BLUR_SAMPLES = 12
/**
 * The longest streak, as a fraction of the screen: a flick of the orbit can move the picture by
 * a third of the frame between two frames, and 12 taps spread over that would show as separate
 * copies rather than a blur.
 */
export const MAX_STREAK = 0.035

/**
 * The shutter `sinceMotion` milliseconds after the camera last moved: open while it moves, eased
 * shut over RELEASE_MS, and exactly 0 from then on (and when it never moved).
 */
export function shutterAfter(sinceMotion: number) {
  if (!(sinceMotion < RELEASE_MS)) return 0
  if (sinceMotion <= 0) return SHUTTER
  const t = 1 - sinceMotion / RELEASE_MS
  return SHUTTER * t * t * (3 - 2 * t)
}

/**
 * The shutter frame by frame, from whether the camera moved since the frame before. A camera
 * placed rather than moved (a cut: entering the 360° view, a new angle) is not motion: `cut` keeps
 * the next frame sharp.
 */
export class MotionShutter {
  private lastMotion = -Infinity
  /** The shutter for a frame drawn at `now` (ms); `moved`: the camera moved since the last one. */
  frame(now: number, moved: boolean) {
    if (moved) this.lastMotion = now
    return shutterAfter(now - this.lastMotion)
  }
  /** The camera was placed, not moved: nothing to blur until it next moves. */
  cut() {
    this.lastMotion = -Infinity
  }
}
