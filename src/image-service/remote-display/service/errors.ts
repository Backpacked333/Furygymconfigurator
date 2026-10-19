import { cloudDisplayErrorSchema } from '../../../display/cloudContract'
import type { z } from 'zod'

type Wire = z.infer<typeof cloudDisplayErrorSchema>
export class CloudServiceError extends Error {
  readonly wire: Wire
  constructor(
    readonly status: number,
    code: Wire['code'],
    message: string,
    blocker?: Wire['blocker'],
  ) {
    super(message)
    this.wire = cloudDisplayErrorSchema.parse({
      code,
      message,
      retryable: false,
      ...(blocker ? { blocker } : {}),
    })
  }
}
export const denied = () =>
  new CloudServiceError(
    503,
    'execution-denied',
    'External GPU execution requires separate reviewed authorization; this build cannot dispatch.',
    'approval-required',
  )
export const unavailable = () =>
  new CloudServiceError(
    503,
    'execution-denied',
    'Private cloud display is not configured; no render was started.',
    'not-configured',
  )
export const invalid = () =>
  new CloudServiceError(
    503,
    'invalid-artifact',
    'External image or evidence failed independent verification.',
    'package-mismatch',
  )
export const capacity = () =>
  new CloudServiceError(429, 'capacity-exceeded', 'Private cloud display capacity reached.')
export const missing = () =>
  new CloudServiceError(404, 'not-found', 'Private cloud interest not found.')
export const quarantined = () =>
  new CloudServiceError(
    503,
    'execution-denied',
    'Prior external ownership remains quarantined; no replacement is admitted.',
    'quarantined',
  )
