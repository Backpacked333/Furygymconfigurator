import { configSchema, inspectDocument, type Config } from './config'

export type EditToken = { id: string; baseRevision: number }
export type EditResult = {
  status: 'committed' | 'noop' | 'previewing' | 'cancelled' | 'rejected' | 'conflict'
  issues: string[]
  recoveryRaw?: string
}
export type EditState = {
  past: Config[]
  present: Config
  future: Config[]
  notice: string
  revision?: number
  preview?: { token: EditToken; base: Config; config: Config }
  result?: EditResult
}
export type EditAction =
  | { type: 'set'; config: Config }
  | { type: 'undo' | 'redo' }
  | { type: 'begin'; token: EditToken }
  | { type: 'preview'; token: EditToken; config: Config }
  | { type: 'commit'; token: EditToken; config?: Config }
  | { type: 'cancel'; token?: EditToken }
  | { type: 'restore'; config: Config; notice?: string; expectedRevision: number }

export function semanticConfig(candidate: Config, base: Config): Config {
  const parsed = configSchema.parse(candidate)
  if (parsed.package === 'custom' && JSON.stringify(parsed.items) === JSON.stringify(base.items))
    parsed.package = base.package
  return parsed
}
export function sameConfig(a: Config, b: Config): boolean {
  return JSON.stringify(configSchema.parse(a)) === JSON.stringify(configSchema.parse(b))
}
function reject(
  state: EditState,
  candidate: unknown,
  status: 'rejected' | 'conflict',
  issues: string[],
): EditState {
  return {
    ...state,
    preview: status === 'conflict' ? state.preview : undefined,
    result: {
      status,
      issues,
      ...(candidate === undefined ? {} : { recoveryRaw: JSON.stringify(candidate) }),
    },
  }
}
function commit(state: EditState, candidate: Config): EditState {
  const inspected = inspectDocument(candidate)
  if (inspected.status !== 'accepted') return reject(state, candidate, 'rejected', inspected.issues)
  const config = semanticConfig(inspected.config, state.present)
  if (sameConfig(config, state.present)) {
    return state.preview
      ? { ...state, preview: undefined, result: { status: 'noop', issues: [] } }
      : state
  }
  return {
    ...state,
    past: [...state.past.slice(-49), state.present],
    present: config,
    future: [],
    preview: undefined,
    revision: (state.revision ?? 0) + 1,
    result: { status: 'committed', issues: [] },
  }
}
export function configReducer(state: EditState, action: EditAction): EditState {
  const revision = state.revision ?? 0
  if (action.type === 'set') return commit(state, action.config)
  if (action.type === 'begin') {
    if (action.token.baseRevision !== revision)
      return reject(state, undefined, 'conflict', [
        'The edit started from a stale document revision. Begin again from the committed design.',
      ])
    return {
      ...state,
      preview: { token: action.token, base: state.present, config: state.present },
      result: { status: 'previewing', issues: [] },
    }
  }
  if (action.type === 'preview' || action.type === 'commit') {
    const preview = state.preview
    if (
      !preview ||
      preview.token.id !== action.token.id ||
      preview.token.baseRevision !== action.token.baseRevision ||
      action.token.baseRevision !== revision
    )
      return reject(state, action.config, 'conflict', [
        'The preview owner or base revision changed. The stale edit was not applied.',
      ])
    const candidate = action.config ?? preview.config
    if (action.type === 'commit') return commit(state, candidate)
    const parsed = configSchema.safeParse(candidate)
    if (!parsed.success)
      return {
        ...state,
        result: {
          status: 'rejected',
          issues: parsed.error.issues.map((issue) => issue.message),
          recoveryRaw: JSON.stringify(candidate),
        },
      }
    return {
      ...state,
      preview: { ...preview, config: semanticConfig(parsed.data, preview.base) },
      result: { status: 'previewing', issues: [] },
    }
  }
  if (action.type === 'cancel') {
    if (!state.preview || (action.token && state.preview.token.id !== action.token.id)) return state
    return { ...state, preview: undefined, result: { status: 'cancelled', issues: [] } }
  }
  if (action.type === 'restore') {
    if (revision !== action.expectedRevision)
      return reject(state, action.config, 'conflict', [
        'The live document changed while recovery was loading. Both documents remain available.',
      ])
    return {
      ...state,
      present: action.config,
      past: [],
      future: [],
      preview: undefined,
      revision: revision + 1,
      notice: action.notice ?? state.notice,
      result: { status: 'committed', issues: [] },
    }
  }
  if (action.type === 'undo' && state.past.length)
    return {
      ...state,
      past: state.past.slice(0, -1),
      present: state.past.at(-1)!,
      future: [state.present, ...state.future],
      preview: undefined,
      revision: revision + 1,
      result: { status: 'committed', issues: [] },
    }
  if (action.type === 'redo' && state.future.length)
    return {
      ...state,
      past: [...state.past.slice(-49), state.present],
      present: state.future[0],
      future: state.future.slice(1),
      preview: undefined,
      revision: revision + 1,
      result: { status: 'committed', issues: [] },
    }
  if (state.preview)
    return { ...state, preview: undefined, result: { status: 'cancelled', issues: [] } }
  return state
}
