// Synthetic PNGs/backends live ONLY in this test module. Never capture or write historical images.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSceneDesignFixtures } from '../../domain/designFixtures'
import { defaultDesign, parseDesign } from '../../domain/design'
import {
  bindDisplay,
  createDisplayRequest,
  DISPLAY_LIMITS,
  DISPLAY_PROTOCOL,
  DISPLAY_REQUEST_PATH,
  parseDisplayReply,
  type DisplayBuild,
  type DisplayReply,
} from '../../display/contract'
import {
  type DisplayJob,
  type LocalDisplayPermit,
  type PrivateDisplayBackend,
} from '../../display/session'
import {
  decodeBoundedPng,
  decodeCapturePng,
  pngCrc,
} from '../../render/prototype/capture/artifacts'
import { LOCAL_REVIEW_PROFILES } from '../../render/prototype/capture/contract'
import { createDisplayService, type DisplayService } from './service'
import { createDisplayMiddleware, assertDisplayRequest } from './http'
import { DisplayDirectory, hash } from './files'
import { DisplayRun } from './run'
import { createDisplayOwnerAuth } from './auth'
import { DisplayServiceError } from './errors'
import {
  createDisplaySelectionQueue,
  startDisplayRequest,
  type DisplayProgress,
  type DisplayTransport,
} from '../../prototype/displayClient'

const roots: string[] = [],
  services: DisplayService[] = [],
  cleaners: (() => Promise<void>)[] = []
const owner = 'synthetic_test_owner_123456789',
  other = 'synthetic_foreign_owner_123456'
const build: DisplayBuild = {
  sourceManifestDigest: hash('test source'),
  assetManifestDigest: hash('test assets'),
  bundleDigest: hash('test bundle'),
  lockfileDigest: hash('test lock'),
  runtimePolicyDigest: hash('test runtime'),
  threeRevision: '186',
}
const permit = (): LocalDisplayPermit => ({
  kind: 'operator-local-only',
  runId: 'synthetic_run_no_permission_123',
  approvalReference: 'TEST DOUBLE ONLY - not authorization',
  expiresAt: Date.now() + 600_000,
  maxJobs: 24,
  maxOutputBytes: DISPLAY_LIMITS.sessionOutputBytes,
  paidExecutionAllowed: false,
  productionAllowed: false,
})
function root() {
  const value = mkdtempSync(join(tmpdir(), 'fury-display-service-test-'))
  roots.push(value)
  return value
}
function chunk(type: string, bytes: Buffer) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(bytes.length)
  head.write(type, 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(pngCrc(Buffer.concat([Buffer.from(type), bytes])))
  return Buffer.concat([head, bytes, crc])
}
function png(width: number, height: number, variant: 'opaque' | 'transparent' | 'flat' = 'opaque') {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 4 + 1) + 1 + x * 4
      raw[i] = variant === 'flat' ? 77 : x % 256
      raw[i + 1] = variant === 'flat' ? 77 : y % 256
      raw[i + 2] = 77
      raw[i + 3] = variant === 'transparent' ? 0 : 255
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const samples = new Map<string, Buffer>()
function result(job: DisplayJob) {
  const p = job.binding.profile
  let bytes = samples.get(p.id)
  if (!bytes) {
    bytes = png(p.width, p.height)
    samples.set(p.id, bytes)
  }
  return {
    png: bytes,
    receipt: {
      protocol: DISPLAY_PROTOCOL,
      kind: 'private-three-display' as const,
      jobId: job.jobId,
      sessionId: job.sessionId,
      revision: job.revision,
      binding: job.binding,
      cameraDigest: hash('synthetic camera, not a GPU observation'),
      checksum: hash(bytes),
      width: p.width,
      height: p.height,
      byteLength: bytes.length,
      readiness: {
        revision: job.revision,
        resources: 'all-current-revision' as const,
        temporalFrames: 40,
        postReadyFrames: 2,
      },
      runtime: {
        backend: 'webgpu' as const,
        acceleration: 'hardware' as const,
        adapter: 'SYNTHETIC TEST ONLY',
        browserVersion: 'TEST ONLY',
      },
      elapsedMs: 1,
      hostShutdownProven: false as const,
      billingFinal: false as const,
    },
  }
}
function backend(
  render: (job: DisplayJob, signal: AbortSignal) => Promise<ReturnType<typeof result>> = async (
    job,
  ) => result(job),
  value = build,
) {
  const session = {
    sessionId: 'synthetic_session_123456789012',
    build: value,
    render: vi.fn(render),
    close: vi.fn(async () => {}),
  }
  const driver = {
    prepare: vi.fn(async () => value),
    revalidate: vi.fn(async () => {}),
    open: vi.fn(async () => session),
    close: vi.fn(async () => {}),
  } satisfies PrivateDisplayBackend
  return { driver, session }
}
function service(
  driver: PrivateDisplayBackend,
  path = root(),
  p: unknown = permit(),
  now?: () => number,
) {
  const value = createDisplayService({ backend: driver, directory: path, permit: p, now })
  services.push(value)
  return value
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
async function ready(s: DisplayService, id: string) {
  let reply: DisplayReply | undefined
  await vi.waitFor(
    async () => {
      reply = await s.status(owner, id)
      expect(reply.state).toBe('ready')
    },
    { timeout: 5000, interval: 5 },
  )
  return reply as Extract<DisplayReply, { state: 'ready' }>
}
afterEach(async () => {
  vi.useRealTimers()
  for (const c of cleaners.splice(0)) await c()
  for (const s of services.splice(0)) await s.close()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('private display service, synthetic backend only', { timeout: 30000 }, () => {
  it('real client supersession drains active work, submits only the latest design and reuses exact cached bytes', async () => {
    const gate = deferred<void>()
    const b = backend(async (job) => {
      await gate.promise
      return result(job)
    })
    const s = service(b.driver)
    const submissions: { status: number; design: unknown }[] = []
    const revoked: string[] = [],
      delivered: string[] = []
    let urlId = 0
    const transport: DisplayTransport = {
      origin: 'http://127.0.0.1:5173',
      fetch: (async (input, init) => {
        const url = String(input),
          path = new URL(url).pathname
        let body: unknown,
          status = 200,
          image = false
        try {
          if (path === DISPLAY_REQUEST_PATH) {
            const request = JSON.parse(String(init?.body))
            const reply = await s.submit(owner, request, init?.signal ?? undefined)
            body = reply.body
            status = reply.status
            submissions.push({ status, design: request.design })
          } else {
            const match = path.match(/\/jobs\/([^/]+)(?:\/(cancel|image\/([a-f0-9]{64})\.png))?$/)
            if (!match) throw new Error(`Unexpected synthetic transport path: ${path}`)
            if (match[3]) {
              body = new Uint8Array(await s.image(owner, match[1], `sha256:${match[3]}`))
              image = true
              delivered.push(hash(body as Uint8Array))
            } else {
              body = match[2] ? await s.cancel(owner, match[1]) : await s.status(owner, match[1])
              const state = (body as DisplayReply).state
              status = state === 'queued' || state === 'rendering' ? 202 : 200
            }
          }
        } catch (error) {
          if (!(error instanceof DisplayServiceError)) throw error
          status = error.status
          body = { protocol: DISPLAY_PROTOCOL, error: error.wire }
        }
        const response = new Response(
          image ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
          {
            status,
            headers: { 'content-type': image ? 'image/png' : 'application/json' },
          },
        )
        Object.defineProperty(response, 'url', { value: url })
        return response
      }) as typeof fetch,
      decode: async (bytes) => {
        const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const value = decodeBoundedPng(Buffer.from(bytes), {
          width: header.getUint32(16),
          height: header.getUint32(20),
          maxBytes: DISPLAY_LIMITS.pngBytes,
          maxPixels: 2_000_000,
        })
        return { width: value.width, height: value.height }
      },
      createObjectURL: () => `blob:synthetic-${++urlId}`,
      revokeObjectURL: (url) => {
        revoked.push(url)
      },
    }
    const queue = createDisplaySelectionQueue((design, notify) =>
      startDisplayRequest(design, notify, transport),
    )
    cleaners.push(async () => queue.dispose())
    const a = defaultDesign(),
      c = defaultDesign({ family: 'container', lengthFt: 40 })
    const progressA: DisplayProgress[] = [],
      skipped: DisplayProgress[] = [],
      progressC: DisplayProgress[] = [],
      again: DisplayProgress[] = []
    queue.select(a, (value) => progressA.push(value))
    await vi.waitFor(() => expect(b.session.render).toHaveBeenCalledOnce(), { timeout: 5000 })
    queue.select(defaultDesign({ family: 'container', lengthFt: 20 }), (value) =>
      skipped.push(value),
    )
    queue.select(c, (value) => progressC.push(value))
    expect(progressC.at(-1)?.state).toBe('pending')
    expect(submissions).toHaveLength(1)
    expect(b.session.close).not.toHaveBeenCalled()
    gate.resolve()
    await vi.waitFor(() => expect(progressC.at(-1)?.state).toBe('ready'), { timeout: 10000 })
    expect(progressA.every((value) => value.state === 'pending')).toBe(true)
    expect(skipped).toEqual([{ state: 'pending' }])
    expect(submissions.map((value) => value.design)).toEqual([a, c])
    expect(revoked).toEqual(['blob:synthetic-1'])
    queue.select(a, (value) => again.push(value))
    await vi.waitFor(() => expect(again.at(-1)?.state).toBe('ready'), { timeout: 5000 })
    expect(submissions.map((value) => value.status)).toEqual([202, 202, 200])
    expect(delivered[2]).toBe(delivered[0])
    expect(b.session.render).toHaveBeenCalledTimes(2)
    expect(b.driver.open).toHaveBeenCalledOnce()
    expect(b.session.close).not.toHaveBeenCalled()
    queue.dispose()
    expect(revoked).toEqual(['blob:synthetic-1', 'blob:synthetic-2', 'blob:synthetic-3'])
  })
  it.each(['transparent', 'flat', 'dimension'] as const)(
    'rejects independently decoded %s output even with an internally matching byte hash',
    async (variant) => {
      const b = backend(async (job) => {
          const valid = result(job),
            p = job.binding.profile
          const bytes = png(
            variant === 'dimension' ? p.width - 1 : p.width,
            p.height,
            variant === 'dimension' ? 'opaque' : variant,
          )
          return {
            ...valid,
            png: bytes,
            receipt: { ...valid.receipt, checksum: hash(bytes), byteLength: bytes.length },
          }
        }),
        s = service(b.driver)
      const reply = await s.submit(owner, createDisplayRequest(defaultDesign()))
      await vi.waitFor(async () =>
        expect((await s.status(owner, reply.body.interestId)).state).toBe('failed'),
      )
      expect(b.session.close).toHaveBeenCalledOnce()
      await expect(s.submit(owner, createDisplayRequest(defaultDesign()))).rejects.toMatchObject({
        status: 503,
      })
    },
  )
  it('prepares and rejects missing/expired permissions, schema/provider injection without opening', async () => {
    const b = backend(),
      s = service(b.driver, root(), null)
    await s.prepare()
    for (const { design } of createSceneDesignFixtures())
      await expect(s.submit(owner, createDisplayRequest(design))).rejects.toMatchObject({
        wire: { code: 'execution-denied' },
      })
    await expect(
      s.submit(owner, {
        ...createDisplayRequest(defaultDesign()),
        provider: 'modal',
        paidExecutionAllowed: true,
      }),
    ).rejects.toMatchObject({ status: 422 })
    expect(b.driver.open).not.toHaveBeenCalled()
    const expired = service(b.driver, root(), { ...permit(), expiresAt: Date.now() - 1 })
    await expect(
      expired.submit(owner, createDisplayRequest(defaultDesign())),
    ).rejects.toMatchObject({ wire: { code: 'execution-denied' } })
    expect(() => service(b.driver, root(), { ...permit(), paidExecutionAllowed: true })).toThrow()
  })
  it('coalesces concurrent same-key misses, separates owners, cancellation detaches one interest, and A-B-A uses byte-exact immutable cache', async () => {
    const gate = deferred<void>(),
      b = backend(async (job) => {
        await gate.promise
        return result(job)
      }),
      s = service(b.driver)
    const a = defaultDesign(),
      bDesign = defaultDesign({ family: 'container', lengthFt: 40 })
    const [first, second] = await Promise.all([
      s.submit(owner, createDisplayRequest(a)),
      s.submit(owner, createDisplayRequest(a)),
    ])
    expect(first.status).toBe(202)
    expect(second.body.binding).toEqual(first.body.binding)
    expect(second.body.interestId).not.toBe(first.body.interestId)
    await expect(s.status(other, first.body.interestId)).rejects.toMatchObject({ status: 404 })
    expect((await s.cancel(owner, first.body.interestId)).state).toBe('cancelled')
    expect(b.session.close).not.toHaveBeenCalled()
    gate.resolve()
    const aReady = await ready(s, second.body.interestId)
    await parseDisplayReply(aReady, a)
    const bytes = await s.image(owner, aReady.interestId, aReady.artifact.checksum)
    const secondDesign = await s.submit(owner, createDisplayRequest(bDesign))
    await ready(s, secondDesign.body.interestId)
    const again = await s.submit(owner, createDisplayRequest(a))
    expect(again.status).toBe(200)
    expect(again.body.state === 'ready' && again.body.artifact.cacheStatus).toBe(
      'verified-exact-hit',
    )
    expect(await s.image(owner, again.body.interestId, aReady.artifact.checksum)).toEqual(bytes)
    expect(b.driver.open).toHaveBeenCalledOnce()
    expect(b.session.render).toHaveBeenCalledTimes(2)
    expect(b.session.render.mock.calls.map(([j]) => j.revision)).toEqual([1, 2])
    expect(aReady.artifact.provenance.flags.qualified).toBe(false)
  })
  it('six full fixtures and tall profile bind without Lite/two-sample restrictions', async () => {
    const b = backend(),
      s = service(b.driver)
    for (const { design } of createSceneDesignFixtures()) {
      const r = await s.submit(owner, createDisplayRequest(design))
      const exact = await ready(s, r.body.interestId)
      expect(exact.binding).toEqual(await bindDisplay(design, build))
    }
    const tall = parseDesign({
      ...defaultDesign(),
      presentation: { ...defaultDesign().presentation, aspect: 'tall' },
    })
    const r = await s.submit(owner, createDisplayRequest(tall))
    expect((await ready(s, r.body.interestId)).artifact).toMatchObject({
      width: 1200,
      height: 1500,
    })
    expect(b.driver.open).toHaveBeenCalledOnce()
  })
  it('restart preserves exact cache but will never adopt/reset a warm or closed run', async () => {
    const path = root(),
      p = permit(),
      b = backend(),
      s = service(b.driver, path, p)
    const initial = await s.submit(owner, createDisplayRequest(defaultDesign()))
    await ready(s, initial.body.interestId)
    const otherBackend = backend(),
      restarted = service(otherBackend.driver, path, p)
    expect((await restarted.submit(owner, createDisplayRequest(defaultDesign()))).status).toBe(200)
    await expect(
      restarted.submit(
        owner,
        createDisplayRequest(defaultDesign({ family: 'container', lengthFt: 20 })),
      ),
    ).rejects.toMatchObject({ wire: { code: 'execution-denied' } })
    expect(otherBackend.driver.open).not.toHaveBeenCalled()
    const records = readdirSync(join(path, `run-${p.runId}`))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(path, `run-${p.runId}`, name), 'utf8')))
    expect(records.at(-1)).toMatchObject({ state: 'owned', attempts: 1 })
    expect(records.at(-1).outputBytes).toBeGreaterThan(0)
    await s.close()
    const afterClose = service(backend().driver, path, p)
    await expect(
      afterClose.submit(
        owner,
        createDisplayRequest(defaultDesign({ family: 'container', lengthFt: 40 })),
      ),
    ).rejects.toMatchObject({ wire: { code: 'execution-denied' } })
  })
  it('source/build changes and corrupt/partial/hash-mismatched PNG objects are never ready', async () => {
    const path = root(),
      b = backend(),
      s = service(b.driver, path)
    const response = await s.submit(owner, createDisplayRequest(defaultDesign())),
      done = await ready(s, response.body.interestId)
    b.driver.revalidate.mockRejectedValueOnce(new Error('test source mutation'))
    await expect(s.image(owner, done.interestId, done.artifact.checksum)).rejects.toThrow()
    const changed = service(
      backend(undefined, { ...build, bundleDigest: hash('changed bundle') }).driver,
      path,
      null,
    )
    await expect(
      changed.submit(owner, createDisplayRequest(defaultDesign())),
    ).rejects.toMatchObject({ wire: { code: 'execution-denied' } })
    const pngPath = join(path, 'objects', `${done.binding.displayDigest.slice(7)}.png`)
    writeFileSync(pngPath, Buffer.from('partial'))
    await expect(s.status(owner, done.interestId)).rejects.toMatchObject({
      wire: { code: 'invalid-artifact' },
    })
    expect(b.driver.open).toHaveBeenCalledOnce()
  })
  it('bounds queue and interests, removes the last queued interest without rendering it', async () => {
    const gate = deferred<void>(),
      b = backend(async (job) => {
        await gate.promise
        return result(job)
      }),
      s = service(b.driver)
    const fixtures = createSceneDesignFixtures()
    const first = await s.submit(owner, createDisplayRequest(fixtures[0].design))
    await vi.waitFor(() => expect(b.session.render).toHaveBeenCalledOnce())
    const queued: Awaited<ReturnType<DisplayService['submit']>>[] = []
    for (const { design } of fixtures.slice(1, 5))
      queued.push(await s.submit(owner, createDisplayRequest(design)))
    await expect(s.submit(owner, createDisplayRequest(fixtures[5].design))).rejects.toMatchObject({
      status: 429,
    })
    await s.cancel(owner, queued[0].body.interestId)
    const replacement = await s.submit(owner, createDisplayRequest(fixtures[5].design))
    for (let i = 0; i < 26; i++) await s.submit(owner, createDisplayRequest(fixtures[0].design))
    await expect(s.submit(owner, createDisplayRequest(fixtures[0].design))).rejects.toMatchObject({
      status: 429,
    })
    gate.resolve()
    await ready(s, first.body.interestId)
    await ready(s, replacement.body.interestId)
    expect(b.session.render).toHaveBeenCalledTimes(5)
    expect(
      b.session.render.mock.calls.some(
        ([job]) => job.binding.displayDigest === queued[0].body.binding.displayDigest,
      ),
    ).toBe(false)
  })
  it('last-active cancellation poisons/observes exit and fences a late successful result', async () => {
    const gate = deferred<void>(),
      b = backend(async (job) => {
        await gate.promise
        return result(job)
      }),
      path = root(),
      p = permit(),
      s = service(b.driver, path, p)
    const r = await s.submit(owner, createDisplayRequest(defaultDesign()))
    await vi.waitFor(() => expect(b.session.render).toHaveBeenCalledOnce())
    await s.cancel(owner, r.body.interestId)
    await vi.waitFor(() => expect(b.session.close).toHaveBeenCalledOnce())
    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readdirSync(join(path, 'objects'))).toEqual([])
    expect((await s.status(owner, r.body.interestId)).state).toBe('cancelled')
    await expect(s.submit(owner, createDisplayRequest(defaultDesign()))).rejects.toMatchObject({
      wire: { code: 'execution-denied' },
    })
  })
  it('failed shutdown is durably quarantined; receipt billing/shutdown booleans cannot settle it', async () => {
    const b = backend(async (job) => {
        const r = result(job)
        return { ...r, receipt: { ...r.receipt, billingFinal: true as never } }
      }),
      path = root(),
      p = permit()
    b.session.close.mockRejectedValue(new Error('unobserved child exit'))
    const s = service(b.driver, path, p),
      r = await s.submit(owner, createDisplayRequest(defaultDesign()))
    await vi.waitFor(async () =>
      expect((await s.status(owner, r.body.interestId)).state).toBe('failed'),
    )
    const names = readdirSync(join(path, `run-${p.runId}`)).sort()
    expect(
      JSON.parse(readFileSync(join(path, `run-${p.runId}`, names.at(-1)!), 'utf8')),
    ).toMatchObject({ state: 'quarantined', attempts: 1 })
    const next = service(backend().driver, path, p)
    await expect(next.submit(owner, createDisplayRequest(defaultDesign()))).rejects.toMatchObject({
      wire: { code: 'execution-denied' },
    })
  })
  it('fails closed on corrupt run records, symlink directories and exhausted bytes/jobs', () => {
    const p = permit(),
      path = root(),
      dir = new DisplayDirectory(path),
      run = new DisplayRun(p, dir)
    run.own()
    run.attached('synthetic_session_123456789012')
    run.output(DISPLAY_LIMITS.sessionOutputBytes)
    expect(() => run.admit()).toThrow()
    const next = new DisplayRun(p, dir)
    expect(next.snapshot()?.outputBytes).toBe(DISPLAY_LIMITS.sessionOutputBytes)
    expect(() => next.admit()).toThrow()
    writeFileSync(join(path, `run-${p.runId}`, '001.json'), 'bad')
    expect(() => new DisplayRun(p, dir)).toThrow()
    const link = join(root(), 'linked')
    symlinkSync(path, link)
    expect(() => new DisplayDirectory(link)).toThrow()
    const one = new DisplayRun({ ...permit(), maxJobs: 1 }, new DisplayDirectory(root()))
    one.own()
    one.attached('synthetic_session_123456789012')
    expect(() => one.attempt()).toThrow()
  })
  it('startup timeout charges an attempt, quarantines the run and closes a late returned session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const b = backend(),
      opening = deferred<typeof b.session>(),
      path = root(),
      p = permit()
    b.driver.open.mockImplementation(() => opening.promise)
    const s = service(b.driver, path, p)
    const admitted = await s.submit(owner, createDisplayRequest(defaultDesign()))
    for (let i = 0; i < 20 && !b.driver.open.mock.calls.length; i++) await new Promise(setImmediate)
    expect(b.driver.open).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(DISPLAY_LIMITS.startupMs + 1)
    expect((await s.status(owner, admitted.body.interestId)).state).toBe('failed')
    const directory = join(path, `run-${p.runId}`),
      names = readdirSync(directory).sort()
    expect(JSON.parse(readFileSync(join(directory, names.at(-1)!), 'utf8'))).toMatchObject({
      state: 'quarantined',
      attempts: 1,
    })
    opening.resolve(b.session)
    for (let i = 0; i < 10; i++) await new Promise(setImmediate)
    expect(b.session.close).toHaveBeenCalledExactlyOnceWith('poisoned')
    expect(b.session.render).not.toHaveBeenCalled()
    expect(readdirSync(join(path, 'objects'))).toEqual([])
  })
  it('idle timeout closes the original run once; cached bytes remain reusable without a replacement', async () => {
    const b = backend(),
      s = service(b.driver)
    const admitted = await s.submit(owner, createDisplayRequest(defaultDesign()))
    const done = await ready(s, admitted.body.interestId)
    // Keep a real wait for WebCrypto's worker while controlling the service idle clock.
    const wait = setTimeout
    // Replace timers before a second accepted job, so the next idle deadline is controlled.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const second = await s.submit(
      owner,
      createDisplayRequest(defaultDesign({ family: 'container', lengthFt: 20 })),
    )
    for (let i = 0; i < 500; i++) {
      if ((await s.status(owner, second.body.interestId)).state === 'ready') break
      await new Promise((resolve) => wait(resolve, 10))
    }
    expect((await s.status(owner, second.body.interestId)).state).toBe('ready')
    await vi.advanceTimersByTimeAsync(DISPLAY_LIMITS.idleMs + 1)
    expect(b.session.close).toHaveBeenCalledExactlyOnceWith('idle')
    expect(b.driver.close).not.toHaveBeenCalled() // Source-only revalidation must still work.
    expect((await s.submit(owner, createDisplayRequest(defaultDesign()))).status).toBe(200)
    expect(await s.image(owner, done.interestId, done.artifact.checksum)).toEqual(
      samples.get(done.binding.profile.id),
    )
    await expect(
      s.submit(owner, createDisplayRequest(defaultDesign({ family: 'container', lengthFt: 40 }))),
    ).rejects.toMatchObject({ wire: { code: 'execution-denied' } })
    expect(b.driver.open).toHaveBeenCalledOnce()
  })
  it('simultaneous service instances cannot both open the same durable run; new run ids cannot bypass it', async () => {
    const gate = deferred<void>(),
      path = root(),
      p = permit()
    const a = backend(async (job) => {
        await gate.promise
        return result(job)
      }),
      b = backend(async (job) => {
        await gate.promise
        return result(job)
      })
    const sa = service(a.driver, path, p),
      sb = service(b.driver, path, p)
    await Promise.allSettled([
      sa.submit(owner, createDisplayRequest(defaultDesign())),
      sb.submit(owner, createDisplayRequest(defaultDesign())),
    ])
    for (let i = 0; i < 20; i++) await new Promise(setImmediate)
    expect(a.driver.open.mock.calls.length + b.driver.open.mock.calls.length).toBe(1)
    expect(() =>
      service(backend().driver, path, { ...p, runId: 'different_test_run_1234567890' }),
    ).toThrow()
    gate.resolve()
    for (let i = 0; i < 20; i++) await new Promise(setImmediate)
  })
  it('expired/foreign/cancelled interests cannot read bytes; invalid PNG CRC/inflate and Lite cap remain rejected', async () => {
    let now = Date.now()
    const b = backend(),
      s = service(b.driver, root(), permit(), () => now)
    const r = await s.submit(owner, createDisplayRequest(defaultDesign())),
      done = await ready(s, r.body.interestId)
    await expect(s.image(other, done.interestId, done.artifact.checksum)).rejects.toMatchObject({
      status: 404,
    })
    now += DISPLAY_LIMITS.interestMs + 1
    await expect(s.status(owner, done.interestId)).rejects.toMatchObject({ status: 404 })
    const bytes = png(1600, 1000)
    expect(
      decodeBoundedPng(bytes, {
        width: 1600,
        height: 1000,
        maxBytes: DISPLAY_LIMITS.pngBytes,
        maxPixels: 1_800_000,
      }).width,
    ).toBe(1600)
    const corrupt = Buffer.from(bytes)
    corrupt[50] ^= 1
    expect(() =>
      decodeBoundedPng(corrupt, {
        width: 1600,
        height: 1000,
        maxBytes: DISPLAY_LIMITS.pngBytes,
        maxPixels: 1_800_000,
      }),
    ).toThrow()
    expect(() =>
      decodeBoundedPng(bytes, {
        width: 1600,
        height: 1000,
        maxBytes: DISPLAY_LIMITS.pngBytes,
        maxPixels: 10,
      }),
    ).toThrow()
    expect(() => decodeCapturePng(bytes, LOCAL_REVIEW_PROFILES.wide)).toThrow()
  })
})

describe('private display loopback HTTP, no browser or renderer', () => {
  async function http(s?: DisplayService) {
    const middleware = createDisplayMiddleware({
      service: s,
      authenticate: () => owner,
      bodyTimeoutMs: 100,
    })
    const server = createServer((req, res) =>
      middleware(req, res, () => {
        res.statusCode = 418
        res.end()
      }),
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleaners.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    )
    const port = (server.address() as AddressInfo).port
    return (
      path = DISPLAY_REQUEST_PATH as string,
      method = 'POST',
      data: unknown = createDisplayRequest(defaultDesign()),
      extra: Record<string, string> = {},
    ) =>
      new Promise<{ status: number; bytes: Buffer; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          const bytes =
            data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data)
          const request = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path,
              method,
              headers: {
                origin: `http://127.0.0.1:${port}`,
                'content-type': 'application/json',
                ...(method === 'POST' ? { 'content-length': Buffer.byteLength(bytes) } : {}),
                ...extra,
              },
            },
            (response) => {
              const parts: Buffer[] = []
              response.on('data', (part) => parts.push(part))
              response.on('end', () =>
                resolve({
                  status: response.statusCode!,
                  bytes: Buffer.concat(parts),
                  headers: response.headers,
                }),
              )
            },
          )
          request.on('error', reject)
          request.end(method === 'POST' ? bytes : undefined)
        },
      )
  }
  it('strict routes/media/JSON/method/origin/proxy and disabled namespace fail closed', async () => {
    const b = backend(),
      s = service(b.driver, root(), null),
      call = await http(s)
    expect((await call()).status).toBe(503)
    expect((await call(DISPLAY_REQUEST_PATH, 'GET')).status).toBe(405)
    expect((await call(`${DISPLAY_REQUEST_PATH}?provider=modal`)).status).toBe(404)
    expect((await call(DISPLAY_REQUEST_PATH, 'POST', '{')).status).toBe(400)
    expect(
      (await call(DISPLAY_REQUEST_PATH, 'POST', {}, { 'content-type': 'text/plain' })).status,
    ).toBe(415)
    expect((await call(DISPLAY_REQUEST_PATH, 'POST', 'x'.repeat(17 * 1024))).status).toBe(413)
    expect(
      (await call(DISPLAY_REQUEST_PATH, 'POST', {}, { origin: 'https://remote.invalid' })).status,
    ).toBe(403)
    expect(
      (await call(DISPLAY_REQUEST_PATH, 'POST', {}, { 'x-forwarded-for': '127.0.0.1' })).status,
    ).toBe(403)
    const disabled = await http()
    const no = await disabled()
    expect(no.status).toBe(503)
    expect(no.headers['cache-control']).toBe('private, no-store')
    expect((await disabled('/__fury-display%2fv1/images')).status).toBe(404)
    expect(b.driver.open).not.toHaveBeenCalled()
  })
  it('exchanges owner-session auth without dispatch, polls queued/rendering as 202 and ready as 200 while the host remains warm', async () => {
    const hold = deferred<void>(),
      b = backend(async (job) => {
        await hold.promise
        return result(job)
      }),
      s = service(b.driver),
      call = await http(s)
    const auth = await call('/__fury-display/v1/session', 'POST', { protocol: DISPLAY_PROTOCOL })
    expect(auth.status).toBe(200)
    expect(JSON.parse(auth.bytes.toString())).toMatchObject({
      authenticated: true,
      executionAuthorized: false,
    })
    expect(b.driver.open).not.toHaveBeenCalled()
    const first = JSON.parse((await call()).bytes.toString()) as DisplayReply
    await vi.waitFor(() => expect(b.session.render).toHaveBeenCalledOnce())
    const working = await call(`/__fury-display/v1/jobs/${first.interestId}`, 'GET')
    expect(working.status).toBe(202)
    expect(JSON.parse(working.bytes.toString()).state).toBe('rendering')
    const other = createSceneDesignFixtures().find(
      (f) => JSON.stringify(f.design) !== JSON.stringify(defaultDesign()),
    )!.design
    const second = JSON.parse(
      (await call(DISPLAY_REQUEST_PATH, 'POST', createDisplayRequest(other))).bytes.toString(),
    ) as DisplayReply
    const queued = await call(`/__fury-display/v1/jobs/${second.interestId}`, 'GET')
    expect(queued.status).toBe(202)
    expect(JSON.parse(queued.bytes.toString()).state).toBe('queued')
    hold.resolve()
    await ready(s, first.interestId)
    expect((await call(`/__fury-display/v1/jobs/${first.interestId}`, 'GET')).status).toBe(200)
    expect(b.session.close).not.toHaveBeenCalled()
    expect(b.driver.close).not.toHaveBeenCalled()
  })
  it('round trips exact synthetic ready bytes, polling and interest-only cancellation with security headers', async () => {
    const b = backend(),
      s = service(b.driver),
      call = await http(s)
    const admitted = await call()
    expect(admitted.status).toBe(202)
    const initial = JSON.parse(admitted.bytes.toString()) as DisplayReply
    const done = await ready(s, initial.interestId)
    const status = await call(`/__fury-display/v1/jobs/${initial.interestId}`, 'GET')
    expect(status.status).toBe(200)
    const image = await call(done.artifact.src, 'GET')
    expect(hash(image.bytes)).toBe(done.artifact.checksum)
    expect(image.headers['cross-origin-resource-policy']).toBe('same-origin')
    const cancelled = await call(`/__fury-display/v1/jobs/${initial.interestId}/cancel`, 'POST', {
      protocol: DISPLAY_PROTOCOL,
    })
    expect(JSON.parse(cancelled.bytes.toString())).toMatchObject({
      state: 'cancelled',
      cancellationScope: 'interest-only',
    })
    expect((await call(done.artifact.src, 'GET')).status).toBe(404)
  })
  it('rejects nonloopback and duplicate auth headers; operator header exchanges only an existing run cookie', () => {
    const req = {
      headers: { host: 'localhost:1234', origin: 'http://localhost:1234' },
      rawHeaders: ['Host', 'localhost:1234'],
      socket: { remoteAddress: '192.0.2.1' },
      method: 'POST',
    }
    expect(() => assertDisplayRequest(req as never)).toThrow()
    req.socket.remoteAddress = '127.0.0.1'
    req.rawHeaders.push('Cookie', 'a', 'cookie', 'b')
    expect(() => assertDisplayRequest(req as never)).toThrow()
    const auth = createDisplayOwnerAuth({
        version: 1,
        permit: permit(),
        ownerId: owner,
        credential: 'ab'.repeat(32),
      }),
      setHeader = vi.fn()
    expect(
      auth(
        { headers: { authorization: `Bearer ${'ab'.repeat(32)}` } } as never,
        { setHeader } as never,
      ),
    ).toBe(owner)
    expect(setHeader.mock.calls[0][1]).toContain(
      'HttpOnly; SameSite=Strict; Path=/__fury-display/v1',
    )
    expect(
      auth(
        { headers: { cookie: `fury_private_display_owner=${'ab'.repeat(32)}` } } as never,
        { setHeader } as never,
      ),
    ).toBe(owner)
    expect(createDisplayOwnerAuth(null)({ headers: {} } as never, { setHeader } as never)).toBe(
      null,
    )
  })
})
