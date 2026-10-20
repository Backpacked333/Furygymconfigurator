import type { ImageError } from './protocol'

export class ImageServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ImageError['code'],
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ImageServiceError'
  }

  get wireError(): ImageError {
    return { code: this.code, message: this.message, retryable: this.retryable }
  }
}

export function unavailable(): ImageServiceError {
  return new ImageServiceError(
    503,
    'unavailable',
    'Local mock service is unavailable; no new work was admitted.',
    true,
  )
}

export function capacity(): ImageServiceError {
  return new ImageServiceError(
    429,
    'capacity-exceeded',
    'Local mock capacity or synthetic work-unit budget is exhausted. Retained requests need time to expire; lifetime budgets require operator review. Immediate retries are disabled.',
    false,
  )
}
