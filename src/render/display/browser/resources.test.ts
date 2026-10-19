import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeDisplayResources } from './resources'
import { loadedMaps } from '../../materials'

vi.mock('../../materials', () => ({
  TEXTURE_SETS: { testScan: {}, detailScan: { detailOnly: true } },
  loadedMaps: vi.fn(),
}))
const origin = 'http://127.0.0.1:1'
const fetcher = vi.fn()
const response = (path = '/textures/testScan/albedo.webp', bytes = new Uint8Array([1, 2, 3])) => ({
  status: 200,
  redirected: false,
  url: `${origin}${path}`,
  headers: new Headers({ 'content-type': 'image/webp' }),
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }),
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { fetch: fetcher })
  vi.stubGlobal('location', { origin })
})
afterEach(() => vi.unstubAllGlobals())
describe('session-scoped resource fencing without a DOM, canvas or real network', () => {
  it('acknowledges only fully received and applied maps; cached maps remain ready across revisions', async () => {
    fetcher.mockResolvedValue(response())
    const resources = observeDisplayResources()
    expect(resources.ready()).toBe(false)
    await window.fetch('/textures/testScan/albedo.webp')
    expect(resources.ready()).toBe(false)
    vi.mocked(loadedMaps).mockReturnValue({} as NonNullable<ReturnType<typeof loadedMaps>>)
    expect(resources.ready()).toBe(true)
    expect(resources.ready()).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    resources.close()
    expect(window.fetch).toBe(fetcher)
    expect(() => resources.ready()).toThrow('failure')
  })
  it.each([
    'https://external.invalid/x',
    '/textures/testScan/albedo.webp?x=1',
    '/textures/testScan/%61lbedo.webp',
    '/textures/detailScan/albedo.webp',
    '/textures/unknown/albedo.webp',
  ])('poisons on an unlisted/ambiguous resource %s before dispatch', async (path) => {
    const resources = observeDisplayResources()
    await expect(window.fetch(path)).rejects.toThrow('failure')
    expect(fetcher).not.toHaveBeenCalled()
    expect(() => resources.ready()).toThrow('failure')
    resources.close()
  })
  it('pending/late responses cannot satisfy a closed session', async () => {
    let resolve: ((value: unknown) => void) | undefined
    fetcher.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const resources = observeDisplayResources()
    const pending = window.fetch('/textures/testScan/albedo.webp')
    const rejected = expect(pending).rejects.toThrow('failure')
    expect(resources.ready()).toBe(false)
    resources.close()
    resolve?.(response())
    await rejected
    expect(() => resources.ready()).toThrow('failure')
  })
  it('rejects invalid responses and oversized streamed bytes; retries cannot unpoison', async () => {
    fetcher.mockResolvedValue(
      response('/textures/testScan/albedo.webp', new Uint8Array(16 * 1024 * 1024 + 1)),
    )
    const resources = observeDisplayResources()
    await expect(window.fetch('/textures/testScan/albedo.webp')).rejects.toThrow('bytes exceeded')
    await expect(window.fetch('/textures/testScan/albedo.webp')).rejects.toThrow('failure')
    resources.close()
  })
})
