import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import {
  authContextSchema,
  canonicalJson,
  CONTROL_PROTOCOL,
  timestampSchema,
  type Authenticate,
  type AuthContext,
} from './contracts'

const MAX_TOKEN_BYTES = 2048
const MAX_CONTEXT_TTL_MS = 60_000
const claimsSchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    audience: z.literal('fury-local-control-api'),
    auth: authContextSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .refine(
    (claims) =>
      claims.expiresAt > claims.issuedAt &&
      claims.expiresAt - claims.issuedAt <= MAX_CONTEXT_TTL_MS,
    'Invalid local credential lifetime.',
  )

export type SignedContextAuthOptions = Readonly<{ secret: string; now?: () => number }>
export type SignedContextAuth = Readonly<{
  /** Trusted issuer ONLY: the caller must have verified these grants externally. Never mount this on HTTP. */
  issue: (verifiedGrant: AuthContext, ttlMs: number) => string
  authenticate: Authenticate
}>

/** Local HMAC adapter, not production identity, grant discovery, revocation or key management.
 * No default principal or scopes. The private issuer is deliberately separate from HTTP authentication.
 * Tokens must never be placed in URLs, logs, error messages, or evidence files.
 */
export function createSignedContextAuth(options: SignedContextAuthOptions): SignedContextAuth {
  if (
    typeof options.secret !== 'string' ||
    Buffer.byteLength(options.secret, 'utf8') < 32 ||
    Buffer.byteLength(options.secret, 'utf8') > 4096
  )
    throw new TypeError('An injected private local auth key of 32–4096 UTF-8 bytes is required.')
  const secret = options.secret
  const now = options.now ?? Date.now
  const sign = (encoded: string) =>
    createHmac('sha256', secret).update(`p04-local-auth\n${encoded}`).digest('hex')

  function issue(verifiedGrant: AuthContext, ttlMs: number): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CONTEXT_TTL_MS)
      throw new TypeError('Local auth credentials must expire within 60 seconds.')
    const issuedAt = timestampSchema.parse(now())
    const claims = claimsSchema.parse({
      protocol: CONTROL_PROTOCOL,
      audience: 'fury-local-control-api',
      auth: verifiedGrant,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    })
    const encoded = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url')
    return `${encoded}.${sign(encoded)}`
  }

  function authenticate(request: IncomingMessage): AuthContext | null {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || authorization.length > MAX_TOKEN_BYTES + 7) return null
    let headerCount = 0
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      if (request.rawHeaders[i].toLowerCase() === 'authorization') headerCount += 1
    if (headerCount !== 1 || !authorization.startsWith('Bearer ')) return null
    const token = authorization.slice(7)
    if (token.length > MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) return null
    const [encoded, supplied] = token.split('.')
    if (!timingSafeEqual(Buffer.from(sign(encoded), 'hex'), Buffer.from(supplied, 'hex')))
      return null
    try {
      const decoded = Buffer.from(encoded, 'base64url')
      if (decoded.toString('base64url') !== encoded) return null
      const claims = claimsSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)),
      )
      // Only our canonical encoding is admitted, avoiding ambiguous alternate representations.
      if (Buffer.from(canonicalJson(claims)).toString('base64url') !== encoded) return null
      const at = timestampSchema.parse(now())
      if (at < claims.issuedAt || at >= claims.expiresAt) return null
      return Object.freeze({
        ...claims.auth,
        scopes: Object.freeze([...claims.auth.scopes]) as AuthContext['scopes'],
      })
    } catch {
      return null
    }
  }

  return Object.freeze({ issue, authenticate })
}
