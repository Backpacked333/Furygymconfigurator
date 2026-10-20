import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { RESOURCE_BOUNDS, type DisplayResource } from './build'

export async function startDisplayHost(
  resources: ReadonlyMap<string, DisplayResource>,
  fail: (error: Error) => void,
) {
  const token = randomBytes(32).toString('hex')
  const snapshot = new Map(
    [...resources].map(([path, r]) => [path, { ...r, bytes: Buffer.from(r.bytes) }]),
  )
  let origin = '',
    requests = 0,
    transferred = 0
  const pagePath = `/${token}/display.html`
  const allow = (url: string, method: string, redirected = false) => {
    if (redirected || method !== 'GET' || !url.startsWith(`${origin}/`)) return false
    const path = url.slice(origin.length)
    return (
      path === pagePath ||
      (!/[?%#\\]/.test(path) &&
        !path.split('/').some((v) => v === '.' || v === '..') &&
        path !== '/display.html' &&
        snapshot.has(path))
    )
  }
  const deny = () => fail(new Error('Private host denied a request.'))
  const server = createServer((req, res) => {
    const path = req.url ?? '',
      headers = req.headers
    const counts = new Map<string, number>()
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i].toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (
      [...counts.values()].some((n) => n > 1) ||
      ++requests > RESOURCE_BOUNDS.requests ||
      req.socket.remoteAddress !== '127.0.0.1' ||
      headers.host !== origin.slice(7) ||
      headers['x-fury-display-entry'] !== token ||
      (headers.origin && headers.origin !== origin) ||
      headers['transfer-encoding'] ||
      (headers['content-length'] && headers['content-length'] !== '0') ||
      Object.keys(headers).some((k) => k === 'forwarded' || k.startsWith('x-forwarded-')) ||
      !allow(`${origin}${path}`, req.method ?? '')
    ) {
      deny()
      res.writeHead(403, { Connection: 'close' })
      res.end()
      return
    }
    const value = snapshot.get(path === pagePath ? '/display.html' : path)!
    transferred += value.bytes.length
    if (transferred > RESOURCE_BOUNDS.total) {
      deny()
      res.writeHead(429)
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': value.mediaType,
      'Content-Length': value.bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    res.end(value.bytes)
  })
  server.requestTimeout = server.headersTimeout = 5000
  server.keepAliveTimeout = 1000
  server.maxConnections = 12
  server.on('upgrade', (_req, socket) => {
    deny()
    socket.destroy()
  })
  server.on('clientError', (_error, socket) => {
    deny()
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private host bind failed.')
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    token,
    pageUrl: `${origin}${pagePath}`,
    allow,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
export type DisplayHost = Awaited<ReturnType<typeof startDisplayHost>>
