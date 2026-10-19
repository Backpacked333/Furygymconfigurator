import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, type DesignEnvelope } from '../domain/design'
import { createSceneDesignFixtures } from '../domain/designFixtures'
import {
  DISPLAY_FLAGS,
  DISPLAY_LABEL,
  DISPLAY_LIMITS,
  DISPLAY_MODE,
  DISPLAY_PROTOCOL,
  DISPLAY_REQUEST_PATH,
  bindDisplay,
  displayHolds,
  displayImagePath,
  displayStatusPath,
  type DisplayBuild,
  type DisplayReadyReply,
} from '../display/contract'
import {
  DISPLAY_CLIENT_DEADLINE_MS,
  DISPLAY_CLIENT_POLL_LIMIT,
  decodeDisplayImage,
  startDisplayRequest,
  type DisplayProgress,
  type DisplayTransport,
} from './displayClient'

// Synthetic header bytes and decoder doubles ONLY. These are not complete PNGs or render evidence.
const origin = 'http://localhost:5173'
const digest = (c = 'a') => `sha256:${c.repeat(64)}`
const build: DisplayBuild = {
  sourceManifestDigest: digest(),
  assetManifestDigest: digest(),
  bundleDigest: digest(),
  lockfileDigest: digest(),
  runtimePolicyDigest: digest(),
  threeRevision: '186',
}
const id = 'synthetic-display-interest-00001'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function response(url: string, body: unknown, status = 200, png = false) {
  const result = new Response(png ? new Uint8Array(body as Uint8Array) : JSON.stringify(body), {
    status,
    headers: { 'content-type': png ? 'image/png' : 'application/json' },
  })
  Object.defineProperty(result, 'url', { value: url, configurable: true })
  return result
}
async function fixture(design: DesignEnvelope = defaultDesign(), interestId = id) {
  const binding = await bindDisplay(design, build)
  const bytes = new Uint8Array(44)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const header = new DataView(bytes.buffer)
  header.setUint32(8, 13)
  header.setUint32(12, 0x49484452)
  header.setUint32(16, binding.profile.width)
  header.setUint32(20, binding.profile.height)
  const checksum = `sha256:${Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')}`
  const base = { protocol: DISPLAY_PROTOCOL, mode: DISPLAY_MODE, interestId, binding }
  const reply: DisplayReadyReply = {
    ...base,
    state: 'ready',
    artifact: {
      checksum,
      receiptDigest: digest('b'),
      mediaType: 'image/png',
      byteLength: bytes.length,
      width: binding.profile.width,
      height: binding.profile.height,
      src: displayImagePath(interestId, checksum),
      exactMatch: true,
      approvedCurrentImage: false,
      cacheStatus: 'verified-exact-hit',
      provenance: {
        kind: 'private-three-display',
        label: DISPLAY_LABEL,
        sessionId: 'synthetic-display-session-00001',
        revision: 1,
        flags: DISPLAY_FLAGS,
        holds: displayHolds(design),
      },
    },
  }
  return {
    design,
    bytes,
    reply,
    pending: { ...base, state: 'queued' as const, retryAfterMs: 500 },
    cancelled: {
      ...base,
      state: 'cancelled' as const,
      cancellationScope: 'interest-only' as const,
    },
  }
}

describe('private display transport (only synthetic responses; no server/GPU)', () => {
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
    const events: DisplayProgress[] = []
    const transport = {
      origin,
      fetch: vi.fn<typeof fetch>(),
      decode: vi.fn<DisplayTransport['decode']>().mockResolvedValue({ width: 1600, height: 1000 }),
      createObjectURL: vi.fn<DisplayTransport['createObjectURL']>(() => 'blob:synthetic-display'),
      revokeObjectURL: vi.fn(),
    }
    const start = (design = defaultDesign()) => {
      const stop = startDisplayRequest(design, (event) => events.push(event), transport)
      stops.push(stop)
      return stop
    }
    return { events, transport, start }
  }
  function deliver(
    transport: ReturnType<typeof harness>['transport'],
    f: Awaited<ReturnType<typeof fixture>>,
    pending = false,
  ) {
    transport.decode.mockResolvedValue({
      width: f.reply.artifact.width,
      height: f.reply.artifact.height,
    })
    transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return response(url, f.cancelled)
      if (pending && url.endsWith('/images')) return response(url, f.pending, 202)
      return response(url, url.endsWith('.png') ? f.bytes : f.reply, 200, url.endsWith('.png'))
    })
  }
  const settle = async (events: DisplayProgress[]) => {
    await vi.waitFor(() => expect(events.at(-1)?.state).not.toBe('pending'), { timeout: 3000 })
  }

  it.each(createSceneDesignFixtures())(
    'accepts complete $id without a Lite sample restriction',
    async ({ design }) => {
      const h = harness(),
        f = await fixture(design)
      deliver(h.transport, f)
      const mutable = structuredClone(design)
      const stop = h.start(mutable)
      Reflect.set(mutable.config.appearance, 'finish', 'bronze')
      await settle(h.events)
      expect(h.events.at(-1)).toMatchObject({
        state: 'ready',
        reply: f.reply,
        src: 'blob:synthetic-display',
      })
      expect(h.transport.fetch.mock.calls[0][0]).toBe(origin + DISPLAY_REQUEST_PATH)
      expect(h.transport.fetch.mock.calls[0][1]).toMatchObject({
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      })
      expect(JSON.parse(h.transport.fetch.mock.calls[0][1]!.body as string)).toEqual({
        protocol: DISPLAY_PROTOCOL,
        design,
      })
      expect(h.transport.decode).toHaveBeenCalledExactlyOnceWith(f.bytes, expect.any(AbortSignal))
      stop()
      stop()
      expect(h.transport.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-display')
      expect(h.transport.fetch.mock.calls.at(-1)?.[0]).toBe(
        origin + displayStatusPath(id) + '/cancel',
      )
      expect(JSON.parse(h.transport.fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
        protocol: DISPLAY_PROTOCOL,
      })
    },
  )
  it('accepts tall full-quality profile, thumbnail semantic identity and immutable polling', async () => {
    const base = defaultDesign()
    const design = parseDesign({
      ...base,
      presentation: { ...base.presentation, aspect: 'tall', lookRef: 'studio-night-draft@1' },
      outputProfile: 'web-thumbnail',
    })
    const h = harness(),
      f = await fixture(design)
    deliver(h.transport, f, true)
    h.start(design)
    await settle(h.events)
    expect(h.events.at(-1)).toMatchObject({
      state: 'ready',
      reply: { binding: { profile: { width: 1200, height: 1500, quality: 'ultra' } } },
    })
    expect(h.transport.fetch.mock.calls.map(([url]) => url)).toEqual([
      origin + DISPLAY_REQUEST_PATH,
      origin + displayStatusPath(id),
      origin + f.reply.artifact.src,
    ])
  })
  it.each([
    'https://example.com',
    'http://localhost.evil:5173',
    origin + '/',
    'http://user@localhost:5173',
    'https://localhost:5173',
  ])('refuses origin %s', (value) => {
    const h = harness()
    h.transport.origin = value
    h.start()
    expect(h.events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect(h.transport.fetch).not.toHaveBeenCalled()
  })
  it('denies production and invalid designs before any request', () => {
    const h = harness()
    h.start({ ...defaultDesign(), provider: 'paid' } as DesignEnvelope)
    vi.stubEnv('DEV', false)
    h.start()
    expect(h.transport.fetch).not.toHaveBeenCalled()
    expect(h.events.map((event) => event.state)).toEqual(['unavailable', 'unavailable'])
  })
  it('collapses edits/unmount before admission without any request', async () => {
    const h = harness()
    h.start()()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.transport.fetch).not.toHaveBeenCalled()
  })
  it.each([
    'binding',
    'build',
    'valid-build-drift',
    'interest',
    'profile',
    'route',
    'remote-route',
    'dimensions',
    'holds',
    'approved',
    'flags',
    'kind',
    'mode',
  ])('rejects %s metadata before image retrieval', async (mode) => {
    const h = harness(),
      f = await fixture()
    const altered = structuredClone(f.reply)
    if (mode === 'binding') altered.binding.displayDigest = digest('c')
    if (mode === 'build') altered.binding.build.runtimePolicyDigest = digest('c')
    if (mode === 'valid-build-drift')
      altered.binding = await bindDisplay(f.design, { ...build, runtimePolicyDigest: digest('c') })
    if (mode === 'interest') altered.interestId = 'another-synthetic-interest-0001'
    if (mode === 'profile') Reflect.set(altered.binding.profile, 'quality', 'lite')
    if (mode === 'route') altered.artifact.src = '/stills/historical.png'
    if (mode === 'remote-route') altered.artifact.src = 'https://evil.test/image.png'
    if (mode === 'dimensions') altered.artifact.width = 640
    if (mode === 'holds') altered.artifact.provenance.holds = ['Approved']
    if (mode === 'approved') Reflect.set(altered.artifact, 'approvedCurrentImage', true)
    if (mode === 'flags') Reflect.set(altered.artifact.provenance.flags, 'qualified', true)
    if (mode === 'kind') Reflect.set(altered.artifact.provenance, 'kind', 'local-three-capture')
    if (mode === 'mode') Reflect.set(altered, 'mode', 'mock')
    h.transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      return response(
        url,
        url.endsWith('/images') ? f.pending : altered,
        url.endsWith('/images') ? 202 : 200,
      )
    })
    h.start()
    await settle(h.events)
    expect(h.events.at(-1)).toMatchObject({ state: 'error', retryable: false })
    expect(h.transport.decode).not.toHaveBeenCalled()
    expect(h.transport.fetch.mock.calls.some(([url]) => String(url).endsWith('.png'))).toBe(false)
  })
  it.each([
    'hash',
    'signature',
    'header',
    'length',
    'decode-dimensions',
    'decode-failure',
    'media',
    'redirect',
    'destination',
    'encoding',
    'oversize',
    'http',
  ])('rejects %s PNG delivery', async (mode) => {
    const h = harness(),
      f = await fixture()
    let bytes = new Uint8Array(f.bytes)
    if (mode === 'hash') bytes[43] ^= 1
    if (mode === 'signature') bytes[0] = 0
    if (mode === 'header') bytes[19] ^= 1
    if (mode === 'length') bytes = bytes.slice(0, -1)
    if (mode === 'oversize') bytes = new Uint8Array(DISPLAY_LIMITS.pngBytes + 1)
    if (mode === 'decode-dimensions')
      h.transport.decode.mockResolvedValue({ width: 640, height: 400 })
    if (mode === 'decode-failure')
      h.transport.decode.mockRejectedValue(new Error('Synthetic failure'))
    h.transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (!url.endsWith('.png')) return response(url, f.reply)
      const result = response(url, bytes, mode === 'http' ? 404 : 200, true)
      if (mode === 'media') result.headers.set('content-type', 'image/svg+xml')
      if (mode === 'encoding') result.headers.set('content-encoding', 'gzip')
      if (mode === 'redirect') Object.defineProperty(result, 'redirected', { value: true })
      if (mode === 'destination')
        Object.defineProperty(result, 'url', { value: 'http://evil.test/' })
      return result
    })
    h.start()
    await settle(h.events)
    expect(h.events.at(-1)?.state).toMatch(/error|unavailable/)
    expect(h.transport.createObjectURL).not.toHaveBeenCalled()
    expect(
      h.transport.fetch.mock.calls.filter(([url]) => String(url).endsWith('/images')),
    ).toHaveLength(1)
  })
  it.each([
    'oversize',
    'dishonest-length',
    'invalid-json',
    'ready-202',
    'pending-200',
    'pending-poll-200',
    'html',
    'redirect',
    'url',
    'compressed',
  ])('rejects %s metadata with no retry', async (mode) => {
    const h = harness(),
      f = await fixture()
    h.transport.fetch.mockImplementation(async (input) => {
      const url = String(input),
        poll = mode === 'pending-poll-200'
      const result = response(
        url,
        mode === 'oversize'
          ? 'x'.repeat(DISPLAY_LIMITS.replyBytes)
          : mode === 'pending-200' || poll
            ? f.pending
            : f.reply,
        mode === 'ready-202' || (poll && url.endsWith('/images')) ? 202 : 200,
      )
      if (mode === 'dishonest-length') result.headers.set('content-length', '1')
      if (mode === 'invalid-json') {
        const broken = new Response('{', { headers: { 'content-type': 'application/json' } })
        Object.defineProperty(broken, 'url', { value: url })
        return broken
      }
      if (mode === 'html') result.headers.set('content-type', 'text/html')
      if (mode === 'redirect') Object.defineProperty(result, 'redirected', { value: true })
      if (mode === 'url') Object.defineProperty(result, 'url', { value: origin + '/fallback' })
      if (mode === 'compressed') result.headers.set('content-encoding', 'gzip')
      return result
    })
    h.start()
    await settle(h.events)
    expect(h.events.at(-1)?.state).toMatch(/error|unavailable/)
    expect(h.transport.decode).not.toHaveBeenCalled()
  })
  it.each(['execution-denied', 'unavailable', 'capacity-exceeded', 'forbidden'] as const)(
    'reports %s without displaying provider error text or retrying',
    async (code) => {
      const h = harness()
      h.transport.fetch.mockImplementation(async (input) =>
        response(
          String(input),
          {
            protocol: DISPLAY_PROTOCOL,
            error: { code, message: 'sensitive server text', retryable: false },
          },
          503,
        ),
      )
      h.start()
      await settle(h.events)
      expect(h.events.at(-1)).toMatchObject({
        state: 'unavailable',
        retryable: false,
        message: expect.stringContaining(code),
      })
      expect(JSON.stringify(h.events)).not.toContain('sensitive server text')
      await vi.advanceTimersByTimeAsync(DISPLAY_CLIENT_DEADLINE_MS)
      expect(h.transport.fetch).toHaveBeenCalledOnce()
    },
  )
  it.each(['failed', 'expired', 'cancelled'] as const)(
    'handles terminal %s interest without retrying',
    async (state) => {
      const h = harness(),
        f = await fixture()
      const { retryAfterMs, ...base } = f.pending
      expect(retryAfterMs).toBe(500)
      const terminal = {
        ...base,
        state,
        ...(state === 'failed'
          ? { error: { code: 'render-failed', message: 'Synthetic failure', retryable: false } }
          : state === 'cancelled'
            ? { cancellationScope: 'interest-only' }
            : {}),
      }
      h.transport.fetch.mockImplementation(async (input) =>
        response(
          String(input),
          String(input).endsWith('/images') ? f.pending : terminal,
          String(input).endsWith('/images') ? 202 : 200,
        ),
      )
      h.start()
      await settle(h.events)
      expect(h.events.at(-1)?.state).toMatch(/error|unavailable/)
      expect(h.transport.decode).not.toHaveBeenCalled()
    },
  )
  it('aborts hanging metadata streams at the original deadline', async () => {
    const h = harness(),
      cancel = vi.fn()
    const result = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
        },
        cancel,
      }),
      { headers: { 'content-type': 'application/json' } },
    )
    Object.defineProperty(result, 'url', { value: origin + DISPLAY_REQUEST_PATH })
    h.transport.fetch.mockResolvedValue(result)
    h.start()
    await vi.advanceTimersByTimeAsync(DISPLAY_CLIENT_DEADLINE_MS)
    expect(h.events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.transport.fetch).toHaveBeenCalledOnce()
  })
  it('times out a hanging transport without resubmission', async () => {
    const h = harness()
    h.transport.fetch.mockImplementation(() => new Promise(() => undefined))
    h.start()
    await vi.advanceTimersByTimeAsync(DISPLAY_CLIENT_DEADLINE_MS * 2)
    expect(h.events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect(h.transport.fetch).toHaveBeenCalledOnce()
    expect(h.transport.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('detaches only a late admitted interest after unmount, without polling or decoding', async () => {
    const h = harness(),
      f = await fixture(),
      held = deferred<Response>()
    h.transport.fetch
      .mockReturnValueOnce(held.promise)
      .mockImplementation(async (input) => response(String(input), f.cancelled))
    const stop = h.start()
    await vi.advanceTimersByTimeAsync(120)
    stop()
    held.resolve(response(origin + DISPLAY_REQUEST_PATH, f.pending, 202))
    await vi.waitFor(() => expect(h.transport.fetch).toHaveBeenCalledTimes(2))
    expect(h.transport.fetch.mock.calls[1][0]).toBe(origin + displayStatusPath(id) + '/cancel')
    expect(h.events).toEqual([{ state: 'pending' }])
    expect(h.transport.decode).not.toHaveBeenCalled()
  })
  it.each(['hash', 'decode'] as const)('fences delayed PNG %s across A→B→A', async (phase) => {
    const h = harness(),
      a = await fixture(),
      b = await fixture(defaultDesign({ family: 'container', lengthFt: 40 }))
    const held = deferred<ArrayBuffer>(),
      decoded = deferred<{ width: number; height: number }>()
    const actualDigest = webcrypto.subtle.digest.bind(webcrypto.subtle)
    let hash: ArrayBuffer | undefined,
      intercepted = false
    if (phase === 'hash')
      vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        if (
          !intercepted &&
          ArrayBuffer.isView(data) &&
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength)[0] === 137
        ) {
          intercepted = true
          hash = await actualDigest(algorithm, data)
          return held.promise
        }
        return actualDigest(algorithm, data)
      })
    deliver(h.transport, a)
    if (phase === 'decode') h.transport.decode.mockReturnValueOnce(decoded.promise)
    const stopA = h.start()
    await vi.waitFor(() =>
      expect(phase === 'hash' ? hash !== undefined : h.transport.decode.mock.calls.length > 0).toBe(
        true,
      ),
    )
    stopA()
    deliver(h.transport, b)
    const stopB = h.start(b.design)
    await settle(h.events)
    stopB()
    deliver(h.transport, a)
    h.start()
    await settle(h.events)
    const before = h.events.length
    if (phase === 'hash') held.resolve(hash!)
    else decoded.resolve({ width: 1600, height: 1000 })
    await vi.advanceTimersByTimeAsync(1)
    expect(h.events).toHaveLength(before)
    expect(h.events.filter((event) => event.state === 'ready')).toHaveLength(2)
    expect(h.transport.createObjectURL).toHaveBeenCalledTimes(2)
  })
  it('stops at the polling count bound without resetting the original interest or retrying', async () => {
    const h = harness(),
      f = await fixture()
    const realDigest = webcrypto.subtle.digest.bind(webcrypto.subtle)
    // Memoize real digests of these identical test binding bytes to keep 600 polls CPU-only/fast.
    const digests = new Map<string, Promise<ArrayBuffer>>()
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      const key = ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex')
        : Buffer.from(data as ArrayBuffer).toString('hex')
      if (!digests.has(key)) digests.set(key, realDigest(algorithm, data))
      return digests.get(key)!
    })
    h.transport.fetch.mockImplementation(async (input) =>
      response(
        String(input),
        String(input).endsWith('/cancel') ? f.cancelled : f.pending,
        String(input).endsWith('/cancel') ? 200 : 202,
      ),
    )
    h.start()
    await vi.waitFor(() => expect(h.transport.fetch.mock.calls.length).toBeGreaterThan(1))
    await vi.advanceTimersByTimeAsync(DISPLAY_CLIENT_POLL_LIMIT * 500 + 500)
    expect(h.events.at(-1)).toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('polling cap'),
      retryable: false,
    })
    expect(
      h.transport.fetch.mock.calls.filter(([url]) => url === origin + displayStatusPath(id)),
    ).toHaveLength(DISPLAY_CLIENT_POLL_LIMIT)
    expect(
      h.transport.fetch.mock.calls.filter(([url]) => String(url).endsWith('/images')),
    ).toHaveLength(1)
    expect(h.transport.decode).not.toHaveBeenCalled()
  })
  it('cancellation during initial identity hashing preserves only the validated interest for detach', async () => {
    const h = harness(),
      f = await fixture(),
      held = deferred<ArrayBuffer>()
    const actual = webcrypto.subtle.digest.bind(webcrypto.subtle)
    let first: ArrayBuffer | undefined,
      intercepted = false
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      if (!intercepted) {
        intercepted = true
        first = await actual(algorithm, data)
        return held.promise
      }
      return actual(algorithm, data)
    })
    deliver(h.transport, f)
    const stop = h.start()
    await vi.waitFor(() => expect(first).toBeDefined())
    stop()
    held.resolve(first!)
    await vi.waitFor(() => expect(h.transport.fetch).toHaveBeenCalledTimes(2))
    expect(h.transport.fetch.mock.calls[1][0]).toBe(origin + displayStatusPath(id) + '/cancel')
    expect(h.events).toEqual([{ state: 'pending' }])
    expect(h.transport.decode).not.toHaveBeenCalled()
  })
  it('closes late bitmaps and revokes temporary Image.decode URLs on abort', async () => {
    const bitmap = deferred<ImageBitmap>(),
      close = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => bitmap.promise),
    )
    const controller = new AbortController(),
      decoding = decodeDisplayImage(new Uint8Array(), controller.signal)
    const rejected = expect(decoding).rejects.toThrow()
    controller.abort()
    bitmap.resolve({ width: 1600, height: 1000, close } as ImageBitmap)
    await rejected
    expect(close).toHaveBeenCalledOnce()
    vi.stubGlobal('createImageBitmap', undefined)
    const NativeURL = URL,
      revoke = vi.fn()
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        static createObjectURL = () => 'blob:temporary'
        static revokeObjectURL = revoke
      },
    )
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        decode() {
          return new Promise(() => undefined)
        }
      },
    )
    const fallback = new AbortController(),
      decode = decodeDisplayImage(new Uint8Array(), fallback.signal)
    const failed = expect(decode).rejects.toThrow()
    fallback.abort()
    await failed
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:temporary')
  })
})
