import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, projectDesignToConfig } from '../domain/design'
import { textureSetsFor } from '../lib/designTextures'

describe('the 360° view’s early scan downloads', () => {
  const fetchScan = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    () => new Promise(() => {}),
  )
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', fetchScan)
    vi.stubGlobal('createImageBitmap', vi.fn())
    vi.stubGlobal('navigator', { userAgent: 'Chrome/140' })
  })
  afterEach(() => {
    fetchScan.mockClear()
    vi.unstubAllGlobals()
  })

  it('are every file of the sets the shown design is made from, at low priority', async () => {
    const { warmLiveDesign } = await import('./liveWarmup')
    const design = defaultDesign({ family: 'container', lengthFt: 40 })
    warmLiveDesign(design)
    const sets = textureSetsFor(projectDesignToConfig(design))
    const urls = fetchScan.mock.calls.map(([url, init]) => {
      expect(init).toEqual({ priority: 'low' })
      return url
    })
    expect(new Set(urls.map((url) => url.split('/')[2]))).toEqual(new Set(sets))
    // Detail-only sets have no albedo to download.
    expect(urls).toContain('/textures/powder_coat/normal.webp')
    expect(urls).not.toContain('/textures/powder_coat/albedo.webp')
    expect(urls).toContain('/textures/painted_metal_shutter/albedo.webp')
  })

  it('leave the Studio look’s hidden hardscape out', async () => {
    const { warmLiveDesign } = await import('./liveWarmup')
    warmLiveDesign(defaultDesign())
    const urls = fetchScan.mock.calls.map(([url]) => url)
    expect(urls.length).toBeGreaterThan(0)
    for (const set of ['concrete_pavement', 'concrete_slab_wall', 'clean_pebbles'])
      expect(
        urls.some((url) => url.includes(`/${set}/`)),
        set,
      ).toBe(false)
  })

  it('refuse what is not a design', async () => {
    const { warmLiveDesign } = await import('./liveWarmup')
    expect(() => warmLiveDesign({ event: 'pointerover' })).toThrow()
    expect(fetchScan).not.toHaveBeenCalled()
  })
})
