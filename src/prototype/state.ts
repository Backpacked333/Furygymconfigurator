import {
  defaultDesign,
  deserializeDesign,
  parseDesign,
  serializeDesign,
  type DesignEnvelope,
} from '../domain/design'

export const PROTOTYPE_SHARE_PREFIX = '#fury-v4='
export type ShareRead =
  | { status: 'empty'; raw: '' }
  | { status: 'ready'; raw: string; design: DesignEnvelope }
  | { status: 'invalid'; raw: string }
export function readPrototypeShare(raw: string): ShareRead {
  if (!raw) return { status: 'empty', raw: '' }
  if (raw.startsWith(PROTOTYPE_SHARE_PREFIX) && raw.length <= 64 * 1024) {
    try {
      const design = deserializeDesign(decodeURIComponent(raw.slice(PROTOTYPE_SHARE_PREFIX.length)))
      if (design) return { status: 'ready', raw, design }
    } catch {
      /* Preserve the exact unsupported fragment, including malformed percent encoding. */
    }
  }
  return { status: 'invalid', raw }
}
export function prototypeLink(design: DesignEnvelope, href: string): string {
  const url = new URL(href)
  // Do not carry legacy cloud/bake/query options into a prototype link.
  url.search =
    url.searchParams.get('experience') === 'library' ? '?experience=library' : '?prototype=images'
  url.hash = PROTOTYPE_SHARE_PREFIX + encodeURIComponent(serializeDesign(design))
  return url.href
}
export type DesignHistory = {
  past: readonly DesignEnvelope[]
  present: DesignEnvelope
  future: readonly DesignEnvelope[]
}
export type HistoryAction = { type: 'commit'; design: DesignEnvelope } | { type: 'undo' | 'redo' }
export function initialHistory(): DesignHistory {
  return { past: [], present: defaultDesign(), future: [] }
}
export function designHistory(state: DesignHistory, action: HistoryAction): DesignHistory {
  if (action.type === 'commit') {
    const next = parseDesign(action.design)
    return serializeDesign(next) === serializeDesign(state.present)
      ? state
      : {
          past: [...state.past.slice(-49), state.present],
          present: next,
          future: [],
        }
  }
  if (action.type === 'undo') {
    const previous = state.past.at(-1)
    return previous
      ? {
          past: state.past.slice(0, -1),
          present: previous,
          future: [state.present, ...state.future],
        }
      : state
  }
  const next = state.future[0]
  return next
    ? { past: [...state.past, state.present], present: next, future: state.future.slice(1) }
    : state
}

/** Local text/SVG downloads only. No PDF/renderer module is imported. */
export function downloadPrototypeFile(
  name: string,
  content: string,
  type = 'application/json',
): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  try {
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
export function prototypeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
