import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIELD_DIMS } from '../../../siteLight'
import { CAPTURE_LIMITS } from '../contract'
import { CaptureScope, SettleGate } from './control'
import { admittedResource, guardResources, validSiteField } from './resources'

const origin = 'http://127.0.0.1:9876'
const texture = '/textures/rubber_tiles/albedo.webp'
const workerPath = '/assets/siteLight.worker-test123.js'
const field = () => ({
  origin: [0, 0, 0],
  cell: [1, 1, 1],
  dims: [...FIELD_DIMS],
  capture: [1, 0, 0, 0],
  values: new Float32Array(FIELD_DIMS.reduce((a, b) => a * b, 4)),
})
const scopes: CaptureScope[] = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope.close()
  vi.unstubAllGlobals()
})

function localResponse(
  body: Uint8Array<ArrayBuffer> = new Uint8Array([1]),
  contentType = 'image/webp',
  url = `${origin}${texture}`,
  status = 200,
) {
  const response = new Response(body, { status, headers: { 'content-type': contentType } })
  Object.defineProperty(response, 'url', { value: url })
  return response
}
function environment(
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => localResponse()),
) {
  class FakeWorker extends EventTarget {
    terminate = vi.fn()
  }
  const page = {
    location: new URL(`${origin}/worker.html?renderer=webgl2`),
    fetch: fetcher,
    Worker: FakeWorker as unknown as typeof Worker,
    setTimeout: ((fn: () => void, ms?: number) =>
      Number(setTimeout(fn, ms))) as typeof window.setTimeout,
    clearTimeout: ((id: number) => clearTimeout(id)) as typeof window.clearTimeout,
  }
  vi.stubGlobal('window', page)
  const scope = new CaptureScope()
  scopes.push(scope)
  const gate = new SettleGate(500)
  const guarded = guardResources(scope, gate)
  return { scope, gate, guarded, page, fetcher }
}

describe('canonical local resources', () => {
  it('admits only the authored map names and emitted worker family', () => {
    expect(admittedResource(texture, origin, 'texture').href).toBe(`${origin}${texture}`)
    expect(admittedResource(`${origin}${texture}`, origin, 'texture').pathname).toBe(texture)
    expect(admittedResource('/textures/powder_coat/normal.webp', origin, 'texture')).toBeInstanceOf(
      URL,
    )
    expect(admittedResource(workerPath, origin, 'worker')).toBeInstanceOf(URL)
  })
  it.each([
    `https://example.invalid${texture}`,
    `http://user@127.0.0.1:9876${texture}`,
    `${texture}?token=not-admitted`,
    `${texture}#not-admitted`,
    `//127.0.0.1:9876${texture}`,
    '/textures/rubber_tiles/../rubber_tiles/albedo.webp',
    '/textures/%72ubber_tiles/albedo.webp',
    '/textures/rubber_tiles\\albedo.webp',
    'textures/rubber_tiles/albedo.webp',
    '/textures/powder_coat/albedo.webp',
    '/textures/rubber_tiles/ao.webp',
    '/worker.html',
  ])('rejects noncanonical or unsupported texture %s', (path) => {
    expect(() => admittedResource(path, origin, 'texture')).toThrow()
  })
  it.each([
    '/assets/another-worker.js',
    '/src/render/siteLight.worker.ts',
    `${workerPath}?v=1`,
    'blob:opaque',
  ])('rejects unexpected worker %s', (path) => {
    expect(() => admittedResource(path, origin, 'worker')).toThrow()
  })
})

describe('site field readiness', () => {
  it('accepts the authored typed grid and rejects malformed or nonfinite data', () => {
    expect(validSiteField(field())).toBe(true)
    for (const invalid of [
      null,
      {},
      { ...field(), dims: [1, 2, 3] },
      { ...field(), cell: [1, 0, 1] },
      { ...field(), capture: [1, NaN, 0, 0] },
      { ...field(), values: [] },
      { ...field(), values: new Float32Array(1) },
    ])
      expect(validSiteField(invalid)).toBe(false)
    const invalid = field()
    invalid.values[0] = Infinity
    expect(validSiteField(invalid)).toBe(false)
  })
  it('observes only a valid ticket and terminates the owned worker', async () => {
    const { page, gate, guarded, scope } = environment()
    const worker = new page.Worker(workerPath, { type: 'module' })
    expect(gate.siteField).toBe(false)
    worker.dispatchEvent(new MessageEvent('message', { data: { id: 1, field: field() } }))
    expect(gate.siteField).toBe(true)
    expect(() => guarded.check()).not.toThrow()
    await scope.close()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it.each([
    { id: 2, field: field() },
    { id: 1, field: null },
  ])('rejects unexpected worker results', (data) => {
    const { page, gate, guarded } = environment()
    const worker = new page.Worker(workerPath, { type: 'module' })
    worker.dispatchEvent(new MessageEvent('message', { data }))
    expect(gate.siteField).toBe(false)
    expect(() => guarded.check()).toThrow(expect.objectContaining({ code: 'scene-failed' }))
  })
  it('makes worker rejection sticky even if the authored loader catches and attempts CPU fallback', () => {
    const { page, guarded } = environment()
    expect(() => new page.Worker('/not-admitted.js', { type: 'module' })).toThrow()
    expect(() => guarded.check()).toThrow(expect.objectContaining({ code: 'network-denied' }))
  })
  it('forbids a second worker, classic scripts and extra options', () => {
    const { page, guarded } = environment()
    new page.Worker(workerPath, { type: 'module' })
    expect(() => new page.Worker(workerPath, { type: 'module' })).toThrow()
    expect(() => guarded.check()).toThrow(expect.objectContaining({ code: 'network-denied' }))
    const second = environment()
    expect(() => new second.page.Worker(workerPath)).toThrow()
    const third = environment()
    expect(
      () => new third.page.Worker(workerPath, { type: 'module', credentials: 'include' }),
    ).toThrow()
  })
})

describe('bounded fetch and teardown', () => {
  it('applies private fetch restrictions and does not mistake downloaded bytes for decoded maps', async () => {
    const { page, fetcher, guarded, scope } = environment()
    const response = await page.fetch(texture)
    expect(response.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(`${origin}${texture}`, {
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: scope.signal,
    })
    expect(guarded.materialsReady()).toBe(false)
    expect(guarded.maps()).toEqual([])
  })
  it('fails missing assets without accepting material loader retry/fallback', async () => {
    const { page, guarded, fetcher } = environment(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          localResponse(new Uint8Array([1]), 'image/webp', `${origin}${texture}`, 404),
        ),
    )
    await expect(page.fetch(texture)).rejects.toMatchObject({ code: 'asset-failed' })
    await expect(page.fetch(texture)).rejects.toMatchObject({ code: 'asset-failed' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(() => guarded.materialsReady()).toThrow()
  })
  it.each(['wrong-type', 'wrong-url', 'redirect', 'empty'])(
    'rejects asset response %s',
    async (problem) => {
      const response = localResponse(
        problem === 'empty' ? new Uint8Array() : undefined,
        problem === 'wrong-type' ? 'text/html' : undefined,
        problem === 'wrong-url' ? `${origin}/unexpected` : undefined,
      )
      if (problem === 'redirect') Object.defineProperty(response, 'redirected', { value: true })
      const { page } = environment(vi.fn<typeof fetch>().mockResolvedValue(response))
      await expect(page.fetch(texture)).rejects.toMatchObject({ code: 'asset-failed' })
    },
  )
  it('rejects caller headers, Request objects and external traffic before native fetch', async () => {
    const { page, fetcher } = environment()
    await expect(page.fetch(texture, { headers: { accept: 'image/webp' } })).rejects.toMatchObject({
      code: 'network-denied',
    })
    expect(fetcher).not.toHaveBeenCalled()
    const second = environment()
    await expect(second.page.fetch(new Request(`${origin}${texture}`))).rejects.toMatchObject({
      code: 'network-denied',
    })
    const third = environment()
    await expect(third.page.fetch('https://example.invalid/')).rejects.toMatchObject({
      code: 'network-denied',
    })
    expect(third.fetcher).not.toHaveBeenCalled()
  })
  it('rejects an over-limit asset body', async () => {
    const { page } = environment(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(localResponse(new Uint8Array(CAPTURE_LIMITS.assetBytes + 1))),
    )
    await expect(page.fetch(texture)).rejects.toMatchObject({ code: 'limit-exceeded' })
  })
  it('enforces the resource request cap before another native request', async () => {
    const { page, fetcher } = environment()
    for (let i = 0; i < CAPTURE_LIMITS.resourceRequests; i++) await page.fetch(texture)
    await expect(page.fetch(texture)).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(fetcher).toHaveBeenCalledTimes(CAPTURE_LIMITS.resourceRequests)
  })
  it('removes owned timers and prevents late continuations from starting new work', async () => {
    const { page, scope } = environment()
    const callback = vi.fn()
    page.setTimeout(callback, 60_000)
    await scope.close()
    expect(page.setTimeout(callback, 60_000)).toBe(0)
    expect(callback).not.toHaveBeenCalled()
    await expect(page.fetch(texture)).rejects.toMatchObject({ code: 'cancelled' })
  })
})
