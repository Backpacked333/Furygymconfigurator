import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CLOUD_DISPLAY_PREFIX,
  CLOUD_DISPLAY_PROTOCOL,
  CLOUD_DISPLAY_REQUEST_PATH,
  createCloudDisplayRequest,
} from '../../../display/cloudContract'
import { defaultDesign } from '../../../domain/design'
import { createCloudDisplayMiddleware, type CloudHttpService } from './http'
import { CLOUD_OWNER_COOKIE, createCloudOwnerAuth } from './auth'
import { denied } from './errors'

const owner = 'inert_cloud_owner_123456789012'
function driver() {
  return {
    submit: vi.fn(async () => {
      throw denied()
    }),
    status: vi.fn(async () => {
      throw denied()
    }),
    cancel: vi.fn(async () => {
      throw denied()
    }),
    image: vi.fn(async () => {
      throw denied()
    }),
  } satisfies CloudHttpService
}
function request(path: string, method = 'POST', headers: Record<string, string> = {}) {
  const req = new PassThrough() as unknown as IncomingMessage
  Object.assign(req, {
    url: path,
    method,
    headers: {
      host: 'localhost:12345',
      origin: 'http://localhost:12345',
      'content-type': 'application/json',
      ...headers,
    },
    rawHeaders: [],
    socket: { localPort: 12345, remoteAddress: '127.0.0.1' },
    complete: true,
  })
  req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) => [k, String(v)])
  return req
}
function response() {
  const res = new EventEmitter() as ServerResponse
  const headers = new Map<string, unknown>()
  Object.assign(res, { statusCode: 200, destroyed: false, writableEnded: false })
  res.setHeader = ((key: string, value: unknown) => {
    headers.set(key.toLowerCase(), value)
    return res
  }) as ServerResponse['setHeader']
  let done!: (value: { status: number; body: string; headers: Map<string, unknown> }) => void
  const promise = new Promise<{ status: number; body: string; headers: Map<string, unknown> }>(
    (r) => {
      done = r
    },
  )
  res.end = ((bytes?: Buffer) => {
    Object.assign(res, { writableEnded: true })
    done({ status: res.statusCode, body: bytes?.toString() ?? '', headers })
    res.emit('finish')
    return res
  }) as ServerResponse['end']
  res.destroy = (() => {
    Object.assign(res, { destroyed: true })
    res.emit('close')
    return res
  }) as ServerResponse['destroy']
  return { res, promise, headers }
}
async function invoke(
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    raw?: Buffer
    service?: CloudHttpService
    authenticated?: boolean
    duplicate?: boolean
  } = {},
) {
  const req = request(path, options.method, options.headers),
    { res, promise } = response()
  if (options.duplicate) req.rawHeaders.push('HOST', 'localhost:12345')
  createCloudDisplayMiddleware({
    service: options.service,
    authenticate: options.service
      ? () => (options.authenticated === false ? null : owner)
      : undefined,
  })(req, res, () => res.end(Buffer.from('NEXT')))
  queueMicrotask(() =>
    (req as unknown as PassThrough).end(
      options.raw ??
        Buffer.from(JSON.stringify(options.body ?? createCloudDisplayRequest(defaultDesign()))),
    ),
  )
  return promise
}

describe('in-process cloud HTTP boundary: no sockets or browsers', () => {
  it('unconfigured namespace is bounded cloud JSON, never HTML or local/P04 provenance', async () => {
    const result = await invoke(CLOUD_DISPLAY_REQUEST_PATH)
    expect(result.status).toBe(503)
    expect(JSON.parse(result.body)).toMatchObject({
      protocol: CLOUD_DISPLAY_PROTOCOL,
      error: { code: 'execution-denied', retryable: false, blocker: 'not-configured' },
    })
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(result.body.length).toBeLessThan(1024)
    expect((await invoke('/__fury-display/v1/images')).body).toBe('NEXT')
  })
  it.each<{
    path: string
    status: number
    method?: string
    headers?: Record<string, string>
    duplicate?: boolean
  }>([
    { path: `${CLOUD_DISPLAY_REQUEST_PATH}?provider=modal`, status: 404 },
    { path: '/%5f%5ffury-display-cloud/v1/images', status: 404 },
    { path: CLOUD_DISPLAY_REQUEST_PATH, method: 'GET', status: 405 },
    { path: `${CLOUD_DISPLAY_PREFIX}/unknown`, status: 404 },
    { path: CLOUD_DISPLAY_REQUEST_PATH, headers: { origin: 'http://evil.invalid' }, status: 403 },
    { path: CLOUD_DISPLAY_REQUEST_PATH, headers: { 'x-forwarded-for': '127.0.0.1' }, status: 403 },
    { path: CLOUD_DISPLAY_REQUEST_PATH, headers: { host: 'localhost:5206' }, status: 403 },
    { path: CLOUD_DISPLAY_REQUEST_PATH, duplicate: true, status: 403 },
  ])(
    'rejects malformed/cross-origin route without service dispatch: $path',
    async ({ path, status, ...rest }) => {
      const service = driver(),
        result = await invoke(path, { ...rest, service })
      expect(result.status).toBe(status)
      expect(service.submit).not.toHaveBeenCalled()
      expect(service.image).not.toHaveBeenCalled()
    },
  )
  it('requires authentication and strict request/cancel fields before touching any service method', async () => {
    const service = driver()
    expect(
      (await invoke(CLOUD_DISPLAY_REQUEST_PATH, { service, authenticated: false })).status,
    ).toBe(403)
    for (const extra of [
      { provider: 'modal' },
      { camera: [0, 0, 0] },
      { budget: 100 },
      { url: 'https://invalid' },
      { priority: 1 },
    ]) {
      expect(
        (
          await invoke(CLOUD_DISPLAY_REQUEST_PATH, {
            service,
            body: { ...createCloudDisplayRequest(defaultDesign()), ...extra },
          })
        ).status,
      ).toBe(422)
    }
    expect(
      (
        await invoke(`${CLOUD_DISPLAY_PREFIX}/jobs/inert_interest_12345678901234/cancel`, {
          service,
          body: { protocol: CLOUD_DISPLAY_PROTOCOL, all: true },
        })
      ).status,
    ).toBe(422)
    expect(service.submit).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    expect((await invoke(CLOUD_DISPLAY_REQUEST_PATH, { service })).status).toBe(503)
    expect(service.submit).toHaveBeenCalledOnce()
  })
  it('caps bodies, rejects compressed or invalid UTF8, and redacts exceptions', async () => {
    const service = driver()
    expect(
      (await invoke(CLOUD_DISPLAY_REQUEST_PATH, { service, raw: Buffer.alloc(16385, 65) })).status,
    ).toBe(413)
    expect(
      (await invoke(CLOUD_DISPLAY_REQUEST_PATH, { service, raw: Buffer.from([0xff]) })).status,
    ).toBe(400)
    expect(
      (
        await invoke(CLOUD_DISPLAY_REQUEST_PATH, {
          service,
          headers: { 'content-encoding': 'gzip' },
        })
      ).status,
    ).toBe(415)
    expect(service.submit).not.toHaveBeenCalled()
    service.submit.mockRejectedValueOnce(
      new Error('/private/path provider exception MUST NOT REFLECT'),
    )
    const result = await invoke(CLOUD_DISPLAY_REQUEST_PATH, { service })
    expect(result.status).toBe(503)
    expect(result.body).not.toContain('MUST NOT REFLECT')
  })
})
describe('distinct cloud owner authentication with inert test strings only', () => {
  const credential = 'a'.repeat(64) // Inert test literal, not a stored credential.
  const configured = () =>
    createCloudOwnerAuth(
      { kind: 'external-display-owner@1', ownerId: owner, credential, expiresAt: 2000 },
      () => 1000,
    )
  it('uses only its own expiring cookie namespace, never the local owner/permit', async () => {
    const { res } = response(),
      auth = configured()
    expect(
      await auth(request('/', 'GET', { cookie: `fury_private_display_owner=${credential}` }), res),
    ).toBeNull()
    expect(
      await auth(request('/', 'GET', { cookie: `${CLOUD_OWNER_COOKIE}=${credential}` }), res),
    ).toBe(owner)
    expect(
      await auth(
        request('/', 'GET', {
          cookie: `${CLOUD_OWNER_COOKIE}=${credential}; ${CLOUD_OWNER_COOKIE}=${credential}`,
        }),
        res,
      ),
    ).toBeNull()
    expect(
      await createCloudOwnerAuth({ kind: 'operator-local-only', credential })(request('/'), res),
    ).toBeNull()
    expect(
      await createCloudOwnerAuth(
        { kind: 'external-display-owner@1', ownerId: owner, credential, expiresAt: 1000 },
        () => 1000,
      )(request('/'), res),
    ).toBeNull()
  })
  it('permits only nonbrowser operator header exchange and never treats it as execution permission', async () => {
    const { res, headers } = response(),
      auth = configured()
    expect(
      await auth(
        request('/', 'POST', { authorization: `Bearer ${credential}`, 'sec-fetch-mode': 'cors' }),
        res,
      ),
    ).toBeNull()
    expect(await auth(request('/', 'POST', { authorization: `Bearer ${credential}` }), res)).toBe(
      owner,
    )
    const cookie = String(headers.get('set-cookie'))
    expect(cookie).toContain(`Path=${CLOUD_DISPLAY_PREFIX}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })
})
