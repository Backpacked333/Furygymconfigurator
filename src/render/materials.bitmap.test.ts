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

    const decoded = albedo.image as FakeBitmap
    albedo.onUpdate!(albedo)
    // Freed, with its size kept (three and the 360° view's tracer atlas read it; a closed bitmap
    // reads 0 × 0). Setting the stand-in uploads nothing.
    expect(decoded.width).toBe(0)
    expect(albedo.image).toEqual({ width: 4, height: 4, released: true })
    expect([albedo.width, albedo.height]).toEqual([4, 4])
    // A later upload has nothing more to free.
    albedo.onUpdate!(albedo)
    expect(albedo.image).toEqual({ width: 4, height: 4, released: true })
    const version = albedo.version
    decode.mockClear()
    await restoreTextures()
    expect(decode).toHaveBeenCalledTimes(1)
    expect(albedo.image).toBeInstanceOf(FakeBitmap)
    expect((albedo.image as FakeBitmap).width).toBe(4)
    expect(albedo.version).toBe(version + 1)
  })

  it('keep the decoded pixels while the legacy route’s path tracer reads them', async () => {
    const { keepDecodedTextures, textureMaps } = await import('./materials')
    const albedo = (await textureMaps('teak_veneer')).albedo as Texture
    // Released before the tracer loaded: decoded again, and kept through later uploads, since that
    // tracer's atlas still reads them.
    albedo.onUpdate!(albedo)
    await keepDecodedTextures(true)
    const kept = albedo.image as FakeBitmap
    expect(kept).toBeInstanceOf(FakeBitmap)
    expect(kept.width).toBe(4)
    albedo.onUpdate!(albedo)
    expect(albedo.image).toBe(kept)
    expect(kept.width).toBe(4)
    // Without a tracer the pixels are freed after upload again.
    await keepDecodedTextures(false)
    albedo.onUpdate!(albedo)
    expect(kept.width).toBe(0)
    expect(albedo.image).toEqual({ width: 4, height: 4, released: true })
  })
})

describe('scans downloaded early, for the 360° view', () => {
  const decode = vi.fn(async () => new FakeBitmap())
  /** Each early download, held until released. */
  let held: (() => void)[] = []
  let failEarly = false
  const fetchScan = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init) {
      await new Promise<void>((resolve) => held.push(resolve))
      if (failEarly) return new Response(null, { status: 503 })
    }
    return new Response(new Blob(['scan'], { type: 'image/webp' }))
  })

  beforeEach(() => {
    vi.resetModules()
    held = []
    failEarly = false
    decode.mockClear()
    fetchScan.mockClear()
    vi.stubGlobal('createImageBitmap', decode)
    vi.stubGlobal('fetch', fetchScan)
  })
  afterEach(() => vi.unstubAllGlobals())

  /** The material library, with the early downloads of a set's files started first. */
  async function prefetched(set: 'teak_veneer') {
    const { prefetchEncoded, scanFiles } = await import('./scanFiles')
    const urls = scanFiles(set).map((file) => file.url)
    prefetchEncoded(urls)
    return { urls, ...(await import('./materials')), ...(await import('./progress')) }
  }

  it('are decoded once the library asks for them, from the one download, and counted from then', async () => {
    const { urls, textureMaps, textureProgress } = await prefetched('teak_veneer')
    for (const url of urls) expect(fetchScan).toHaveBeenCalledWith(url, { priority: 'low' })
    held.forEach((release) => release())
    await new Promise((resolve) => setTimeout(resolve))
    // Downloaded, not decoded, and nothing the page waits on.
    expect(decode).not.toHaveBeenCalled()
    expect(textureProgress.get()).toEqual({ requested: 0, loaded: 0 })

    const maps = await textureMaps('teak_veneer')
    expect(maps.albedo).toBeDefined()
    expect(fetchScan).toHaveBeenCalledTimes(3)
    expect(decode).toHaveBeenCalledTimes(3)
    expect(textureProgress.get()).toEqual({ requested: 3, loaded: 3 })
  })

  it('are waited for by the library while still on their way, not downloaded twice', async () => {
    const { textureMaps } = await prefetched('teak_veneer')
    let maps: unknown = null
    void textureMaps('teak_veneer').then((loaded) => (maps = loaded))
    await new Promise((resolve) => setTimeout(resolve))
    expect(maps).toBeNull()
    held.forEach((release) => release())
    await vi.waitFor(() => expect(maps).not.toBeNull())
    expect(fetchScan).toHaveBeenCalledTimes(3)
  })

  it('are downloaded again by the library, without options, when they failed', async () => {
    failEarly = true
    const { urls, textureMaps } = await prefetched('teak_veneer')
    held.forEach((release) => release())
    const maps = await textureMaps('teak_veneer')
    expect(maps.albedo).toBeDefined()
    // The library's own request is a bare fetch(url), as the display and capture realms require.
    for (const url of urls) expect(fetchScan).toHaveBeenCalledWith(url)
    expect(fetchScan).toHaveBeenCalledTimes(6)
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

  it('counts a set the page asks for after a quiet round of it failed, so the progress completes', async () => {
    const { material, prefetchTextures, quietly } = await import('./materials')
    const { textureProgress } = await import('./progress')
    // Downloaded for a design the page does not show: it fails, and with nothing waiting on it no
    // round follows the pause.
    quietly(() => prefetchTextures('teak_veneer'))
    await vi.advanceTimersByTimeAsync(3000 + 30_000)
    expect(textureProgress.get()).toEqual({ requested: 0, loaded: 0 })
    // A surface on screen asks for it later (the live view opening): a fresh, counted round.
    failing = false
    material({ set: 'teak_veneer', color: '#e7d2bd' })
    expect(textureProgress.get()).toEqual({ requested: 3, loaded: 0 })
    await vi.advanceTimersByTimeAsync(0)
    // Every map counts as it arrives: the live view's wait for the scans (the trace gate) ends.
    expect(textureProgress.get()).toEqual({ requested: 3, loaded: 3 })
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
