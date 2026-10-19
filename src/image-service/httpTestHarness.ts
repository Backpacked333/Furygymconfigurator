import { EventEmitter } from 'node:events'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { MockImageMiddleware } from './http'

/** Stream-level unit harness. It never listens on a port or starts a browser/dev server. */
export function invokeMockHttp(
  middleware: MockImageMiddleware,
  options: {
    url?: string
    method?: string
    body?: unknown
    chunks?: Buffer[]
    end?: boolean
    headers?: Record<string, string | undefined>
    remote?: string
  } = {},
) {
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: options.remote ?? '127.0.0.1' })
  const request = new IncomingMessage(socket)
  request.url = options.url ?? '/__fury-prototype/v1/images'
  request.method = options.method ?? 'POST'
  request.headers = {
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
    'content-type': 'application/json',
    ...options.headers,
  }
  request.rawHeaders = Object.entries(request.headers).flatMap(([key, value]) =>
    value === undefined ? [] : [key, String(value)],
  )
  const headers: Record<string, string> = {}
  let settle!: (value: { status: number; body: unknown; headers: Record<string, string> }) => void
  const result = new Promise<{ status: number; body: unknown; headers: Record<string, string> }>(
    (resolve) => {
      settle = resolve
    },
  )
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(value: string) {
      this.writableEnded = true
      settle({ status: this.statusCode, body: JSON.parse(value), headers })
      response.emit('finish')
    },
  })
  middleware(request, response as unknown as ServerResponse, () =>
    settle({ status: 0, body: null, headers }),
  )
  if (options.end !== false) {
    const chunks =
      options.chunks ??
      (options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))])
    for (const chunk of chunks) request.push(chunk)
    request.complete = true
    request.push(null)
  }
  return { request, response, result }
}
