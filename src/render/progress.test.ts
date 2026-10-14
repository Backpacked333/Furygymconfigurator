import { describe, expect, it } from 'vitest'
import { createTextureProgress, type AssetMapState } from './progress'

const map = (id: string, source: AssetMapState['source']): AssetMapState => ({
  id,
  set: 'wood',
  role: 'albedo',
  source,
  status: source === 'failed' ? 'degraded' : source,
  render: source === 'ready' ? 'ready' : 'fallback',
  attempts: 2,
  maxAttempts: 3,
})

describe('active asset progress (pure shell module)', () => {
  it('counts terminal fallbacks without calling them ready', () => {
    const progress = createTextureProgress()
    const owner = progress.register('scene', 0, () => {})
    owner.update([map('a', 'ready'), map('n', 'failed')])
    expect(progress.snapshot()).toMatchObject({
      requested: 2,
      loaded: 2,
      ready: 1,
      failed: 1,
      degraded: 1,
      pending: 0,
      settled: true,
      canRetry: true,
    })
    expect(progress.snapshot()).toBe(progress.snapshot())
  })
  it('deduplicates shared maps and drops previous generation progress', () => {
    const progress = createTextureProgress()
    const a = progress.register('a', 0, () => {})
    const b = progress.register('b', 0, () => {})
    a.update([map('shared', 'ready')])
    b.update([map('shared', 'ready')])
    expect(progress.snapshot()).toMatchObject({ owners: 2, requested: 1 })
    progress.setGeneration(1)
    a.update([map('late', 'pending')])
    expect(progress.snapshot()).toMatchObject({ generation: 1, owners: 0, requested: 0 })
  })
  it('ignores stale updates and cleanup after reusing an owner name', () => {
    const progress = createTextureProgress()
    const old = progress.register('scene', 0, () => {})
    const current = progress.register('scene', 0, () => {})
    current.update([map('new', 'ready')])
    old.dispose()
    old.update([map('old', 'pending')])
    expect(progress.snapshot('scene').maps.map((m) => m.id)).toEqual(['new'])
  })
  it('retries only selected active owners and unsubscribes listeners', () => {
    const progress = createTextureProgress()
    const retried: string[] = []
    let notifications = 0
    const off = progress.subscribe(() => notifications++)
    progress.register('a', 0, () => retried.push('a'))
    progress.register('b', 1, () => retried.push('b'))
    progress.retry()
    progress.retry('b')
    off()
    expect(retried).toEqual(['a'])
    progress.setGeneration(1)
    expect(notifications).toBe(2)
    expect(progress.snapshot('missing')).toBe(progress.snapshot('missing'))
  })
  it('aggregates hierarchical scopes and routes retry only to that subtree', () => {
    const progress = createTextureProgress()
    const retried: string[] = []
    progress
      .register('scene:model:a', 0, () => retried.push('model'))
      .update([map('wood', 'failed')])
    progress
      .register('scene:landscape:b', 0, () => retried.push('landscape'))
      .update([map('grass', 'ready')])
    progress
      .register('preview:model:c', 0, () => retried.push('preview'))
      .update([map('wood', 'ready')])
    expect(progress.snapshot('scene')).toMatchObject({ requested: 2, owners: 2, failed: 1 })
    expect(progress.snapshot('scene:model')).toMatchObject({ requested: 1, owners: 1, failed: 1 })
    progress.retry('scene:model')
    expect(retried).toEqual(['model'])
  })
})
