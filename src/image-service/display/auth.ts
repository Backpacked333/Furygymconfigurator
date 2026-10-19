import { timingSafeEqual } from 'node:crypto'
import { loadDisplayOperator } from '../../display/operator'
import type { DisplayAuthenticator } from './http'

export { loadDisplayOperator }
export function createDisplayOwnerAuth(
  operator: ReturnType<typeof loadDisplayOperator>,
): DisplayAuthenticator {
  return (request, response) => {
    if (!operator || operator.permit.expiresAt <= Date.now()) return null
    const cookieName = 'fury_private_display_owner'
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`))
    if (cookies.length > 1) return null
    const supplied = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : cookies[0]?.slice(cookieName.length + 1)
    if (
      !supplied ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(operator.credential))
    )
      return null
    if (request.headers.authorization) {
      // Operator-only header exchange. The normal browser client only uses same-origin cookies.
      // No allowance/principal is created; all interests consume the already-provisioned run.
      response.setHeader(
        'Set-Cookie',
        `${cookieName}=${operator.credential}; HttpOnly; SameSite=Strict; Path=/__fury-display/v1; Max-Age=${Math.max(0, Math.floor((operator.permit.expiresAt - Date.now()) / 1000))}`,
      )
    }
    return operator.ownerId
  }
}
