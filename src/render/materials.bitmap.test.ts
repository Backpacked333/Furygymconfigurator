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

describe('scans decoded off the main thread', () => {
  const decode = vi.fn(async () => new FakeBitmap())

  beforeEach(() => {
    vi.resetModules()
    decode.mockClear()
    vi.stubGlobal('createImageBitmap', decode)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['scan'], { type: 'image/webp' }))),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('decode upright without conversion, release after upload, and restore for a new renderer', async () => {
    const { material, restoreTextures, textureMaps } = await import('./materials')
    const maps = await textureMaps('teak_veneer')
    const albedo = maps.albedo as Texture
    // (fetch's Blob is Node's here, not jsdom's, so only the options are matched exactly.)
    expect(decode).toHaveBeenCalledWith(expect.anything(), {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
    expect(albedo.flipY).toBe(false)
    // The material keeps its maps across the release.
    const m = material({ set: 'teak_veneer', color: '#e7d2bd' })
    expect(m.map).toBe(albedo)

    albedo.onUpdate!(albedo)
    expect((albedo.image as FakeBitmap).width).toBe(0)
    const version = albedo.version
    decode.mockClear()
    await restoreTextures()
    expect(decode).toHaveBeenCalledTimes(1)
    expect((albedo.image as FakeBitmap).width).toBe(4)
    expect(albedo.version).toBe(version + 1)
  })

  it('keep the decoded pixels while a local path tracer reads them', async () => {
    const { keepDecodedTextures, textureMaps } = await import('./materials')
    const albedo = (await textureMaps('teak_veneer')).albedo as Texture
    // Released before the tracer loaded: decoded again, and kept through later uploads, since the
    // tracer packs its own texture array from these pixels (a released map traces black).
    albedo.onUpdate!(albedo)
    await keepDecodedTextures(true)
    expect((albedo.image as FakeBitmap).width).toBe(4)
    albedo.onUpdate!(albedo)
    expect((albedo.image as FakeBitmap).width).toBe(4)
    // Without a tracer the pixels are freed after upload again.
    await keepDecodedTextures(false)
    albedo.onUpdate!(albedo)
    expect((albedo.image as FakeBitmap).width).toBe(0)
  })
})

describe('a scan set that fails', () => {
  const decoded: FakeBitmap[] = []
  const decode = vi.fn(async () => {
    const bitmap = new FakeBitmap()
    decoded.push(bitmap)
    return bitmap
  })
  let failing = true
  const fetchScan = vi.fn(async (url: string) =>
    failing && url.endsWith('normal.webp')
      ? new Response(null, { status: 404 })
      : new Response(new Blob(['scan'], { type: 'image/webp' })),
  )

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    decoded.length = 0
    failing = true
    decode.mockClear()
    fetchScan.mockClear()
    vi.stubGlobal('createImageBitmap', decode)
    vi.stubGlobal('fetch', fetchScan)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('counts the maps that never arrive as loaded, so nothing waits on the progress', async () => {
    const { prefetchTextures } = await import('./materials')
    const { textureProgress } = await import('./progress')
    prefetchTextures('teak_veneer')
    expect(textureProgress.get()).toEqual({ requested: 3, loaded: 0 })
    // Two retries (1 s, then 2 s) and the normal map is given up on, for now.
    await vi.advanceTimersByTimeAsync(3000)
    expect(textureProgress.get()).toEqual({ requested: 3, loaded: 3 })
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('frees the maps that did arrive, pauses, and textures waiting surfaces once it recovers', async () => {
    const { textureMaps, prefetchTextures } = await import('./materials')
    let maps: unknown = null
    void textureMaps('teak_veneer').then((loaded) => (maps = loaded))
    await vi.advanceTimersByTimeAsync(3000)
    expect(decoded).toHaveLength(2)
    expect(decoded.every((bitmap) => bitmap.width === 0)).toBe(true)

    // Renders during the pause do not hammer the host.
    const requests = fetchScan.mock.calls.length
    prefetchTextures('teak_veneer')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchScan.mock.calls.length).toBe(requests)

    failing = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchScan.mock.calls.length).toBeGreaterThan(requests)
    expect(maps).toMatchObject({ albedo: expect.anything(), normal: expect.anything() })
  })

  it('waits longer after each failed round', async () => {
    const { textureMaps } = await import('./materials')
    void textureMaps('teak_veneer')
    const requests = () => fetchScan.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    const first = requests()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(requests()).toBeGreaterThan(first)
    await vi.advanceTimersByTimeAsync(3000)
    const second = requests()
    await vi.advanceTimersByTimeAsync(50_000)
    expect(requests()).toBe(second)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requests()).toBeGreaterThan(second)
  })
})
