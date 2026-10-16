import { afterEach, describe, expect, it } from 'vitest'
import { COLD_MS, bench, benchEnabled } from './bench'

describe('the bench', () => {
  afterEach(() => bench.reset())

  it('is shown with ?bench=1 alone', () => {
    expect(benchEnabled('?bench=1')).toBe(true)
    expect(benchEnabled('?bench=0')).toBe(false)
    expect(benchEnabled('')).toBe(false)
  })

  it('keeps each first as it was first told', () => {
    bench.mark('firstRaster', 120)
    bench.mark('firstRaster', 900)
    bench.mark('firstPreview', 2400)
    expect(bench.get().marks).toEqual({
      firstRaster: 120,
      firstPreview: 2400,
      firstGood: null,
      firstLocalTrace: null,
    })
  })

  it('tells a warm cloud from one that started for the page, and a full one from a failed one', () => {
    expect(bench.get().cloud).toBe('off')
    bench.answered({ renderer: 'own', totalMs: 1500 })
    expect(bench.get().cloud).toBe('warm')
    // The first answer decides; a later slow one is a long render, not a start.
    bench.answered({ renderer: 'own', totalMs: COLD_MS + 1 })
    expect(bench.get().cloud).toBe('warm')
    bench.reset()
    bench.answered({ renderer: 'shared', totalMs: 1500 })
    expect(bench.get().cloud).toBe('cold')
    bench.reset()
    bench.answered({ renderer: 'own', totalMs: COLD_MS + 1 })
    expect(bench.get().cloud).toBe('cold')
    // Every GPU in use, until one answers again; a failure stays.
    bench.cloud('full')
    expect(bench.get().cloud).toBe('full')
    bench.answered({ renderer: 'own', totalMs: 1000 })
    expect(bench.get().cloud).toBe('warm')
    bench.cloud('failed')
    bench.cloud('full')
    bench.answered({ renderer: 'own', totalMs: 1000 })
    expect(bench.get().cloud).toBe('failed')
  })

  it('takes the medians over rendered frames, counting the cached ones apart', () => {
    const frame = (renderMs: number, cached = false, renderer = 'own') =>
      bench.frame({ renderMs, finishMs: renderMs / 10, totalMs: renderMs + 500, cached, renderer })
    frame(4000)
    frame(1000)
    frame(2000)
    frame(0, true, 'shared')
    expect(bench.get()).toMatchObject({
      frames: 4,
      cached: 1,
      renderer: { own: 3, shared: 1 },
      renderMs: 2000,
      finishMs: 200,
      totalMs: 2500,
    })
    // An even count takes the middle two's mean; a view finished in the browser has no finish.
    bench.frame({ renderMs: 3000, finishMs: null, totalMs: 3500, cached: false, renderer: '' })
    expect(bench.get()).toMatchObject({ renderMs: 2500, finishMs: 200, totalMs: 3000 })
    // Only the last two dozen count.
    for (let i = 0; i < 30; i++) frame(100)
    expect(bench.get().renderMs).toBe(100)
  })

  it('reports the local tracer as it goes', () => {
    bench.local({ firstMs: 800, settledMs: null })
    expect(bench.get().local).toEqual({ firstMs: 800, settledMs: null })
    bench.local({ firstMs: 800, settledMs: 6000 })
    expect(bench.get().local.settledMs).toBe(6000)
  })
})
