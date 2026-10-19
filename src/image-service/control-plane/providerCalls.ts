import { unavailable } from './contracts'

/** A timeout releases the caller, NOT the operation's slot or its financial liability. */
export class BoundedProviderCalls {
  readonly #pending = new Map<string, { promise: Promise<unknown>; timedOut: boolean }>()

  run<T>(key: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
    const existing = this.#pending.get(key)
    if (existing)
      return existing.timedOut ? Promise.reject(unavailable()) : (existing.promise as Promise<T>)
    if (this.#pending.size >= 64) return Promise.reject(unavailable())
    const entry = { promise: Promise.resolve() as Promise<unknown>, timedOut: false }
    this.#pending.set(key, entry)
    const source = Promise.resolve().then(operation)
    entry.promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.timedOut = true
        reject(unavailable('Provider response deadline exceeded; execution remains unconfirmed.'))
      }, timeoutMs)
      source.then(resolve, reject).finally(() => {
        clearTimeout(timer)
        this.#pending.delete(key)
      })
    })
    return entry.promise as Promise<T>
  }
}

const pools = new WeakMap<object, BoundedProviderCalls>()
export function providerCalls(provider: object): BoundedProviderCalls {
  let pool = pools.get(provider)
  if (!pool) {
    pool = new BoundedProviderCalls()
    pools.set(provider, pool)
  }
  return pool
}

export function providerCallTimeout(input = 250): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > 5_000) throw unavailable()
  return input
}
