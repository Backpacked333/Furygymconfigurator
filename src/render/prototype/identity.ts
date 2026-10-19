import { createHash } from 'node:crypto'

/** Sorted keys, ordered arrays; never coerce invalid numbers into null or omit unknown values. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite value in preparation manifest.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  throw new Error('Unsupported value in preparation manifest.')
}
export const bytesDigest = (bytes: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const digest = (value: unknown): string => bytesDigest(canonical(value))
