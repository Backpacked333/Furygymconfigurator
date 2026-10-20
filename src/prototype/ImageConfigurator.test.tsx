// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, serializeDesign, type DesignEnvelope } from '../domain/design'
import { designIdentity } from '../domain/designIdentity'
import { PROTOTYPE_STORAGE_KEY, PROTOTYPE_RECOVERY_PREFIX } from '../domain/prototypeStorage'
import { createMockArtifact, imageReplyBase, type ImageReadyReply } from '../image-service/protocol'
import { ImageConfigurator, HISTORICAL_REFERENCE } from './ImageConfigurator'
import { localRenderDesign, LOCAL_RENDER_REQUEST_PATH } from '../image-service/localRenderProtocol'
import {
  bindDisplay,
  DISPLAY_FLAGS,
  DISPLAY_LABEL,
  DISPLAY_MODE,
  DISPLAY_PROTOCOL,
  DISPLAY_REQUEST_PATH,
  displayHolds,
  displayImagePath,
  type DisplayReadyReply,
} from '../display/contract'
import { fakeResponse, localFixture } from './localRenderClient.fixtures'
import { downloadPrototypeFile, prototypeLink, readPrototypeShare } from './state'

vi.mock('./state', async (original) => ({
  ...(await original<typeof import('./state')>()),
  downloadPrototypeFile: vi.fn(),
}))
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const id = 'browser_interest_1234567890ABCDE'
async function ready(design: DesignEnvelope): Promise<ImageReadyReply> {
  return {
    ...imageReplyBase(id, await designIdentity(design)),
    state: 'ready',
    artifact: await createMockArtifact(design),
  }
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('image configurator interactions (jsdom only, no browser/server)', () => {
  let host: HTMLDivElement, root: Root
  let decode: ReturnType<typeof vi.fn<() => Promise<void>>>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    )
    decode = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        onload = null
        onerror = null
        get naturalWidth() {
          return Number(decodeURIComponent(this.src).match(/width="(\d+)"/)?.[1])
        }
        get naturalHeight() {
          return Number(decodeURIComponent(this.src).match(/height="(\d+)"/)?.[1])
        }
        decode() {
          return decode()
        }
      },
    )
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
    vi.mocked(downloadPrototypeFile).mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'locks')
    Reflect.deleteProperty(navigator, 'clipboard')
    vi.unstubAllGlobals()
  })
  const mount = () =>
    act(() =>
      root.render(
        <StrictMode>
          <ImageConfigurator />
        </StrictMode>,
      ),
    )
  function button(text: string) {
    const found = [...host.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === text || item.textContent?.trim() === text,
    )
    if (!found) throw new Error(`Missing button: ${text}`)
    return found
  }
  const click = (text: string) => act(() => button(text).click())
  const tab = (name: string) =>
    act(() =>
      [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')]
        .find((item) => item.textContent?.endsWith(name))!
        .click(),
    )
  const library = () => {
    if (!host.querySelector('dialog[open]')) click('My builds')
  }
  const close = () => {
    if (host.querySelector('dialog[open]')) click('Close dialog')
  }
  function exported(): DesignEnvelope {
    library()
    click('Export design JSON')
    return JSON.parse(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)![1])
  }
  const chooseContainer = () => {
    click('Container Gym')
  }
  async function flushToDecode(count = 1) {
    await act(async () => {
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(count), { timeout: 3000 })
    })
  }

  it('uses the native image stage itself for the assembly animation without stacked status panels', () => {
    window.history.replaceState(null, '', '/?experience=library')
    mount()
    expect(host.querySelectorAll('.library-set-status')).toHaveLength(1)
    expect(host.querySelector('.stage-frame .library-set-status iframe')).not.toBeNull()
    expect(host.querySelector('.prototype-image-status')).toBeNull()
    expect(host.querySelector('.prototype-image-label')).toBeNull()
    expect(host.querySelectorAll('[aria-label="Rendered camera views"] button')).toHaveLength(5)
    click('Image details')
    expect(host.querySelector('dialog[open]')?.textContent).toContain('Art direction')
  })

  it('keeps the Fury shell, four tabs, reference stage and all controls usable without renderer imports', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    mount()
    expect(host.querySelector('.brand')?.textContent).toContain('FURY')
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(4)
    expect(host.querySelectorAll('[aria-label="Five draft cameras"] button')).toHaveLength(5)
    expect(host.querySelector('canvas')).toBeNull()
    expect(write).not.toHaveBeenCalled()
    expect(host.querySelector('img')?.getAttribute('src')).toBe(HISTORICAL_REFERENCE.src)
    expect(host.textContent).toContain('Historical reference — not this configuration')
    expect(host.textContent).toContain('97f204ffff')
    expect(button('Explore in 360°').disabled).toBe(true)
    click('Image status & limits')
    expect(button('Strict image / PDF export').disabled).toBe(true)
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'No automatic live/cloud fallback',
    )
  })
  it('wires the familiar header, panel, footer, share and plan actions without image readiness', () => {
    mount()
    click('Hide options')
    expect(host.querySelector('.app')?.classList.contains('panel-closed')).toBe(true)
    click('Customize gym')
    expect(host.querySelector('.app')?.classList.contains('panel-open')).toBe(true)
    click('Help and information')
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'No sales request is submitted',
    )
    close()
    act(() => (host.querySelector('.summary-estimate button') as HTMLButtonElement).click())
    expect(host.querySelector('dialog[open] .comparison table')?.textContent).toContain(
      'Quote required',
    )
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'A priced estimate is unavailable',
    )
    click('Read-only plan')
    expect(host.querySelector('.floor-plan.is-read-only')).not.toBeNull()
    click('Exterior')
    act(() => (host.querySelector('.brief-cta') as HTMLButtonElement).click())
    expect(host.querySelector('dialog[open] .prototype-spec')).not.toBeNull()
    close()
    click('Share')
    expect(host.querySelector('dialog[open] .share-visual')).not.toBeNull()
    click('Export design JSON')
    expect(JSON.parse(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)![1])).toEqual(
      defaultDesign(),
    )
    expect(fetch).not.toHaveBeenCalled() // Existing 120 ms admission delay, not presentation startup.
  })
  it('uses the shared fullscreen frame and keeps truth labels and scene focus inside it', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
    try {
      mount()
      const frame = host.querySelector<HTMLElement>('.stage-frame')!
      const request = vi.fn(async () => {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: frame })
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      const exit = vi.fn(async () => {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      Object.defineProperty(frame, 'requestFullscreen', { configurable: true, value: request })
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
      await act(async () => button('Full screen').click())
      expect(request).toHaveBeenCalledOnce()
      expect(frame.textContent).toContain('Historical reference — not this configuration')
      click('Adjust scene')
      expect(frame.querySelector('.scene-popover')?.contains(document.activeElement)).toBe(true)
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
      await act(async () => button('Exit full screen').click())
      expect(exit).toHaveBeenCalledOnce()
      expect(button('Full screen').getAttribute('aria-pressed')).toBe('false')
      await act(async () => button('Full screen').click())
      click('Adjust scene')
      await act(async () => button('All setting options').click())
      act(() => vi.advanceTimersByTime(20))
      expect(exit).toHaveBeenCalledTimes(2)
      expect(document.activeElement).toBe(host.querySelector('#prototype-tab-3'))
      expect(host.querySelector('#prototype-tab-3')?.getAttribute('aria-selected')).toBe('true')
    } finally {
      for (const key of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen'])
        Reflect.deleteProperty(document, key)
    }
  })
  it('keeps decoded previous diagnostics distinct after rapid look, camera and aspect changes', async () => {
    const reply = await ready(defaultDesign())
    vi.mocked(fetch).mockResolvedValue(response(reply))
    mount()
    await flushToDecode()
    click('Adjust scene')
    const popover = document.querySelector('.scene-popover')!
    expect(popover.contains(document.activeElement)).toBe(true)
    const choose = [...popover.querySelectorAll('button')].find(
      (item) => item.textContent === 'Desert retreat',
    )!
    act(() => choose.click())
    act(() =>
      [...popover.querySelectorAll('button')].find((item) => item.textContent === 'Night')!.click(),
    )
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.activeElement).toBe(button('Adjust scene'))
    click('Interior entry DRAFT · interior')
    tab('Setting')
    click('Portrait')
    expect(host.querySelector('.still-stage')?.classList.contains('is-tall')).toBe(true)
    expect(host.querySelector('img')?.getAttribute('src')).toBe(HISTORICAL_REFERENCE.src)
    expect(host.textContent).toContain('Historical reference — not this configuration')
    click('View mock preview')
    expect(host.querySelector('img')?.getAttribute('src')).toBe(reply.artifact.src)
    expect(host.querySelector('img')?.alt).toContain('Previous request')
    expect(button('Download mock diagnostic').disabled).toBe(true)
    expect(button('Explore in 360°').disabled).toBe(true)
    click('Image status & limits')
    expect(button('Strict image / PDF export').disabled).toBe(true)
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'previous request diagnostic, not selected',
    )
    close()
    const current = exported()
    expect(current.presentation).toMatchObject({
      lookRef: 'desert-night-draft@1',
      cameraRef: 'entry-draft@1',
      aspect: 'tall',
    })
    expect(host.querySelector('canvas')).toBeNull()
  })
  it('retains the unavailable historical label and design when the fixed photo fails', () => {
    mount()
    act(() => host.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(host.textContent).toContain(
      'Historical reference unavailable. Your design controls still work.',
    )
    expect(host.textContent).toContain('Historical reference — not this configuration')
    tab('Exterior')
    click('Cloud')
    expect(host.querySelector('img')).toBeNull()
    expect(exported().config.appearance.finish).toBe('cloud')
    expect(localStorage.length).toBe(0)
  })
  it('applies family/size and required adjustments atomically and Undo/Redo restore full envelopes', () => {
    mount()
    const initial = exported()
    close()
    chooseContainer()
    expect(host.querySelector('h1')?.textContent).toContain('C-20')
    expect(host.textContent).toContain('Layout switches to the Container 20 ft arrangement.')
    click('40 ft Container')
    expect(host.textContent).toContain('Layout switches to the Container 40 ft arrangement.')
    const changed = exported()
    close()
    expect(changed.config.arrangementRef).toBe('container-40-review@1')
    click('Undo last change')
    expect(exported().config.product).toEqual({ family: 'container', lengthFt: 20 })
    close()
    click('Undo last change')
    expect(exported()).toEqual(initial)
    close()
    click('Redo last change')
    click('Redo last change')
    expect(exported()).toEqual(changed)
    expect(localStorage.length).toBe(0)
  })
  it('retains appearance, structure, additions, looks, cameras and output profiles in JSON while requests are pending', () => {
    mount()
    tab('Exterior')
    click('Cloud')
    click('Concept timber accentVisual study only. Material and availability unconfirmed.')
    click('Front deckOutdoor space for your Studio. Dimensions by inquiry.Quote required')
    tab('Interior')
    click('Warm cedarCedar-lined walls and ceiling with recessed downlights.')
    click('Oak look')
    click('Concept mirror wallVisual study only. Availability requires confirmation.')
    tab('Setting')
    click('Desert retreat')
    click('Night')
    click('Portrait')
    click('Thumbnail diagnostic')
    click('Interior entry DRAFT · interior')
    const design = exported()
    expect(design.config.appearance).toEqual({
      finish: 'cloud',
      accent: true,
      interior: 'timber',
      floor: 'oak',
      mirror: true,
    })
    expect(design.config.structure.addons).toEqual(['deck'])
    expect(design.presentation).toMatchObject({
      lookRef: 'desert-night-draft@1',
      cameraRef: 'entry-draft@1',
      aspect: 'tall',
    })
    expect(design.outputProfile).toBe('web-thumbnail')
    expect(host.querySelector('img')?.getAttribute('src')).toBe(HISTORICAL_REFERENCE.src)
    expect(host.textContent).toContain('Historical reference — not this configuration')
  })
  it('retains inquiry-only options without pretending to model or submit them', () => {
    mount()
    expect(host.textContent).toContain('Multi-unit & custom inquiries')
    const inquiries = [...host.querySelectorAll('.catalog-details li')]
    expect(inquiries).toHaveLength(5)
    expect(inquiries.every((item) => item.textContent?.endsWith('— inquiry only'))).toBe(true)
    expect(host.querySelector('.catalog-details button, .studio-layout select')).toBeNull()
    expect(host.textContent).toContain('No conversion or submission is available')
    expect(exported().config.structure).toMatchObject({ layout: 'single' })
  })
  it('shows a fixed read-only plan/inventory; units and equipment events cannot mutate design', () => {
    mount()
    const before = exported()
    close()
    click('Floor plan')
    expect(host.querySelectorAll('[data-equipment]')).toHaveLength(3)
    const item = host.querySelector('[data-equipment]')!
    act(() => {
      for (const key of ['Enter', ' ', 'Delete', 'Backspace', 'r', 'ArrowRight', 'ArrowDown'])
        item.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }))
      item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }))
      const svg = host.querySelector('.plan-svg')!
      svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 90, clientY: 80 }))
      svg.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
      svg.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    })
    expect(
      host.querySelectorAll('[data-equipment] button,[data-equipment][tabindex]'),
    ).toHaveLength(0)
    tab('Setting')
    click('Metric')
    expect(host.querySelector('.plan-svg')?.textContent).toContain('6.10 m')
    expect(exported()).toEqual(before)
    expect(host.textContent).toContain('Ceiling, doors and access are unresolved')
  })
  it('does not mount-load or autosave a valid saved original; explicit load is undoable', async () => {
    const saved = defaultDesign({ family: 'container', lengthFt: 40 })
    localStorage.setItem(PROTOTYPE_STORAGE_KEY, serializeDesign(saved))
    for (const key of ['fury-draft-v1', 'fury-builds-v1', 'fury-fixed-review-v1'])
      localStorage.setItem(key, `sentinel:${key}`)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    mount()
    expect(exported()).toEqual(defaultDesign())
    expect(write).not.toHaveBeenCalled()
    click('Load saved prototype')
    expect(exported()).toEqual(saved)
    close()
    click('Undo last change')
    library()
    await act(async () => button('Save design locally').click())
    expect(JSON.parse(localStorage.getItem(PROTOTYPE_STORAGE_KEY)!)).toEqual(defaultDesign())
    expect(host.querySelector('dialog[open] [role="status"]')?.textContent).toContain(
      'Saved the selected v4 snapshot locally',
    )
    const archive = Object.keys(localStorage).find((key) =>
      key.startsWith(PROTOTYPE_RECOVERY_PREFIX),
    )!
    expect(localStorage.getItem(archive)).toBe(serializeDesign(saved))
    for (const key of ['fury-draft-v1', 'fury-builds-v1', 'fury-fixed-review-v1'])
      expect(localStorage.getItem(key)).toBe(`sentinel:${key}`)
  })
  it.each([' \n {malformed', ' {"config":{"schemaVersion":999},"future":" exact "} '])(
    'preserves invalid/future originals before explicit replacement (%#)',
    async (raw) => {
      localStorage.setItem(PROTOTYPE_STORAGE_KEY, raw)
      mount()
      library()
      expect(button('Save design locally').disabled).toBe(true)
      click('Download saved original')
      expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)).toEqual([
        'fury-v4-original.txt',
        raw,
        'text/plain',
      ])
      expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw)
      await act(async () => button('Preserve original and replace with this design').click())
      const archive = Object.keys(localStorage).find((key) =>
        key.startsWith(PROTOTYPE_RECOVERY_PREFIX),
      )!
      expect(localStorage.getItem(archive)).toBe(raw)
      expect(JSON.parse(localStorage.getItem(PROTOTYPE_STORAGE_KEY)!)).toEqual(defaultDesign())
    },
  )
  it('refuses stale writes until explicit re-inspection without overwriting the new sentinel', async () => {
    mount()
    library()
    localStorage.setItem(PROTOTYPE_STORAGE_KEY, 'intervening exact original')
    await act(async () => button('Save design locally').click())
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe('intervening exact original')
    expect(host.querySelector('dialog[open] [role="status"]')?.textContent).toContain(
      'A newer or changed prototype is stored',
    )
    click('Inspect saved prototype')
    expect(button('Save design locally').disabled).toBe(true)
  })
  it('fails closed on denied preservation and retains original bytes', async () => {
    localStorage.setItem(PROTOTYPE_STORAGE_KEY, 'unreadable')
    mount()
    library()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota')
    })
    await act(async () => button('Preserve original and replace with this design').click())
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe('unreadable')
    expect(host.querySelector('dialog[open] [role="status"]')?.textContent).toContain(
      'Save was not confirmed',
    )
  })
  it('shows final-write quota failure inside the open dialog, preserves raw data and permits a later save', async () => {
    const original = serializeDesign(defaultDesign({ family: 'container', lengthFt: 40 }))
    localStorage.setItem(PROTOTYPE_STORAGE_KEY, original)
    mount()
    library()
    const setItem = Storage.prototype.setItem
    let denied = 0
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === PROTOTYPE_STORAGE_KEY) {
        denied++
        throw new DOMException('Synthetic final-write quota', 'QuotaExceededError')
      }
      setItem.call(this, key, value)
    })
    await act(async () => button('Save design locally').click())
    expect(denied).toBe(1)
    expect(host.querySelector('dialog[open] [role="status"]')?.textContent).toContain(
      'Save was not confirmed',
    )
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(original)
    const archive = Object.keys(localStorage).find((key) =>
      key.startsWith(PROTOTYPE_RECOVERY_PREFIX),
    )!
    expect(localStorage.getItem(archive)).toBe(original)
    expect(exported()).toEqual(defaultDesign())
    write.mockRestore()
    await act(async () => button('Save design locally').click())
    expect(host.querySelector('dialog[open] [role="status"]')?.textContent).toContain(
      'Saved the selected v4 snapshot locally',
    )
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(serializeDesign(defaultDesign()))
  })
  it('shows a final-write readback conflict inside the modal instead of reporting success', async () => {
    const original = serializeDesign(defaultDesign({ family: 'container', lengthFt: 40 }))
    localStorage.setItem(PROTOTYPE_STORAGE_KEY, original)
    mount()
    library()
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      setItem.call(this, key, value)
      if (key === PROTOTYPE_STORAGE_KEY) setItem.call(this, key, 'intervening writer sentinel')
    })
    await act(async () => button('Save design locally').click())
    expect(host.querySelector('dialog[open] [role="status"]')?.textContent).toContain(
      'A newer or changed prototype is stored',
    )
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe('intervening writer sentinel')
    const archive = Object.keys(localStorage).find((key) =>
      key.startsWith(PROTOTYPE_RECOVERY_PREFIX),
    )!
    expect(localStorage.getItem(archive)).toBe(original)
    expect(exported()).toEqual(defaultDesign())
  })
  it('edits/exports without storage and reports clipboard denial', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('Denied')
    })
    mount()
    library()
    expect(button('Save design locally').disabled).toBe(true)
    expect(host.textContent).toContain('Browser storage is unavailable')
    expect(exported()).toEqual(defaultDesign())
    await act(async () => button('Copy local prototype link').click())
    expect(host.querySelector('dialog[open] [role="status"]')?.textContent).toContain(
      'Clipboard unavailable',
    )
    expect(host.querySelector('textarea')?.value).toContain('prototype=images')
  })
  it('opens valid hash history only explicitly and never writes storage on mount/hash changes', () => {
    const design = defaultDesign({ family: 'container', lengthFt: 40 })
    window.history.replaceState(null, '', prototypeLink(design, window.location.href))
    const write = vi.spyOn(Storage.prototype, 'setItem')
    mount()
    expect(exported()).toEqual(defaultDesign())
    click('Open shared design')
    expect(exported()).toEqual(design)
    close()
    click('Undo last change')
    expect(exported()).toEqual(defaultDesign())
    window.history.replaceState(null, '', '#fury-v4=%ZZ')
    act(() => window.dispatchEvent(new Event('popstate')))
    expect(host.textContent).toContain('Unsupported link preserved')
    click('Download original link fragment')
    expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)![1]).toBe('#fury-v4=%ZZ')
    expect(write).not.toHaveBeenCalled()
  })
  it('shares the full frozen design; an invalid raw hash is not replaced by sharing', async () => {
    const raw = '#fury-v4=%7B%22config%22%3A999%7D'
    window.history.replaceState(null, '', raw)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mount()
    tab('Exterior')
    click('Chalk')
    library()
    await act(async () => button('Copy local prototype link').click())
    const copied = new URL(writeText.mock.calls[0][0])
    const parsed = readPrototypeShare(copied.hash)
    expect(parsed.status).toBe('ready')
    if (parsed.status === 'ready') expect(parsed.design.config.appearance.finish).toBe('chalk')
    expect(window.location.hash).toBe(raw)
    click('Download original link fragment')
    expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)![1]).toBe(raw)
  })
  it('keeps skip-link focus, tab keyboard navigation and invalid hash recovery independent', () => {
    window.history.replaceState(null, '', '#legacy=original')
    mount()
    const skip = host.querySelector<HTMLAnchorElement>('.skip-link')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => skip.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('aside'))
    expect(window.location.hash).toBe('#legacy=original')
    const first = host.querySelector<HTMLButtonElement>('[role=tab]')!
    act(() =>
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(document.activeElement?.textContent).toContain('Exterior')
    expect(host.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(
      'prototype-tab-1',
    )
  })
  it('recovers raw legacy/review records without parsing, conversion or unrelated-key disclosure', () => {
    localStorage.setItem('fury-draft-v1', 'legacy unparsed sentinel')
    localStorage.setItem('fury-fixed-review-v1', 'review sentinel')
    localStorage.setItem('other-private-key', 'private')
    mount()
    library()
    click('Inspect saved originals')
    click('Download fury-draft-v1')
    expect(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)![1]).toBe('legacy unparsed sentinel')
    click('Preserve legacy originals')
    expect(localStorage.getItem('fury-draft-v1')).toBe('legacy unparsed sentinel')
    expect(localStorage.getItem('fury-fixed-review-v1')).toBe('review sentinel')
    expect(localStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull()
    expect(host.textContent).not.toContain('other-private-key')
  })
  it('validates/decodes mock readiness, keeps the reference truthful, and downloads only exact diagnostic bytes', async () => {
    const reply = await ready(defaultDesign())
    vi.mocked(fetch).mockResolvedValue(response(reply))
    mount()
    await flushToDecode()
    expect(host.textContent).toContain('Mock preview ready for the selected revision')
    expect(host.querySelector('img')?.getAttribute('src')).toBe(HISTORICAL_REFERENCE.src)
    click('View mock preview')
    expect(host.querySelector('img')?.getAttribute('src')).toBe(reply.artifact.src)
    expect(host.textContent).toContain('Mock preview — not a current design image')
    click('Download mock diagnostic')
    const download = vi.mocked(downloadPrototypeFile).mock.calls.at(-1)!
    expect(download).toEqual([
      `Fury-MOCK-${reply.requested.requestDigest.slice(7)}.svg`,
      decodeURIComponent(reply.artifact.src.split(',')[1]),
      'image/svg+xml',
    ])
    tab('Exterior')
    click('Cloud')
    expect(button('Download mock diagnostic').disabled).toBe(true)
    expect(host.textContent).toContain('showing previous configuration diagnostic')
    expect(host.querySelector('img')?.alt).toContain('Previous request')
  })
  it('refuses an old decode after a new selection and cancels interests on unmount', async () => {
    const first = await ready(defaultDesign())
    const cloud = defaultDesign()
    const secondDesign = {
      ...cloud,
      config: {
        ...cloud.config,
        appearance: { ...cloud.config.appearance, finish: 'cloud' as const },
      },
    }
    const second = await ready(secondDesign)
    const delayed = deferred<void>()
    decode.mockReturnValueOnce(delayed.promise).mockResolvedValue(undefined)
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith('/cancel'))
        return response({
          ...imageReplyBase(id, first.requested),
          state: 'cancelled',
          cancellationScope: 'interest-only',
          sharedWorkCancelled: false,
        })
      return response(
        JSON.parse(init!.body as string).design.config.appearance.finish === 'cloud'
          ? second
          : first,
      )
    })
    mount()
    click('View mock preview')
    await flushToDecode()
    tab('Exterior')
    click('Cloud')
    await flushToDecode(2)
    expect(host.querySelector('img')?.getAttribute('src')).toBe(second.artifact.src)
    await act(async () => {
      delayed.resolve()
      await Promise.resolve()
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBe(second.artifact.src)
    const signals = vi
      .mocked(fetch)
      .mock.calls.filter(([path]) => !String(path).endsWith('/cancel'))
      .map(([, init]) => init!.signal!)
    act(() => root.unmount())
    root = createRoot(host)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(
      vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/cancel')),
    ).toHaveLength(2)
  })
  it('freezes a save before waiting on a cooperating-tab lock while later edits remain editable', async () => {
    const lock = deferred<void>()
    const request = vi.fn(async (_name: string, callback: () => unknown) => {
      await lock.promise
      return callback()
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    mount()
    library()
    click('Save design locally')
    expect(request).toHaveBeenCalledOnce()
    close()
    tab('Exterior')
    click('Cloud')
    await act(async () => {
      lock.resolve()
      await Promise.resolve()
    })
    expect(JSON.parse(localStorage.getItem(PROTOTYPE_STORAGE_KEY)!).config.appearance.finish).toBe(
      'obsidian',
    )
    expect(exported().config.appearance.finish).toBe('cloud')
  })
  // Private display tests use synthetic headers + fake bitmap decoder; never render evidence.
  function displayMode() {
    const mocks = localMode()
    window.history.replaceState(
      null,
      '',
      '/?prototype=images&imageMode=private-display&displayEndpoint=https://ignored.invalid',
    )
    mocks.bitmap.mockResolvedValue({ width: 1600, height: 1000, close: vi.fn() })
    return mocks
  }
  async function displayReplies() {
    const hash = `sha256:${'a'.repeat(64)}`
    const bytes = new Uint8Array(44)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const header = new DataView(bytes.buffer)
    header.setUint32(8, 13)
    header.setUint32(12, 0x49484452)
    header.setUint32(16, 1600)
    header.setUint32(20, 1000)
    const checksum = `sha256:${Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')}`
    let serial = 0
    const replies: DisplayReadyReply[] = []
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return fakeResponse(url, {}, 404)
      if (url.endsWith('.png')) return fakeResponse(url, bytes, 200, true)
      const design = JSON.parse(options!.body as string).design as DesignEnvelope
      const binding = await bindDisplay(design, {
        sourceManifestDigest: hash,
        assetManifestDigest: hash,
        bundleDigest: hash,
        lockfileDigest: hash,
        runtimePolicyDigest: hash,
        threeRevision: '186',
      })
      const interestId = `synthetic-ui-display-interest-${++serial}`
      const reply: DisplayReadyReply = {
        protocol: DISPLAY_PROTOCOL,
        mode: DISPLAY_MODE,
        interestId,
        binding,
        state: 'ready',
        artifact: {
          checksum,
          receiptDigest: hash,
          mediaType: 'image/png',
          byteLength: 44,
          width: 1600,
          height: 1000,
          src: displayImagePath(interestId, checksum),
          exactMatch: true,
          approvedCurrentImage: false,
          cacheStatus: 'verified-exact-hit',
          provenance: {
            kind: 'private-three-display',
            label: DISPLAY_LABEL,
            sessionId: 'synthetic-ui-display-session-1',
            revision: serial,
            flags: DISPLAY_FLAGS,
            holds: displayHolds(design),
          },
        },
      }
      replies.push(reply)
      return fakeResponse(url, reply)
    })
    return replies
  }
  async function displayReady(blobCount = 1) {
    await act(async () => {
      await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(blobCount), {
        timeout: 3000,
      })
    })
    expect(host.querySelector('[data-image-state="current-display-unqualified"]')).not.toBeNull()
  }
  it('selects only the private-display hook in the existing B shell and keeps history/save/share/plan immediate while pending', async () => {
    displayMode()
    mount()
    expect(host.querySelector('.brand')?.textContent).toContain('FURY')
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(4)
    expect(host.querySelector('canvas, img')).toBeNull()
    expect(host.querySelector('[aria-label="Image source"]')).toBeNull()
    expect(host.textContent).toContain(DISPLAY_LABEL)
    expect(host.textContent).toContain('1600×1000 / Ultra')
    tab('Exterior')
    click('Bronze')
    click('Undo last change')
    expect(exported().config.appearance.finish).toBe('obsidian')
    close()
    click('Redo last change')
    library()
    await act(async () => button('Save design locally').click())
    expect(JSON.parse(localStorage.getItem(PROTOTYPE_STORAGE_KEY)!).config.appearance.finish).toBe(
      'bronze',
    )
    close()
    click('Share')
    expect(host.querySelector('dialog[open] .share-visual')).not.toBeNull()
    close()
    click('Floor plan')
    expect(host.querySelector('.floor-plan.is-read-only')).not.toBeNull()
    click('Exterior')
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(fetch).toHaveBeenCalledOnce()
    tab('Space')
    chooseContainer()
    click('40 ft Container')
    await act(async () => vi.advanceTimersByTimeAsync(120))
    tab('Setting')
    click('Desert retreat')
    click('Night')
    click('Portrait')
    click('Interior entry DRAFT · interior')
    await act(async () => vi.advanceTimersByTimeAsync(120))
    const calls = vi.mocked(fetch).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls.every(([url]) => url === window.location.origin + DISPLAY_REQUEST_PATH)).toBe(true)
    const selected = exported()
    close()
    expect(selected.config.product).toEqual({ family: 'container', lengthFt: 40 })
    expect(selected.presentation).toMatchObject({
      lookRef: 'desert-night-draft@1',
      aspect: 'tall',
      cameraRef: 'entry-draft@1',
    })
    expect(host.querySelector('img')).toBeNull()
    expect(button('Display candidate export unavailable').disabled).toBe(true)
    expect(button('Explore in 360°').disabled).toBe(true)
    expect(host.textContent).not.toContain('97f204ffff')
    expect(decode).not.toHaveBeenCalled()
  })
  it('presents only verified candidate Blob bytes and full holds; changing design hides revoked previous pixels immediately', async () => {
    const { revoke } = displayMode(),
      replies = await displayReplies()
    mount()
    await displayReady()
    expect(host.textContent).toContain('Verified exact display cache')
    expect(host.querySelector('img')?.src).toBe('blob:synthetic-local-1')
    expect(host.querySelector('img')?.alt).toContain('Exact matching candidate, not approved art')
    click('Image status & limits')
    const details = host.querySelector('dialog[open]')!.textContent!
    for (const value of [
      replies[0].binding.displayDigest,
      replies[0].artifact.checksum,
      ...displayHolds(defaultDesign()),
      'neither host shutdown nor final billing',
      'No renderer is finally selected',
    ])
      expect(details).toContain(value)
    expect(button('Strict image / PDF export').disabled).toBe(true)
    close()
    vi.mocked(fetch).mockImplementation(async (input) =>
      fakeResponse(
        String(input),
        {
          protocol: DISPLAY_PROTOCOL,
          error: { code: 'execution-denied', message: 'No operator permit', retryable: false },
        },
        503,
      ),
    )
    tab('Exterior')
    click('Cloud')
    expect(host.querySelector('img')).toBeNull()
    await act(async () => Promise.resolve())
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-local-1')
    expect(host.textContent).toContain('Previous display image hidden; not this configuration')
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(host.textContent).toContain('execution-denied')
    expect(host.querySelector('img')).toBeNull()
    expect(exported().config.appearance.finish).toBe('cloud')
    close()
    click('Image status & limits')
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'PREVIOUS candidate provenance — image hidden',
    )
    expect(
      [...host.querySelectorAll('button')].some((b) => /retry/i.test(b.textContent ?? '')),
    ).toBe(false)
    expect(decode).not.toHaveBeenCalled()
  })
  it('drains delayed A after A→B→A without publishing it or cancelling active work', async () => {
    const { bitmap, create, revoke } = displayMode()
    await displayReplies()
    const delayed = deferred<{ width: number; height: number; close: () => void }>()
    bitmap.mockReturnValueOnce(delayed.promise)
    mount()
    await act(async () => {
      await vi.waitFor(() => expect(bitmap).toHaveBeenCalledOnce())
    })
    tab('Exterior')
    click('Bronze')
    expect(host.querySelector('img')).toBeNull()
    click('Obsidian')
    expect(host.querySelector('img')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(create).not.toHaveBeenCalled()
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel')),
    ).toHaveLength(0)
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(DISPLAY_REQUEST_PATH)),
    ).toHaveLength(1)
    await act(async () => {
      delayed.resolve({ width: 1600, height: 1000, close: vi.fn() })
      await Promise.resolve()
    })
    expect(host.querySelector('img')).toBeNull()
    await displayReady(2)
    expect(host.querySelector('img')?.src).toBe('blob:synthetic-local-2')
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-local-1')
    expect(host.querySelector('img')?.alt).toContain('Obsidian')
    expect(create).toHaveBeenCalledTimes(2)
    const cancelled = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/cancel'))
      .map(([url]) => String(url))
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toContain('synthetic-ui-display-interest-1/cancel')
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([url]) =>
          String(url).startsWith(window.location.origin + '/__fury-display/v1/'),
        ),
    ).toBe(true)
  })
  it('shows private-display unavailable with no substitute when the namespace is absent', async () => {
    displayMode()
    vi.mocked(fetch).mockImplementation(async (url) => {
      const result = fakeResponse(String(url), {}, 404)
      result.headers.set('content-type', 'text/html')
      return result
    })
    mount()
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('Private display service unavailable')
    expect(host.textContent).toContain('Rights, fonts, art direction and engineering remain held')
    tab('Exterior')
    click('Bronze')
    expect(exported().config.appearance.finish).toBe('bronze')
    expect(decode).not.toHaveBeenCalled()
  })
  // Local-real tests use fake transport + fake bitmap decoder and synthetic header bytes only.
  function localMode() {
    window.history.replaceState(null, '', '/?prototype=images&imageMode=local-real')
    let serial = 0
    const create = vi.fn(() => `blob:synthetic-local-${++serial}`)
    const revoke = vi.fn()
    const NativeURL = URL
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        static createObjectURL = create
        static revokeObjectURL = revoke
      },
    )
    const bitmap = vi.fn().mockResolvedValue({ width: 640, height: 400, close: vi.fn() })
    vi.stubGlobal('createImageBitmap', bitmap)
    return { create, revoke, bitmap }
  }
  async function localReplies() {
    const a = await localFixture()
    const b = await localFixture('bronze')
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return fakeResponse(url, {}, 404)
      const fixture = url.endsWith('.png')
        ? url.includes(b.reply.artifact.checksum.slice(7))
          ? b
          : a
        : JSON.parse(options!.body as string).design.config.appearance.finish === 'bronze'
          ? b
          : a
      return fakeResponse(
        url,
        url.endsWith('.png') ? fixture.bytes : fixture.reply,
        200,
        url.endsWith('.png'),
      )
    })
    return { a, b }
  }
  async function localReady(count = 1, blobCount = count) {
    await act(async () => {
      await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(blobCount), {
        timeout: 3000,
      })
    })
    expect(host.querySelector('[data-image-state="current-local-unqualified"]')).not.toBeNull()
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/images')),
    ).toHaveLength(count)
  }
  it('selects the real path inside the same shell, with no historical/mock image or renderer dependency', async () => {
    localMode()
    const write = vi.spyOn(Storage.prototype, 'setItem')
    mount()
    expect(host.querySelector('.brand')?.textContent).toContain('FURY')
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(4)
    expect(host.querySelector('canvas, img')).toBeNull()
    expect(host.textContent).toContain('Local render — unqualified software preview')
    expect(host.textContent).toContain('local-review-wide@1')
    expect(host.textContent).not.toContain('97f204ffff')
    expect(host.querySelector('[aria-label="Image source"]')).toBeNull()
    expect(write).not.toHaveBeenCalled()
    tab('Exterior')
    click('Bronze')
    expect(exported()).toEqual(localRenderDesign('bronze'))
    close()
    click('Undo last change')
    expect(exported()).toEqual(localRenderDesign('obsidian'))
    close()
    click('Redo last change')
    library()
    await act(async () => button('Save design locally').click())
    expect(JSON.parse(localStorage.getItem(PROTOTYPE_STORAGE_KEY)!)).toEqual(
      localRenderDesign('bronze'),
    )
    close()
    click('Share')
    expect(host.querySelector('dialog[open] .share-visual')).not.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    close()
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      window.location.origin + LOCAL_RENDER_REQUEST_PATH,
    )
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).design).toEqual(
      localRenderDesign('bronze'),
    )
    expect(button('Explore in 360°').disabled).toBe(true)
    expect(button('Local preview export unavailable').disabled).toBe(true)
  })
  it('shows only independently checked Blob bytes for both actual full-envelope finish controls, with software provenance', async () => {
    const { create, revoke } = localMode()
    const { a, b } = await localReplies()
    mount()
    await localReady()
    expect(host.querySelector('img')?.src).toBe('blob:synthetic-local-1')
    expect(host.textContent).toContain('Verified exact local cache')
    expect(host.textContent).toContain('640×400 / Lite / AgX / 4x MSAA')
    expect(host.textContent).toContain('webgl2 / software')
    click('Image status & limits')
    const details = host.querySelector('dialog[open]')!.textContent!
    for (const value of [
      a.reply.requested.requestDigest,
      a.reply.capture.captureDigest,
      a.reply.capture.build.assetManifestDigest,
      a.reply.artifact.checksum,
      a.reply.artifact.provenance.receiptDigest,
      'SYNTHETIC software test adapter',
      'screen-space-gi: omitted',
      'mirror: approximate',
      'thin-glass: approximate',
      'site-light-field: approximate',
    ])
      expect(details).toContain(value)
    expect(details).toContain('No approved current image, G1, visual parity')
    expect(button('Strict image / PDF export').disabled).toBe(true)
    close()
    tab('Exterior')
    click('Bronze')
    expect(host.querySelector('img')).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-local-1')
    expect(host.textContent).toContain('Previous local image hidden; not this configuration')
    await localReady(2)
    expect(host.querySelector('img')?.src).toBe('blob:synthetic-local-2')
    expect(host.querySelector('img')?.alt).toContain('Bronze')
    const bodies = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/images'))
      .map(([, options]) => JSON.parse(options!.body as string))
    expect(bodies.map((body) => body.design)).toEqual([a.design, b.design])
    expect(create).toHaveBeenCalledTimes(2)
    expect(decode).not.toHaveBeenCalled() // Mock SVG decoder is never used in real mode.
    expect(localStorage.length).toBe(0)
  })
  it('keeps unsupported options editable, hides previous pixels immediately and makes supported setup undoable without storage writes', async () => {
    localMode()
    await localReplies()
    mount()
    await localReady()
    tab('Exterior')
    click('Cloud')
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('No matching rendered preview')
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/images')),
    ).toHaveLength(1)
    click('Image status & limits')
    expect(host.querySelector('dialog[open]')?.textContent).toContain(
      'PREVIOUS preview provenance — image hidden, not this configuration',
    )
    close()
    expect(exported().config.appearance.finish).toBe('cloud')
    close()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    click('Use Studio-20 preview setup')
    expect(exported()).toEqual(localRenderDesign('obsidian'))
    close()
    click('Undo last change')
    expect(exported().config.appearance.finish).toBe('cloud')
    expect(localStorage.length).toBe(0)
  })
  it('does not resurrect previous A pixels on A→B→A or allow an obsolete decode to replace the current generation', async () => {
    const { bitmap, create } = localMode()
    await localReplies()
    const delayed = deferred<{ width: number; height: number; close: () => void }>()
    bitmap.mockReturnValueOnce(delayed.promise)
    mount()
    await act(async () => {
      await vi.waitFor(() => expect(bitmap).toHaveBeenCalledOnce())
    })
    tab('Exterior')
    click('Bronze')
    await localReady(2, 1)
    click('Obsidian')
    expect(host.querySelector('img')).toBeNull()
    await localReady(3, 2)
    const selected = host.querySelector('img')?.src
    await act(async () => {
      delayed.resolve({ width: 640, height: 400, close: vi.fn() })
      await Promise.resolve()
    })
    expect(host.querySelector('img')?.src).toBe(selected)
    expect(host.querySelector('img')?.alt).toContain('Obsidian')
    expect(create).toHaveBeenCalledTimes(2)
  })
  it('fails closed when local service is absent; no historical/mock fallback or unsafe retry control', async () => {
    localMode()
    vi.mocked(fetch).mockImplementation(async (url) => {
      const result = fakeResponse(String(url), {}, 404)
      result.headers.set('content-type', 'text/html')
      return result
    })
    mount()
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('wrong media type')
    expect(
      [...host.querySelectorAll('button')].some((item) => /retry/i.test(item.textContent ?? '')),
    ).toBe(false)
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/images')),
    ).toHaveLength(1)
    expect(button('Explore in 360°').disabled).toBe(true)
    expect(exported()).toEqual(localRenderDesign('obsidian'))
    close()
    click('Image status & limits')
    expect(button('Strict image / PDF export').disabled).toBe(true)
  })
  it('shows unavailable/retry for network failure without changing the design or enabling live', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Offline'))
    mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(host.textContent).toContain('Mock preview rejected or could not be decoded')
    expect(button('Retry mock preview').disabled).toBe(false)
    expect(button('Explore in 360°').disabled).toBe(true)
    expect(exported()).toEqual(defaultDesign())
    close()
    const reply = await ready(defaultDesign())
    vi.mocked(fetch).mockResolvedValue(response(reply))
    click('Retry mock preview')
    await flushToDecode()
    expect(host.textContent).toContain('Mock preview ready')
  })
})
