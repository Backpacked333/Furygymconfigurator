import type { SceneChange } from './progress'

/**
 * How many more frames the rest pipeline draws before the picture counts as converged. A camera
 * move or a content change starts a full run; a texture, probe, or environment arriving mid-run
 * only makes sure enough frames remain to absorb it (half a run), instead of starting over, so a
 * stream of late arrivals never keeps the GPU busy long after the picture stopped changing.
 */
export class Convergence {
  remaining = 0
  constructor(public frames: number) {}

  restart() {
    this.remaining = this.frames
  }

  change(change: SceneChange | 'camera') {
    if (change === 'camera' || change === 'content') this.restart()
    else this.remaining = Math.max(this.remaining, Math.ceil(this.frames / 2))
  }

  /** Counts a drawn frame; true while more frames are needed. */
  drawn() {
    this.remaining = Math.max(0, this.remaining - 1)
    return this.remaining > 0
  }

  get settling() {
    return this.remaining > 0
  }
}
