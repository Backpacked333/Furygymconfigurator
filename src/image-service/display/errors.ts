import type { DisplayError } from '../../display/contract'

export class DisplayServiceError extends Error {
  readonly wire: DisplayError
  constructor(
    readonly status: number,
    code: DisplayError['code'],
    message: string,
  ) {
    super(message)
    this.wire = { code, message, retryable: false }
  }
}
export const denied = () =>
  new DisplayServiceError(
    503,
    'execution-denied',
    'No available operator-provisioned local run allowance; rendering is not authorized.',
  )
export const unavailable = () =>
  new DisplayServiceError(
    503,
    'unavailable',
    'Private display candidate unavailable; no fallback is enabled.',
  )
export const capacity = () =>
  new DisplayServiceError(
    429,
    'capacity-exceeded',
    'Private display capacity exhausted; no automatic retry.',
  )
export const notFound = () =>
  new DisplayServiceError(404, 'not-found', 'Private display interest or image not found.')
export const invalidArtifact = () =>
  new DisplayServiceError(503, 'invalid-artifact', 'Private image integrity verification failed.')
