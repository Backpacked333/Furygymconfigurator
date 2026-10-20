/**
 * Median interval between back-to-back raster frames of a moving 360° view, in milliseconds, above
 * which Ultra drops its screen-space GI and reflections: 25 fps. It sits above a 30 Hz display's
 * own 33 ms, so a capped display (a laptop or tablet saving power) never trips it by its cap alone.
 * A judgment call without device data: too tight costs one rebuild at rest, too loose never trips.
 */
export const MOVING_FRAME_BUDGET_MS = 40
/** Intervals behind each verdict: under half a second of motion at 60 Hz. */
export const GUARD_SAMPLES = 24
/**
 * Intervals ignored after a change (a pipeline built, an edit, scans arriving, a press or release
 * of the pointer): their frames compile shaders, upload textures or drain the trace's last GPU work.
 */
export const GUARD_SKIP = 8

/**
 * Watches how fast the live view draws while it moves. Only the interval between two consecutive
 * moving frames counts: a frame at rest, or one that stops a trace or carries an edit, breaks the
 * chain, so neither it nor the frame after it (whose interval still holds that pause or that work)
 * is measured. Each verdict takes the median of its window, so a hitch or a pause mid-drag among
 * smooth frames never trips it.
 */
export class FrameGuard {
  private last = -1
  private skipping: number
  private samples: number[] = []

  constructor(
    readonly budgetMs = MOVING_FRAME_BUDGET_MS,
    readonly count = GUARD_SAMPLES,
    readonly skip = GUARD_SKIP,
  ) {
    this.skipping = skip
  }

  /** Something changed: the next `skip` intervals are not representative. Samples so far stay. */
  change() {
    this.skipping = this.skip
  }

  /**
   * A raster frame drawn at `now`, `moving` if it is part of a steady move. True when this frame
   * completes a window whose median interval is over the budget.
   */
  frame(now: number, moving: boolean): boolean {
    const last = this.last
    this.last = moving ? now : -1
    if (!moving || last < 0) return false
    if (this.skipping > 0) {
      this.skipping--
      return false
    }
    this.samples.push(now - last)
    if (this.samples.length < this.count) return false
    const sorted = this.samples.sort((a, b) => a - b)
    this.samples = []
    return sorted[sorted.length >> 1] > this.budgetMs
  }
}
