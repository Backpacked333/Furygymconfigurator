import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, type DesignEnvelope } from '../domain/design'
import { createSceneDesignFixtures } from '../domain/designFixtures'
import { DISPLAY_LIMITS, displayHolds, type DisplayBuild } from '../display/contract'
import {
  CLOUD_DISPLAY_LABEL,
  CLOUD_DISPLAY_MODE,
  CLOUD_DISPLAY_PROTOCOL,
  CLOUD_DISPLAY_REQUEST_PATH,
  bindCloudRecipe,
  cloudDisplayImagePath,
  type CloudDisplayReadyReply,
} from '../display/cloudContract'
import { DISPLAY_CLIENT_DEADLINE_MS, type DisplayTransport } from './displayClient'
import { startCloudDisplayRequest, type CloudDisplayProgress } from './cloudDisplayClient'

// Inert protocol fixtures only: incomplete PNG headers plus a decoder double, NOT images/render evidence.
const origin = 'http://localhost:5173'
const hash = (c = 'a') => `sha256:${c.repeat(64)}`
const build: DisplayBuild = {
  sourceManifestDigest: hash(),
  assetManifestDigest: hash(),
  bundleDigest: hash(),
  lockfileDigest: hash(),
  runtimePolicyDigest: hash(),
  threeRevision: '186',
}
const interestId = 'synthetic-cloud-interest-00001'
function response(url: string, body: unknown, status = 200, png = false) {
  const result = new Response(png ? new Uint8Array(body as Uint8Array) : JSON.stringify(body), {
    status,
    headers: { 'content-type': png ? 'image/png' : 'application/json' },
  })
  Object.defineProperty(result, 'url', { value: url, configurable: true })
  return result
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(design: DesignEnvelope = defaultDesign()) {
  const recipe = structuredClone(await bindCloudRecipe(design, build, hash('b'), hash('c')))
  const bytes = new Uint8Array(44)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const header = new DataView(bytes.buffer)
  header.setUint32(8, 13)
  header.setUint32(12, 0x49484452)
  header.setUint32(16, recipe.binding.profile.width)
  header.setUint32(20, recipe.binding.profile.height)
  const checksum = `sha256:${Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')}`
  const base = { protocol: CLOUD_DISPLAY_PROTOCOL, mode: CLOUD_DISPLAY_MODE, interestId, recipe }
  const reply: CloudDisplayReadyReply = {
    ...base,
    state: 'ready',
    artifact: {
      checksum,
      receiptDigest: hash('d'),
      mediaType: 'image/png',
      byteLength: bytes.length,
      width: recipe.binding.profile.width,
      height: recipe.binding.profile.height,
      src: cloudDisplayImagePath(interestId, checksum),
      exactMatch: true,
      approvedCurrentImage: false,
      cacheStatus: 'verified-exact-hit',
      provenance: {
        kind: 'external-private-three-display',
        label: CLOUD_DISPLAY_LABEL,
        sessionId: 'synthetic-cloud-session-00001',
        revision: 1,
        proofDigest: hash('e'),
        qualified: false,
        productionAllowed: false,
        strictReference: false,
        visualParityClaimed: false,
        holds: displayHolds(design),
      },
    },
  }
  return {
    design,
    bytes,
    reply,
    pending: { ...base, state: 'queued', retryAfterMs: 500 },
    cancelled: { ...base, state: 'cancelled', cancellationScope: 'interest-only' },
  }
}

describe('cloud transport, inert service and decode doubles only', () => {
  const stops: (() => void)[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('crypto', webcrypto)
  })
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  function harness() {
    const events: CloudDisplayProgress[] = []
    const transport = {
      origin,
      fetch: vi.fn<typeof fetch>(),
      decode: vi.fn<DisplayTransport['decode']>().mockResolvedValue({ width: 1600, height: 1000 }),
      createObjectURL: vi.fn<DisplayTransport['createObjectURL']>(() => 'blob:inert-cloud'),
      revokeObjectURL: vi.fn(),
    }
    const start = (design = defaultDesign()) => {
      const stop = startCloudDisplayRequest(design, (event) => events.push(event), transport)
      stops.push(stop)
      return stop
    }
    return { events, transport, start }
  }
  function deliver(
    h: ReturnType<typeof harness>,
    f: Awaited<ReturnType<typeof fixture>>,
    pending = false,
  ) {
    h.transport.decode.mockResolvedValue({
      width: f.reply.artifact.width,
      height: f.reply.artifact.height,
    })
    h.transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return response(url, f.cancelled)
      if (pending && url.endsWith('/images')) return response(url, f.pending, 202)
      return response(url, url.endsWith('.png') ? f.bytes : f.reply, 200, url.endsWith('.png'))
    })
  }
  const settle = async (h: ReturnType<typeof harness>) =>
    vi.waitFor(() => expect(h.events.at(-1)?.state).not.toBe('pending'), { timeout: 3000 })

  it.each(createSceneDesignFixtures())(
    'accepts full $id with exact cloud recipe and no provider fields',
    async ({ design }) => {
      const h = harness(),
        f = await fixture(design)
      deliver(h, f)
      const mutable = structuredClone(design)
      const stop = h.start(mutable)
      Reflect.set(mutable.config.appearance, 'finish', 'bronze')
      await settle(h)
      expect(h.events.at(-1)).toEqual({ state: 'ready', reply: f.reply, src: 'blob:inert-cloud' })
      const [url, options] = h.transport.fetch.mock.calls[0]
      expect(url).toBe(origin + CLOUD_DISPLAY_REQUEST_PATH)
      expect(JSON.parse(String(options?.body))).toEqual({
        protocol: CLOUD_DISPLAY_PROTOCOL,
        design,
      })
      expect(options).toMatchObject({
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      })
      stop()
      expect(h.transport.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:inert-cloud')
      const cancel = h.transport.fetch.mock.calls.at(-1)!
      expect(String(cancel[0])).toMatch(/\/cancel$/)
      expect(JSON.parse(String(cancel[1]?.body))).toEqual({ protocol: CLOUD_DISPLAY_PROTOCOL })
    },
  )
  it('surfaces bounded unconfigured denial without decode, retry, fallback or provider call', async () => {
    const h = harness()
    h.transport.fetch.mockImplementation(async (url) =>
      response(
        String(url),
        {
          protocol: CLOUD_DISPLAY_PROTOCOL,
          error: {
            code: 'execution-denied',
            blocker: 'approval-required',
            message: 'DO NOT REFLECT',
            retryable: false,
          },
        },
        503,
      ),
    )
    h.start()
    await settle(h)
    expect(h.events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect(JSON.stringify(h.events)).toContain('approval-required')
    expect(JSON.stringify(h.events)).not.toContain('DO NOT REFLECT')
    await vi.advanceTimersByTimeAsync(DISPLAY_CLIENT_DEADLINE_MS * 2)
    expect(h.transport.fetch).toHaveBeenCalledOnce()
    expect(h.transport.decode).not.toHaveBeenCalled()
    expect(h.transport.createObjectURL).not.toHaveBeenCalled()
  })
  it.each(['https://localhost:5173', 'http://example.com', 'http://localhost:5173/path'])(
    'rejects origin %s before requests',
    (value) => {
      const h = harness()
      h.transport.origin = value
      h.start()
      expect(h.events.at(-1)?.state).toBe('unavailable')
      expect(h.transport.fetch).not.toHaveBeenCalled()
    },
  )
  it('denies production and non-design control injection before requests', () => {
    const h = harness()
    h.start({ ...defaultDesign(), provider: 'modal' } as DesignEnvelope)
    expect(h.transport.fetch).not.toHaveBeenCalled()
    vi.stubEnv('DEV', false)
    h.start()
    expect(h.transport.fetch).not.toHaveBeenCalled()
    expect(h.events.at(-1)?.state).toBe('unavailable')
  })
  it.each([
    'package',
    'camera',
    'recipe',
    'local',
    'mock',
    'src',
    'dimensions',
    'holds',
    'qualified',
  ])('rejects tampered %s before image fetch', async (field) => {
    const h = harness(),
      f = await fixture()
    if (field === 'package') f.reply.recipe.workerPackageDigest = hash('f')
    if (field === 'camera') f.reply.recipe.cameraDigest = hash('f')
    if (field === 'recipe') f.reply.recipe.recipeDigest = hash('f')
    if (field === 'local') Reflect.set(f.reply.artifact.provenance, 'kind', 'private-three-display')
    if (field === 'mock') Reflect.set(f.reply.artifact.provenance, 'kind', 'mock-diagnostic')
    if (field === 'src') f.reply.artifact.src = 'https://example.com/image.png'
    if (field === 'dimensions') f.reply.artifact.width = 640
    if (field === 'holds') f.reply.artifact.provenance.holds = ['changed']
    if (field === 'qualified') Reflect.set(f.reply.artifact.provenance, 'qualified', true)
    deliver(h, f)
    h.start()
    await settle(h)
    expect(h.events.at(-1)?.state).toBe('error')
    expect(h.transport.fetch.mock.calls.some(([url]) => String(url).endsWith('.png'))).toBe(false)
    expect(h.transport.decode).not.toHaveBeenCalled()
  })
  it('rejects valid but changed package/camera identity on polling', async () => {
    const h = harness(),
      f = await fixture()
    const changed = structuredClone(f.reply)
    changed.recipe = await bindCloudRecipe(f.design, build, hash('f'), hash('e'))
    h.transport.fetch.mockImplementation(async (url) =>
      response(
        String(url),
        String(url).endsWith('/images') ? f.pending : changed,
        String(url).endsWith('/images') ? 202 : 200,
      ),
    )
    h.start()
    await settle(h)
    expect(h.events.at(-1)?.state).toBe('error')
    expect(h.transport.decode).not.toHaveBeenCalled()
  })
  it.each(['hash', 'header', 'length', 'decode'])(
    'rejects %s byte/decode mismatch without publication',
    async (field) => {
      const h = harness(),
        f = await fixture()
      if (field === 'hash') f.bytes[43] = 1
      if (field === 'header') f.bytes[0] = 0
      if (field === 'length') f.reply.artifact.byteLength++
      deliver(h, f)
      if (field === 'decode') h.transport.decode.mockResolvedValue({ width: 640, height: 400 })
      h.start()
      await settle(h)
      expect(h.events.at(-1)?.state).toBe('error')
      expect(h.transport.createObjectURL).not.toHaveBeenCalled()
    },
  )
  it.each(['redirect', 'html', 'compressed', 'oversized', 'status'])(
    'rejects %s transport without image publication',
    async (field) => {
      const h = harness(),
        f = await fixture()
      h.transport.fetch.mockImplementation(async (url) => {
        const r = response(String(url), f.reply, field === 'status' ? 202 : 200)
        if (field === 'redirect') Object.defineProperty(r, 'redirected', { value: true })
        if (field === 'html') r.headers.set('content-type', 'text/html')
        if (field === 'compressed') r.headers.set('content-encoding', 'gzip')
        if (field === 'oversized')
          r.headers.set('content-length', String(DISPLAY_LIMITS.replyBytes + 1))
        return r
      })
      h.start()
      await settle(h)
      expect(h.events.at(-1)?.state).not.toBe('ready')
      expect(h.transport.decode).not.toHaveBeenCalled()
    },
  )
  it('does not publish a stale decode and detaches only its interest', async () => {
    const h = harness(),
      f = await fixture(),
      decode = deferred<{ width: number; height: number }>()
    deliver(h, f)
    h.transport.decode.mockReturnValue(decode.promise)
    const stop = h.start()
    await vi.waitFor(() => expect(h.transport.decode).toHaveBeenCalledOnce())
    stop()
    decode.resolve({ width: f.reply.artifact.width, height: f.reply.artifact.height })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.events).toEqual([{ state: 'pending' }])
    expect(h.transport.createObjectURL).not.toHaveBeenCalled()
    expect(
      h.transport.fetch.mock.calls.filter(([url]) => String(url).endsWith('/cancel')),
    ).toHaveLength(1)
  })
  it('validates and detaches late POST admission without polling or decoding', async () => {
    const h = harness(),
      f = await fixture(),
      post = deferred<Response>()
    h.transport.fetch.mockImplementation(async (url) =>
      String(url).endsWith('/images') ? post.promise : response(String(url), f.cancelled),
    )
    const stop = h.start()
    await vi.advanceTimersByTimeAsync(120)
    stop()
    post.resolve(response(origin + CLOUD_DISPLAY_REQUEST_PATH, f.pending, 202))
    await vi.waitFor(() => expect(h.transport.fetch).toHaveBeenCalledTimes(2))
    expect(h.transport.decode).not.toHaveBeenCalled()
    expect(h.events).toEqual([{ state: 'pending' }])
  })
  it('expires once and never submits another job', async () => {
    const h = harness(),
      f = await fixture()
    h.transport.fetch.mockImplementation(async (url) =>
      response(
        String(url),
        String(url).endsWith('/cancel') ? f.cancelled : { ...f.pending, retryAfterMs: 30000 },
        String(url).endsWith('/cancel') ? 200 : 202,
      ),
    )
    h.start()
    await vi.waitFor(() => expect(h.transport.fetch).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(DISPLAY_CLIENT_DEADLINE_MS)
    expect(h.events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect(
      h.transport.fetch.mock.calls.filter(([url]) => String(url).endsWith('/images')),
    ).toHaveLength(1)
    expect(h.transport.createObjectURL).not.toHaveBeenCalled()
  })
  it('requires the exact selected full design', async () => {
    const h = harness(),
      f = await fixture()
    deliver(h, f)
    h.start(
      parseDesign({
        ...f.design,
        config: {
          ...f.design.config,
          appearance: { ...f.design.config.appearance, finish: 'bronze' },
        },
      }),
    )
    await settle(h)
    expect(h.events.at(-1)?.state).toBe('error')
    expect(h.transport.decode).not.toHaveBeenCalled()
  })
})
