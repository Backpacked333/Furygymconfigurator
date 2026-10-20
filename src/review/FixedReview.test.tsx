// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFixedLayout, serializeFixedLayout } from '../domain/fixedLayout'
import { downloadFile } from '../lib/export'
import { FixedReview } from './FixedReview'
import { REVIEW_STORAGE_KEY, defaultReview, readReviewShare, reviewLink } from './state'

vi.mock('../lib/export', () => ({ downloadFile: vi.fn() }))

describe('fixed review component interactions (DOM, not browser E2E)', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('fetch', vi.fn())
    localStorage.clear()
    window.history.replaceState(null, '', '/review.html')
    vi.mocked(downloadFile).mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const mount = () =>
    act(() =>
      root.render(
        <StrictMode>
          <FixedReview />
        </StrictMode>,
      ),
    )
  function button(text: string) {
    const found = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
    )
    if (!found) throw new Error(`Missing button: ${text}`)
    return found
  }
  const click = (text: string) => act(() => button(text).click())
  function exported() {
    click('Export review JSON')
    return JSON.parse(vi.mocked(downloadFile).mock.calls.at(-1)![1] as string)
  }

  it('starts without graphics, requests, storage writes or equipment edit controls', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    mount()
    expect(write).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelectorAll('[data-equipment]').length).toBe(3)
    expect(
      host.querySelectorAll('[data-equipment] [role="button"], [data-equipment][tabindex]').length,
    ).toBe(0)
    expect(host.textContent).toContain('Production use blocked')
    expect(
      [...host.querySelectorAll('button')].some((b) =>
        /^(Add|Move|Rotate|Remove)\b/.test(b.textContent || ''),
      ),
    ).toBe(false)
  })

  it('selects fixed arrangements and undoes/redoes as complete states without touching storage', () => {
    mount()
    click('ContainerContainer concept')
    click('40 ftRoom for more')
    expect(host.querySelectorAll('[data-equipment]').length).toBe(6)
    expect(exported().arrangementRef).toBe('container-40-review@1')
    click('Undo review change')
    expect(exported().arrangementRef).toBe('container-20-review@1')
    click('Redo review change')
    expect(exported().arrangementRef).toBe('container-40-review@1')
    expect(localStorage.length).toBe(0)
  })

  it('does not change the layout through equipment keyboard/pointer events or display units', () => {
    mount()
    const original = exported()
    const item = host.querySelector('[data-equipment]')!
    act(() => {
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const unit = host.querySelector('select')!
    act(() => {
      unit.value = 'm'
      unit.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    expect(exported()).toEqual(original)
    expect(host.textContent).toContain('Amber halos are illustrative only')
  })

  it('restores a valid draft, saves explicitly and leaves legacy originals unchanged', () => {
    const layout = createFixedLayout({ family: 'container', lengthFt: 40 })
    localStorage.setItem(REVIEW_STORAGE_KEY, serializeFixedLayout(layout))
    localStorage.setItem('fury-builds-v1', '{broken library')
    localStorage.setItem('fury-draft-v1', 'compressed-original')
    mount()
    expect(exported()).toEqual(layout)
    click('20 ftFocused footprint')
    expect(JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY)!).product.lengthFt).toBe(40)
    click('Save review')
    expect(JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY)!).product.lengthFt).toBe(20)
    expect(localStorage.getItem('fury-builds-v1')).toBe('{broken library')
    expect(localStorage.getItem('fury-draft-v1')).toBe('compressed-original')
  })

  it('retains an unreadable review until explicit preserve-and-replace consent', () => {
    const raw = ' \n {"contractVersion":99,"future":"unaltered"} '
    localStorage.setItem(REVIEW_STORAGE_KEY, raw)
    mount()
    expect(button('Save review').disabled).toBe(true)
    expect(host.textContent).toContain('not the unreadable original')
    click('Download original review')
    expect(vi.mocked(downloadFile).mock.calls.at(-1)).toEqual([
      'original-review.txt',
      raw,
      'text/plain',
    ])
    expect(localStorage.getItem(REVIEW_STORAGE_KEY)).toBe(raw)
    click('Preserve original and save review')
    const archive = Object.keys(localStorage).find((key) =>
      key.startsWith(`${REVIEW_STORAGE_KEY}-recovery-`),
    )
    expect(archive).toBeDefined()
    expect(localStorage.getItem(archive!)).toBe(raw)
    expect(button('Save review').disabled).toBe(false)
  })

  it('shows recovery failures without replacing the original', () => {
    localStorage.setItem(REVIEW_STORAGE_KEY, '{')
    mount()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    click('Preserve original and save review')
    expect(localStorage.getItem(REVIEW_STORAGE_KEY)).toBe('{')
    expect(host.textContent).toContain('Quota exceeded')
    expect(button('Save review').disabled).toBe(true)
  })

  it('loads share changes into history without saving, and preserves unsupported fragments', () => {
    const shared = createFixedLayout({ family: 'container', lengthFt: 40 })
    window.history.replaceState(null, '', reviewLink(shared, window.location.href))
    mount()
    expect(exported()).toEqual(shared)
    const next = defaultReview()
    window.history.replaceState(null, '', reviewLink(next, window.location.href))
    act(() => window.dispatchEvent(new Event('hashchange')))
    expect(exported()).toEqual(next)
    click('Undo review change')
    expect(exported()).toEqual(shared)
    const invalid = '#layout=' + encodeURIComponent(JSON.stringify({ ...next, items: [] }))
    window.history.replaceState(null, '', invalid)
    act(() => window.dispatchEvent(new Event('hashchange')))
    expect(exported()).toEqual(shared)
    expect(host.textContent).toContain('not a rendering of that link')
    click('Download original link fragment')
    expect(vi.mocked(downloadFile).mock.calls.at(-1)![1]).toBe(invalid)
    expect(localStorage.length).toBe(0)
  })

  it('reports an intervening save rather than overwriting another review', () => {
    mount()
    localStorage.setItem(REVIEW_STORAGE_KEY, 'newer external review')
    click('Save review')
    expect(host.textContent).toContain('A newer review is stored')
    expect(localStorage.getItem(REVIEW_STORAGE_KEY)).toBe('newer external review')
  })

  it('copies the exact current local review link and offers JSON when clipboard access fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mount()
    await act(async () => button('Copy local review link').click())
    expect(readReviewShare(new URL(writeText.mock.calls[0][0]).hash).layout).toEqual(
      defaultReview(),
    )
    writeText.mockRejectedValue(new Error('Denied'))
    await act(async () => button('Copy local review link').click())
    expect(host.textContent).toContain('Export the review JSON instead')
  })

  it('inspects and archives legacy originals without parsing, replacing or converting them', () => {
    localStorage.setItem('fury-builds-v1', 'not-json')
    localStorage.setItem('fury-draft-v1', 'opaque-compressed-v99')
    mount()
    click('Inspect saved originals')
    click('Download legacy saved library')
    expect(vi.mocked(downloadFile).mock.calls.at(-1)).toEqual([
      'fury-builds-v1-original.txt',
      'not-json',
      'text/plain',
    ])
    click('Preserve legacy originals')
    expect(host.textContent).toContain('Preserved 2 originals')
    expect(localStorage.getItem('fury-builds-v1')).toBe('not-json')
    expect(localStorage.getItem('fury-draft-v1')).toBe('opaque-compressed-v99')
    expect(localStorage.getItem(REVIEW_STORAGE_KEY)).toBeNull()
  })

  it('exposes recovery copies from earlier visits without exposing unrelated storage', () => {
    localStorage.setItem('unrelated-private-key', 'not part of Fury')
    for (let i = 0; i < 7; i++)
      localStorage.setItem(`fury-fixed-review-v1-recovery-test-${i}`, `original ${i}`)
    mount()
    click('Inspect saved originals')
    expect(host.textContent).not.toContain('unrelated-private-key')
    expect(
      host.querySelector('[aria-label="Recovery copies"]')!.querySelectorAll('li'),
    ).toHaveLength(5)
    click('Show more recovery copies')
    expect(
      host.querySelector('[aria-label="Recovery copies"]')!.querySelectorAll('li'),
    ).toHaveLength(7)
    click('Download recovery copy 7')
    expect(vi.mocked(downloadFile).mock.calls.at(-1)).toEqual([
      'fury-fixed-review-v1-recovery-test-6.txt',
      'original 6',
      'text/plain',
    ])
    expect(localStorage.getItem(REVIEW_STORAGE_KEY)).toBeNull()
  })

  it('keeps working in memory when the storage accessor is unavailable', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('Denied')
    })
    mount()
    expect(button('Save review').disabled).toBe(true)
    expect(host.textContent).toContain('Browser storage is unavailable')
    expect(exported()).toEqual(defaultReview())
  })

  it('renders the occupied rack footprint at its fixed position, not just its body width', () => {
    mount()
    click('ContainerContainer concept')
    const rack = host.querySelector('[data-equipment="rack"]')!
    expect(rack.getAttribute('transform')).toBe('translate(-5.6 -1.6)')
    expect(rack.querySelector('rect')!.getAttribute('width')).toBe('7.3')
    expect(rack.querySelector('rect')!.getAttribute('height')).toBe('3.2')
  })

  it.each([
    '',
    '#layout=' + encodeURIComponent(serializeFixedLayout(defaultReview())),
    '#unsupported=original',
  ])('skips to the main workspace without replacing the share fragment (%#)', (hash) => {
    window.history.replaceState(null, '', '/review.html' + hash)
    mount()
    const original = exported()
    const warning = host.querySelector('[role="alert"]')?.textContent
    const link = host.querySelector<HTMLAnchorElement>('.review-skip')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('main'))
    expect(window.location.hash).toBe(hash)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(warning)
    expect(localStorage.length).toBe(0)
    expect(exported()).toEqual(original)
  })
})
