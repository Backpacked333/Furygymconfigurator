import { DisplayReadiness } from '../../display/readiness'
import { DISPLAY_READY_PARTS, type DisplayReadyPart } from '../../display/session'
import type { RigObservation } from './observation'

/** CPU-testable fence around real rig callbacks. Subepochs invalidate late work within a revision. */
export class RevisionResources {
  readonly gate = new DisplayReadiness()
  private revision = 0
  private epoch = 0
  private controller = new AbortController()
  private ready = new Set<DisplayReadyPart>()
  private failure: unknown
  constructor(private readonly now = () => performance.now()) {}
  begin(revision: number) {
    this.gate.begin(revision, this.now())
    this.revision = revision
    return this.restart()
  }
  restart(): RigObservation {
    this.controller.abort()
    this.controller = new AbortController()
    const epoch = ++this.epoch,
      revision = this.revision,
      signal = this.controller.signal
    this.ready.clear()
    for (const part of DISPLAY_READY_PARTS) this.gate.invalidate(part, revision, this.now())
    const active = () => !signal.aborted && epoch === this.epoch && !this.failure
    return {
      revision,
      signal,
      active,
      // Even environment/site PMREM samples siteAmbient: never capture the previous field.
      permitted: (part) =>
        active() &&
        this.ready.has('react-commit') &&
        this.ready.has('materials') &&
        this.ready.has('site-field') &&
        (part === 'environment' || this.ready.has('environment')),
      invalidate: (part) => {
        if (!active()) return
        this.ready.delete(part)
        this.gate.invalidate(part, revision, this.now())
        if (part !== 'pipeline-warm') {
          this.ready.delete('pipeline-warm')
          this.gate.invalidate('pipeline-warm', revision, this.now())
        }
      },
      complete: (part) => {
        if (!active()) return
        this.ready.add(part)
        this.gate.complete(part, revision, this.now())
      },
      fail: (error) => {
        if (active()) this.poison(error)
      },
    }
  }
  has(part: DisplayReadyPart) {
    return this.ready.has(part)
  }
  resourcesReady() {
    return DISPLAY_READY_PARTS.filter((p) => p !== 'pipeline-warm').every((p) => this.ready.has(p))
  }
  frame() {
    this.check()
    return this.gate.frame(this.revision, this.now())
  }
  check() {
    if (this.failure) throw new Error('Display resource epoch poisoned.', { cause: this.failure })
  }
  poison(error: unknown) {
    this.failure = error || new Error('Display resources closed.')
    this.controller.abort()
    this.gate.poison()
  }
  finish() {
    this.controller.abort()
  }
}
