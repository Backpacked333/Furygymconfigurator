// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, shareUrl, writeSaved } from '../lib/config'
import { downloadFile } from '../lib/export'
import { defaultDesign, serializeDesign } from '../domain/design'
import { normalizeCustomerDesign } from '../render-library/views'
import { PROTOTYPE_RECOVERY_PREFIX, PROTOTYPE_STORAGE_KEY } from '../domain/prototypeStorage'
import { DesignLibrary } from '../prototype/DesignLibrary'
import { downloadPrototypeFile, readPrototypeShare } from '../prototype/state'
import { LibraryDialog, ShareDialog } from './Dialogs'

vi.mock('../lib/export', () => ({
  downloadFile: vi.fn(),
  exportBrief: vi.fn(),
  PdfToolUnavailable: class extends Error {},
}))
vi.mock('../prototype/state', async (original) => ({
  ...(await original<typeof import('../prototype/state')>()),
  downloadPrototypeFile: vi.fn(),
}))

describe('shared build dialog adapters (jsdom, not visual verification)', () => {
  let host: HTMLDivElement, root: Root
  const notify = vi.fn(),
    load = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
      },
    })
    localStorage.clear()
    window.history.replaceState(null, '', '/?prototype=images')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    notify.mockClear()
    load.mockClear()
    vi.mocked(downloadFile).mockClear()
    vi.mocked(downloadPrototypeFile).mockClear()
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'clipboard')
    Reflect.deleteProperty(navigator, 'locks')
  })
  const button = (label: string) => {
    const result = [...host.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label,
    )
    if (!result) throw new Error(`Missing button: ${label}`)
    return result
  }
  const click = (label: string) => act(() => button(label).click())
  const mount = (design = defaultDesign()) =>
    act(() => root.render(<DesignLibrary design={design} onLoad={load} notify={notify} />))
  const feedback = () =>
    host.querySelector('dialog[open] .prototype-library-feedback[role=status]')?.textContent
  const copies = () =>
    Object.keys(localStorage).filter((key) => key.startsWith(PROTOTYPE_RECOVERY_PREFIX))

  it('keeps legacy Share markup, Config link, JSON schema and clipboard behavior', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    })
    act(() =>
      root.render(<ShareDialog config={DEFAULT_CONFIG} onClose={vi.fn()} notify={notify} />),
    )
    expect(host.querySelector('.share-visual .mini-studio')).not.toBeNull()
    expect(host.querySelector('input')?.value).toBe(shareUrl(DEFAULT_CONFIG))
    await act(async () => button('Copy your build link').click())
    expect(copy).toHaveBeenCalledWith(shareUrl(DEFAULT_CONFIG))
    expect(button('Link copied')).toBeDefined()
    click('Download configuration JSON')
    expect(JSON.parse(String(vi.mocked(downloadFile).mock.calls[0][1]))).toMatchObject({
      configuration: DEFAULT_CONFIG,
      notice: expect.stringContaining('Not manufacturer CAD'),
    })
    expect(localStorage.length).toBe(0)
  })

  it('keeps legacy build save, comparison table, load and confirmed delete behavior', () => {
    const other = { ...DEFAULT_CONFIG, finish: 'chalk' as const }
    writeSaved([
      { id: 'first', name: 'First', date: '2026-01-01', config: DEFAULT_CONFIG },
      { id: 'second', name: 'Second', date: '2026-01-02', config: other },
    ])
    const close = vi.fn()
    act(() =>
      root.render(
        <LibraryDialog
          config={DEFAULT_CONFIG}
          unit="ft"
          onLoad={load}
          onClose={close}
          notify={notify}
        />,
      ),
    )
    expect(host.querySelector('.save-row .field-label')?.textContent).toBe('Name this build')
    expect(host.querySelectorAll('.saved-card')).toHaveLength(2)
    host
      .querySelectorAll<HTMLInputElement>('input[type=checkbox]')
      .forEach((input) => act(() => input.click()))
    expect(host.querySelector('.comparison h3')?.textContent).toBe('Side by side.')
    expect(host.querySelector('table')?.getAttribute('aria-label')).toBe('Side by side.')
    expect(host.querySelectorAll('tr.different')).not.toHaveLength(0)
    click('Load')
    expect(load).toHaveBeenCalledWith(DEFAULT_CONFIG)
    expect(close).toHaveBeenCalledTimes(1)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    click('Delete Second')
    expect(host.querySelectorAll('.saved-card')).toHaveLength(1)
    click('Save current')
    expect(host.querySelectorAll('.saved-card')).toHaveLength(2)
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull()
  })

  it('opens familiar Share/Help actions with complete v4 JSON and local clipboard feedback, not Config hashes', async () => {
    const design = defaultDesign({ family: 'container', lengthFt: 40 })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    mount(design)
    expect(
      [...host.querySelectorAll('.header-actions button')].map(
        (node) => node.textContent || node.getAttribute('aria-label'),
      ),
    ).toEqual(['My builds', 'Share', 'Help and information'])
    click('Share')
    expect(host.querySelector('.modal-header h2')?.textContent).toBe('Good things are shared.')
    expect(host.querySelector('.share-visual .mini-studio')).not.toBeNull()
    await act(async () => button('Copy local prototype link').click())
    expect(feedback()).toContain('Clipboard unavailable')
    const url = host.querySelector('textarea')!.value
    expect(readPrototypeShare(new URL(url).hash)).toMatchObject({
      status: 'ready',
      design: normalizeCustomerDesign(design),
    })
    click('Export design JSON')
    expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)?.[1]).toBe(serializeDesign(design))
    expect(localStorage.length).toBe(0)
    click('Close dialog')
    click('Help and information')
    expect(host.textContent).toContain('Fixed arrangements are DRAFT')
    expect(host.textContent).toContain('Quote required')
  })

  it('saves and loads full v4 snapshots in isolation with the original shared library surfaces', async () => {
    const design = defaultDesign({ family: 'container', lengthFt: 40 })
    localStorage.setItem('fury-builds-v1', 'legacy sentinel')
    mount(design)
    click('My builds')
    expect(host.querySelector('.empty-library')).not.toBeNull()
    expect(host.querySelector('.modal-header h2')?.textContent).toBe('Keep the possibilities open.')
    await act(async () => button('Save design locally').click())
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(
      serializeDesign(normalizeCustomerDesign(design)),
    )
    expect(localStorage.getItem('fury-builds-v1')).toBe('legacy sentinel')
    expect(host.querySelector('.saved-card .mini-studio')).not.toBeNull()
    expect(feedback()).toContain('Saved the selected v4 snapshot')
    click('Load saved prototype')
    expect(load).toHaveBeenCalledWith(normalizeCustomerDesign(design))
    expect(feedback()).toContain('one Undo step')
  })

  it('requires explicit preservation consent and retains exact malformed raw bytes before replacement', async () => {
    const raw = '  {"future":99}\n\tunsupported original  '
    localStorage.setItem(PROTOTYPE_STORAGE_KEY, raw)
    mount()
    click('My builds')
    expect(button('Save design locally').disabled).toBe(true)
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw)
    click('Download saved original')
    expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)?.[1]).toBe(raw)
    await act(async () => button('Preserve original and replace with this design').click())
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(serializeDesign(defaultDesign()))
    expect(copies()).toHaveLength(1)
    expect(localStorage.getItem(copies()[0])).toBe(raw)
  })

  it('keeps preservation/quota failure inside the modal without overwriting any originals', async () => {
    const raw = 'malformed retained bytes\n'
    localStorage.setItem(PROTOTYPE_STORAGE_KEY, raw)
    localStorage.setItem('fury-draft-v1', 'legacy sentinel')
    mount()
    click('My builds')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    await act(async () => button('Preserve original and replace with this design').click())
    expect(feedback()).toContain('preservation or verification failed')
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw)
    expect(localStorage.getItem('fury-draft-v1')).toBe('legacy sentinel')
    expect(copies()).toHaveLength(0)
  })

  it('does not claim success after readback replacement by a noncooperating writer', async () => {
    mount()
    click('My builds')
    const set = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      set.call(this, key, key === PROTOTYPE_STORAGE_KEY ? 'intervening raw writer' : value)
    })
    await act(async () => button('Save design locally').click())
    expect(feedback()).toContain('newer or changed prototype')
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe('intervening raw writer')
    expect(host.querySelector('.saved-card')).toBeNull()
  })

  it('holds a frozen save snapshot inside the existing Web Lock despite later design props', async () => {
    let run: (() => unknown) | undefined
    let resolve: ((value: unknown) => void) | undefined
    const request = vi.fn((_name: string, callback: () => unknown) => {
      run = callback
      return new Promise((done) => {
        resolve = done
      })
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    const first = defaultDesign()
    mount(first)
    click('My builds')
    click('Save design locally')
    expect(request.mock.calls[0][0]).toBe('fury-prototype-v4-save')
    expect(button('Save design locally').disabled).toBe(true)
    mount(defaultDesign({ family: 'container', lengthFt: 40 }))
    await act(async () => resolve!(run!()))
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(serializeDesign(first))
    expect(feedback()).toContain('selected v4 snapshot')
  })

  it('retains invalid link bytes and paginates exact recovery downloads without conversion', async () => {
    const hash = '#unknown-fury=%20original%0A'
    window.history.replaceState(null, '', '/?prototype=images' + hash)
    for (let i = 0; i < 7; i++)
      localStorage.setItem(`${PROTOTYPE_RECOVERY_PREFIX}${i}`, `raw ${i}\n`)
    mount()
    click('My builds')
    click('Download original link fragment')
    expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)?.[1]).toBe(hash)
    await act(async () => button('Copy local prototype link').click())
    expect(window.location.hash).toBe(hash)
    click('Inspect saved originals')
    expect(
      host.querySelectorAll('[aria-label="Prototype and legacy recovery copies"] button'),
    ).toHaveLength(6)
    click('Show more recovery copies')
    expect(
      host.querySelectorAll('[aria-label="Prototype and legacy recovery copies"] button'),
    ).toHaveLength(7)
    click('Download recovery copy 7')
    expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)?.[1]).toBe('raw 6\n')
    expect(load).not.toHaveBeenCalled()
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull()
  })
})
