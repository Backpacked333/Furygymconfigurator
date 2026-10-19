// In-process streams only: no server, port, customer application or browser is started.
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createLocalRenderMiddleware, type LocalRenderHttpService } from './localRenderHttp'
import {
  LOCAL_RENDER_API_PREFIX,
  LOCAL_RENDER_REQUEST_PATH,
  createLocalRenderCancelRequest,
} from './localRenderProtocol'

const interest = 'x'.repeat(32)
const statusPath = `${LOCAL_RENDER_API_PREFIX}/image-jobs/${interest}`
function service() {
  return {
    submit: vi.fn(async () => ({ status: 202, body: { state: 'queued' } })),
    status: vi.fn(async () => ({ state: 'queued' })),
    detach: vi.fn(async () => ({ state: 'cancelled' })),
    image: vi.fn(async () => Buffer.from('synthetic bytes for adapter-only test')),
  }
}
async function invoke(
  options: {
    path?: string
    method?: string
    headers?: Record<string, string | undefined>
    rawHeaders?: string[]
    remote?: string
    body?: Buffer | string
    chunks?: Buffer[]
    disabled?: boolean
    noEnd?: boolean
    timeout?: number
  } = {},
) {
  const fake = service()
  const headers = {
    host: '127.0.0.1:5173',
    origin: 'http://127.0.0.1:5173',
    'content-type': 'application/json',
    ...options.headers,
  }
  const request = Object.assign(new PassThrough(), {
    url: options.path ?? LOCAL_RENDER_REQUEST_PATH,
    method: options.method ?? 'POST',
    headers,
    rawHeaders:
      options.rawHeaders ??
      Object.entries(headers)
        .filter(([, value]) => value !== undefined)
        .flatMap(([key, value]) => [key, value!]),
    socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    complete: false,
    aborted: false,
  }) as unknown as IncomingMessage
  const result = new Promise<{
    status: number
    headers: Record<string, unknown>
    bytes: Buffer
    next?: boolean
  }>((resolve) => {
    const responseHeaders: Record<string, unknown> = {}
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      statusCode: 200,
      setHeader: (name: string, value: unknown) => {
        responseHeaders[name] = value
      },
      end(bytes: Buffer) {
        this.writableEnded = true
        resolve({ status: this.statusCode, headers: responseHeaders, bytes: Buffer.from(bytes) })
        response.emit('finish')
      },
    })
    createLocalRenderMiddleware({
      service: options.disabled ? undefined : (fake as unknown as LocalRenderHttpService),
      bodyTimeoutMs: options.timeout ?? 100,
    })(request, response as unknown as ServerResponse, () =>
      resolve({ status: 0, headers: {}, bytes: Buffer.alloc(0), next: true }),
    )
  })
  if (!options.noEnd) {
    for (const chunk of options.chunks ?? [Buffer.from(options.body ?? '{}')])
      (request as unknown as PassThrough).write(chunk)
    request.complete = true
    ;(request as unknown as PassThrough).end()
  }
  const response = await result
  request.destroy()
  return {
    ...response,
    fake,
    json:
      response.headers['Content-Type'] === 'application/json; charset=utf-8'
        ? (JSON.parse(response.bytes.toString()) as {
            mode?: string
            error?: { code: string; retryable: boolean }
          })
        : null,
  }
}

describe('strict local-real HTTP boundary', () => {
  it('dispatches submission, status, cancel and exact PNG with private/no-store headers', async () => {
    expect((await invoke()).status).toBe(202)
    const get = await invoke({ path: statusPath, method: 'GET', body: '' })
    expect(get.status).toBe(200)
    expect(get.fake.status).toHaveBeenCalledWith(interest)
    const cancel = await invoke({
      path: `${statusPath}/cancel`,
      body: JSON.stringify(createLocalRenderCancelRequest(interest)),
    })
    expect(cancel.status).toBe(200)
    expect(cancel.fake.detach).toHaveBeenCalledWith(interest)
    const image = await invoke({
      path: `${statusPath}/image/${'a'.repeat(64)}.png`,
      method: 'GET',
      body: '',
    })
    expect(image.status).toBe(200)
    expect(image.headers).toMatchObject({
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    })
    expect(image.fake.image).toHaveBeenCalledWith(interest, `sha256:${'a'.repeat(64)}`)
    expect(image.headers.Location).toBeUndefined()
    expect(image.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
  it('leaves default, mock and other product URLs untouched', async () => {
    for (const path of ['/', '/src/main.tsx', '/__fury-prototype/v1/images'])
      expect((await invoke({ path })).next).toBe(true)
  })
  it('returns typed local-real unavailable when disabled; never mock fallback', async () => {
    const result = await invoke({ disabled: true })
    expect(result.status).toBe(503)
    expect(result.json).toMatchObject({
      mode: 'local-real',
      error: { code: 'unavailable', retryable: false },
    })
    expect(result.fake.submit).not.toHaveBeenCalled()
  })
  it.each([
    { remote: '192.168.1.2' },
    { headers: { host: 'evil.test' } },
    { headers: { host: '127.0.0.1:99999' } },
    { headers: { origin: undefined } },
    { headers: { origin: 'http://evil.test' } },
    { headers: { 'x-forwarded-anything': '127.0.0.1' } },
    { headers: { 'x-real-ip': '127.0.0.1' } },
    { headers: { via: 'local-proxy' } },
    { headers: { forwarded: 'for=127.0.0.1' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': 'same-site' } },
    { headers: { 'sec-fetch-mode': 'navigate' } },
    { headers: { referer: 'http://evil.test/' } },
    { headers: { expect: '100-continue' } },
    { headers: { 'transfer-encoding': 'gzip' } },
    { headers: { 'transfer-encoding': 'chunked', 'content-length': '3' } },
    { rawHeaders: ['Host', '127.0.0.1:5173', 'host', '127.0.0.1:5173'] },
    { rawHeaders: ['Origin', 'http://127.0.0.1:5173', 'origin', 'http://127.0.0.1:5173'] },
    { rawHeaders: ['Content-Type', 'application/json', 'content-type', 'application/json'] },
  ])('denies nonlocal, proxy, browser cross-origin and ambiguous headers %j', async (options) => {
    const result = await invoke(options)
    expect(result.status).toBe(403)
    expect(result.fake.submit).not.toHaveBeenCalled()
  })
  it.each(['?x=1', '%2f', '/../images', '#fragment', '\\images', '/image/http://evil.test'])(
    'rejects route ambiguity %s',
    async (suffix) => {
      const result = await invoke({ path: `${LOCAL_RENDER_REQUEST_PATH}${suffix}` })
      expect(result.status).toBe(404)
      expect(result.fake.submit).not.toHaveBeenCalled()
    },
  )
  it.each(['OPTIONS', 'HEAD', 'PUT', 'GET'])('rejects %s submission', async (method) => {
    expect((await invoke({ method })).status).toBe(405)
  })
  it('rejects GET body, wrong cancel binding, compressed/non-JSON and malformed UTF-8/JSON', async () => {
    expect(
      (await invoke({ path: statusPath, method: 'GET', headers: { 'content-length': '1' } }))
        .status,
    ).toBe(400)
    expect(
      (
        await invoke({
          path: statusPath,
          method: 'GET',
          headers: { 'transfer-encoding': 'chunked' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await invoke({
          path: `${statusPath}/cancel`,
          body: JSON.stringify(createLocalRenderCancelRequest('y'.repeat(32))),
        })
      ).status,
    ).toBe(400)
    for (const headers of [{ 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }])
      expect((await invoke({ headers })).status).toBe(415)
    expect((await invoke({ body: '{' })).status).toBe(400)
    expect((await invoke({ body: Buffer.from([0xff]) })).json?.error?.code).toBe('invalid-json')
  })
  it('counts actual chunked UTF-8 bytes rather than trusting content-length or characters', async () => {
    const result = await invoke({
      headers: { 'transfer-encoding': 'chunked' },
      chunks: [Buffer.from('"'), Buffer.from('é'.repeat(9000)), Buffer.from('"')],
    })
    expect(result.status).toBe(413)
    expect(result.fake.submit).not.toHaveBeenCalled()
    expect((await invoke({ headers: { 'content-length': '999999' } })).status).toBe(413)
  })
  it('bounds incomplete body time without admitting work', async () => {
    const result = await invoke({ noEnd: true, timeout: 10 })
    expect(result.status).toBe(504)
    expect(result.fake.submit).not.toHaveBeenCalled()
  })
})
