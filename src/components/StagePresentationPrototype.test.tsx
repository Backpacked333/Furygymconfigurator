// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageConfigurator, HISTORICAL_REFERENCE } from '../prototype/ImageConfigurator'
import { usePrototypeImage } from '../prototype/usePrototypeImage'
import { defaultDesign, type DesignEnvelope } from '../domain/design'
import { DRAFT_CAMERAS } from '../domain/presentation'
import { createMockArtifact, imageReplyBase } from '../image-service/protocol'
import { designIdentity } from '../domain/designIdentity'
import { downloadPrototypeFile } from '../prototype/state'

vi.mock('../prototype/usePrototypeImage', () => ({ usePrototypeImage: vi.fn() }))
vi.mock('../prototype/state', async (original) => ({
  ...(await original<typeof import('../prototype/state')>()),
  downloadPrototypeFile: vi.fn(),
}))

describe('v4 adapters on the shared stage (jsdom, not browser visual evidence)', () => {
  let host: HTMLDivElement, root: Root, selected: DesignEnvelope
  let image: ReturnType<typeof usePrototypeImage>
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
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
    image = { progress: { state: 'pending' }, shown: null, current: false, retry: vi.fn() }
    vi.mocked(usePrototypeImage).mockImplementation((design) => {
      selected = design
      return image
    })
    vi.mocked(downloadPrototypeFile).mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const mount = () => act(() => root.render(<ImageConfigurator />))
  const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
    )
    if (!found) throw new Error(`Missing button ${label}`)
    return found
  }
  const click = (label: string) => act(() => button(label).click())
  it('uses the real shell/frame/filmstrip/toolbar and keeps its fixed reference honest', () => {
    mount()
    expect(
      host.querySelector(
        '.workspace > .stage > .stage-body > .stage-frame > .still-stage .stage-toolbar',
      ),
    ).not.toBeNull()
    expect(host.querySelectorAll('header nav')).toHaveLength(1)
    expect(host.querySelectorAll('.filmstrip button')).toHaveLength(7)
    expect(host.querySelector('.prototype-hero')?.getAttribute('data-image-state')).toBe(
      'historical',
    )
    expect(host.querySelector('.still-layer')?.getAttribute('src')).toBe(HISTORICAL_REFERENCE.src)
    expect(host.querySelector('.prototype-image-label')?.textContent).toContain(
      'Historical reference — not this configuration',
    )
    expect(button('Download mock diagnostic').disabled).toBe(true)
    expect(host.querySelector('canvas')).toBeNull()
    click('Image status & limits')
    expect(button('Strict image / PDF export').disabled).toBe(true)
    expect(host.querySelector('dialog')?.textContent).toContain('No automatic live/cloud fallback')
    expect(host.querySelector('dialog')?.textContent).toContain(
      'Requested: DRAFT — Front three-quarter',
    )
  })
  it('all seven views emit canonical presentation changes and history restores the whole revision', () => {
    mount()
    const initial = selected!
    for (const camera of DRAFT_CAMERAS) {
      click(`${camera.name.replace('DRAFT — ', '')} DRAFT · ${camera.group}`)
      expect(selected!.presentation.cameraRef).toBe(camera.ref)
      expect(selected!.config).toEqual(initial.config)
      expect(selected!.presentation.lookRef).toBe(initial.presentation.lookRef)
      expect(selected!.outputProfile).toBe(initial.outputProfile)
      expect(host.querySelector('.prototype-reference')?.getAttribute('src')).toBe(
        HISTORICAL_REFERENCE.src,
      )
    }
    const final = selected!
    click('Undo last change')
    expect(selected!.presentation.cameraRef).toBe('entry-draft@1')
    click('Redo last change')
    expect(selected!).toEqual(final)
    const exterior = host.querySelector<HTMLButtonElement>(
      '.view-switch[aria-label="Camera views"] button',
    )!
    act(() => exterior.click())
    expect(selected!.presentation.cameraRef).toBe('top-draft@1')
  })
  it('replaces the stage with the actual read-only plan and keeps full design unchanged', () => {
    mount()
    const initial = selected!
    click('Floor plan')
    expect(host.querySelector('.stage-body > .floor-plan.is-read-only')).not.toBeNull()
    expect(host.querySelector('.prototype-hero')).toBeNull()
    expect(host.querySelectorAll('.floor-plan [role="button"]')).toHaveLength(0)
    expect(host.querySelector('.floor-plan')?.textContent).toContain('Fixed arrangement')
    expect(selected!).toBe(initial)
    const exterior = host.querySelector<HTMLButtonElement>(
      '.view-switch[aria-label="Camera views"] button',
    )!
    act(() => exterior.click())
    expect(host.querySelector('.floor-plan')).toBeNull()
    expect(host.querySelector('.prototype-hero')).not.toBeNull()
  })
  it('binds draft looks/aspect in the shared popover and opens the real Setting step', () => {
    mount()
    const initial = selected!
    click('Adjust scene')
    click('Desert retreat')
    click('Night')
    click('Tall · 4:5')
    expect(selected!.presentation.lookRef).toBe('desert-night-draft@1')
    expect(selected!.presentation.aspect).toBe('tall')
    expect(selected!.presentation.cameraRef).toBe(initial.presentation.cameraRef)
    expect(selected!.config).toEqual(initial.config)
    expect(host.querySelector('.still-stage')?.classList.contains('is-tall')).toBe(true)
    click('All setting options')
    expect(host.querySelector('#prototype-tab-3')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[aria-label="Adjust scene"][role="dialog"]')).toBeNull()
  })
  it('keeps Pending/Failed/Unavailable and previous/selected diagnostics distinct with safe download gating', async () => {
    mount()
    click('View mock preview')
    expect(host.textContent).toContain('Mock image pending')
    image = {
      ...image,
      progress: { state: 'error', message: 'Mock decode failed.', retryable: true },
    }
    mount()
    expect(host.textContent).toContain('Failed')
    expect(host.textContent).toContain('Mock decode failed.')
    click('Retry mock preview')
    expect(image.retry).toHaveBeenCalledOnce()
    image = {
      ...image,
      progress: { state: 'unavailable', message: 'Service unavailable.', retryable: false },
    }
    mount()
    expect(host.textContent).toContain('Unavailable')
    expect(button('Retry mock preview').disabled).toBe(true)
    const design = defaultDesign()
    const reply = {
      ...imageReplyBase('test_interest_1234567890ABCDE', await designIdentity(design)),
      state: 'ready' as const,
      artifact: await createMockArtifact(design),
    }
    image = {
      ...image,
      shown: { key: 'previous', reply },
      current: false,
      progress: { state: 'pending' },
    }
    mount()
    expect(host.querySelector('.prototype-image-label')?.textContent).toContain('PREVIOUS request')
    expect(host.querySelector('img')?.alt).toContain('Previous request')
    expect(button('Download mock diagnostic').disabled).toBe(true)
    image = { ...image, current: true, progress: { state: 'ready', reply } }
    mount()
    expect(host.querySelector('.prototype-image-label')?.textContent).toContain('selected request')
    expect(host.textContent).toContain('Mock preview — not a current design image')
    click('Download mock diagnostic')
    expect(downloadPrototypeFile).toHaveBeenCalledWith(
      `Fury-MOCK-${reply.requested.requestDigest.slice(7)}.svg`,
      decodeURIComponent(reply.artifact.src.split(',')[1]),
      'image/svg+xml',
    )
  })
  it('leaves save/share/JSON usable while pending and retains dialog-local feedback', () => {
    mount()
    click('My builds')
    click('Export design JSON')
    const exported = JSON.parse(vi.mocked(downloadPrototypeFile).mock.calls.at(-1)![1])
    expect(exported).toEqual(selected!)
    expect(host.querySelector('dialog .prototype-library-feedback')).not.toBeNull()
  })
})
