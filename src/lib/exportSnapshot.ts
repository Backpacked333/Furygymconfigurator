import type { Config } from './config'
import type { CaptureProvider } from './capture'
import { samePresentation, type PresentationToken } from './presentation'

export type ExportSnapshot = {
  config: Config
  revision: number
  provider: CaptureProvider | null
  token: PresentationToken | null
}

export function exportSnapshot(
  config: Config,
  revision: number,
  provider: CaptureProvider | null,
): ExportSnapshot {
  return {
    config: structuredClone(config),
    revision,
    provider,
    token: provider ? { ...provider.getState().token } : null,
  }
}

export function assertExportCurrent(
  snapshot: ExportSnapshot,
  revision: number,
  provider: CaptureProvider | null,
  blocked: boolean,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error('Export cancelled. No file was downloaded.')
  if (blocked || snapshot.revision !== revision)
    throw new Error('The design changed. Start a new export of the committed design.')
  if (
    snapshot.provider &&
    (provider !== snapshot.provider ||
      !snapshot.token ||
      snapshot.token.revision !== snapshot.revision ||
      !samePresentation(snapshot.token, snapshot.provider.getState().token) ||
      snapshot.provider.getState().stage === 'lost')
  )
    throw new Error('The rendered view changed. Start a new export when it settles.')
}
