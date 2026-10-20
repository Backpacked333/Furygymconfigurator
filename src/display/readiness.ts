import { DISPLAY_PROFILES } from './contract'
import { DISPLAY_READY_PARTS, type DisplayReadyPart } from './session'

/** Pure revision fence, NOT a probe/resource detector. Renderer must report actual applied work.
 * Each callback captures the revision at scheduling time; it must never read the latest revision.
 * A session owns one gate, but every accepted design starts an empty epoch. */
export class DisplayReadiness {
  private revision = 0
  private completed = new Set<DisplayReadyPart>()
  private changedAt = 0
  private lastNow = 0
  private frames = 0
  private totalFrames = 0
  private poisoned = false
  begin(revision: number, now: number) {
    if (this.poisoned || !Number.isSafeInteger(revision) || revision <= this.revision)
      throw new Error('Invalid display readiness revision.')
    this.checkTime(now)
    this.revision = revision
    this.completed.clear()
    this.changedAt = now
    this.frames = this.totalFrames = 0
  }
  private checkTime(now: number) {
    if (!Number.isFinite(now) || now < this.lastNow)
      throw new Error('Non-monotonic display readiness clock.')
    this.lastNow = now
  }
  private accepts(revision: number, now: number) {
    if (this.poisoned) throw new Error('Poisoned display readiness gate.')
    if (this.revision === 0 || revision !== this.revision) return false
    this.checkTime(now)
    return true
  }
  invalidate(part: DisplayReadyPart, revision: number, now: number) {
    if (!this.accepts(revision, now)) return false
    this.completed.delete(part)
    this.changedAt = now
    this.frames = 0
    return true
  }
  complete(part: DisplayReadyPart, revision: number, now: number) {
    if (!this.accepts(revision, now)) return false
    if (!DISPLAY_READY_PARTS.includes(part)) throw new Error('Unknown display readiness component.')
    if (!this.completed.has(part)) {
      this.completed.add(part)
      this.changedAt = now
      this.frames = 0
    }
    return true
  }
  frame(revision: number, now: number) {
    if (!this.accepts(revision, now)) return false
    if (++this.totalFrames > DISPLAY_PROFILES.wide.maxFrames) {
      this.poison()
      throw new Error('Display readiness frame cap exceeded.')
    }
    if (
      this.completed.size !== DISPLAY_READY_PARTS.length ||
      now - this.changedAt < DISPLAY_PROFILES.wide.quietMs
    )
      return false
    this.frames++
    return (
      this.frames >= DISPLAY_PROFILES.wide.temporalFrames + DISPLAY_PROFILES.wide.postReadyFrames
    )
  }
  receipt() {
    if (this.poisoned || this.frames < 42) throw new Error('Display revision is not ready.')
    return {
      revision: this.revision,
      resources: 'all-current-revision' as const,
      temporalFrames: this.frames - 2,
      postReadyFrames: 2,
    }
  }
  poison() {
    this.poisoned = true
    this.completed.clear()
    this.frames = 0
  }
}
