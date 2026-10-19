import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, designEnvelopeSchema } from '../domain/design'
import { designIdentity } from '../domain/designIdentity'
import {
  createMockArtifact,
  imageReplyBase,
  IMAGE_REQUEST_PATH,
  imageCancelPath,
  imageStatusPath,
  type ImageReadyReply,
} from '../image-service/protocol'
import {
  IMAGE_DEADLINE_MS,
  IMAGE_POLL_LIMIT,
  startImageRequest,
  type ImageProgress,
} from './imageClient'

const id = 'opaque_interest_1234567890ABCDE'
const design = defaultDesign()
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let ready: ImageReadyReply
let stop: (() => void) | undefined
beforeEach(async () => {
  ready = {
    ...imageReplyBase(id, await designIdentity(design)),
    state: 'ready',
    artifact: await createMockArtifact(design),
  }
  vi.useFakeTimers()
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const cancelled = () => ({
  ...ready,
  artifact: undefined,
  state: 'cancelled',
  cancellationScope: 'interest-only',
  sharedWorkCancelled: false,
})

function harness(replies: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (String(input).endsWith('/cancel')) return response(cancelled())
    return replies.shift() ?? response({ error: 'no more replies' }, 503)
  })
  const decode = vi.fn().mockResolvedValue(undefined)
  const updates: ImageProgress[] = []
  stop = startImageRequest(design, (value) => updates.push(value), { fetch, decode })
  return { fetch, decode, updates }
}

describe('frozen mock image fetch/status/detach lifecycle', () => {
  it('decodes before publishing and posts only the v4 request envelope', async () => {
    const decoded = deferred<void>()
    const h = harness([response(ready)])
    h.decode.mockReturnValue(decoded.promise)
    await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce())
    expect(h.updates.map((item) => item.state)).toEqual(['pending'])
    expect(h.fetch.mock.calls[0][0]).toBe(IMAGE_REQUEST_PATH)
    const body = JSON.parse(h.fetch.mock.calls[0][1]!.body as string)
    expect(body.design).toEqual(design)
    expect(body).not.toHaveProperty('scene')
    decoded.resolve()
    await vi.waitFor(() => expect(h.updates.at(-1)?.state).toBe('ready'))
  })
  it('snapshots mutable callers before admission delay and keeps validation bound to that revision', async () => {
    const mutable = designEnvelopeSchema.parse(design)
    const updates: ImageProgress[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      response(String(input).endsWith('/cancel') ? cancelled() : ready),
    )
    const decode = vi.fn().mockResolvedValue(undefined)
    stop = startImageRequest(mutable, (value) => updates.push(value), { fetch, decode })
    mutable.config.appearance.finish = 'chalk'
    mutable.presentation.aspect = 'tall'
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe('ready'))
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).design).toEqual(design)
    expect(decode).toHaveBeenCalledOnce()
    expect(mutable.config.appearance.finish).toBe('chalk')
  })

  it('polls server-issued interest only and verifies the cancellation receipt', async () => {
    const queued = {
      ...imageReplyBase(id, await designIdentity(design)),
      state: 'queued',
      retryAfterMs: 100,
    }
    const h = harness([response(queued, 202), response(ready)])
    await vi.waitFor(() => expect(h.updates.at(-1)?.state).toBe('ready'))
    expect(h.fetch.mock.calls[1][0]).toBe(imageStatusPath(id))
    stop?.()
    expect(h.fetch.mock.calls.at(-1)![0]).toBe(imageCancelPath(id))
    expect(JSON.parse(h.fetch.mock.calls.at(-1)![1]!.body as string).interestId).toBe(id)
    expect(h.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true)
  })
  it('cancels before admission without making any request', async () => {
    const h = harness([response(ready)])
    stop?.()
    await vi.advanceTimersByTimeAsync(300)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.updates).toEqual([{ state: 'pending' }])
  })
  it('detaches a late submission while refusing to publish it', async () => {
    const late = deferred<Response>()
    const h = harness([])
    h.fetch.mockImplementation(async (path) =>
      String(path).endsWith('/cancel') ? response(cancelled()) : late.promise,
    )
    await vi.advanceTimersByTimeAsync(120)
    stop?.()
    late.resolve(response(ready))
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
    expect(h.decode).not.toHaveBeenCalled()
    expect(h.updates).toEqual([{ state: 'pending' }])
  })
  it('does not publish a decoded reply after cancellation', async () => {
    const decoded = deferred<void>()
    const h = harness([response(ready)])
    h.decode.mockReturnValue(decoded.promise)
    await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce())
    stop?.()
    decoded.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.updates).toEqual([{ state: 'pending' }])
  })
  it.each(['request', 'interest', 'bytes', 'approval', 'future', 'status'] as const)(
    'rejects %s mismatch without image substitution',
    async (kind) => {
      const corrupt = structuredClone(ready)
      if (kind === 'request') corrupt.requested.requestDigest = 'sha256:' + '0'.repeat(64)
      if (kind === 'bytes') corrupt.artifact.src += 'changed'
      const input: unknown =
        kind === 'approval'
          ? { ...corrupt, artifact: { ...corrupt.artifact, approvedCurrentImage: true } }
          : kind === 'future'
            ? { ...corrupt, protocolVersion: 999 }
            : corrupt
      const queued = {
        ...imageReplyBase(id, await designIdentity(design)),
        state: 'queued',
        retryAfterMs: 100,
      }
      const h =
        kind === 'interest'
          ? harness([
              response(queued, 202),
              response({ ...corrupt, interestId: 'another_interest_1234567890ABCDE' }),
            ])
          : harness([response(input, kind === 'status' ? 202 : 200)])
      await vi.waitFor(() => expect(h.updates.at(-1)?.state).toBe('error'))
      expect(h.decode).not.toHaveBeenCalled()
    },
  )
  it.each(['failed', 'expired', 'cancelled'] as const)(
    'handles terminal %s status without retrying or substituting',
    async (state) => {
      const base = imageReplyBase(id, await designIdentity(design))
      const queued = { ...base, state: 'queued', retryAfterMs: 100 }
      const terminal = {
        ...base,
        state,
        ...(state === 'failed'
          ? { error: { code: 'internal-error', message: 'Mock failed', retryable: true } }
          : {}),
        ...(state === 'cancelled'
          ? { cancellationScope: 'interest-only', sharedWorkCancelled: false }
          : {}),
      }
      const h = harness([response(queued, 202), response(terminal)])
      await vi.waitFor(() => expect(['error', 'unavailable']).toContain(h.updates.at(-1)?.state))
      expect(h.decode).not.toHaveBeenCalled()
      expect(
        h.fetch.mock.calls.filter(([path]) => String(path) === IMAGE_REQUEST_PATH),
      ).toHaveLength(1)
    },
  )
  it('bounds polling and requires explicit retry without falling back', async () => {
    const queued = {
      ...imageReplyBase(id, await designIdentity(design)),
      state: 'queued',
      retryAfterMs: 100,
    }
    const h = harness([])
    h.fetch.mockImplementation(async (path) =>
      String(path).endsWith('/cancel')
        ? response(cancelled())
        : response(queued, String(path) === IMAGE_REQUEST_PATH ? 202 : 200),
    )
    await vi.waitFor(() => expect(h.updates.at(-1)?.state).toBe('unavailable'), {
      timeout: 10000,
      interval: 250,
    })
    const calls = h.fetch.mock.calls.filter(([path]) => String(path) === imageStatusPath(id))
    expect(calls).toHaveLength(IMAGE_POLL_LIMIT)
    expect(h.updates.at(-1)).toMatchObject({ retryable: true })
    await vi.advanceTimersByTimeAsync(30000)
    expect(
      h.fetch.mock.calls.filter(([path]) => String(path) === imageStatusPath(id)),
    ).toHaveLength(IMAGE_POLL_LIMIT)
  }, 15000)
  it('bounds a hanging request deadline and ignores any later ready result', async () => {
    const late = deferred<Response>()
    const h = harness([])
    h.fetch.mockImplementation(async (path) =>
      String(path).endsWith('/cancel') ? response(cancelled()) : late.promise,
    )
    await vi.advanceTimersByTimeAsync(IMAGE_DEADLINE_MS)
    expect(h.updates.at(-1)?.state).toBe('unavailable')
    late.resolve(response(ready))
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
    expect(h.decode).not.toHaveBeenCalled()
  })
  it('explains retained capacity and does not offer immediate retry even for an older retryable reply', async () => {
    const h = harness([
      response(
        {
          protocol: 'fury.prototype-images',
          protocolVersion: 1,
          mode: 'mock',
          error: { code: 'capacity-exceeded', message: 'Capacity exhausted', retryable: true },
        },
        429,
      ),
    ])
    await vi.waitFor(() => expect(h.updates.at(-1)?.state).toBe('unavailable'))
    expect(h.updates.at(-1)).toMatchObject({
      retryable: false,
      message: expect.stringContaining('Immediate retry will not free retained requests'),
    })
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.decode).not.toHaveBeenCalled()
  })
  it.each(['network', 'html', 'oversized', 'decode', 'denied'] as const)(
    'reports %s failures honestly and never calls a renderer',
    async (kind) => {
      const input =
        kind === 'html'
          ? new Response('<html>no route</html>')
          : kind === 'oversized'
            ? new Response('x'.repeat(32769))
            : kind === 'denied'
              ? response(
                  {
                    protocol: 'fury.prototype-images',
                    protocolVersion: 1,
                    mode: 'mock',
                    error: { code: 'production-denied', message: 'Blocked', retryable: false },
                  },
                  403,
                )
              : response(ready)
      const h = harness([input])
      if (kind === 'network') h.fetch.mockRejectedValue(new Error('Offline'))
      if (kind === 'decode') h.decode.mockRejectedValue(new Error('Broken image'))
      await vi.waitFor(() => expect(['error', 'unavailable']).toContain(h.updates.at(-1)?.state))
      if (kind === 'denied') expect(h.updates.at(-1)).toMatchObject({ retryable: false })
      expect(h.updates.some((item) => item.state === 'ready')).toBe(false)
      expect(
        h.fetch.mock.calls.every(([path]) => String(path).startsWith('/__fury-prototype/v1/')),
      ).toBe(true)
    },
  )
})
