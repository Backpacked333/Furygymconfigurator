import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  artifactDescriptorSchema,
  authContextSchema,
  cancelRequestSchema,
  CONTROL_API_PREFIX,
  CONTROL_PROTOCOL,
  ControlError,
  EXPORT_PATH,
  exportRequestSchema,
  IMAGE_PATH,
  imageRequestSchema,
  MAX_REQUEST_BYTES,
  parseSubmissionReply,
  sha256Bytes,
  statusReplySchema,
  type ControlHttpOptions,
  type ControlMiddleware,
  type ErrorCode,
} from './contracts'

const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  'invalid-request': 'Request does not match the strict local diagnostic protocol.',
  'invalid-json': 'Request body must be one valid UTF-8 JSON value.',
  'body-too-large': 'Request body exceeds the 16 KiB limit.',
  'unsupported-media-type': 'Only uncompressed application/json with UTF-8 is accepted.',
  unauthorized: 'A valid expiring authentication credential is required.',
  forbidden: 'Request origin, local transport, or granted scope is not permitted.',
  'not-found': 'Owned interest or local route was not found.',
  'method-not-allowed': 'HTTP method is not supported on this local route.',
  'idempotency-conflict': 'Idempotency key is already bound to a different request.',
  'capacity-exceeded': 'A bounded local request, job, or delivery capacity has been reached.',
  'budget-exceeded': 'Worst-case reservation exceeds the available synthetic budget.',
  killed: 'The persistent control kill switch is enabled.',
  'store-unavailable': 'Durable control state is unavailable; execution is denied.',
  unavailable: 'The bounded local diagnostic operation is unavailable or timed out.',
  expired: 'This credential or interest no longer permits the operation.',
  'stale-lease': 'The private execution lease is no longer valid.',
  'identity-mismatch': 'Immutable diagnostic identity could not be verified.',
  'publication-failed': 'Immutable diagnostic publication could not be verified.',
  'reconciliation-required': 'Execution outcome remains unresolved; liability is retained.',
  'paid-execution-disabled': 'Paid execution is permanently unavailable in this phase.',
})

type Route = {
  kind: 'image' | 'export' | 'status' | 'cancel' | 'artifact'
  method: 'POST' | 'GET'
  id?: string
}

function routeFor(target: string): Route {
  if (
    target.length > 512 ||
    target.includes('?') ||
    target.includes('#') ||
    target.includes('%') ||
    target.includes('\\')
  )
    throw new ControlError(400, 'invalid-request', 'Only an exact fixed local path is supported.')
  if (target === IMAGE_PATH) return { kind: 'image', method: 'POST' }
  if (target === EXPORT_PATH) return { kind: 'export', method: 'POST' }
  const match = new RegExp(
    `^${CONTROL_API_PREFIX}/interests/([A-Za-z0-9_-]{16,128})(?:/(cancel|artifact))?$`,
  ).exec(target)
  if (!match) throw new ControlError(404, 'not-found', 'Local route was not found.')
  return {
    kind: match[2] === 'cancel' ? 'cancel' : match[2] === 'artifact' ? 'artifact' : 'status',
    method: match[2] === 'cancel' ? 'POST' : 'GET',
    id: match[1],
  }
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i].toLowerCase() === name) count += 1
  return count
}

function requireLocalOrigin(request: IncomingMessage): void {
  const remote = request.socket.remoteAddress
  const port = request.socket.localPort
  const host = request.headers.host
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') ||
    !port ||
    headerCount(request, 'host') !== 1 ||
    typeof host !== 'string' ||
    ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host) ||
    Object.keys(request.headers).some(
      (name) =>
        name === 'forwarded' ||
        name === 'via' ||
        name === 'x-real-ip' ||
        name.startsWith('x-forwarded-'),
    )
  )
    throw new ControlError(403, 'forbidden', 'Only direct loopback transport is permitted.')
  const origin = request.headers.origin
  if (
    (origin !== undefined &&
      (headerCount(request, 'origin') !== 1 || origin !== `http://${host}`)) ||
    (request.headers['sec-fetch-site'] !== undefined &&
      !['none', 'same-origin'].includes(String(request.headers['sec-fetch-site'])))
  )
    throw new ControlError(
      403,
      'forbidden',
      'Only same-origin or direct authenticated local clients are permitted.',
    )
  if (headerCount(request, 'authorization') > 1)
    throw new ControlError(401, 'unauthorized', 'Duplicate authorization is not accepted.')
}

function framing(request: IncomingMessage, expectsBody: boolean): void {
  const length = request.headers['content-length']
  const transfer = request.headers['transfer-encoding']
  if (
    length !== undefined &&
    (!/^\d{1,8}$/.test(length) || headerCount(request, 'content-length') !== 1)
  )
    throw new ControlError(400, 'invalid-request', 'Ambiguous body length is not accepted.')
  if (
    transfer !== undefined &&
    (transfer !== 'chunked' ||
      length !== undefined ||
      headerCount(request, 'transfer-encoding') !== 1)
  )
    throw new ControlError(400, 'invalid-request', 'Ambiguous transfer framing is not accepted.')
  if (!expectsBody) {
    if (transfer !== undefined || (length !== undefined && Number(length) !== 0))
      throw new ControlError(400, 'invalid-request', 'This route does not accept a body.')
    return
  }
  if (length !== undefined && Number(length) > MAX_REQUEST_BYTES)
    throw new ControlError(413, 'body-too-large', 'Body exceeds the fixed byte limit.')
  const type = request.headers['content-type']
  const encoding = request.headers['content-encoding']
  if (
    typeof type !== 'string' ||
    headerCount(request, 'content-type') !== 1 ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(type) ||
    (encoding !== undefined &&
      (encoding !== 'identity' || headerCount(request, 'content-encoding') !== 1))
  )
    throw new ControlError(415, 'unsupported-media-type', 'Unsupported request encoding.')
}

function readJson(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let length = 0
    const chunks: Buffer[] = []
    let ended = false
    const cleanup = () => {
      request.off('data', data)
      request.off('end', end)
      request.off('error', error)
      request.off('aborted', abort)
      signal.removeEventListener('abort', abort)
    }
    const fail = (failure: ControlError) => {
      if (ended) return
      ended = true
      cleanup()
      request.pause()
      reject(failure)
    }
    const abort = () =>
      fail(new ControlError(408, 'unavailable', 'Local body read was interrupted.'))
    const error = () => fail(new ControlError(400, 'invalid-json', 'Local body read failed.'))
    const data = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      length += bytes.byteLength
      if (length > MAX_REQUEST_BYTES) {
        fail(new ControlError(413, 'body-too-large', 'Actual body bytes exceed the limit.'))
        return
      }
      chunks.push(bytes)
    }
    const end = () => {
      if (ended) return
      ended = true
      cleanup()
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))
        resolve(JSON.parse(text))
      } catch {
        reject(new ControlError(400, 'invalid-json', 'Invalid UTF-8 JSON.'))
      }
    }
    request.on('data', data)
    request.once('end', end)
    request.once('error', error)
    request.once('aborted', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted || request.aborted) abort()
  })
}

function secureHeaders(response: ServerResponse): void {
  // Identity may be public, but all current delivery is authenticated and never shared-cacheable.
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('Vary', 'Authorization, Origin')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  const bytes = Buffer.from(JSON.stringify(body))
  secureHeaders(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', bytes.byteLength)
  response.end(bytes)
}

function failure(response: ServerResponse, input: unknown): void {
  const error =
    input instanceof ControlError
      ? input
      : new ControlError(503, 'store-unavailable', 'Local control state unavailable.')
  // Never log/reflect input, bearer tokens, URLs, stored provider text or raw dependency exceptions.
  response.shouldKeepAlive = false
  if (!response.headersSent) {
    response.setHeader('Connection', 'close')
    if (error.status === 429 || error.retryable) response.setHeader('Retry-After', '1')
  }
  json(response, error.status, {
    protocol: CONTROL_PROTOCOL,
    error: { code: error.code, message: ERROR_MESSAGES[error.code], retryable: error.retryable },
  })
}

/** Explicitly mounted by a trusted local caller only; does not alter Vite, UI, routes or provider state. */
export function createControlMiddleware(options: ControlHttpOptions): ControlMiddleware {
  const timeoutMs = options.bodyTimeoutMs ?? 5000
  const maxConcurrent = options.maxConcurrentRequests ?? 4
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 32
  )
    throw new TypeError('Local HTTP timeout and request concurrency must be bounded.')
  let active = 0
  return (request, response, next) => {
    const target = request.url ?? ''
    if (!(
      target === CONTROL_API_PREFIX ||
      target.startsWith(`${CONTROL_API_PREFIX}/`) ||
      target.startsWith(`${CONTROL_API_PREFIX}?`)
    )) {
      next()
      return
    }
    if (active >= maxConcurrent) {
      failure(
        response,
        new ControlError(429, 'capacity-exceeded', 'Local request capacity reached.', true),
      )
      return
    }
    active += 1
    let alive = true
    let operationDone = false
    let transportDone = false
    let released = false
    const controller = new AbortController()
    const release = () => {
      // A timed-out unabortable dependency keeps its slot until it settles: no unbounded detached promises.
      if (operationDone && transportDone && !released) {
        released = true
        active -= 1
      }
    }
    const finish = () => {
      alive = false
      transportDone = true
      clearTimeout(timer)
      controller.abort()
      release()
      response.off('finish', finish)
      response.off('close', finish)
    }
    const timer = setTimeout(() => {
      if (!alive) return
      alive = false
      controller.abort()
      failure(response, new ControlError(408, 'unavailable', 'Local request deadline elapsed.'))
    }, timeoutMs)
    timer.unref()
    response.once('finish', finish)
    response.once('close', finish)

    void (async () => {
      try {
        requireLocalOrigin(request)
        const route = routeFor(target)
        if (request.method !== route.method) {
          response.setHeader('Allow', route.method)
          throw new ControlError(405, 'method-not-allowed', 'Unsupported route method.')
        }
        framing(request, route.method === 'POST')
        const identity = await options.authenticate(request)
        if (!alive) return
        const auth = authContextSchema.safeParse(identity)
        if (!auth.success) throw new ControlError(401, 'unauthorized', 'Authentication required.')
        if (route.kind === 'image' || route.kind === 'export') {
          const input = await readJson(request, controller.signal)
          if (!alive) return
          const parsed = (
            route.kind === 'image' ? imageRequestSchema : exportRequestSchema
          ).safeParse(input)
          if (!parsed.success)
            throw new ControlError(422, 'invalid-request', 'Strict diagnostic request required.')
          const result =
            route.kind === 'image'
              ? await options.service.submitImage(auth.data, parsed.data)
              : await options.service.submitExport(auth.data, parsed.data)
          if (!alive) return
          const reply = parseSubmissionReply(result.status, result.body)
          if (reply.status === 202)
            response.setHeader(
              'Retry-After',
              String(Math.ceil((reply.body.retryAfterMs ?? 1000) / 1000)),
            )
          json(response, reply.status, reply.body)
        } else if (route.kind === 'cancel') {
          const input = await readJson(request, controller.signal)
          if (!alive) return
          if (!cancelRequestSchema.safeParse(input).success)
            throw new ControlError(422, 'invalid-request', 'Strict cancel protocol required.')
          const result = statusReplySchema.parse(await options.service.cancel(auth.data, route.id!))
          if (alive) json(response, 200, result)
        } else if (route.kind === 'status') {
          const result = statusReplySchema.parse(await options.service.status(auth.data, route.id!))
          if (alive) json(response, 200, result)
        } else {
          const result = await options.service.artifact(auth.data, route.id!)
          if (!alive) return
          const object = artifactDescriptorSchema.parse(result.object)
          if (
            result.bytes.byteLength !== object.byteLength ||
            sha256Bytes(result.bytes) !== object.checksum
          )
            throw new ControlError(
              503,
              'publication-failed',
              'Returned bytes failed immutable verification.',
            )
          secureHeaders(response)
          response.statusCode = 200
          response.setHeader('Content-Type', object.mediaType)
          response.setHeader('Content-Length', result.bytes.byteLength)
          response.setHeader('ETag', `"${object.checksum}"`)
          response.setHeader(
            'Content-Disposition',
            `${object.binding.purpose === 'export' ? 'attachment' : 'inline'}; filename="mock-diagnostic-${object.binding.revision.slice(7)}.svg"`,
          )
          response.end(result.bytes)
        }
      } catch (error) {
        if (alive) failure(response, error)
      } finally {
        operationDone = true
        release()
      }
    })()
  }
}

/** Returns an UNLISTENED, bounded HTTP server. The integrator must explicitly listen on 127.0.0.1/::1.
 * Non-loopback clients are rejected even if the caller mistakenly binds a wider interface.
 * No authentication issuer, worker, shutdown, stream, kill, policy or signed-URL route exists.
 */
export function createLoopbackControlServer(options: ControlHttpOptions): Server {
  const middleware = createControlMiddleware(options)
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 10_000,
      connectionsCheckingInterval: 1000,
      keepAliveTimeout: 1000,
    },
    (request, response) =>
      middleware(request, response, () =>
        failure(response, new ControlError(404, 'not-found', 'Local route not found.')),
      ),
  )
  server.maxConnections = 32
  server.maxRequestsPerSocket = 32
  // Reject Expect before Node can send 100-continue or queue an unbounded body.
  server.on('checkContinue', (_request, response) =>
    failure(response, new ControlError(415, 'unsupported-media-type', 'Expect is unsupported.')),
  )
  server.on('checkExpectation', (_request, response) =>
    failure(response, new ControlError(415, 'unsupported-media-type', 'Expect is unsupported.')),
  )
  return server
}
