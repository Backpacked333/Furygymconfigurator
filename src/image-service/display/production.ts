import { realpathSync } from 'node:fs'
import { createDisplayService } from './service'
import { createDisplayOwnerAuth, loadDisplayOperator } from './auth'
import { stableDisplayJson } from '../../display/contract'
import type { DisplayAuthenticator } from './http'

export const DISPLAY_SOURCE_ROOT = '/home/ubuntu/Documents/fury-display'
export const DISPLAY_HANDOFF_ROOT = '/home/ubuntu/Documents/fury-display-handoff'
export const DISPLAY_STORAGE_ROOT = `${DISPLAY_HANDOFF_ROOT}/private-display-service`

/** The ONLY production renderer factory: fixed module, no caller endpoint/command/provider. */
export async function createProductionDisplayService(
  root = DISPLAY_SOURCE_ROOT,
  verifyOnly = false,
) {
  if (root !== DISPLAY_SOURCE_ROOT || realpathSync(root) !== DISPLAY_SOURCE_ROOT)
    throw new Error('Display source root is pinned to the isolated candidate.')
  const { createPrivateDisplayBackend } = await import('../../render/display/backend')
  const backend = createPrivateDisplayBackend()
  // Verification deliberately does not read operator credentials/permit or admit a run.
  const operator = verifyOnly ? null : loadDisplayOperator()
  const service = createDisplayService({
    backend,
    directory: DISPLAY_STORAGE_ROOT,
    permit: operator?.permit ?? null,
  })
  const auth = createDisplayOwnerAuth(operator)
  const authenticate: DisplayAuthenticator = (request, response) => {
    // Revocation/replacement never silently authorizes the already-open service/run.
    if (!operator || stableDisplayJson(loadDisplayOperator()) !== stableDisplayJson(operator))
      return null
    return auth(request, response)
  }
  return { service, authenticate }
}
