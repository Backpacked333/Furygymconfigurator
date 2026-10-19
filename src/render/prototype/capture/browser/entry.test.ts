import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_LIMITS, CAPTURE_PROTOCOL, WORKER_GLOBAL } from '../contract'
import { bootstrapPrivatePage, installPrivatePage, validatePrivateLocation } from './entry'

const origin = 'http://127.0.0.1:9876'
const build = {
  sourceManifestDigest: `sha256:${'a'.repeat(64)}`,
  assetManifestDigest: `sha256:${'b'.repeat(64)}`,
  bundleDigest: `sha256:${'c'.repeat(64)}`,
  lockfileDigest: `sha256:${'d'.repeat(64)}`,
  threeRevision: '186',
}
afterEach(() => vi.unstubAllGlobals())
function bootstrapResponse(body = JSON.stringify(build), type = 'application/json') {
  const response = new Response(body, { headers: { 'content-type': type } })
  Object.defineProperty(response, 'url', { value: `${origin}/__capture_bootstrap.json` })
  return response
}
function setup(response = bootstrapResponse()) {
  const page = { location: new URL(`${origin}/worker.html?renderer=webgl2`) }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('window', page)
  vi.stubGlobal('fetch', fetcher)
  return { page, fetcher }
}
describe('private bootstrap, never a customer URL route', () => {
  it.each(['webgl2', 'webgpu'])('accepts a fixed local %s page', (renderer) => {
    expect(() =>
      validatePrivateLocation(`${origin}/worker.html?renderer=${renderer}`),
    ).not.toThrow()
  })
  it.each([
    'https://127.0.0.1:9876/worker.html?renderer=webgl2',
    'http://localhost:9876/worker.html?renderer=webgl2',
    'http://127.0.0.1/worker.html?renderer=webgl2',
    `${origin}/?renderer=webgl2`,
    `${origin}/worker.html?renderer=webgl2&quality=ultra`,
    `${origin}/worker.html?renderer=webgl2#capture`,
    `${origin}/worker.html`,
    `${origin}/worker.html?renderer=auto`,
    'http://user@127.0.0.1:9876/worker.html?renderer=webgl2',
  ])('rejects %s', (url) => {
    expect(() => validatePrivateLocation(url)).toThrow()
  })
  it('loads only the fixed bounded build identity; readiness does not instantiate graphics', async () => {
    const { fetcher } = setup()
    const worker = await bootstrapPrivatePage()
    expect(await worker.ready()).toMatchObject({
      state: 'ready',
      protocol: CAPTURE_PROTOCOL,
      build,
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      new URL(`${origin}/__capture_bootstrap.json`),
      expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' }),
    )
    expect(worker.progress()).toBeNull()
    await worker.dispose()
  })
  it('installs a nonreplaceable protocol global', async () => {
    const { page } = setup()
    await installPrivatePage()
    expect(Object.getOwnPropertyDescriptor(page, WORKER_GLOBAL)).toMatchObject({
      writable: false,
      configurable: false,
    })
  })
  it.each(['type', 'redirect', 'size', 'extra-key'])(
    'rejects bootstrap failure %s',
    async (problem) => {
      const response = bootstrapResponse(
        problem === 'size'
          ? ' '.repeat(CAPTURE_LIMITS.metadataBytes + 1)
          : problem === 'extra-key'
            ? JSON.stringify({ ...build, callerURL: '/not-admitted' })
            : undefined,
        problem === 'type' ? 'text/html' : undefined,
      )
      if (problem === 'redirect') Object.defineProperty(response, 'redirected', { value: true })
      setup(response)
      await expect(bootstrapPrivatePage()).rejects.toThrow()
      expect(Object.prototype.hasOwnProperty.call(window, WORKER_GLOBAL)).toBe(false)
    },
  )
})
