import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { CONTRACT_VERSION, safeError, type SafeError } from '../contracts.js'
import type { AdmissionContext } from './ports.js'

export class ServiceError extends Error {
  constructor(
    readonly code: SafeError['code'],
    readonly status: number,
  ) {
    super(code)
  }
}
export const unavailable = () => new ServiceError('rendering-disabled', 503)
export function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}
export function errorResponse(error: unknown) {
  const safe = error instanceof ServiceError ? error : new ServiceError('lookup-unavailable', 503)
  return json(
    { contractVersion: CONTRACT_VERSION, status: 'error', error: safeError(safe.code) },
    safe.status,
  )
}
export async function boundedBytes(
  response: Response | Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    throw new ServiceError('invalid-request', 400)
  if (!response.body) throw new ServiceError('invalid-request', 400)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let expired = false
  const timeout = setTimeout(() => {
    expired = true
    void reader.cancel()
  }, 15_000)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maxBytes) throw new ServiceError('invalid-request', 400)
      chunks.push(value)
    }
    if (expired || (declared && length !== Number(declared)))
      throw new ServiceError('invalid-request', 400)
    const bytes = new Uint8Array(length)
    let position = 0
    for (const chunk of chunks) {
      bytes.set(chunk, position)
      position += chunk.length
    }
    return bytes
  } finally {
    clearTimeout(timeout)
    await reader.cancel().catch(() => undefined)
  }
}
export async function boundedJson(request: Request, maxBytes = 32_768): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new ServiceError('invalid-request', 400)
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(request, maxBytes)),
    )
  } catch {
    throw new ServiceError('invalid-request', 400)
  }
}
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export function requireBearer(request: Request, expected: string | undefined) {
  if (
    !expected ||
    expected.length < 32 ||
    !equalSecret(request.headers.get('authorization') ?? '', `Bearer ${expected}`)
  )
    throw new ServiceError('origin-denied', 403)
}
export function httpsOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw unavailable()
  return url.origin
}

const COOKIE = '__Host-fury-render-session'
export class SessionSecurity {
  constructor(
    private readonly origin: string,
    private readonly secret: string,
    private readonly now = Date.now,
  ) {
    httpsOrigin(origin)
    if (secret.length < 32) throw unavailable()
  }
  private sign(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex')
  }
  verifyOrigin(request: Request, allowSameOriginGet = false) {
    const site = request.headers.get('sec-fetch-site')
    const origin = request.headers.get('origin')
    if (
      new URL(request.url).origin !== this.origin ||
      (site !== null && site !== 'same-origin') ||
      (origin !== this.origin && !(allowSameOriginGet && !origin && site === 'same-origin'))
    )
      throw new ServiceError('origin-denied', 403)
  }
  read(request: Request) {
    const matches = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE}=`))
    if (matches.length !== 1) return null
    const token = matches[0].slice(COOKIE.length + 1)
    const [sid, expiry, signature, extra] = token.split('.')
    if (
      extra ||
      !/^[a-f0-9-]{36}$/.test(sid) ||
      !/^\d{13}$/.test(expiry) ||
      !signature ||
      !equalSecret(signature, this.sign(`session:${sid}:${expiry}`)) ||
      Number(expiry) <= this.now()
    )
      return null
    return { sid, expiry: Number(expiry), sessionHash: this.sign(`id:${sid}`), token }
  }
  issue(request: Request) {
    this.verifyOrigin(request, true)
    const existing = this.read(request)
    const sid = existing?.sid ?? randomUUID()
    const expiry = existing?.expiry ?? this.now() + 24 * 60 * 60 * 1000
    const token = existing?.token ?? `${sid}.${expiry}.${this.sign(`session:${sid}:${expiry}`)}`
    const csrfExpiry = Math.min(expiry, this.now() + 15 * 60 * 1000)
    return {
      cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor((expiry - this.now()) / 1000)}`,
      sessionHash: this.sign(`id:${sid}`),
      networkHash: this.networkHash(),
      expiresAt: new Date(expiry).toISOString(),
      response: {
        contractVersion: CONTRACT_VERSION,
        csrfToken: `${csrfExpiry}.${this.sign(`csrf:${sid}:${csrfExpiry}`)}`,
        expiresAt: new Date(csrfExpiry).toISOString(),
      },
    }
  }
  // Deliberately shared conservative anonymous quota. Never trust caller-supplied X-Forwarded-For.
  private networkHash() {
    return this.sign('network:unattributed-shared')
  }
  context(request: Request): AdmissionContext {
    this.verifyOrigin(request)
    const session = this.read(request)
    const [expiry, signature, extra] = (request.headers.get('x-csrf-token') ?? '').split('.')
    if (
      !session ||
      extra ||
      !/^\d{13}$/.test(expiry) ||
      Number(expiry) <= this.now() ||
      Number(expiry) > session.expiry ||
      !signature ||
      !equalSecret(signature, this.sign(`csrf:${session.sid}:${expiry}`))
    )
      throw new ServiceError('csrf-invalid', 403)
    return {
      sessionHash: session.sessionHash,
      networkHash: this.networkHash(),
      sameOriginVerified: true,
      csrfVerified: true,
    }
  }
  authorizeRead(request: Request) {
    this.verifyOrigin(request, true)
    const session = this.read(request)
    if (!session) throw new ServiceError('csrf-invalid', 403)
    return session.sessionHash
  }
}
