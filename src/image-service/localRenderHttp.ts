import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import {
  LOCAL_RENDER_API_PREFIX,
  LOCAL_RENDER_PROTOCOL,
  LOCAL_RENDER_PROTOCOL_VERSION,
  LOCAL_RENDER_MODE,
  LOCAL_RENDER_REQUEST_PATH,
  MAX_LOCAL_RENDER_REQUEST_BYTES,
  MAX_LOCAL_RENDER_REPLY_BYTES,
  MAX_LOCAL_RENDER_PNG_BYTES,
  localRenderCancelRequestSchema,
  localRenderErrorReplySchema,
} from './localRenderProtocol'
import { LocalRenderServiceError, localCapacity, localUnavailable } from './localRenderErrors'
import type { LocalRenderService } from './localRenderService'

export type LocalRenderMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void
export type LocalRenderHttpService = Pick<
  LocalRenderService,
  'submit' | 'status' | 'detach' | 'image'
>
const forbidden = () =>
  new LocalRenderServiceError(
    403,
    'forbidden',
    'Local real preview accepts direct same-origin loopback requests only.',
  )

export function assertLocalRenderRequest(request: IncomingMessage) {
  const host = request.headers.host
  if (
    !host ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/.test(host) ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
  )
    throw forbidden()
  const names = request.rawHeaders
    .filter((_value, index) => index % 2 === 0)
    .map((name) => name.toLowerCase())
  for (const name of [
    'host',
    'origin',
    'content-length',
    'content-type',
    'content-encoding',
    'transfer-encoding',
    'sec-fetch-site',
    'sec-fetch-mode',
    'referer',
  ])
    if (names.filter((value) => value === name).length > 1) throw forbidden()
  if (
    Object.keys(request.headers).some(
      (name) =>
        [
          'forwarded',
          'via',
          'x-real-ip',
          'x-original-host',
          'x-original-url',
          'x-rewrite-url',
        ].includes(name) || name.startsWith('x-forwarded-'),
    ) ||
    request.headers.expect !== undefined
  )
    throw forbidden()
  const origin = `${(request.socket as TLSSocket).encrypted ? 'https' : 'http'}://${host}`
  try {
    if (new URL(origin).origin !== origin) throw forbidden()
  } catch {
    throw forbidden()
  }
  if (request.headers.origin !== undefined && request.headers.origin !== origin) throw forbidden()
  if (request.method === 'POST' && request.headers.origin !== origin) throw forbidden()
  const site = request.headers['sec-fetch-site'],
    mode = request.headers['sec-fetch-mode']
  if (site !== undefined && site !== 'same-origin') throw forbidden()
  if (mode !== undefined && mode !== 'cors' && mode !== 'same-origin') throw forbidden()
  if (request.headers.referer !== undefined) {
    try {
      if (new URL(request.headers.referer).origin !== origin) throw forbidden()
    } catch {
      throw forbidden()
    }
  }
  if (
    request.headers['transfer-encoding'] !== undefined &&
    (request.headers['transfer-encoding'] !== 'chunked' ||
      request.headers['content-length'] !== undefined)
  )
    throw forbidden()
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
function json(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > MAX_LOCAL_RENDER_REPLY_BYTES) throw localUnavailable()
  headers(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', bytes.length)
  response.end(bytes)
}
function fail(request: IncomingMessage, response: ServerResponse, error: unknown) {
  if (response.destroyed || response.writableEnded) return
  if (!request.complete) {
    request.pause()
    response.setHeader('Connection', 'close')
    response.once('finish', () => request.destroy())
  }
  const safe = error instanceof LocalRenderServiceError ? error : localUnavailable()
  json(
    response,
    safe.status,
    localRenderErrorReplySchema.parse({
      protocol: LOCAL_RENDER_PROTOCOL,
      protocolVersion: LOCAL_RENDER_PROTOCOL_VERSION,
      mode: LOCAL_RENDER_MODE,
      error: safe.wireError,
    }),
  )
}
function readJson(request: IncomingMessage, timeoutMs: number): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
    (request.headers['content-encoding'] !== undefined &&
      request.headers['content-encoding'] !== 'identity')
  )
    throw new LocalRenderServiceError(
      415,
      'unsupported-media-type',
      'Only uncompressed UTF-8 application/json is accepted.',
    )
  const length = request.headers['content-length']
  if (
    length !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_LOCAL_RENDER_REQUEST_BYTES)
  )
    throw new LocalRenderServiceError(
      413,
      'body-too-large',
      'Local render request exceeds the 16 KiB byte cap.',
    )
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', data).off('end', end).off('error', aborted).off('aborted', aborted)
    }
    const stop = (error: LocalRenderServiceError) => {
      cleanup()
      request.pause()
      reject(error)
    }
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_LOCAL_RENDER_REQUEST_BYTES) {
        stop(
          new LocalRenderServiceError(
            413,
            'body-too-large',
            'Local render request exceeds the 16 KiB byte cap.',
          ),
        )
        return
      }
      chunks.push(bytes)
    }
    const end = () => {
      cleanup()
      try {
        resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
      } catch {
        reject(
          new LocalRenderServiceError(400, 'invalid-json', 'Request must be valid UTF-8 JSON.'),
        )
      }
    }
    const aborted = () =>
      stop(
        new LocalRenderServiceError(
          400,
          'invalid-request',
          'Request body interrupted before admission.',
        ),
      )
    const timer = setTimeout(
      () =>
        stop(
          new LocalRenderServiceError(
            504,
            'timeout',
            'Request body deadline elapsed before admission.',
          ),
        ),
      timeoutMs,
    )
    timer.unref()
    request.on('data', data).once('end', end).once('error', aborted).once('aborted', aborted)
  })
}

/** Mount BEFORE the older broad /__fury-prototype/ mock middleware. Only owns /local-render. */
export function createLocalRenderMiddleware(
  options: {
    service?: LocalRenderHttpService
    bodyTimeoutMs?: number
    maxConcurrentRequests?: number
  } = {},
): LocalRenderMiddleware {
  const timeout = options.bodyTimeoutMs ?? 2000,
    max = options.maxConcurrentRequests ?? 8
  if (
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    timeout > 10_000 ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > 16
  )
    throw new Error('Invalid local HTTP limits.')
  let active = 0
  return (request, response, next) => {
    // Also intercept malformed/encoded variants of our namespace rather than returning app HTML.
    if (!request.url?.startsWith('/__fury-prototype/local-render')) {
      next()
      return
    }
    try {
      assertLocalRenderRequest(request)
    } catch (error) {
      fail(request, response, error)
      return
    }
    if (active >= max) {
      fail(request, response, localCapacity())
      return
    }
    active++
    const admission = new AbortController()
    const abort = () => admission.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    void (async () => {
      try {
        const path = request.url!
        if (path.length > 320 || /[?%#\\]/.test(path))
          throw new LocalRenderServiceError(404, 'not-found', 'Unknown local real-render endpoint.')
        const route = new RegExp(
          `^${LOCAL_RENDER_API_PREFIX}/image-jobs/([A-Za-z0-9_-]{24,128})(/cancel|/image/([a-f0-9]{64})\\.png)?$`,
        ).exec(path)
        const submit = path === LOCAL_RENDER_REQUEST_PATH
        if (!route && !submit)
          throw new LocalRenderServiceError(404, 'not-found', 'Unknown local real-render endpoint.')
        const cancel = route?.[2] === '/cancel'
        if (request.method !== (submit || cancel ? 'POST' : 'GET'))
          throw new LocalRenderServiceError(
            405,
            'method-not-allowed',
            'Method not allowed for this local endpoint.',
          )
        if (!options.service) throw localUnavailable()
        let input: unknown
        if (request.method === 'POST') input = await readJson(request, timeout)
        else if (
          request.headers['transfer-encoding'] !== undefined ||
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0')
        )
          throw new LocalRenderServiceError(
            400,
            'invalid-request',
            'GET requests cannot contain a body.',
          )
        if (request.aborted || response.destroyed) throw localUnavailable()
        if (submit) {
          const reply = await options.service.submit(input, admission.signal)
          json(response, reply.status, reply.body)
        } else if (cancel) {
          const parsed = localRenderCancelRequestSchema.safeParse(input)
          if (!parsed.success || parsed.data.interestId !== route![1])
            throw new LocalRenderServiceError(
              400,
              'invalid-request',
              'Cancellation must exactly match this interest.',
            )
          json(response, 200, await options.service.detach(route![1]))
        } else if (route![3]) {
          const bytes = await options.service.image(route![1], `sha256:${route![3]}`)
          if (bytes.length > MAX_LOCAL_RENDER_PNG_BYTES) throw localUnavailable()
          if (response.destroyed || response.writableEnded) return
          headers(response)
          response.statusCode = 200
          response.setHeader('Content-Type', 'image/png')
          response.setHeader('Content-Length', bytes.length)
          response.end(bytes)
        } else json(response, 200, await options.service.status(route![1]))
      } catch (error) {
        fail(request, response, error)
      } finally {
        active--
        request.off('aborted', abort)
        response.off('close', abort)
      }
    })()
  }
}
