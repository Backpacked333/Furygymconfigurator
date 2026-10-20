import type { LocalRenderError } from './localRenderProtocol'

export class LocalRenderServiceError extends Error {
  readonly wireError: LocalRenderError
  constructor(
    readonly status: number,
    code: LocalRenderError['code'],
    message: string,
  ) {
    super(message)
    this.wireError = { code, message, retryable: false }
  }
}
export const localUnavailable = () =>
  new LocalRenderServiceError(
    503,
    'unavailable',
    'Local real preview unavailable. No mock, historical image or fallback render was substituted.',
  )
export const localCapacity = () =>
  new LocalRenderServiceError(
    429,
    'capacity-exceeded',
    'Retained local capture capacity is blocked or exhausted. Operator review is required; no automatic retry.',
  )
export const localInvalidArtifact = () =>
  new LocalRenderServiceError(
    503,
    'invalid-artifact',
    'Completed local artifact failed independent verification; no image was delivered.',
  )
export const localIdentityMismatch = () =>
  new LocalRenderServiceError(
    503,
    'identity-mismatch',
    'Current source, asset, profile or capture identity differs. A prior successful sample will not be rendered again.',
  )
