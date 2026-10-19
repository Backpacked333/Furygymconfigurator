// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign } from '../domain/design'
import {
  createImageCancelRequest,
  createImageRequest,
  imageCancelPath,
  imageErrorReplySchema,
  imageStatusPath,
  MAX_IMAGE_REQUEST_BYTES,
  parseImageSubmissionReply,
  type ImageReply,
} from './protocol'
import { createMockImageMiddleware } from './http'
import { invokeMockHttp } from './httpTestHarness'
import { MockImageService } from './service'
import { MockJobStore } from './store'

const cleanups: (() => void)[] = []
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'fury-mock-http-'))
  const path = join(directory, 'jobs.sqlite')
  const store = new MockJobStore({ path })
  const service = new MockImageService({ store })
  cleanups.push(() => {
    service.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const middleware = createMockImageMiddleware({
    service,
    principalSecret: store.principalSecret(),
  })
  return { store, service, middleware, path }
}
const request = () => createImageRequest(defaultDesign(), 'http-idempotency-key')
const cookie = (headers: Record<string, string>) => headers['set-cookie'].split(';')[0]
afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('local mock HTTP control plane without any listening server', () => {
  it('submits, polls, verifies mock bytes, detaches, and reuses signed ownership after restart', async () => {
    const f = setup()
    const accepted = await invokeMockHttp(f.middleware, { body: request() }).result
    expect(accepted.status).toBe(202)
    await expect(
      parseImageSubmissionReply(accepted.status, accepted.body, defaultDesign()),
    ).resolves.toMatchObject({ status: 202 })
    expect(accepted.headers['cache-control']).toBe('private, no-store')
    expect(accepted.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict')
    expect(accepted.headers['access-control-allow-origin']).toBeUndefined()
    const interest = (accepted.body as ImageReply).interestId
    const signed = cookie(accepted.headers)
    const repeated = await invokeMockHttp(f.middleware, {
      body: request(),
      headers: { cookie: signed },
    }).result
    expect((repeated.body as ImageReply).interestId).toBe(interest)
    f.service.close()
    const reopened = new MockJobStore({ path: f.path })
    const resumed = new MockImageService({ store: reopened })
    // Close before setup removes its test-owned directory.
    cleanups.unshift(() => resumed.close())
    const middleware = createMockImageMiddleware({
      service: resumed,
      principalSecret: reopened.principalSecret(),
    })
    await resumed.runOnce()
    const ready = await invokeMockHttp(middleware, {
      method: 'GET',
      url: imageStatusPath(interest),
      headers: { cookie: signed, origin: undefined },
    }).result
    expect(ready.body).toMatchObject({
      state: 'ready',
      artifact: {
        exactMatch: false,
        approvedCurrentImage: false,
        provenance: { kind: 'mock-diagnostic' },
      },
    })
    const detached = await invokeMockHttp(middleware, {
      url: imageCancelPath(interest),
      headers: { cookie: signed },
      body: createImageCancelRequest(interest),
    }).result
    expect(detached.body).toMatchObject({ state: 'cancelled', sharedWorkCancelled: false })
    const unknown = await invokeMockHttp(middleware, {
      method: 'GET',
      url: imageStatusPath(interest),
    }).result
    expect(unknown.status).toBe(404)
  })

  it('isolates two local cookie principals and never shares private status even when work coalesces', async () => {
    const f = setup()
    const a = await invokeMockHttp(f.middleware, { body: request() }).result
    const b = await invokeMockHttp(f.middleware, { body: request() }).result
    const id = (a.body as ImageReply).interestId
    const forbidden = await invokeMockHttp(f.middleware, {
      method: 'GET',
      url: imageStatusPath(id),
      headers: { cookie: cookie(b.headers) },
    }).result
    expect(forbidden.status).toBe(404)
    const forged = await invokeMockHttp(f.middleware, {
      method: 'GET',
      url: imageStatusPath(id),
      headers: { cookie: `${cookie(a.headers).slice(0, -1)}!` },
    }).result
    expect(forged.status).toBe(404)
    await invokeMockHttp(f.middleware, {
      url: imageCancelPath(id),
      body: createImageCancelRequest(id),
      headers: { cookie: cookie(a.headers) },
    }).result
    await f.service.runOnce()
    expect(f.store.inspect()).toMatchObject({ jobs: 1, spent: 1, interests: 2 })
    expect(
      (
        await invokeMockHttp(f.middleware, {
          method: 'GET',
          url: imageStatusPath((b.body as ImageReply).interestId),
          headers: { cookie: cookie(b.headers) },
        }).result
      ).body,
    ).toMatchObject({ state: 'ready' })
  })

  it.each([
    { host: 'example.com' },
    { host: 'localhost.evil.invalid:5173' },
    { host: '127.1:5173' },
    { origin: 'http://evil.invalid' },
    { origin: 'null' },
    { origin: undefined },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-forwarded-for': '127.0.0.1' },
    { 'x-forwarded-host': 'localhost:5173' },
    { forwarded: 'for=127.0.0.1' },
  ])('denies rebinding, nonlocal, cross-origin and proxy headers %j', async (headers) => {
    const f = setup()
    const denied = await invokeMockHttp(f.middleware, { body: request(), headers }).result
    expect(denied.status).toBe(403)
    expect(() => imageErrorReplySchema.parse(denied.body)).not.toThrow()
    expect(f.store.inspect().jobs).toBe(0)
  })

  it('denies non-loopback peers regardless of a spoofed local Host', async () => {
    const f = setup()
    expect(
      (await invokeMockHttp(f.middleware, { body: request(), remote: '192.168.1.2' }).result)
        .status,
    ).toBe(403)
  })

  it.each(['localhost:5173', '127.0.0.1:5173', '[::1]:5173'])(
    'permits an exact direct loopback Host/Origin pair %s',
    async (host) => {
      const f = setup()
      expect(
        (
          await invokeMockHttp(f.middleware, {
            body: request(),
            headers: { host, origin: `http://${host}` },
          }).result
        ).status,
      ).toBe(202)
    },
  )

  it('rejects invalid JSON, invalid UTF-8, unsupported/compressed bodies and declared oversized content', async () => {
    const f = setup()
    for (const chunks of [[Buffer.from('{')], [Buffer.from([0xff, 0xfe])]]) {
      const reply = await invokeMockHttp(f.middleware, { chunks }).result
      expect(reply.status).toBe(400)
      expect(reply.body).toMatchObject({ error: { code: 'invalid-json' } })
    }
    for (const headers of [{ 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }]) {
      expect((await invokeMockHttp(f.middleware, { body: request(), headers }).result).status).toBe(
        415,
      )
    }
    expect(
      (
        await invokeMockHttp(f.middleware, {
          body: request(),
          headers: { 'content-length': String(MAX_IMAGE_REQUEST_BYTES + 1) },
        }).result
      ).status,
    ).toBe(413)
    expect(f.store.inspect().jobs).toBe(0)
  })

  it('caps actual streamed UTF-8 bytes before JSON parsing, irrespective of Content-Length', async () => {
    const f = setup()
    const reply = await invokeMockHttp(f.middleware, {
      chunks: [
        Buffer.from('{"padding":"'),
        Buffer.from('é'.repeat(MAX_IMAGE_REQUEST_BYTES)),
        Buffer.from('"}'),
      ],
    }).result
    expect(reply.status).toBe(413)
    expect(reply.body).toMatchObject({ error: { code: 'body-too-large' } })
    expect(f.store.inspect().jobs).toBe(0)
  })

  it('rejects injected and future fields at 422, idempotency conflict at 409', async () => {
    const f = setup()
    for (const body of [
      { ...request(), protocolVersion: 99 },
      { ...request(), resetBudget: true },
      { ...request(), mesh: 'blob' },
      { ...request(), priority: 100 },
    ]) {
      expect((await invokeMockHttp(f.middleware, { body }).result).status).toBe(422)
    }
    const first = await invokeMockHttp(f.middleware, { body: request() }).result
    const changed = request()
    changed.design.config.appearance.accent = true
    expect(
      (
        await invokeMockHttp(f.middleware, {
          body: changed,
          headers: { cookie: cookie(first.headers) },
        }).result
      ).status,
    ).toBe(409)
  })

  it('validates method, version, path, cancel identity and GET body without any admin/reset endpoint', async () => {
    const f = setup()
    const first = await invokeMockHttp(f.middleware, { body: request() }).result
    const id = (first.body as ImageReply).interestId
    const headers = { cookie: cookie(first.headers) }
    expect((await invokeMockHttp(f.middleware, { method: 'GET' }).result).status).toBe(405)
    expect((await invokeMockHttp(f.middleware, { method: 'OPTIONS' }).result).status).toBe(405)
    for (const url of [
      '/__fury-prototype/v1/reset',
      '/__fury-prototype/v2/images',
      '/__fury-prototype/v1/images?reset=true',
    ])
      expect((await invokeMockHttp(f.middleware, { url, body: {} }).result).status).toBe(404)
    expect(
      (await invokeMockHttp(f.middleware, { url: '/ordinary-app-route', method: 'GET' }).result)
        .status,
    ).toBe(0)
    expect(
      (
        await invokeMockHttp(f.middleware, {
          url: imageCancelPath(id),
          body: createImageCancelRequest('x'.repeat(32)),
          headers,
        }).result
      ).status,
    ).toBe(422)
    expect(
      (
        await invokeMockHttp(f.middleware, {
          url: imageStatusPath(id),
          method: 'GET',
          headers: { ...headers, 'content-length': '1' },
          chunks: [Buffer.from('x')],
        }).result
      ).status,
    ).toBe(422)
  })

  it('bounds slow bodies and simultaneous control requests with deterministic fake time', async () => {
    vi.useFakeTimers()
    const f = setup()
    const middleware = createMockImageMiddleware({
      service: f.service,
      principalSecret: f.store.principalSecret(),
      bodyTimeoutMs: 100,
      maxConcurrentRequests: 1,
    })
    const slow = invokeMockHttp(middleware, { end: false })
    const full = await invokeMockHttp(middleware, { body: request() }).result
    expect(full.status).toBe(429)
    await vi.advanceTimersByTimeAsync(100)
    expect((await slow.result).status).toBe(408)
    expect(f.store.inspect().jobs).toBe(0)
  })

  it('denies interrupted requests and an unavailable store without admitting unreserved work', async () => {
    const f = setup()
    const interrupted = invokeMockHttp(f.middleware, { end: false })
    interrupted.request.emit('aborted')
    expect((await interrupted.result).status).toBe(400)
    f.store.close()
    const unavailable = await invokeMockHttp(f.middleware, { body: request() }).result
    expect(unavailable.status).toBe(503)
    expect(unavailable.body).toMatchObject({ error: { code: 'unavailable' } })
  })
})
