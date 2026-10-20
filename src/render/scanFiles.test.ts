import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('the scans’ files', () => {
  it('are each set’s three maps, or two for detail-only sets, which have no albedo', async () => {
    const { scanFiles } = await import('./scanFiles')
    expect(scanFiles('teak_veneer')).toEqual([
      { name: 'albedo', url: '/textures/teak_veneer/albedo.webp' },
      { name: 'normal', url: '/textures/teak_veneer/normal.webp' },
      { name: 'arm', url: '/textures/teak_veneer/arm.webp' },
    ])
    expect(scanFiles('powder_coat').map((file) => file.name)).toEqual(['normal', 'arm'])
  })
})

describe('early downloads', () => {
  const fetchScan = vi.fn(async () => new Response(new Blob(['scan'])))
  const urls = ['/textures/teak_veneer/albedo.webp', '/textures/teak_veneer/normal.webp']

  beforeEach(() => {
    vi.resetModules()
    fetchScan.mockClear()
    vi.stubGlobal('fetch', fetchScan)
    vi.stubGlobal('createImageBitmap', vi.fn())
    vi.stubGlobal('navigator', { userAgent: 'Chrome/140' })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('download each file once, at low priority, until the library takes it', async () => {
    const { prefetchEncoded, takePrefetched } = await import('./scanFiles')
    prefetchEncoded(urls)
    prefetchEncoded(urls)
    expect(fetchScan.mock.calls).toEqual(urls.map((url) => [url, { priority: 'low' }]))
    expect(await takePrefetched(urls[0])).toBeInstanceOf(Blob)
    // Taken once: the library downloads it itself from then on, so it is not downloaded early again.
    expect(takePrefetched(urls[0])).toBeUndefined()
    prefetchEncoded(urls)
    expect(fetchScan).toHaveBeenCalledTimes(2)
  })

  it('leave out files the library asked for before any early download', async () => {
    const { prefetchEncoded, takePrefetched } = await import('./scanFiles')
    expect(takePrefetched(urls[0])).toBeUndefined()
    prefetchEncoded(urls)
    expect(fetchScan.mock.calls).toEqual([[urls[1], { priority: 'low' }]])
  })

  it('do not start where the visitor asked to save data', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/140', connection: { saveData: true } })
    const { prefetchEncoded } = await import('./scanFiles')
    prefetchEncoded(urls)
    expect(fetchScan).not.toHaveBeenCalled()
  })

  it('do not start where the library loads scans through an <img>, which has no use for bytes', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Version/16.6 Safari/605.1.15' })
    const { prefetchEncoded } = await import('./scanFiles')
    prefetchEncoded(urls)
    expect(fetchScan).not.toHaveBeenCalled()
  })

  it('swallow their own failures, which the library meets again only if it asks', async () => {
    fetchScan.mockImplementation(async () => new Response(null, { status: 404 }))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { prefetchEncoded, takePrefetched } = await import('./scanFiles')
      prefetchEncoded(urls)
      await new Promise((resolve) => setTimeout(resolve))
      expect(unhandled).not.toHaveBeenCalled()
      await expect(takePrefetched(urls[0])).rejects.toThrow('404')
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
