import { describe, expect, it, vi } from 'vitest'
import {
  createDisposalScope,
  createPresentationStore,
  samePresentation,
  type PresentationToken,
} from './presentation'

export const token: PresentationToken = {
  revision: 1,
  generation: 3,
  view: 'exterior',
  camera: 'camera-1',
  material: 'maps-2',
  presentation: 'sun-3',
  quality: 'high',
  preview: false,
}

describe('presentation identity', () => {
  it.each(Object.keys(token) as (keyof PresentationToken)[])('rejects changed %s', (key) => {
    expect(samePresentation(token, { ...token })).toBe(true)
    expect(samePresentation(token, { ...token, [key]: 'different' })).toBe(false)
  })
  it('notifies subscribers and releases subscriptions', () => {
    const store = createPresentationStore({
      token,
      stage: 'initializing',
      reasons: [],
      animating: false,
      rendered: { width: 0, height: 0 },
    })
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    store.set({ ...store.get(), stage: 'settled' })
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    store.set({ ...store.get(), stage: 'lost' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('explicit GPU ownership scope', () => {
  it('disposes unique owned resources in reverse order exactly once, never borrowed resources', () => {
    const calls: string[] = []
    const scope = createDisposalScope()
    const borrowed = { dispose: vi.fn() }
    const pass = scope.own({ dispose: () => calls.push('pass'), borrowed })
    scope.own(pass)
    scope.own({ dispose: () => calls.push('history') })
    scope.dispose()
    scope.dispose()
    expect(calls).toEqual(['history', 'pass'])
    expect(borrowed.dispose).not.toHaveBeenCalled()
    expect(() => scope.own(borrowed)).toThrow('disposed')
  })
  it('continues disposal after failures and can recreate a fresh StrictMode generation', () => {
    const first = createDisposalScope()
    const dispose = vi.fn()
    first.own({ dispose })
    first.own({
      dispose: () => {
        throw new Error('device lost')
      },
    })
    expect(() => first.dispose()).toThrow(AggregateError)
    expect(dispose).toHaveBeenCalledTimes(1)
    const second = createDisposalScope()
    second.own({ dispose })
    second.dispose()
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
