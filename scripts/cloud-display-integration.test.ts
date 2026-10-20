// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ViteDevServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudDisplayServicePlugin } from './cloud-display-service-plugin'
import {
  createCloudDisplayMiddleware,
  type CloudMiddleware,
} from '../src/image-service/remote-display/service/http'
import { createCloudDisplayService } from '../src/image-service/remote-display/service/service'
import { createRemoteDisplayBackend } from '../src/image-service/remote-display/worker/backend'
import {
  CLOUD_OWNER_COOKIE,
  createCloudOwnerAuth,
} from '../src/image-service/remote-display/service/auth'
import {
  CLOUD_DISPLAY_PROTOCOL,
  CLOUD_DISPLAY_REQUEST_PATH,
  createCloudDisplayRequest,
} from '../src/display/cloudContract'
import { defaultDesign } from '../src/domain/design'
import {
  startCloudDisplayRequest,
  type CloudDisplayProgress,
} from '../src/prototype/cloudDisplayClient'

const origin = 'http://localhost:12345'
// Inert authentication fixture only; never read or create any credential/permit file.
const credential = 'c'.repeat(64)
const ownerId = 'inert_integration_owner_123456'
function bridge(middleware: CloudMiddleware, cookie?: string) {
  const next = vi.fn()
  const responses: { status: number; body: unknown }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.origin).toBe(origin)
    expect(init).toMatchObject({
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    })
    const req = new PassThrough() as unknown as IncomingMessage
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    Object.assign(req, {
      url: url.pathname,
      method: init?.method ?? 'GET',
      headers: { ...headers, host: url.host, origin, ...(cookie ? { cookie } : {}) },
      socket: { localPort: 12345, remoteAddress: '127.0.0.1' },
      complete: true,
    })
    req.rawHeaders = Object.entries(req.headers).flatMap(([k, v]) => [k, String(v)])
    return new Promise<Response>((resolve) => {
      const res = new EventEmitter() as ServerResponse
      const output = new Headers()
      Object.assign(res, { statusCode: 200, destroyed: false, writableEnded: false })
      res.setHeader = ((name: string, value: string | number) => {
        output.set(name, String(value))
        return res
      }) as ServerResponse['setHeader']
      res.end = ((bytes?: Buffer) => {
        Object.assign(res, { writableEnded: true })
        const body = bytes?.toString() ?? ''
        responses.push({ status: res.statusCode, body: JSON.parse(body) })
        const response = new Response(body, { status: res.statusCode, headers: output })
        Object.defineProperty(response, 'url', { value: url.href })
        res.emit('finish')
        resolve(response)
        return res
      }) as ServerResponse['end']
      middleware(req, res, next)
      queueMicrotask(() => (req as unknown as PassThrough).end(init?.body))
    })
  })
  return { fetch, next, responses }
}
async function client(middleware: CloudMiddleware, cookie?: string) {
  const wire = bridge(middleware, cookie)
  const decode = vi.fn(),
    createObjectURL = vi.fn(),
    revokeObjectURL = vi.fn()
  const events: CloudDisplayProgress[] = []
  const done = new Promise<void>((resolve) => {
    const stop = startCloudDisplayRequest(
      defaultDesign(),
      (event) => {
        events.push(event)
        if (event.state === 'unavailable' || event.state === 'error') {
          resolve()
          queueMicrotask(stop)
        }
      },
      { origin, fetch: wire.fetch, decode, createObjectURL, revokeObjectURL },
    )
  })
  await done
  expect(wire.fetch).toHaveBeenCalledOnce()
  expect(wire.fetch.mock.calls[0][0]).toBe(origin + CLOUD_DISPLAY_REQUEST_PATH)
  expect(JSON.parse(String(wire.fetch.mock.calls[0][1]?.body))).toEqual(
    createCloudDisplayRequest(defaultDesign()),
  )
  expect(events.map((event) => event.state)).toEqual(['pending', 'unavailable'])
  expect(events[1]).toMatchObject({
    message: expect.stringContaining('execution-denied; not-configured'),
    retryable: false,
  })
  expect(decode).not.toHaveBeenCalled()
  expect(createObjectURL).not.toHaveBeenCalled()
  expect(revokeObjectURL).not.toHaveBeenCalled()
  expect(wire.next).not.toHaveBeenCalled()
  expect(wire.responses).toEqual([
    {
      status: 503,
      body: expect.objectContaining({
        protocol: CLOUD_DISPLAY_PROTOCOL,
        error: expect.objectContaining({ code: 'execution-denied', blocker: 'not-configured' }),
      }),
    },
  ])
}
afterEach(() => vi.unstubAllEnvs())
describe('real cloud client to real private middleware/service: in-process, no listener or pixels', () => {
  it('reaches the production plugin cloud error contract rather than local/P04/HTML fallback', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
    let middleware!: CloudMiddleware
    const plugin = cloudDisplayServicePlugin()
    await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)({
      config: {
        root: '/home/ubuntu/Documents/fury-display-cloud',
        command: 'serve',
        mode: 'development',
        isProduction: false,
        logger: { warn: vi.fn() },
      },
      middlewares: {
        use: (value: CloudMiddleware) => {
          middleware = value
        },
      },
      httpServer: { once: vi.fn() },
    } as unknown as ViteDevServer)
    try {
      await client(middleware)
    } finally {
      await (plugin.closeBundle as () => Promise<void>)()
    }
  })
  it('authenticates an inert owner and reaches service.submit without preparation or worker execution', async () => {
    const backend = createRemoteDisplayBackend()
    const prepare = vi.spyOn(backend, 'prepare'),
      open = vi.spyOn(backend, 'open'),
      revalidate = vi.spyOn(backend, 'revalidate')
    const service = createCloudDisplayService({ backend })
    const submit = vi.spyOn(service, 'submit')
    const middleware = createCloudDisplayMiddleware({
      service,
      authenticate: createCloudOwnerAuth(
        { kind: 'external-display-owner@1', ownerId, credential, expiresAt: 2000 },
        () => 1000,
      ),
    })
    try {
      await client(middleware, `${CLOUD_OWNER_COOKIE}=${credential}`)
      expect(submit).toHaveBeenCalledOnce()
      expect(submit.mock.calls[0][0]).toBe(ownerId)
      expect(prepare).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(revalidate).not.toHaveBeenCalled()
    } finally {
      await service.close()
    }
  })
})
