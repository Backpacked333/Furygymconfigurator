import { randomBytes } from 'node:crypto'
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockArtifact } from '../protocol'
import { createControlMiddleware, createLoopbackControlServer } from './api'
import { createSignedContextAuth } from './auth'
import {
  artifactPath,
  bindRequestSync,
  CONTROL_API_PREFIX,
  CONTROL_PROTOCOL,
  ControlError,
  describeArtifact,
  diagnosticBytes,
  EXPORT_PATH,
  exportRequestFixture,
  IMAGE_PATH,
  imageRequestFixture,
  interestPath,
  MAX_REQUEST_BYTES,
  type Authenticate,
  type AuthContext,
  type ControlHttpOptions,
  type ControlService,
  type StatusReply,
  type SubmissionReply,
} from './contracts'

const auth: AuthContext = {
  principalId: 'principal-http-0001',
  experimentId: 'experiment-http-01',
  scopes: ['images:read', 'images:write', 'exports:write'],
}
const interestId = 'interest-http-0001'
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

async function fixture(
  overrides: Partial<
    Pick<ControlHttpOptions, 'authenticate' | 'bodyTimeoutMs' | 'maxConcurrentRequests'>
  > = {},
) {
  const input = imageRequestFixture()
  const binding = bindRequestSync(input.design, 'image', auth)
  const mock = await createMockArtifact(input.design)
  const object = describeArtifact(mock, input.design, binding)
  const bytes = diagnosticBytes(mock)
  const pending: StatusReply = {
    protocol: CONTROL_PROTOCOL,
    mode: 'mock-diagnostic',
    productionAllowed: false,
    paidExecutionAllowed: false,
    interestId,
    jobId: 'job-http-00000001',
    purpose: 'image',
    requested: binding.identity,
    state: 'queued',
    interestState: 'active',
    reconciliationRequired: false,
    cancellationScope: null,
    sharedWorkCancelled: false,
    artifact: null,
    error: null,
    retryAfterMs: 1000,
  }
  const service = {
    submitImage: vi.fn<ControlService['submitImage']>(async () => ({ status: 202, body: pending })),
    submitExport: vi.fn<ControlService['submitExport']>(async () => ({
      status: 202,
      body: { ...pending, purpose: 'export' },
    })),
    status: vi.fn<ControlService['status']>(async () => pending),
    cancel: vi.fn<ControlService['cancel']>(async () => ({
      ...pending,
      interestState: 'cancelled',
      cancellationScope: 'interest-only',
    })),
    artifact: vi.fn<ControlService['artifact']>(async () => ({ object, bytes })),
  }
  const adapter = createSignedContextAuth({ secret: randomBytes(32).toString('hex') })
  const authenticate = vi.fn(overrides.authenticate ?? adapter.authenticate)
  const server = createLoopbackControlServer({ service, authenticate, ...overrides })
  expect(server.listening).toBe(false)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const authorization = `Bearer ${adapter.issue(auth, 60_000)}`
  const defaults = { authorization, 'content-type': 'application/json' }
  type SendOptions = {
    path?: string
    method?: string
    body?: string | Buffer
    headers?: Record<string, string | string[] | undefined>
    authenticated?: boolean
  }
  const send = ({
    path = IMAGE_PATH,
    method = 'POST',
    body = JSON.stringify(input),
    headers = {},
    authenticated = true,
  }: SendOptions = {}) =>
    new Promise<{
      status: number
      headers: IncomingHttpHeaders
      bytes: Buffer
      text: string
    }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            ...(authenticated ? defaults : { 'content-type': 'application/json' }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const bytes = Buffer.concat(chunks)
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              bytes,
              text: bytes.toString('utf8'),
            })
          })
          response.on('error', reject)
        },
      )
      request.on('error', reject)
      request.end(body)
    })
  return {
    server,
    send,
    service,
    authenticate,
    input,
    binding,
    object,
    bytes,
    pending,
    authorization,
    port,
  }
}

describe('unmounted bounded local control HTTP adapter', () => {
  it('dispatches strict authenticated image misses as 202 without renderer/provider access', async () => {
    const f = await fixture()
    const response = await f.send()
    expect(response.status).toBe(202)
    expect(JSON.parse(response.text)).toEqual(f.pending)
    expect(response.headers['retry-after']).toBe('1')
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers.vary).toBe('Authorization, Origin')
    expect(f.service.submitImage).toHaveBeenCalledExactlyOnceWith(auth, f.input)
    expect(f.service.submitExport).not.toHaveBeenCalled()
  })

  it('returns a valid verified-ready service response as 200, not another queued job', async () => {
    const f = await fixture()
    const body: StatusReply = {
      ...f.pending,
      state: 'ready',
      artifact: f.object,
      retryAfterMs: null,
    }
    f.service.submitImage.mockResolvedValue({ status: 200, body })
    const response = await f.send()
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual(body)
    expect(response.headers['cache-control']).not.toContain('public')
  })

  it('has a distinct strict export route with no real/PDF promise', async () => {
    const f = await fixture()
    expect(
      (await f.send({ path: EXPORT_PATH, body: JSON.stringify(exportRequestFixture()) })).status,
    ).toBe(202)
    expect(f.service.submitExport).toHaveBeenCalledExactlyOnceWith(auth, exportRequestFixture())
    expect(f.service.submitImage).not.toHaveBeenCalled()
    expect(
      (
        await f.send({
          path: EXPORT_PATH,
          body: JSON.stringify({ ...exportRequestFixture(), format: 'pdf' }),
        })
      ).status,
    ).toBe(422)
    expect((await f.send({ body: JSON.stringify(exportRequestFixture()) })).status).toBe(422)
  })

  it.each([
    'assetURLs',
    'meshes',
    'camera',
    'samples',
    'script',
    'callback',
    'workerCommand',
    'priority',
    'principalId',
    'experimentId',
  ])('rejects unknown %s without invoking even an injected service', async (field) => {
    const f = await fixture()
    expect(
      (await f.send({ body: JSON.stringify({ ...f.input, [field]: 'untrusted' }) })).status,
    ).toBe(422)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('enforces v4 named presentation/profile validation before service invocation', async () => {
    const f = await fixture()
    const withoutPresentation = {
      config: f.input.design.config,
      outputProfile: f.input.design.outputProfile,
    }
    for (const design of [
      { ...f.input.design, config: { ...f.input.design.config, schemaVersion: 3 } },
      withoutPresentation,
      { ...f.input.design, outputProfile: 'arbitrary-8k' },
    ])
      expect((await f.send({ body: JSON.stringify({ ...f.input, design }) })).status).toBe(422)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('returns 401 for missing/invalid/duplicate auth and ignores identity headers/body', async () => {
    const f = await fixture()
    expect((await f.send({ authenticated: false })).status).toBe(401)
    expect((await f.send({ headers: { authorization: 'Bearer invalid' } })).status).toBe(401)
    expect(
      (await f.send({ headers: { authorization: [f.authorization, f.authorization] } })).status,
    ).toBe(401)
    expect(
      (
        await f.send({
          authenticated: false,
          headers: { 'x-principal-id': auth.principalId },
          body: JSON.stringify({ ...f.input, auth }),
        })
      ).status,
    ).toBe(401)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('rejects an injected authenticator returning a malformed identity', async () => {
    const f = await fixture({
      authenticate: (() => ({ principalId: 'x' })) as unknown as Authenticate,
    })
    expect((await f.send()).status).toBe(401)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it.each([
    { origin: 'https://attacker.invalid' },
    { origin: 'null' },
    { host: 'rebind.invalid:80' },
    { 'x-forwarded-for': '127.0.0.1' },
    { 'x-forwarded-host': 'localhost' },
    { forwarded: 'for=127.0.0.1' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ])('rejects cross-origin, DNS-rebind or proxy transport %#', async (headers) => {
    const f = await fixture()
    const response = await f.send({ headers })
    expect(response.status).toBe(403)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(f.authenticate).not.toHaveBeenCalled()
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('accepts exact same origin and direct nonbrowser loopback; rejects mismatched local origin', async () => {
    const f = await fixture()
    expect(
      (
        await f.send({
          headers: { origin: `http://127.0.0.1:${f.port}`, 'sec-fetch-site': 'same-origin' },
        })
      ).status,
    ).toBe(202)
    expect((await f.send({ headers: { origin: `http://localhost:${f.port}` } })).status).toBe(403)
  })

  it('rejects nonloopback peers even if mounted on a wider server', async () => {
    const f = await fixture()
    f.server.prependListener('request', (request) =>
      Object.defineProperty(request.socket, 'remoteAddress', { value: '203.0.113.1' }),
    )
    expect((await f.send()).status).toBe(403)
    expect(f.authenticate).not.toHaveBeenCalled()
  })

  it.each([
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/json; charset=iso-8859-1' },
    { 'content-encoding': 'gzip' },
    { 'content-encoding': 'br' },
    { expect: '100-continue' },
  ])('rejects compressed, ambiguous or unsupported media %#', async (headers) => {
    const f = await fixture()
    expect((await f.send({ headers })).status).toBe(415)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON or invalid UTF-8 instead of admitting replacement bytes', async () => {
    const f = await fixture()
    for (const body of ['{', '', Buffer.from([0xff, 0xfe]), '{"protocol":"x"}\n{}'])
      expect((await f.send({ body })).status).toBe(400)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('bounds both announced and actual chunked UTF-8 bytes, not string character count', async () => {
    const f = await fixture()
    expect(
      (await f.send({ body: 'x', headers: { 'content-length': String(MAX_REQUEST_BYTES + 1) } }))
        .status,
    ).toBe(413)
    const body = JSON.stringify({ payload: 'é'.repeat(9000) })
    expect(body.length).toBeLessThan(MAX_REQUEST_BYTES)
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_REQUEST_BYTES)
    expect((await f.send({ body, headers: { 'transfer-encoding': 'chunked' } })).status).toBe(413)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('allows exactly 16 KiB actual JSON body and rejects one byte more', async () => {
    const f = await fixture()
    const body = JSON.stringify(f.input)
    expect((await f.send({ body: body.padEnd(MAX_REQUEST_BYTES, ' ') })).status).toBe(202)
    expect(
      (
        await f.send({
          body: body.padEnd(MAX_REQUEST_BYTES + 1, ' '),
          headers: { 'transfer-encoding': 'chunked' },
        })
      ).status,
    ).toBe(413)
    expect(f.service.submitImage).toHaveBeenCalledTimes(1)
  })

  it('allows owned status and strict interest-only cancel, rejects bodies on GET', async () => {
    const f = await fixture()
    expect((await f.send({ path: interestPath(interestId), method: 'GET', body: '' })).status).toBe(
      200,
    )
    const detached = await f.send({
      path: `${interestPath(interestId)}/cancel`,
      body: JSON.stringify({ protocol: CONTROL_PROTOCOL }),
    })
    expect(detached.status).toBe(200)
    expect(JSON.parse(detached.text)).toMatchObject({
      state: 'queued',
      interestState: 'cancelled',
      sharedWorkCancelled: false,
    })
    expect(
      (
        await f.send({
          path: `${interestPath(interestId)}/cancel`,
          body: JSON.stringify({ protocol: CONTROL_PROTOCOL, job: 'cancel-all' }),
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await f.send({
          path: interestPath(interestId),
          method: 'GET',
          body: '{}',
          headers: { 'content-length': '2' },
        })
      ).status,
    ).toBe(400)
  })

  it.each(['streams', 'workers', 'kill', 'policy', 'execute', 'objects/private', 'exports/sign'])(
    'does not expose %s control routes',
    async (path) => {
      const f = await fixture()
      expect((await f.send({ path: `${CONTROL_API_PREFIX}/${path}` })).status).toBe(404)
      expect(f.service.submitImage).not.toHaveBeenCalled()
    },
  )

  it('does not accept signed/bearer URLs or path transformations, and never reflects them', async () => {
    const f = await fixture()
    for (const path of [
      `${IMAGE_PATH}?token=DO_NOT_REFLECT`,
      `${IMAGE_PATH}%2f`,
      `${CONTROL_API_PREFIX}/interests/..%2fprivate/artifact`,
    ]) {
      const response = await f.send({ path })
      expect(response.status).toBe(400)
      expect(response.text).not.toContain('DO_NOT_REFLECT')
      expect(response.text).not.toContain('%2f')
    }
  })

  it('returns method 405 and only passes unrelated routes to next', async () => {
    const f = await fixture()
    const response = await f.send({ method: 'GET', body: '' })
    expect(response.status).toBe(405)
    expect(response.headers.allow).toBe('POST')
    const next = vi.fn()
    const middleware = createControlMiddleware({ service: f.service, authenticate: f.authenticate })
    middleware({ url: '/existing-ui' } as IncomingMessage, {} as ServerResponse, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it.each([
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'idempotency-conflict'],
    [410, 'expired'],
    [429, 'budget-exceeded'],
    [429, 'capacity-exceeded'],
    [503, 'killed'],
    [503, 'reconciliation-required'],
  ] as const)(
    'preserves typed service status %s/%s but strips arbitrary error text',
    async (status, code) => {
      const f = await fixture()
      f.service.submitImage.mockRejectedValue(
        new ControlError(status, code, 'secret private/path?bearer=DO_NOT_REFLECT'),
      )
      const response = await f.send()
      expect(response.status).toBe(status)
      expect(JSON.parse(response.text).error.code).toBe(code)
      expect(response.text).not.toMatch(/DO_NOT_REFLECT|private\/path/)
      if (status === 429) expect(response.headers['retry-after']).toBe('1')
    },
  )

  it('maps raw dependency failures to sanitized fail-closed 503 and rejects impossible success replies', async () => {
    const f = await fixture()
    f.service.submitImage.mockRejectedValueOnce(new Error('secret raw database error'))
    const failure = await f.send()
    expect(failure.status).toBe(503)
    expect(failure.text).not.toContain('secret')
    f.service.submitImage.mockResolvedValueOnce({ status: 200, body: f.pending })
    expect((await f.send()).status).toBe(503)
  })

  it('delivers diagnostic bytes with checksum ETag and never uses shared public cache', async () => {
    const f = await fixture()
    const response = await f.send({ path: artifactPath(interestId), method: 'GET', body: '' })
    expect(response.status).toBe(200)
    expect(response.bytes).toEqual(Buffer.from(f.bytes))
    expect(response.headers.etag).toBe(`"${f.object.checksum}"`)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['content-type']).toBe('image/svg+xml')
    expect(response.headers['content-security-policy']).toContain('sandbox')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-disposition']).toContain(f.binding.revision.slice(7))
    expect(response.text).toContain('MOCK DIAGNOSTIC')
  })

  it('serves private diagnostic exports as authenticated no-store immutable-revision attachments', async () => {
    const f = await fixture()
    const binding = bindRequestSync(f.input.design, 'export', auth)
    const object = describeArtifact(
      await createMockArtifact(f.input.design),
      f.input.design,
      binding,
    )
    f.service.artifact.mockResolvedValue({ object, bytes: f.bytes })
    const response = await f.send({ path: artifactPath(interestId), method: 'GET', body: '' })
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="mock-diagnostic-${binding.revision.slice(7)}.svg"`,
    )
    expect(
      (
        await f.send({
          path: artifactPath(interestId),
          method: 'GET',
          body: '',
          authenticated: false,
        })
      ).status,
    ).toBe(401)
  })

  it('rejects corrupt artifact bytes even from a faulty service adapter', async () => {
    const f = await fixture()
    f.service.artifact.mockResolvedValue({
      object: f.object,
      bytes: new Uint8Array(f.bytes.length),
    })
    const response = await f.send({ path: artifactPath(interestId), method: 'GET', body: '' })
    expect(response.status).toBe(503)
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('bounds body wall time and closes a slow partial request without admitting it', async () => {
    const f = await fixture({ bodyTimeoutMs: 40 })
    const result = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: f.port,
          path: IMAGE_PATH,
          method: 'POST',
          headers: {
            authorization: f.authorization,
            'content-type': 'application/json',
            'content-length': '1000',
          },
        },
        (response) => {
          response.resume()
          response.on('end', () => {
            request.destroy()
            resolve(response.statusCode!)
          })
        },
      )
      request.on('error', reject)
      request.write('{')
    })
    expect(result).toBe(408)
    expect(f.service.submitImage).not.toHaveBeenCalled()
  })

  it('retains request capacity for timed-out unabortable auth and never dispatches after its deadline', async () => {
    let resolveAuth!: (auth: AuthContext) => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<AuthContext>((resolve) => {
      resolveAuth = resolve
    })
    let count = 0
    const f = await fixture({
      bodyTimeoutMs: 40,
      maxConcurrentRequests: 1,
      authenticate: () => {
        count += 1
        if (count === 1) {
          entered()
          return held
        }
        return auth
      },
    })
    const first = f.send()
    await enteredPromise
    expect((await f.send()).status).toBe(429)
    expect((await first).status).toBe(408)
    expect((await f.send()).status).toBe(429)
    resolveAuth(auth)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.service.submitImage).not.toHaveBeenCalled()
    expect((await f.send()).status).toBe(202)
    expect(f.service.submitImage).toHaveBeenCalledTimes(1)
  })

  it('bounds waiting service time without reporting late success or allowing unbounded detached work', async () => {
    const f = await fixture({ bodyTimeoutMs: 40, maxConcurrentRequests: 1 })
    let resolveService!: (result: SubmissionReply) => void
    f.service.submitImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveService = resolve
        }),
    )
    expect((await f.send()).status).toBe(408)
    expect((await f.send()).status).toBe(429)
    resolveService({ status: 202, body: f.pending })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((await f.send()).status).toBe(202)
  })

  it('rejects unbounded middleware options', async () => {
    const f = await fixture()
    for (const options of [
      { bodyTimeoutMs: 0 },
      { bodyTimeoutMs: 30_001 },
      { maxConcurrentRequests: 0 },
      { maxConcurrentRequests: 33 },
    ])
      expect(() =>
        createControlMiddleware({ service: f.service, authenticate: f.authenticate, ...options }),
      ).toThrow()
  })
})
