import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import {
  IMAGE_PROTOCOL,
  IMAGE_PROTOCOL_VERSION,
  IMAGE_REQUEST_PATH,
  PROTOTYPE_API_PREFIX,
  MAX_IMAGE_REQUEST_BYTES,
  imageCancelRequestSchema,
  imageErrorReplySchema,
} from './protocol'
import { ImageServiceError, unavailable } from './errors'
import type { MockImageService } from './service'

export const LOCAL_PRINCIPAL_COOKIE = 'fury_mock_principal_v1'
export type MockImageMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void
export type MockHttpOptions = {
  service: MockImageService
  principalSecret: string
  bodyTimeoutMs?: number
  maxConcurrentRequests?: number
}

function localRequest(request: IncomingMessage): { origin: string; secure: boolean } {
  const host = request.headers.host
  const remote = request.socket.remoteAddress
  const forbidden = () =>
    new ImageServiceError(
      403,
      'forbidden',
      'Mock image API accepts direct same-origin loopback requests only.',
    )
  if (
    !host ||
    !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(host) ||
    !remote ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
  )
    throw forbidden()
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'])
    if (request.headers[name] !== undefined) throw forbidden()
  for (const name of ['host', 'origin', 'content-length'])
    if (
      request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name)
        .length > 1
    )
      throw forbidden()
  const secure = !!(request.socket as TLSSocket).encrypted
  const origin = `${secure ? 'https' : 'http'}://${host}`
  try {
    if (new URL(origin).origin !== origin) throw forbidden()
  } catch {
    throw forbidden()
  }
  const supplied = request.headers.origin
  if (supplied !== undefined && supplied !== origin) throw forbidden()
  if (request.method !== 'GET' && supplied !== origin) throw forbidden()
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw forbidden()
  return { origin, secure }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(value))
}

function fail(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  if (!request.complete && !response.destroyed && !response.writableEnded) {
    request.pause()
    response.setHeader('Connection', 'close')
    response.once('finish', () => request.destroy())
  }
  const safe = error instanceof ImageServiceError ? error : unavailable()
  json(
    response,
    safe.status,
    imageErrorReplySchema.parse({
      protocol: IMAGE_PROTOCOL,
      protocolVersion: IMAGE_PROTOCOL_VERSION,
      mode: 'mock',
      error: safe.wireError,
    }),
  )
}

function readJson(request: IncomingMessage, timeoutMs: number): Promise<unknown> {
  const type = request.headers['content-type']
  if (
    !type ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type) ||
    (request.headers['content-encoding'] !== undefined &&
      request.headers['content-encoding'] !== 'identity')
  )
    throw new ImageServiceError(
      415,
      'unsupported-media-type',
      'Only uncompressed UTF-8 application/json is accepted.',
    )
  const length = request.headers['content-length']
  if (
    length !== undefined &&
    (!/^[0-9]+$/.test(length) || Number(length) > MAX_IMAGE_REQUEST_BYTES)
  )
    throw new ImageServiceError(
      413,
      'body-too-large',
      'Mock image request exceeds the 16 KiB byte limit.',
    )
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', data).off('end', end).off('aborted', aborted).off('error', aborted)
    }
    const stop = (error: ImageServiceError) => {
      cleanup()
      request.pause() // Do not keep buffering an oversized/slow body. HTTP adapter closes this connection.
      reject(error)
    }
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > MAX_IMAGE_REQUEST_BYTES) {
        stop(
          new ImageServiceError(
            413,
            'body-too-large',
            'Mock image request exceeds the 16 KiB byte limit.',
          ),
        )
        return
      }
      chunks.push(buffer)
    }
    const end = () => {
      cleanup()
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        resolve(JSON.parse(raw))
      } catch {
        reject(new ImageServiceError(400, 'invalid-json', 'Request body must be valid UTF-8 JSON.'))
      }
    }
    const aborted = () =>
      stop(
        new ImageServiceError(
          400,
          'invalid-request',
          'Request body was interrupted; no work admitted.',
        ),
      )
    const timer = setTimeout(
      () =>
        stop(
          new ImageServiceError(
            408,
            'invalid-request',
            'Request body timed out; no work admitted.',
          ),
        ),
      timeoutMs,
    )
    timer.unref()
    request.on('data', data).once('end', end).once('aborted', aborted).once('error', aborted)
  })
}

function signature(principal: string, secret: string): string {
  return createHmac('sha256', secret).update(principal).digest('base64url')
}
function principalCookie(request: IncomingMessage, secret: string): string | null {
  const header = request.headers.cookie ?? ''
  if (header.length > 2048)
    throw new ImageServiceError(
      400,
      'invalid-request',
      'Local principal cookie header is too large.',
    )
  const tokens = header
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${LOCAL_PRINCIPAL_COOKIE}=`))
  if (tokens.length !== 1) return null
  const token = tokens[0].slice(LOCAL_PRINCIPAL_COOKIE.length + 1)
  const match = /^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!match) return null
  const expected = signature(match[1], secret)
  return timingSafeEqual(Buffer.from(expected), Buffer.from(match[2])) ? match[1] : null
}

/** A failed/missing SQLite runtime stays local-only and never falls through to a different renderer. */
export function unavailableMockImageMiddleware(): MockImageMiddleware {
  return (request, response, next) => {
    if (!request.url?.startsWith('/__fury-prototype/')) {
      next()
      return
    }
    try {
      localRequest(request)
      fail(request, response, unavailable())
    } catch (error) {
      fail(request, response, error)
    }
  }
}

/** No listener/server creation, CORS, admin route, network fetch or production fallback. */
export function createMockImageMiddleware(options: MockHttpOptions): MockImageMiddleware {
  if (options.principalSecret.length < 40)
    throw new Error('A durable server-only local principal secret is required.')
  const timeout = options.bodyTimeoutMs ?? 2000
  const maxRequests = options.maxConcurrentRequests ?? 16
  if (
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    timeout > 10000 ||
    !Number.isInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 64
  )
    throw new Error('Invalid local HTTP bounds.')
  let active = 0
  return (request, response, next) => {
    if (!request.url?.startsWith('/__fury-prototype/')) {
      next()
      return
    }
    let secure: boolean
    try {
      ;({ secure } = localRequest(request))
    } catch (error) {
      fail(request, response, error)
      return
    }
    if (active >= maxRequests) {
      fail(
        request,
        response,
        new ImageServiceError(
          429,
          'capacity-exceeded',
          'Too many concurrent local control requests.',
          true,
        ),
      )
      return
    }
    active++
    void (async () => {
      try {
        if (request.url!.length > 256 || request.url!.includes('?'))
          throw new ImageServiceError(404, 'not-found', 'Unknown local mock endpoint.')
        const route = new RegExp(
          `^${PROTOTYPE_API_PREFIX}/image-jobs/([A-Za-z0-9_-]{24,128})(/cancel)?$`,
        ).exec(request.url!)
        const submit = request.url === IMAGE_REQUEST_PATH
        if (!route && !submit)
          throw new ImageServiceError(404, 'not-found', 'Unknown local mock endpoint.')
        const cancel = !!route?.[2]
        if (request.method !== (submit || cancel ? 'POST' : 'GET'))
          throw new ImageServiceError(
            405,
            'method-not-allowed',
            'Method is not allowed for this mock endpoint.',
          )
        let principal = principalCookie(request, options.principalSecret)
        let input: unknown
        if (request.method === 'POST') input = await readJson(request, timeout)
        else if (
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0') ||
          request.headers['transfer-encoding'] !== undefined
        )
          throw new ImageServiceError(
            422,
            'invalid-request',
            'Status requests cannot contain a body.',
          )
        if (request.aborted || response.destroyed)
          throw new ImageServiceError(400, 'invalid-request', 'Request ended before admission.')
        if (!principal) {
          if (!submit)
            throw new ImageServiceError(
              404,
              'not-found',
              'No image interest is available for this local principal.',
            )
          principal = randomBytes(24).toString('base64url')
          response.setHeader(
            'Set-Cookie',
            `${LOCAL_PRINCIPAL_COOKIE}=${principal}.${signature(principal, options.principalSecret)}; Path=${PROTOTYPE_API_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`,
          )
        }
        if (submit) {
          const reply = await options.service.submit(principal, input)
          json(response, reply.status, reply.body)
        } else if (cancel) {
          const parsed = imageCancelRequestSchema.safeParse(input)
          if (!parsed.success || parsed.data.interestId !== route![1])
            throw new ImageServiceError(
              422,
              'invalid-request',
              'Cancellation body must match the interest in this route.',
            )
          json(response, 200, await options.service.detach(principal, route![1]))
        } else json(response, 200, await options.service.status(principal, route![1]))
      } catch (error) {
        fail(request, response, error)
      } finally {
        active--
      }
    })()
  }
}
