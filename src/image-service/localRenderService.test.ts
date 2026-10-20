// Injected synthetic capture/cache tests. No browser or retained capture-history writes.
import { readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalRenderService } from './localRenderService'
import { LocalRenderCache } from './localRenderCache'
import {
  createLocalRenderRequest,
  localRenderDesign,
  parseLocalRenderReply,
} from './localRenderProtocol'
import { deferred, localRenderFixture } from './localRenderTestFixtures'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const fn of cleanup.splice(0)) await fn()
})
async function setup() {
  const fixture = await localRenderFixture()
  const service = new LocalRenderService(fixture.backend, fixture.cache)
  cleanup.push(async () => {
    service.close()
    await rm(fixture.root, { recursive: true, force: true })
  })
  return { ...fixture, service }
}
const request = (finish: 'obsidian' | 'bronze' = 'obsidian') =>
  createLocalRenderRequest(localRenderDesign(finish))
async function ready(service: LocalRenderService, id: string) {
  await vi.waitFor(
    async () => {
      expect((await service.status(id)).state).toBe('ready')
    },
    { timeout: 5000, interval: 10 },
  )
  const reply = await service.status(id)
  if (reply.state !== 'ready') throw new Error('Synthetic fixture not ready')
  return reply
}

describe('bounded local-real service (synthetic evidence only)', () => {
  it('coalesces equal full requests and detaches only one interest', async () => {
    const f = await setup(),
      gate = deferred<void>()
    f.backend.capture.mockImplementation(async (sample, output) => {
      await gate.promise
      return f.publish(sample, output)
    })
    const [a, b] = await Promise.all([f.service.submit(request()), f.service.submit(request())])
    expect(a.status).toBe(202)
    expect(b.status).toBe(202)
    expect(a.body.interestId).not.toBe(b.body.interestId)
    expect(a.body.capture).toEqual(b.body.capture)
    await vi.waitFor(() => expect(f.backend.capture).toHaveBeenCalledTimes(1))
    expect(await f.service.detach(a.body.interestId)).toMatchObject({
      state: 'cancelled',
      sharedWorkCancelled: false,
    })
    gate.resolve()
    const result = await ready(f.service, b.body.interestId)
    await parseLocalRenderReply(result, request().design, b.body.interestId, b.body.capture)
    expect(result.artifact.cacheStatus).toBe('captured-miss')
    expect((await f.service.status(a.body.interestId)).state).toBe('cancelled')
    await expect(
      f.service.image(a.body.interestId, result.artifact.checksum),
    ).rejects.toMatchObject({ status: 404 })
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
  })
  it('serializes two finish jobs; bytes/cache identities remain separately bound', async () => {
    const f = await setup(),
      gate = deferred<void>()
    f.backend.capture.mockImplementation(async (sample, output) => {
      if (sample === 'studio-20-front-left-wide') await gate.promise
      return f.publish(sample, output)
    })
    const a = await f.service.submit(request()),
      b = await f.service.submit(request('bronze'))
    expect(a.body.capture.captureDigest).not.toBe(b.body.capture.captureDigest)
    await vi.waitFor(() => expect(f.backend.capture).toHaveBeenCalledTimes(1))
    expect((await f.service.status(b.body.interestId)).state).toBe('queued')
    gate.resolve()
    const [ar, br] = await Promise.all([
      ready(f.service, a.body.interestId),
      ready(f.service, b.body.interestId),
    ])
    expect(ar.artifact.provenance.sampleId).toBe('studio-20-front-left-wide')
    expect(br.artifact.provenance.sampleId).toBe('studio-20-bronze-front-left-wide')
    // Synthetic pixels deliberately do not establish finish-difference or real-image evidence.
    expect(f.backend.capture).toHaveBeenCalledTimes(2)
    expect((await f.cache.history()).attempts).toHaveLength(2)
  })
  it('returns verified exact bytes without another capture, including restart and missing index', async () => {
    const f = await setup(),
      first = await f.service.submit(request())
    const result = await ready(f.service, first.body.interestId)
    const before = await readFile(join(f.outputs[0], 'image.png'))
    const cached = await f.service.submit(request())
    expect(cached.status).toBe(200)
    expect(cached.body).toMatchObject({
      state: 'ready',
      artifact: { checksum: result.artifact.checksum, cacheStatus: 'verified-exact-hit' },
    })
    expect(await f.service.image(cached.body.interestId, result.artifact.checksum)).toEqual(before)
    f.service.close()
    await rm(f.cache.paths.index, { recursive: true })
    const restarted = new LocalRenderService(f.backend, new LocalRenderCache(f.cache.paths))
    cleanup.push(async () => restarted.close())
    const hit = await restarted.submit(request())
    expect(hit.status).toBe(200)
    expect(await restarted.image(hit.body.interestId, result.artifact.checksum)).toEqual(before)
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
    expect(await readdir(f.cache.paths.index)).toEqual([
      `${result.capture.captureDigest.slice(7)}.json`,
    ])
  })
  it('rejects a CDP/page browser-major mismatch on cold verification without trusting an index', async () => {
    const f = await setup()
    await f.publish('studio-20-front-left-wide', join(f.root, 'mismatched-browser'))
    const path = join(f.outputs[0], 'browser.json')
    const browser = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...browser, product: 'Chrome/138.0.7118.2' }))
    await expect(f.service.submit(request())).rejects.toMatchObject({
      status: 503,
      wireError: { code: 'invalid-artifact' },
    })
    expect(f.backend.capture).not.toHaveBeenCalled()
  })
  it('reuses the prepared closure on exact hits while still checking source and image bytes', async () => {
    const f = await setup(),
      first = await f.service.submit(request())
    const result = await ready(f.service, first.body.interestId)
    const revalidations = f.revalidate.mock.calls.length
    const cached = await f.service.submit(request())
    expect(cached.status).toBe(200)
    await f.service.image(cached.body.interestId, result.artifact.checksum)
    expect(f.backend.prepare).toHaveBeenCalledTimes(1)
    expect(f.revalidate.mock.calls.length).toBeGreaterThan(revalidations)
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
    f.revalidate.mockRejectedValue(new Error('Synthetic missing source'))
    await expect(
      f.service.image(cached.body.interestId, result.artifact.checksum),
    ).rejects.toMatchObject({ status: 503 })
    expect(f.backend.prepare).toHaveBeenCalledTimes(2)
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
  })
  it('refreshes the retained closure fence for later operations instead of expiring after its first deadline', async () => {
    const f = await setup(),
      original = f.backend.prepare.getMockImplementation()!
    f.backend.prepare.mockImplementation(async (fence) => {
      const prepared = await original(fence)
      return {
        ...prepared,
        revalidate: async () => {
          fence()
          await prepared.revalidate()
          fence()
        },
      }
    })
    const first = await f.service.submit(request())
    const result = await ready(f.service, first.body.interestId)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 180001)
    try {
      const cached = await f.service.submit(request())
      expect(cached.status).toBe(200)
      await f.service.image(cached.body.interestId, result.artifact.checksum)
      expect(f.backend.prepare).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })
  it('rejects changed sources on ready and resubmit without rerendering the successful sample', async () => {
    const f = await setup(),
      first = await f.service.submit(request())
    await ready(f.service, first.body.interestId)
    f.changeBuild()
    expect(await f.service.status(first.body.interestId)).toMatchObject({
      state: 'failed',
      error: { code: 'identity-mismatch', retryable: false },
    })
    await expect(f.service.submit(request())).rejects.toMatchObject({
      status: 503,
      wireError: { code: 'identity-mismatch' },
    })
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
  })
  it.each(['image.png', 'receipt.json', 'COMPLETE.json', 'job.json', 'build.json', 'browser.json'])(
    'rejects %s tampering independently of the index and preserves bytes/no retries',
    async (name) => {
      const f = await setup(),
        first = await f.service.submit(request())
      const result = await ready(f.service, first.body.interestId)
      await writeFile(join(f.outputs[0], name), 'synthetic corruption')
      await expect(
        f.service.image(first.body.interestId, result.artifact.checksum),
      ).rejects.toMatchObject({ status: 503 })
      await expect(f.service.submit(request())).rejects.toMatchObject({ status: 503 })
      expect(f.backend.capture).toHaveBeenCalledTimes(1)
    },
  )
  it('rejects exact-byte inode replacement and symlink substitution', async () => {
    const f = await setup(),
      first = await f.service.submit(request())
    await ready(f.service, first.body.interestId)
    const path = join(f.outputs[0], 'image.png'),
      bytes = await readFile(path)
    await rename(path, `${path}.old`)
    await writeFile(path, bytes)
    expect((await f.service.status(first.body.interestId)).state).toBe('failed')
    await rm(path)
    await symlink(`${path}.old`, path)
    const restarted = new LocalRenderService(f.backend, new LocalRenderCache(f.cache.paths))
    cleanup.push(async () => restarted.close())
    await expect(restarted.submit(request())).rejects.toMatchObject({ status: 503 })
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
  })
  it('does not trust copied index metadata or a missing retained history', async () => {
    const f = await setup(),
      first = await f.service.submit(request())
    await ready(f.service, first.body.interestId)
    // ONLY this test-specific synthetic directory, never the retained real capture history.
    await rm(f.cache.paths.history, { recursive: true })
    const restarted = new LocalRenderService(f.backend, new LocalRenderCache(f.cache.paths))
    cleanup.push(async () => restarted.close())
    await expect(restarted.submit(request())).rejects.toMatchObject({ status: 503 })
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
  })
  it.each(['failed', 'running'] as const)(
    'blocks restart after %s history, with no automatic diagnostic retry',
    async (state) => {
      const f = await setup()
      await f.publish('studio-20-front-left-wide', join(f.root, 'prior-synthetic'), state)
      await expect(f.service.submit(request())).rejects.toMatchObject({ status: 429 })
      expect(f.backend.capture).not.toHaveBeenCalled()
    },
  )
  it('does not turn success JSON without a completed artifact/history into ready', async () => {
    const f = await setup()
    f.backend.capture.mockResolvedValue({ state: 'complete' })
    const first = await f.service.submit(request())
    await vi.waitFor(async () =>
      expect((await f.service.status(first.body.interestId)).state).toBe('failed'),
    )
    await expect(f.service.submit(request())).rejects.toMatchObject({ status: 503 })
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
  })
  it('reports permanent capture failure and never loops or retries', async () => {
    const f = await setup()
    f.backend.capture.mockImplementation((sample, output) => f.publish(sample, output, 'failed'))
    const first = await f.service.submit(request())
    await vi.waitFor(async () =>
      expect(await f.service.status(first.body.interestId)).toMatchObject({
        state: 'failed',
        error: { code: 'capture-failed', retryable: false },
      }),
    )
    await expect(f.service.submit(request())).rejects.toMatchObject({ status: 503 })
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
  })
  it('rejects all other full controls and caller identity/output overrides before build or capture', async () => {
    const f = await setup(),
      base = request()
    const other = {
      ...base,
      design: { ...base.design, presentation: { ...base.design.presentation, aspect: 'tall' } },
    }
    await expect(f.service.submit(other)).rejects.toMatchObject({
      status: 422,
      wireError: { code: 'unsupported-design' },
    })
    for (const extra of [
      { outputDirectory: '/tmp/no' },
      { captureDigest: `sha256:${'a'.repeat(64)}` },
      { sampleId: 'studio-20-front-left-wide' },
    ])
      await expect(f.service.submit({ ...base, ...extra })).rejects.toMatchObject({ status: 400 })
    expect(f.backend.prepare).not.toHaveBeenCalled()
    expect(f.backend.capture).not.toHaveBeenCalled()
  })
  it('fences abandoned submissions before admission, including after a delayed build', async () => {
    const f = await setup(),
      controller = new AbortController(),
      gate = deferred<Awaited<ReturnType<typeof f.backend.prepare>>>()
    const prepared = await f.backend.prepare(() => {})
    f.backend.prepare.mockImplementationOnce(() => gate.promise)
    const pending = f.service.submit(request(), controller.signal)
    await vi.waitFor(() => expect(f.backend.prepare).toHaveBeenCalledTimes(2))
    controller.abort()
    gate.resolve(prepared)
    await expect(pending).rejects.toMatchObject({ status: 503 })
    expect(f.backend.capture).not.toHaveBeenCalled()
  })
  it('bounds a stalled current-build check and never admits its late completion', async () => {
    const f = await setup(),
      gate = deferred<Awaited<ReturnType<typeof f.backend.prepare>>>()
    const prepared = await f.backend.prepare(() => {})
    f.backend.prepare.mockImplementationOnce(() => gate.promise)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = f.service.submit(request())
    const rejected = expect(pending).rejects.toMatchObject({ status: 504 })
    await vi.advanceTimersByTimeAsync(180_001)
    await rejected
    gate.resolve(prepared)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.backend.capture).not.toHaveBeenCalled()
  })
  it('keeps concurrency one after the hard capture timeout until the old runner has settled', async () => {
    const f = await setup(),
      gate = deferred<unknown>()
    f.backend.capture
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ state: 'failed' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = await f.service.submit(request()),
      b = await f.service.submit(request('bronze'))
    await vi.waitFor(() => expect(f.backend.capture).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(180_001)
    expect(await f.service.status(a.body.interestId)).toMatchObject({
      state: 'failed',
      error: { code: 'timeout', retryable: false },
    })
    expect((await f.service.status(b.body.interestId)).state).toBe('queued')
    expect(f.backend.capture).toHaveBeenCalledTimes(1)
    expect(f.backend.capture.mock.calls[0][2].aborted).toBe(true)
    gate.resolve({ state: 'failed' })
    vi.useRealTimers()
    await vi.waitFor(() => expect(f.backend.capture).toHaveBeenCalledTimes(2))
  })
  it('caps local interest memory without creating new render budget principals', async () => {
    const f = await setup(),
      gate = deferred<unknown>()
    f.backend.capture.mockImplementation(() => gate.promise)
    for (let i = 0; i < 64; i++) expect((await f.service.submit(request())).status).toBe(202)
    await expect(f.service.submit(request())).rejects.toMatchObject({ status: 429 })
    await vi.waitFor(() => expect(f.backend.capture).toHaveBeenCalledTimes(1))
    f.service.close()
    gate.resolve({ state: 'failed' })
  })
  it('limits capabilities, expires interests, and denies unknown/wrong-hash artifacts', async () => {
    const f = await setup(),
      first = await f.service.submit(request()),
      result = await ready(f.service, first.body.interestId)
    await expect(
      f.service.image(first.body.interestId, `sha256:${'0'.repeat(64)}`),
    ).rejects.toMatchObject({ status: 404 })
    await expect(f.service.status('x'.repeat(32))).rejects.toMatchObject({ status: 404 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60_000)
    expect((await f.service.status(first.body.interestId)).state).toBe('expired')
    await expect(
      f.service.image(first.body.interestId, result.artifact.checksum),
    ).rejects.toMatchObject({ status: 404 })
  })
})
