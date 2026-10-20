import { describe, expect, it, vi } from 'vitest'
import { createFixedLayout, serializeFixedLayout } from '../domain/fixedLayout'
import {
  defaultReview,
  readReviewDraft,
  readReviewShare,
  REVIEW_STORAGE_KEY,
  reviewHistory,
  reviewLink,
  reviewReducer,
  saveReviewDraft,
} from './state'

function store(raw: string | null = null) {
  const values = new Map<string, string>([
    ['fury-draft-v1', 'opaque legacy draft'],
    ['fury-builds-v1', '{legacy broken library'],
  ])
  if (raw !== null) values.set(REVIEW_STORAGE_KEY, raw)
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}

describe('review-only persistence', () => {
  it('uses a separate namespace and never autosaves while reading', () => {
    const storage = store()
    expect(readReviewDraft(storage).status).toBe('empty')
    expect(storage.setItem).not.toHaveBeenCalled()
    const saved = saveReviewDraft(storage, null, defaultReview())
    expect(readReviewDraft(storage)).toEqual(saved)
    expect(storage.values.get('fury-draft-v1')).toBe('opaque legacy draft')
    expect(storage.values.get('fury-builds-v1')).toBe('{legacy broken library')
  })

  it.each(['', '{', '{"contractVersion":99}', 'x'.repeat(4097)])(
    'preserves unreadable data until explicitly archived (%#)',
    (raw) => {
      const storage = store(raw)
      expect(readReviewDraft(storage)).toEqual({ status: 'unreadable', layout: null, raw })
      expect(() => saveReviewDraft(storage, raw, defaultReview())).toThrow('Preserve')
      expect(storage.setItem).not.toHaveBeenCalled()
      saveReviewDraft(storage, raw, defaultReview(), true)
      const archive = [...storage.values].find(([key]) =>
        key.startsWith(`${REVIEW_STORAGE_KEY}-recovery-`),
      )
      expect(archive?.[1]).toBe(raw)
      expect(storage.setItem.mock.calls[0]).toEqual(archive)
      expect(readReviewDraft(storage).status).toBe('ready')
    },
  )

  it('retains originals if the archive write fails or is silently discarded', () => {
    for (const silent of [true, false]) {
      const storage = store('{')
      storage.setItem.mockImplementation(() => {
        if (!silent) throw new Error('Quota exceeded')
      })
      expect(() => saveReviewDraft(storage, '{', defaultReview(), true)).toThrow()
      expect(storage.values.get(REVIEW_STORAGE_KEY)).toBe('{')
    }
  })

  it('detects intervening writes and never replaces a newer review', () => {
    const storage = store('newer value')
    expect(() => saveReviewDraft(storage, null, defaultReview())).toThrow('newer review')
    expect(storage.setItem).not.toHaveBeenCalled()
    const other = store('{')
    other.setItem.mockImplementation((key, value) => {
      other.values.set(key, value)
      other.values.set(REVIEW_STORAGE_KEY, 'external write')
    })
    expect(() => saveReviewDraft(other, '{', defaultReview(), true)).toThrow('review changed')
    expect(other.values.get(REVIEW_STORAGE_KEY)).toBe('external write')
  })

  it('reports unavailable storage and verifies even a normal save', () => {
    expect(readReviewDraft(null).status).toBe('unavailable')
    const denied = store()
    denied.getItem.mockImplementation(() => {
      throw new Error('Denied')
    })
    expect(readReviewDraft(denied).status).toBe('unavailable')
    const silent = store()
    silent.setItem.mockImplementation(() => undefined)
    expect(() => saveReviewDraft(silent, null, defaultReview())).toThrow('could not be verified')
  })

  it('rejects equipment injection before any write, even with recovery consent', () => {
    const storage = store('{')
    expect(() => saveReviewDraft(storage, '{', { ...defaultReview(), items: [] }, true)).toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})

describe('local review links', () => {
  it('round trips all mappings and removes unrelated query/auth/fragment data', () => {
    for (const family of ['studio', 'container'])
      for (const lengthFt of [20, 40]) {
        const layout = createFixedLayout({ family, lengthFt })
        const link = new URL(
          reviewLink(layout, 'https://name:password@example.test/review.html?tracking=1#old'),
        )
        expect(link.pathname).toBe('/review.html')
        expect(link.search + link.username + link.password).toBe('')
        expect(readReviewShare(link.hash).layout).toEqual(layout)
      }
  })

  it.each([
    '#c=old-compressed-share',
    '#unknown=anything',
    '#layout=bad',
    '#layout=%FF',
    '#layout=' + encodeURIComponent(JSON.stringify({ ...defaultReview(), items: [] })),
    '#layout=' + encodeURIComponent(JSON.stringify({ ...defaultReview(), contractVersion: 99 })),
    '#layout=' + encodeURIComponent(serializeFixedLayout(defaultReview())) + '&items=hidden',
    '#layout=' + encodeURIComponent(serializeFixedLayout(defaultReview())) + '&layout=other',
    '#' + 'x'.repeat(8192),
  ])('retains unsupported or injected fragments without loading them (%#)', (raw) => {
    expect(readReviewShare(raw)).toEqual({ status: 'unreadable', raw, layout: null })
  })
  it('distinguishes an absent share from an unreadable share', () => {
    expect(readReviewShare('').status).toBe('none')
    expect(readReviewShare('#').status).toBe('unreadable')
  })
})

describe('renderer-independent review history', () => {
  it('updates family and arrangement atomically and branches after Undo', () => {
    const start = reviewHistory()
    const next = reviewReducer(start, {
      type: 'select',
      patch: { family: 'container', lengthFt: 40 },
    })
    expect(next.present.arrangementRef).toBe('container-40-review@1')
    const undone = reviewReducer(next, { type: 'undo' })
    expect(undone.present).toEqual(start.present)
    expect(reviewReducer(undone, { type: 'redo' })).toEqual(next)
    const branched = reviewReducer(undone, { type: 'select', patch: { lengthFt: 40 } })
    expect(branched.future).toEqual([])
    expect(reviewReducer(start, { type: 'select', patch: {} })).toBe(start)
    expect(() =>
      reviewReducer(start, { type: 'load', layout: { ...start.present, items: [] } }),
    ).toThrow()
  })
  it('bounds history to fifty steps', () => {
    let state = reviewHistory()
    for (let i = 0; i < 120; i++)
      state = reviewReducer(state, { type: 'select', patch: { lengthFt: i % 2 ? 20 : 40 } })
    expect(state.past.length).toBe(50)
  })
})
