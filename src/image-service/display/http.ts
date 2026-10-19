import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DISPLAY_API_PREFIX,
  DISPLAY_REQUEST_PATH,
  DISPLAY_LIMITS,
  DISPLAY_PROTOCOL,
  displayCancelSchema,
  displayErrorReplySchema,
} from '../../display/contract'
import { assertLocalRenderRequest } from '../localRenderHttp'
import { DisplayServiceError, capacity, notFound, unavailable } from './errors'
import type { DisplayService } from './service'

export type DisplayAuthenticator = (
  request: IncomingMessage,
  response: ServerResponse,
) => string | null | Promise<string | null>
export type DisplayHttpService = Pick<DisplayService, 'submit' | 'status' | 'cancel' | 'image'>
export type DisplayMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void
export function assertDisplayRequest(request: IncomingMessage) {
  try {
    assertLocalRenderRequest(request)
  } catch {
    throw new DisplayServiceError(
      403,
      'forbidden',
      'Direct same-origin loopback requests only; proxy forwarding is forbidden.',
    )
  }
  const origin = `http://${request.headers.host}`
  const port = Number(new URL(origin).port || 80)
  if (request.socket.localPort !== undefined && port !== request.socket.localPort)
    throw new DisplayServiceError(403, 'forbidden', 'Host must name this direct local listener.')
  const names = request.rawHeaders.filter((_v, i) => i % 2 === 0).map((name) => name.toLowerCase())
  if (new Set(names).size !== names.length)
    throw new DisplayServiceError(403, 'forbidden', 'Duplicate headers are forbidden.')
}
function headers(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; sandbox",
  )
}
function json(response: ServerResponse, status: number, input: unknown) {
  if (response.destroyed || response.writableEnded) return
  const bytes = Buffer.from(JSON.stringify(input))
  if (bytes.length > DISPLAY_LIMITS.replyBytes) throw unavailable()
  headers(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', bytes.length)
  response.end(bytes)
}
function body(request: IncomingMessage, timeout: number): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
    (request.headers['content-encoding'] !== undefined &&
      request.headers['content-encoding'] !== 'identity')
  )
    throw new DisplayServiceError(
      415,
      'invalid-request',
      'Only uncompressed UTF-8 JSON is accepted.',
    )
  const length = request.headers['content-length']
  if (
    length !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > DISPLAY_LIMITS.requestBytes)
  )
    throw new DisplayServiceError(413, 'invalid-request', 'Request exceeds the 16KiB cap.')
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', data).off('end', end).off('error', abort).off('aborted', abort)
    }
    const fail = (error: Error) => {
      cleanup()
      request.pause()
      reject(error)
    }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > DISPLAY_LIMITS.requestBytes)
        fail(new DisplayServiceError(413, 'invalid-request', 'Request exceeds the 16KiB cap.'))
      else chunks.push(chunk)
    }
    const end = () => {
      cleanup()
      try {
        resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
      } catch {
        reject(new DisplayServiceError(400, 'invalid-request', 'Invalid UTF-8 JSON.'))
      }
    }
    const abort = () =>
      fail(new DisplayServiceError(400, 'invalid-request', 'Request body interrupted.'))
    const timer = setTimeout(
      () => fail(new DisplayServiceError(503, 'timeout', 'Request body deadline elapsed.')),
      timeout,
    )
    timer.unref()
    request.on('data', data).once('end', end).once('error', abort).once('aborted', abort)
  })
}

/** Always intercept this namespace, including when disabled; no mock or HTML fallback. */
export function createDisplayMiddleware(
  options: {
    service?: DisplayHttpService
    authenticate?: DisplayAuthenticator
    bodyTimeoutMs?: number
    requestTimeoutMs?: number
    maxConcurrentRequests?: number
  } = {},
): DisplayMiddleware {
  const timeout = options.bodyTimeoutMs ?? 2000,
    total = options.requestTimeoutMs ?? 65_000,
    max = options.maxConcurrentRequests ?? 8
  if (
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    timeout > 10_000 ||
    !Number.isInteger(total) ||
    total < timeout ||
    total > 65_000 ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > 8
  )
    throw new Error('Invalid private display HTTP bounds.')
  let active = 0
  return (request, response, next) => {
    let decoded = request.url ?? ''
    try {
      for (let n = 0; n < 3; n++) decoded = decodeURIComponent(decoded)
    } catch {
      /* canonical rejection below */
    }
    if (
      !decoded.replaceAll('\\', '/').includes('/__fury-display') &&
      !request.url?.includes('/__fury-display')
    ) {
      next()
      return
    }
    const fail = (error: unknown) => {
      if (response.destroyed || response.writableEnded) return
      const safe = error instanceof DisplayServiceError ? error : unavailable()
      if (!request.complete) {
        request.pause()
        response.setHeader('Connection', 'close')
        response.once('finish', () => request.destroy())
      }
      json(
        response,
        safe.status,
        displayErrorReplySchema.parse({ protocol: DISPLAY_PROTOCOL, error: safe.wire }),
      )
    }
    try {
      assertDisplayRequest(request)
      if (active >= max) throw capacity()
    } catch (error) {
      fail(error)
      return
    }
    active++
    const admission = new AbortController()
    let released = false
    const release = () => {
      if (!released) {
        released = true
        active--
        clearTimeout(timer)
      }
      admission.abort()
    }
    response.once('finish', release).once('close', release)
    const timer = setTimeout(() => {
      admission.abort()
      fail(new DisplayServiceError(503, 'timeout', 'Display HTTP deadline elapsed.'))
      response.destroy()
    }, total)
    timer.unref()
    void (async () => {
      try {
        const path = request.url!
        if (path.length > 320 || /[?%#\\]/.test(path)) throw notFound()
        const route = new RegExp(
          `^${DISPLAY_API_PREFIX}/jobs/([A-Za-z0-9_-]{24,128})(/cancel|/image/([a-f0-9]{64})\\.png)?$`,
        ).exec(path)
        const submit = path === DISPLAY_REQUEST_PATH,
          authenticateOnly = path === `${DISPLAY_API_PREFIX}/session`,
          cancel = route?.[2] === '/cancel'
        if (!route && !submit && !authenticateOnly) throw notFound()
        if (request.method !== (submit || cancel || authenticateOnly ? 'POST' : 'GET'))
          throw new DisplayServiceError(405, 'invalid-request', 'Method not allowed.')
        if (!options.service || !options.authenticate) throw unavailable()
        const owner = await options.authenticate(request, response)
        if (!owner)
          throw new DisplayServiceError(
            403,
            'forbidden',
            'Operator-provisioned owner authentication required.',
          )
        if (admission.signal.aborted) throw unavailable()
        let input: unknown
        if (request.method === 'POST') input = await body(request, timeout)
        else if (
          request.headers['transfer-encoding'] !== undefined ||
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0')
        )
          throw new DisplayServiceError(400, 'invalid-request', 'GET cannot contain a body.')
        if (admission.signal.aborted) throw unavailable()
        if (authenticateOnly) {
          if (!displayCancelSchema.safeParse(input).success)
            throw new DisplayServiceError(422, 'invalid-request', 'Invalid owner-session envelope.')
          // Existing credential exchange only; creates no owner, allowance, image interest or job.
          json(response, 200, {
            protocol: DISPLAY_PROTOCOL,
            authenticated: true,
            executionAuthorized: false,
          })
        } else if (submit) {
          const result = await options.service.submit(owner, input, admission.signal)
          if (admission.signal.aborted) {
            await options.service.cancel(owner, result.body.interestId)
            return
          }
          json(response, result.status, result.body)
        } else if (cancel) {
          if (!displayCancelSchema.safeParse(input).success)
            throw new DisplayServiceError(422, 'invalid-request', 'Invalid cancellation envelope.')
          json(response, 200, await options.service.cancel(owner, route![1]))
        } else if (route![3]) {
          const bytes = await options.service.image(owner, route![1], `sha256:${route![3]}`)
          if (admission.signal.aborted) return
          if (bytes.length > DISPLAY_LIMITS.pngBytes) throw unavailable()
          headers(response)
          response.statusCode = 200
          response.setHeader('Content-Type', 'image/png')
          response.setHeader('Content-Length', bytes.length)
          response.end(bytes)
        } else {
          const status = await options.service.status(owner, route![1])
          json(
            response,
            status.state === 'queued' || status.state === 'rendering' ? 202 : 200,
            status,
          )
        }
      } catch (error) {
        fail(error)
      }
    })()
  }
}
