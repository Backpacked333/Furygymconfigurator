import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { parseDesign } from '../domain/design'
import {
  LOCAL_RENDER_REQUEST_PATH,
  MAX_LOCAL_RENDER_PNG_BYTES,
  MAX_LOCAL_RENDER_REPLY_BYTES,
  localRenderDesign,
} from '../image-service/localRenderProtocol'
import {
  startLocalRenderRequest,
  decodeLocalRenderImage,
  LOCAL_RENDER_CLIENT_DEADLINE_MS,
  type LocalRenderProgress,
  type LocalRenderTransport,
} from './localRenderClient'
import {
  deferred,
  fakeResponse,
  localFixture,
  syntheticHash,
  TEST_ORIGIN,
} from './localRenderClient.fixtures'

// All fetch/decode/object-URL implementations here are declared fakes. No renderer or network.
describe('local render client: exact transport, byte validation and bounded lifetime', () => {
  const stops: (() => void)[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('crypto', webcrypto)
  })
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
  function harness() {
    const events: LocalRenderProgress[] = []
    const transport = {
      origin: TEST_ORIGIN,
      fetch: vi.fn<typeof fetch>(),
      decode: vi
        .fn<LocalRenderTransport['decode']>()
        .mockResolvedValue({ width: 640, height: 400 }),
      createObjectURL: vi.fn<LocalRenderTransport['createObjectURL']>(
        () => 'blob:synthetic-verified-image',
      ),
      revokeObjectURL: vi.fn(),
    }
    function start(design = localRenderDesign('obsidian')) {
      const stop = startLocalRenderRequest(design, (event) => events.push(event), transport)
      stops.push(stop)
      return stop
    }
    return { events, transport, start }
  }
  async function settle(events: LocalRenderProgress[]) {
    await vi.waitFor(() => expect(events.at(-1)?.state).not.toBe('pending'), { timeout: 3000 })
  }
  async function readyFetch(
    transport: ReturnType<typeof harness>['transport'],
    finish: 'obsidian' | 'bronze' = 'obsidian',
  ) {
    const fixture = await localFixture(finish)
    transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return fakeResponse(url, { error: 'test detach response' }, 404)
      return fakeResponse(
        url,
        url.endsWith('.png') ? fixture.bytes : fixture.reply,
        200,
        url.endsWith('.png'),
      )
    })
    return fixture
  }
  it.each(['obsidian', 'bronze'] as const)(
    'validates full %s binding and bytes before exposing a client-owned URL',
    async (finish) => {
      const { events, transport, start } = harness()
      const fixture = await readyFetch(transport, finish)
      const stop = start(fixture.design)
      await vi.advanceTimersByTimeAsync(120)
      await settle(events)
      expect(events.at(-1)).toMatchObject({
        state: 'ready',
        reply: fixture.reply,
        src: 'blob:synthetic-verified-image',
      })
      const [url, options] = transport.fetch.mock.calls[0]
      expect(url).toBe(TEST_ORIGIN + LOCAL_RENDER_REQUEST_PATH)
      expect(options).toMatchObject({
        redirect: 'error',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      expect(JSON.parse(options!.body as string).design).toEqual(fixture.design)
      expect(transport.fetch.mock.calls[1][0]).toBe(TEST_ORIGIN + fixture.reply.artifact.src)
      expect(transport.decode).toHaveBeenCalledWith(fixture.bytes, expect.any(AbortSignal))
      expect(transport.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob)
      stop()
      expect(transport.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
        'blob:synthetic-verified-image',
      )
      expect(transport.fetch.mock.calls.at(-1)?.[0]).toMatch(/\/cancel$/)
      stop()
      expect(transport.revokeObjectURL).toHaveBeenCalledOnce()
    },
  )
  it('does not admit unsupported full envelopes or nonloopback origins', async () => {
    for (const design of [
      parseDesign({ ...localRenderDesign('bronze'), outputProfile: 'web-thumbnail' }),
      parseDesign({
        ...localRenderDesign('obsidian'),
        presentation: { ...localRenderDesign('obsidian').presentation, aspect: 'tall' },
      }),
    ]) {
      const { events, transport, start } = harness()
      start(design)
      expect(events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
      expect(transport.fetch).not.toHaveBeenCalled()
    }
    for (const origin of [
      'https://example.com',
      'http://localhost.evil:3000',
      'http://user@localhost:3000',
      TEST_ORIGIN + '/',
    ]) {
      const { events, transport, start } = harness()
      transport.origin = origin
      start()
      expect(events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
      expect(transport.fetch).not.toHaveBeenCalled()
    }
  })
  it('fails closed outside DEV even with a loopback origin', () => {
    vi.stubEnv('DEV', false)
    const { events, transport, start } = harness()
    start()
    expect(events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect(transport.fetch).not.toHaveBeenCalled()
  })
  it('snapshots the full caller envelope before admission', async () => {
    const { events, transport, start } = harness()
    const fixture = await readyFetch(transport)
    const mutable = structuredClone(fixture.design)
    start(mutable)
    Reflect.set(mutable.config.appearance, 'finish', 'bronze')
    await vi.advanceTimersByTimeAsync(120)
    await settle(events)
    expect(events.at(-1)?.state).toBe('ready')
    expect(JSON.parse(transport.fetch.mock.calls[0][1]!.body as string).design).toEqual(
      fixture.design,
    )
  })
  it('cancels a hanging response stream at the original deadline', async () => {
    const { events, transport, start } = harness()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel,
    })
    const response = new Response(stream, {
      headers: { 'content-type': 'application/json', 'content-length': '1' },
    })
    Object.defineProperty(response, 'url', { value: TEST_ORIGIN + LOCAL_RENDER_REQUEST_PATH })
    transport.fetch.mockResolvedValue(response)
    start()
    await vi.advanceTimersByTimeAsync(LOCAL_RENDER_CLIENT_DEADLINE_MS)
    expect(events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect(cancel).toHaveBeenCalledOnce()
    expect(transport.fetch).toHaveBeenCalledOnce()
  })
  it.each(['failed', 'expired', 'cancelled'] as const)(
    'handles %s interests without resubmission',
    async (state) => {
      const { events, transport, start } = harness()
      const fixture = await localFixture()
      const { retryAfterMs, ...base } = fixture.pending
      expect(retryAfterMs).toBe(500)
      const terminal = {
        ...base,
        state,
        ...(state === 'failed'
          ? {
              error: {
                code: 'capture-failed',
                message: 'Synthetic test failure',
                retryable: false,
              },
            }
          : state === 'cancelled'
            ? { cancellationScope: 'interest-only', sharedWorkCancelled: false }
            : {}),
      }
      transport.fetch.mockImplementation(async (input) =>
        fakeResponse(
          String(input),
          String(input).endsWith('/images') ? fixture.pending : terminal,
          String(input).endsWith('/images') ? 202 : 200,
        ),
      )
      start()
      await vi.advanceTimersByTimeAsync(120)
      await settle(events)
      expect(events.at(-1)?.state).toMatch(/error|unavailable/)
      expect(events.at(-1)).toMatchObject({ retryable: false })
      expect(
        transport.fetch.mock.calls.filter(([url]) => String(url).endsWith('/images')),
      ).toHaveLength(1)
      expect(transport.decode).not.toHaveBeenCalled()
    },
  )
  it('closes a late bitmap after cancellation and releases temporary Image.decode URLs on abort', async () => {
    const bitmap = deferred<ImageBitmap>()
    const close = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => bitmap.promise),
    )
    const controller = new AbortController()
    const decoding = decodeLocalRenderImage(new Uint8Array(), controller.signal)
    const rejected = expect(decoding).rejects.toThrow()
    controller.abort()
    bitmap.resolve({ width: 640, height: 400, close } as unknown as ImageBitmap)
    await rejected
    expect(close).toHaveBeenCalledOnce()
    vi.stubGlobal('createImageBitmap', undefined)
    const revoke = vi.fn()
    const NativeURL = URL
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        static createObjectURL = vi.fn(() => 'blob:temporary-decode')
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
    const fallbackController = new AbortController()
    const fallback = decodeLocalRenderImage(new Uint8Array(), fallbackController.signal)
    const fallbackRejected = expect(fallback).rejects.toThrow()
    fallbackController.abort()
    await fallbackRejected
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:temporary-decode')
  })
  it('debounces rapid changes and cleanup before admission starts no request', async () => {
    const { transport, start } = harness()
    start()()
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.fetch).not.toHaveBeenCalled()
  })
  it.each([
    'wrong-finish',
    'wrong-interest',
    'capture-drift',
    'build-drift',
    'profile-drift',
    'historical-src',
    'wrong-sample',
    'mock-mode',
  ])('rejects %s replies before image retrieval', async (mode) => {
    const { events, transport, start } = harness()
    const fixture = await localFixture()
    const altered = structuredClone(fixture.reply)
    if (mode === 'wrong-finish') altered.requested = (await localFixture('bronze')).reply.requested
    if (mode === 'wrong-interest') altered.interestId = 'synthetic-different-interest-12345'
    if (mode === 'capture-drift') altered.capture.captureDigest = syntheticHash('0')
    if (mode === 'build-drift') altered.capture.build.assetManifestDigest = syntheticHash('0')
    if (mode === 'profile-drift') Reflect.set(altered.capture.profile, 'msaaSamples', 1)
    if (mode === 'historical-src') altered.artifact.src = '/stills/97f204ffff/historical.webp'
    if (mode === 'wrong-sample')
      altered.artifact.provenance.sampleId = 'studio-20-bronze-front-left-wide'
    if (mode === 'mock-mode') Reflect.set(altered, 'mode', 'mock')
    transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      return fakeResponse(
        url,
        url.endsWith('/images') ? fixture.pending : altered,
        url.endsWith('/images') ? 202 : 200,
      )
    })
    start()
    await vi.advanceTimersByTimeAsync(120)
    await settle(events)
    expect(events.at(-1)).toMatchObject({ state: 'error', retryable: false })
    expect(transport.decode).not.toHaveBeenCalled()
    expect(transport.fetch.mock.calls.some(([url]) => String(url).endsWith('.png'))).toBe(false)
  })
  it.each([
    'bad-hash',
    'bad-header',
    'bad-size',
    'bad-decode',
    'wrong-type',
    'redirect',
    'wrong-url',
    'compressed',
    'oversize',
    'not-found',
  ])('rejects %s PNG delivery without showing it or retrying', async (mode) => {
    const { events, transport, start } = harness()
    const fixture = await localFixture()
    let bytes = new Uint8Array(fixture.bytes)
    if (mode === 'bad-hash') bytes[43] ^= 1
    if (mode === 'bad-header') bytes[0] = 0
    if (mode === 'bad-size') bytes = bytes.slice(0, -1)
    if (mode === 'oversize') bytes = new Uint8Array(MAX_LOCAL_RENDER_PNG_BYTES + 1)
    if (mode === 'bad-decode') transport.decode.mockResolvedValue({ width: 1, height: 400 })
    transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (!url.endsWith('.png')) return fakeResponse(url, fixture.reply)
      const response = fakeResponse(url, bytes, mode === 'not-found' ? 404 : 200, true)
      if (mode === 'wrong-type') response.headers.set('content-type', 'image/svg+xml')
      if (mode === 'compressed') response.headers.set('content-encoding', 'gzip')
      if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true })
      if (mode === 'wrong-url')
        Object.defineProperty(response, 'url', { value: 'http://evil.test/image.png' })
      return response
    })
    start()
    await vi.advanceTimersByTimeAsync(120)
    await settle(events)
    expect(events.at(-1)?.state).toMatch(/error|unavailable/)
    expect(events.at(-1)).toMatchObject({ retryable: false })
    expect(transport.createObjectURL).not.toHaveBeenCalled()
    expect(
      transport.fetch.mock.calls.filter(([url]) => String(url).endsWith('/images')),
    ).toHaveLength(1)
  })
  it.each(['oversize', 'invalid-json', 'wrong-http', 'html', 'url', 'compressed'])(
    'rejects %s metadata without trust in Content-Length',
    async (mode) => {
      const { events, transport, start } = harness()
      const fixture = await localFixture()
      transport.fetch.mockImplementation(async (input) => {
        const url = String(input)
        const response = fakeResponse(
          url,
          mode === 'oversize' ? 'x'.repeat(MAX_LOCAL_RENDER_REPLY_BYTES) : fixture.reply,
          mode === 'wrong-http' ? 202 : 200,
        )
        if (mode === 'invalid-json') {
          const broken = new Response('{', { headers: { 'content-type': 'application/json' } })
          Object.defineProperty(broken, 'url', { value: url })
          return broken
        }
        response.headers.set('content-length', '1')
        if (mode === 'html') response.headers.set('content-type', 'text/html')
        if (mode === 'url') Object.defineProperty(response, 'url', { value: 'http://evil.test/' })
        if (mode === 'compressed') response.headers.set('content-encoding', 'gzip')
        return response
      })
      start()
      await vi.advanceTimersByTimeAsync(120)
      await settle(events)
      expect(events.at(-1)?.state).toMatch(/error|unavailable/)
      expect(transport.decode).not.toHaveBeenCalled()
    },
  )
  it('freezes the initial capture while polling then verifies the PNG', async () => {
    const { events, transport, start } = harness()
    const fixture = await localFixture()
    transport.fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/images')) return fakeResponse(url, fixture.pending, 202)
      return fakeResponse(
        url,
        url.endsWith('.png') ? fixture.bytes : fixture.reply,
        200,
        url.endsWith('.png'),
      )
    })
    start()
    await vi.advanceTimersByTimeAsync(120)
    await settle(events)
    expect(events.at(-1)?.state).toBe('ready')
    expect(transport.fetch).toHaveBeenCalledTimes(3)
  })
  it('times out a hanging transport and never automatically retries capture', async () => {
    const { events, transport, start } = harness()
    transport.fetch.mockImplementation(() => new Promise(() => undefined))
    start()
    await vi.advanceTimersByTimeAsync(LOCAL_RENDER_CLIENT_DEADLINE_MS)
    expect(events.at(-1)).toMatchObject({ state: 'unavailable', retryable: false })
    expect((transport.fetch.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(LOCAL_RENDER_CLIENT_DEADLINE_MS)
    expect(transport.fetch).toHaveBeenCalledOnce()
  })
  it('detaches a valid late submission but does not poll, decode or publish it', async () => {
    const { events, transport, start } = harness()
    const fixture = await localFixture()
    const late = deferred<Response>()
    transport.fetch
      .mockReturnValueOnce(late.promise)
      .mockImplementation(async (input) => fakeResponse(String(input), {}, 404))
    const stop = start()
    await vi.advanceTimersByTimeAsync(120)
    stop()
    late.resolve(fakeResponse(TEST_ORIGIN + LOCAL_RENDER_REQUEST_PATH, fixture.pending, 202))
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2))
    expect(transport.fetch.mock.calls[1][0]).toMatch(/\/cancel$/)
    expect(events).toEqual([{ state: 'pending' }])
    expect(transport.decode).not.toHaveBeenCalled()
  })
  it('suppresses decode completion after cleanup and A→B→A starts as three separate generations', async () => {
    const { events, transport, start } = harness()
    const a = await localFixture()
    const b = await localFixture('bronze')
    const held = deferred<{ width: number; height: number }>()
    transport.decode.mockReturnValueOnce(held.promise)
    transport.fetch.mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return fakeResponse(url, {}, 404)
      const fixture = url.endsWith('.png')
        ? url.includes(b.reply.artifact.checksum.slice(7))
          ? b
          : a
        : JSON.parse(options!.body as string).design.config.appearance.finish === 'bronze'
          ? b
          : a
      return fakeResponse(
        url,
        url.endsWith('.png') ? fixture.bytes : fixture.reply,
        200,
        url.endsWith('.png'),
      )
    })
    const stopA = start(a.design)
    await vi.advanceTimersByTimeAsync(120)
    await vi.waitFor(() => expect(transport.decode).toHaveBeenCalledOnce())
    stopA()
    const stopB = start(b.design)
    await vi.advanceTimersByTimeAsync(120)
    await settle(events)
    stopB()
    start(a.design)
    await vi.advanceTimersByTimeAsync(120)
    await settle(events)
    const before = events.length
    held.resolve({ width: 640, height: 400 })
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toHaveLength(before)
    expect(events.filter((event) => event.state === 'ready')).toHaveLength(2)
    expect(transport.createObjectURL).toHaveBeenCalledTimes(2)
  })
})
