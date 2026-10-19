import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedProviderCalls, providerCallTimeout } from './providerCalls'

afterEach(() => vi.useRealTimers())

describe('bounded provider operations', () => {
  it('keeps timed-out slots until the underlying operation settles without dispatching duplicates', async () => {
    vi.useFakeTimers()
    const calls = new BoundedProviderCalls()
    let release!: (value: number) => void
    const operation = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve
        }),
    )
    const pending = calls.run('stop:one', 10, operation)
    const result = expect(pending).rejects.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(10)
    await result
    for (let n = 0; n < 100; n++)
      await expect(calls.run('stop:one', 10, operation)).rejects.toMatchObject({ status: 503 })
    expect(operation).toHaveBeenCalledOnce()
    release(1)
    await vi.runAllTimersAsync()
    await expect(calls.run('stop:one', 10, async () => 2)).resolves.toBe(2)
  })

  it('bounds hung operations across distinct resources and still permits already pending callers', async () => {
    vi.useFakeTimers()
    const calls = new BoundedProviderCalls()
    const operation = vi.fn(() => new Promise<never>(() => {}))
    const pending = Array.from({ length: 64 }, (_, i) =>
      calls.run(`stop:${i}`, 10, operation).catch(() => 'unconfirmed'),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(await Promise.all(pending)).toEqual(Array(64).fill('unconfirmed'))
    await expect(calls.run('stop:overflow', 10, operation)).rejects.toMatchObject({ status: 503 })
    expect(operation).toHaveBeenCalledTimes(64)
  })

  it('bounds inventory failures without claiming stopped proof and handles late rejection', async () => {
    vi.useFakeTimers()
    const calls = new BoundedProviderCalls()
    let reject!: (error: Error) => void
    const pending = calls.run(
      'inspect',
      10,
      () =>
        new Promise((_, r) => {
          reject = r
        }),
    )
    const result = expect(pending).rejects.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(10)
    await result
    reject(new Error('late adapter failure'))
    await vi.runAllTimersAsync()
    await expect(calls.run('inspect', 10, async () => [])).resolves.toEqual([])
  })

  it('validates private caller timeout bounds', () => {
    for (const value of [0, -1, 5001, Infinity, NaN, 1.5])
      expect(() => providerCallTimeout(value)).toThrow()
    expect(providerCallTimeout()).toBe(250)
  })
})
