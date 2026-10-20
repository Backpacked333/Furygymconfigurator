import {
  createFixedLayout,
  deserializeFixedLayout,
  parseFixedLayout,
  serializeFixedLayout,
  transitionFixedLayout,
  type FixedLayout,
} from '../domain/fixedLayout'
import { archiveRawValue, type RecoveryStorage } from '../lib/recovery'

export const REVIEW_STORAGE_KEY = 'fury-fixed-review-v1'
export const defaultReview = () => createFixedLayout({ family: 'studio', lengthFt: 20 })

export type ReviewSnapshot = {
  status: 'empty' | 'ready' | 'unreadable' | 'unavailable'
  raw: string | null
  layout: FixedLayout | null
}

export function readReviewDraft(storage: RecoveryStorage | null): ReviewSnapshot {
  try {
    if (!storage) throw new Error('Storage unavailable')
    const raw = storage.getItem(REVIEW_STORAGE_KEY)
    if (raw === null) return { status: 'empty', raw, layout: null }
    const layout = deserializeFixedLayout(raw)
    return { status: layout ? 'ready' : 'unreadable', raw, layout }
  } catch {
    return { status: 'unavailable', raw: null, layout: null }
  }
}

export function saveReviewDraft(
  storage: RecoveryStorage,
  expectedRaw: string | null,
  layout: unknown,
  preserveUnreadable = false,
): ReviewSnapshot {
  const next = serializeFixedLayout(layout)
  const current = storage.getItem(REVIEW_STORAGE_KEY)
  if (current !== expectedRaw)
    throw new Error('A newer review is stored. Export your review before reloading.')
  if (current !== null && !deserializeFixedLayout(current)) {
    if (!preserveUnreadable)
      throw new Error('Preserve the unreadable original before replacing it.')
    archiveRawValue(storage, REVIEW_STORAGE_KEY, current)
  }
  if (storage.getItem(REVIEW_STORAGE_KEY) !== current)
    throw new Error('The saved review changed. Export your review before reloading.')
  storage.setItem(REVIEW_STORAGE_KEY, next)
  if (storage.getItem(REVIEW_STORAGE_KEY) !== next)
    throw new Error('The save could not be verified. Export your review to keep a copy.')
  return { status: 'ready', raw: next, layout: parseFixedLayout(layout) }
}

export function readReviewShare(hash: string) {
  if (!hash) return { status: 'none' as const, raw: hash, layout: null }
  const invalid = { status: 'unreadable' as const, raw: hash, layout: null }
  if (hash.length > 8192) return invalid
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  if ([...params].length !== 1 || !params.has('layout')) return invalid
  const layout = deserializeFixedLayout(params.get('layout')!)
  return layout ? { status: 'ready' as const, raw: hash, layout } : invalid
}

export function reviewLink(layout: unknown, href: string) {
  const url = new URL(href)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = `layout=${encodeURIComponent(serializeFixedLayout(layout))}`
  return url.toString()
}

export type ReviewHistory = {
  past: readonly FixedLayout[]
  present: FixedLayout
  future: readonly FixedLayout[]
}
type ReviewAction =
  | { type: 'select'; patch: unknown }
  | { type: 'load'; layout: unknown }
  | { type: 'undo' }
  | { type: 'redo' }

export function reviewHistory(layout: unknown = defaultReview()): ReviewHistory {
  return { past: [], present: parseFixedLayout(layout), future: [] }
}

export function reviewReducer(state: ReviewHistory, action: ReviewAction): ReviewHistory {
  if (action.type === 'undo')
    return state.past.length
      ? {
          past: state.past.slice(0, -1),
          present: state.past.at(-1)!,
          future: [state.present, ...state.future],
        }
      : state
  if (action.type === 'redo')
    return state.future.length
      ? {
          past: [...state.past, state.present],
          present: state.future[0],
          future: state.future.slice(1),
        }
      : state
  const next =
    action.type === 'select'
      ? transitionFixedLayout(state.present, action.patch).next
      : parseFixedLayout(action.layout)
  return serializeFixedLayout(next) === serializeFixedLayout(state.present)
    ? state
    : { past: [...state.past.slice(-49), state.present], present: next, future: [] }
}
