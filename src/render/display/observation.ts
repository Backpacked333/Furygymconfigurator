import type { DisplayReadyPart } from '../../display/session'

/** Opt-in only. Each object captures a revision AND resource epoch, never a mutable latest id. */
export interface RigObservation {
  readonly revision: number
  readonly signal: AbortSignal
  active(): boolean
  permitted(part: 'environment' | 'interior-probe' | 'site-probe'): boolean
  invalidate(part: DisplayReadyPart): void
  complete(part: DisplayReadyPart): void
  fail(error: unknown): void
}
