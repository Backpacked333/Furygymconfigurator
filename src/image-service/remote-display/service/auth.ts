import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { CLOUD_DISPLAY_PREFIX } from '../../../display/cloudContract'
import { displayIdSchema } from '../../../display/contract'
import type { CloudAuthenticator } from './http'

/** Independently provisioned in private operator memory. No file loader or credential creation here.
 * Authentication grants interest ownership only; this is not an approval or spending capability. */
export const cloudOwnerSchema = z
  .object({
    kind: z.literal('external-display-owner@1'),
    ownerId: displayIdSchema,
    credential: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict()
export const CLOUD_OWNER_COOKIE = 'fury_private_cloud_display_owner'
export function createCloudOwnerAuth(input: unknown, now = Date.now): CloudAuthenticator {
  const parsed = cloudOwnerSchema.safeParse(input)
  if (!parsed.success) return () => null
  const owner = parsed.data
  return (request, response) => {
    if (now() >= owner.expiresAt) return null
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${CLOUD_OWNER_COOKIE}=`))
    if (cookies.length > 1) return null
    const authorization = request.headers.authorization
    // Bearer bootstrap is private operator-only, not a browser CORS/header capability.
    if (
      authorization &&
      (cookies.length ||
        request.headers['sec-fetch-mode'] !== undefined ||
        !/^Bearer [a-f0-9]{64}$/.test(authorization))
    )
      return null
    const supplied = authorization?.slice(7) ?? cookies[0]?.slice(CLOUD_OWNER_COOKIE.length + 1)
    if (
      !supplied ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(owner.credential))
    )
      return null
    if (authorization)
      response.setHeader(
        'Set-Cookie',
        `${CLOUD_OWNER_COOKIE}=${owner.credential}; HttpOnly; SameSite=Strict; Path=${CLOUD_DISPLAY_PREFIX}; Max-Age=${Math.min(600, Math.max(0, Math.floor((owner.expiresAt - now()) / 1000)))}`,
      )
    return owner.ownerId
  }
}
