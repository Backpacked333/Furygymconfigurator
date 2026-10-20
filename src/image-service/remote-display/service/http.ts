import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CLOUD_DISPLAY_PREFIX,
  CLOUD_DISPLAY_PROTOCOL,
  CLOUD_DISPLAY_REQUEST_PATH,
  cloudDisplayCancelSchema,
  cloudDisplayErrorReplySchema,
  cloudDisplayReplySchema,
  cloudDisplayRequestSchema,
} from '../../../display/cloudContract'
import { DISPLAY_LIMITS } from '../../../display/contract'
import { assertDisplayRequest } from '../../display/http'
import type { CloudDisplayService } from './service'
import { capacity, CloudServiceError, missing, unavailable } from './errors'

export type CloudAuthenticator = (
  request: IncomingMessage,
  response: ServerResponse,
) => string | null | Promise<string | null>
export type CloudHttpService = Pick<CloudDisplayService, 'submit' | 'status' | 'cancel' | 'image'>
export type CloudMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void
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
  if (bytes.length > DISPLAY_LIMITS.replyBytes) throw unavailable()
  headers(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', bytes.length)
  response.end(bytes)
}
function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
    (request.headers['content-encoding'] !== undefined &&
      request.headers['content-encoding'] !== 'identity')
  )
    throw new CloudServiceError(415, 'invalid-request', 'Only uncompressed UTF-8 JSON is accepted.')
  const length = request.headers['content-length']
  if (
    length !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > DISPLAY_LIMITS.requestBytes)
  )
    throw new CloudServiceError(413, 'invalid-request', 'Request exceeds the 16KiB cap.')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', data).off('end', end).off('error', abort).off('aborted', abort)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      cleanup()
      request.pause()
      reject(error)
    }
    const abort = () =>
      fail(new CloudServiceError(400, 'invalid-request', 'Request body interrupted.'))
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > DISPLAY_LIMITS.requestBytes)
        fail(new CloudServiceError(413, 'invalid-request', 'Request exceeds the 16KiB cap.'))
      else chunks.push(chunk)
    }
    const end = () => {
      cleanup()
      try {
        resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
      } catch {
        reject(new CloudServiceError(400, 'invalid-request', 'Invalid UTF-8 JSON.'))
      }
    }
    const timer = setTimeout(
      () => fail(new CloudServiceError(503, 'timeout', 'Request body deadline elapsed.')),
      2000,
    )
    timer.unref()
    request.on('data', data).once('end', end).once('error', abort).once('aborted', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Must be registered BEFORE the legacy local handler, which broadly matches /__fury-display. */
export function createCloudDisplayMiddleware(
  options: { service?: CloudHttpService; authenticate?: CloudAuthenticator } = {},
): CloudMiddleware {
  let active = 0
  return (request, response, next) => {
    let decoded = request.url ?? ''
    try {
      for (let i = 0; i < 4; i++) decoded = decodeURIComponent(decoded)
    } catch {
      /* reject noncanonical route below */
    }
    if (
      !decoded.replaceAll('\\', '/').includes('/__fury-display-cloud') &&
      !request.url?.includes('/__fury-display-cloud')
    ) {
      next()
      return
    }
    const fail = (error: unknown) => {
      const safe = error instanceof CloudServiceError ? error : unavailable()
      if (!request.complete) {
        request.pause()
        response.setHeader('Connection', 'close')
        response.once('finish', () => request.destroy())
      }
      json(
        response,
        safe.status,
        cloudDisplayErrorReplySchema.parse({ protocol: CLOUD_DISPLAY_PROTOCOL, error: safe.wire }),
      )
    }
    try {
      try {
        assertDisplayRequest(request)
      } catch {
        throw new CloudServiceError(
          403,
          'forbidden',
          'Direct same-origin loopback requests without proxy or duplicate headers only.',
        )
      }
      if (active >= 8) throw capacity()
    } catch (error) {
      fail(error)
      return
    }
    active++
    const controller = new AbortController()
    let released = false
    const timer = setTimeout(() => {
      controller.abort()
      fail(new CloudServiceError(503, 'timeout', 'Cloud request deadline elapsed.'))
      response.destroy()
    }, 65_000)
    timer.unref()
    const release = () => {
      if (!released) {
        released = true
        active--
        clearTimeout(timer)
      }
      controller.abort()
    }
    response.once('finish', release).once('close', release)
    void (async () => {
      try {
        const path = request.url ?? ''
        if (path.length > 320 || /[?%#\\]/.test(path)) throw missing()
        const route = new RegExp(
          `^${CLOUD_DISPLAY_PREFIX}/jobs/([A-Za-z0-9_-]{24,128})(/cancel|/image/([a-f0-9]{64})\\.png)?$`,
        ).exec(path)
        const submit = path === CLOUD_DISPLAY_REQUEST_PATH,
          cancel = route?.[2] === '/cancel'
        if (!submit && !route) throw missing()
        if (request.method !== (submit || cancel ? 'POST' : 'GET'))
          throw new CloudServiceError(405, 'invalid-request', 'Method not allowed.')
        if (!options.service || !options.authenticate) throw unavailable()
        const owner = await options.authenticate(request, response)
        if (!owner)
          throw new CloudServiceError(
            403,
            'forbidden',
            'Separately provisioned cloud owner authentication required.',
          )
        if (controller.signal.aborted) throw unavailable()
        let input: unknown
        if (submit || cancel) input = await readBody(request, controller.signal)
        else if (
          request.headers['transfer-encoding'] !== undefined ||
          (request.headers['content-length'] !== undefined &&
            request.headers['content-length'] !== '0')
        )
          throw new CloudServiceError(400, 'invalid-request', 'GET cannot contain a body.')
        if (controller.signal.aborted) throw unavailable()
        if (submit) {
          if (!cloudDisplayRequestSchema.safeParse(input).success)
            throw new CloudServiceError(
              422,
              'invalid-request',
              'Expected only cloud protocol and complete design.',
            )
          const result = await options.service.submit(owner, input, controller.signal)
          if (controller.signal.aborted) {
            await options.service.cancel(owner, result.body.interestId)
            return
          }
          const body = cloudDisplayReplySchema.parse(result.body)
          json(response, body.state === 'queued' || body.state === 'rendering' ? 202 : 200, body)
        } else if (cancel) {
          if (!cloudDisplayCancelSchema.safeParse(input).success)
            throw new CloudServiceError(
              422,
              'invalid-request',
              'Invalid cloud cancellation envelope.',
            )
          json(
            response,
            200,
            cloudDisplayReplySchema.parse(await options.service.cancel(owner, route![1])),
          )
        } else if (route![3]) {
          const bytes = await options.service.image(owner, route![1], `sha256:${route![3]}`)
          if (controller.signal.aborted) return
          if (bytes.length < 44 || bytes.length > DISPLAY_LIMITS.pngBytes) throw unavailable()
          headers(response)
          response.statusCode = 200
          response.setHeader('Content-Type', 'image/png')
          response.setHeader('Content-Length', bytes.length)
          response.end(bytes)
        } else {
          const body = cloudDisplayReplySchema.parse(await options.service.status(owner, route![1]))
          json(response, body.state === 'queued' || body.state === 'rendering' ? 202 : 200, body)
        }
      } catch (error) {
        if (!response.destroyed && !response.writableEnded) fail(error)
      }
    })()
  }
}
