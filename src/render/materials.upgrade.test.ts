// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Texture } from 'three'

class FakeBitmap {
  constructor(
    public width = 4,
    public height = 4,
  ) {}
  close() {
    this.width = this.height = 0
  }
}

describe('full-resolution scans for the 360 view', () => {
  const requests: string[] = []
  let failFull = false
  beforeEach(() => {
    vi.resetModules()
    requests.length = 0
    failFull = false
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => new FakeBitmap()),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url)
        if (failFull && !url.includes('/1k/')) throw new Error('offline')
        return new Response(new Blob(['scan'], { type: 'image/webp' }))
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('load 1K copies first, then swap in the 2K scans without touching other sets', async () => {
    const { material, upgradeLiveTextures } = await import('./materials')
    const rubber = material({ set: 'rubber_tiles', color: '#353936' })
    const teak = material({ set: 'teak_veneer', color: '#e7d2bd' })
    await vi.waitFor(() => expect(requests.length).toBe(6))
    await vi.waitFor(() => expect((rubber.normalMap as Texture).image).toBeInstanceOf(FakeBitmap))
    expect(requests.filter((u) => u.includes('rubber_tiles/1k/'))).toHaveLength(3)
    const before = { normal: rubber.normalMap, teak: teak.normalMap }
    requests.length = 0
    await upgradeLiveTextures(() => false)
    expect(requests).toEqual([
      expect.stringMatching(/rubber_tiles\/albedo\.webp$/),
      expect.stringMatching(/rubber_tiles\/normal\.webp$/),
      expect.stringMatching(/rubber_tiles\/arm\.webp$/),
    ])
    expect(rubber.normalMap).not.toBe(before.normal)
    expect(teak.normalMap).toBe(before.teak)
    // Materials made afterwards get the full scans too, and a second pass does nothing.
    expect(material({ set: 'rubber_tiles', color: '#111111' }).normalMap).toBe(rubber.normalMap)
    requests.length = 0
    await upgradeLiveTextures(() => false)
    expect(requests).toEqual([])
  })

  it('keep the 1K copies when the full scans cannot be fetched', async () => {
    const { material, upgradeLiveTextures } = await import('./materials')
    const floor = material({ set: 'granite_tile_04', color: '#acb1a5' })
    await vi.waitFor(() => expect((floor.normalMap as Texture).image).toBeInstanceOf(FakeBitmap))
    const before = floor.normalMap
    failFull = true
    await upgradeLiveTextures(() => false)
    expect(floor.normalMap).toBe(before)
  })

  it('leave sets no material on screen uses, such as floors only prepared ahead', async () => {
    const { material, upgradeLiveTextures } = await import('./materials')
    const shown = material({ set: 'rubber_tiles' })
    const prepared = material({ set: 'granite_tile_04' })
    await vi.waitFor(() => expect((prepared.normalMap as Texture).image).toBeInstanceOf(FakeBitmap))
    await vi.waitFor(() => expect((shown.normalMap as Texture).image).toBeInstanceOf(FakeBitmap))
    const before = prepared.normalMap
    requests.length = 0
    await upgradeLiveTextures(
      () => false,
      (m) => m === shown,
    )
    expect(requests.every((u) => u.includes('rubber_tiles/'))).toBe(true)
    expect(prepared.normalMap).toBe(before)
  })

  it('stop as soon as the view goes away', async () => {
    const { material, upgradeLiveTextures } = await import('./materials')
    const floor = material({ set: 'laminate_floor_02' })
    await vi.waitFor(() => expect((floor.normalMap as Texture).image).toBeInstanceOf(FakeBitmap))
    const before = floor.normalMap
    requests.length = 0
    await upgradeLiveTextures(() => true)
    expect(requests).toEqual([])
    expect(floor.normalMap).toBe(before)
  })
})
