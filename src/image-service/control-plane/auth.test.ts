import { randomBytes, createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createSignedContextAuth } from './auth'
import { canonicalJson, CONTROL_PROTOCOL, type AuthContext } from './contracts'

const auth: AuthContext = {
  principalId: 'principal-auth-0001',
  experimentId: 'experiment-auth-01',
  scopes: ['images:read'],
}
const request = (authorization?: string, rawHeaders?: string[]): IncomingMessage =>
  ({
    headers: { authorization },
    rawHeaders: rawHeaders ?? (authorization ? ['Authorization', authorization] : []),
  }) as IncomingMessage

function fixture() {
  let now = 10_000
  const secret = randomBytes(32).toString('hex')
  const adapter = createSignedContextAuth({ secret, now: () => now })
  return {
    ...adapter,
    secret,
    setNow: (at: number) => {
      now = at
    },
  }
}

describe('local signed authentication (not production identity)', () => {
  it('round trips only explicitly granted out-of-body identity and scopes', async () => {
    const f = fixture()
    const token = f.issue(auth, 1000)
    const actual = await f.authenticate(request(`Bearer ${token}`))
    expect(actual).toEqual(auth)
    expect(Object.isFrozen(actual)).toBe(true)
    expect(Object.isFrozen(actual?.scopes)).toBe(true)
    expect(actual?.scopes).not.toContain('images:write')
  })

  it('rejects missing auth and caller body or proxy identities', async () => {
    const f = fixture()
    expect(await f.authenticate(request())).toBeNull()
    const spoof = request()
    spoof.headers['x-principal-id'] = auth.principalId
    Object.assign(spoof, { body: { auth } })
    expect(await f.authenticate(spoof)).toBeNull()
  })

  it('expires exactly at expiry and rejects future issue times', async () => {
    const f = fixture()
    const req = request(`Bearer ${f.issue(auth, 1000)}`)
    f.setNow(10_999)
    expect(await f.authenticate(req)).toEqual(auth)
    f.setNow(11_000)
    expect(await f.authenticate(req)).toBeNull()
    f.setNow(9999)
    expect(await f.authenticate(req)).toBeNull()
  })

  it('rejects token alteration, another key and duplicate Authorization headers', async () => {
    const f = fixture()
    const token = f.issue(auth, 1000)
    const replacement = token.endsWith('0') ? '1' : '0'
    expect(await f.authenticate(request(`Bearer ${token.slice(0, -1)}${replacement}`))).toBeNull()
    expect(await fixture().authenticate(request(`Bearer ${token}`))).toBeNull()
    expect(
      await f.authenticate(
        request(`Bearer ${token}`, [
          'Authorization',
          `Bearer ${token}`,
          'authorization',
          `Bearer ${token}`,
        ]),
      ),
    ).toBeNull()
  })

  it.each(['Basic anything', 'Bearer ', `Bearer ${'a'.repeat(3000)}`, 'Bearer a.b', 'bearer a.b'])(
    'rejects malformed or oversized credential %s',
    async (header) => {
      expect(await fixture().authenticate(request(header))).toBeNull()
    },
  )

  it.each([0, -1, 60_001, 1.5, Infinity])('bounds issuance lifetime %s', (ttl) => {
    expect(() => fixture().issue(auth, ttl)).toThrow()
  })

  it('rejects weak keys and malformed trusted grants rather than minting rights', () => {
    expect(() => createSignedContextAuth({ secret: 'short' })).toThrow()
    const f = fixture()
    expect(() => f.issue({ ...auth, scopes: [] }, 1000)).toThrow()
    expect(() => f.issue({ ...auth, scopes: ['images:read', 'images:read'] }, 1000)).toThrow()
    expect(() => f.issue({ ...auth, principalId: 'short' }, 1000)).toThrow()
  })

  it.each([
    { audience: 'fury-private-fake-worker' },
    { expiresAt: 80_000 },
    { arbitrary: true },
    { auth: { ...auth, scopes: ['admin'] } },
  ])('rejects invalid claims even with an authentic HMAC', async (change) => {
    const f = fixture()
    const encoded = Buffer.from(
      canonicalJson({
        protocol: CONTROL_PROTOCOL,
        audience: 'fury-local-control-api',
        auth,
        issuedAt: 10_000,
        expiresAt: 11_000,
        ...change,
      }),
    ).toString('base64url')
    const signature = createHmac('sha256', f.secret)
      .update(`p04-local-auth\n${encoded}`)
      .digest('hex')
    expect(await f.authenticate(request(`Bearer ${encoded}.${signature}`))).toBeNull()
  })
})
