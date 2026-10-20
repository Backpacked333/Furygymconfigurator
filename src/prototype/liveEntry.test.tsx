// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeDesign, type DesignEnvelope } from '../domain/design'
import { ImageConfigurator } from './ImageConfigurator'
import { LIVE_FADE_MS } from './LiveViewport'
import type { NativeEntry, NativeLibrary } from './nativeLibrary'

const native = vi.hoisted(() => ({
  /** While set, image delivery never completes: the stage has no image of the selected design. */
  hold: false,
  shas: new Map<string, string>(),
}))
// Exact library images delivered for every design, so the stage shows the selected design's own.
vi.mock('./nativeLibrary', async (original) => {
  const actual = await original<typeof import('./nativeLibrary')>()
  const sha = (design: DesignEnvelope) => {
    const key = serializeDesign(design)
    if (!native.shas.has(key)) native.shas.set(key, native.shas.size.toString(16).padStart(64, '0'))
    return native.shas.get(key)!
  }
  return {
    ...actual,
    getNativeLibrary: async () => ({ entries: [] }) as unknown as NativeLibrary,
    findNativeImage: (_library: NativeLibrary, design: DesignEnvelope) =>
      ({
        design,
        imageSha256: sha(design),
        recipeDigest: sha(design),
        renderSeconds: 1,
        width: 1920,
        height: 1200,
      }) as NativeEntry,
    decodeNativeImage: (entry: NativeEntry) =>
      native.hold
        ? new Promise(() => undefined)
        : Promise.resolve({ src: `blob:${entry.imageSha256}`, release: () => {}, entry }),
  }
})
vi.mock('./LiveDesignScene', () => ({
  default: ({
    active,
    onReady,
    onLeaveEntry,
    entryImage,
    onProgress,
  }: {
    active: boolean
    onReady: () => void
    onLeaveEntry: () => void
    entryImage?: string
    onProgress?: (progress: { step: 'ready'; fraction: null; refine: { phase: 'idle' } }) => void
  }) => (
    <div data-live-scene data-active={active} data-entry-image={entryImage}>
      <canvas />
      {/* Drawn, with its first trace started: the loading screen is done. */}
      <button
        onClick={() => {
          onReady()
          onProgress?.({ step: 'ready', fraction: null, refine: { phase: 'idle' } })
        }}
      >
        Scene ready
      </button>
      <button onClick={onLeaveEntry}>Camera moved</button>
    </div>
  ),
}))

describe('entering the 360° view on the rendered image (jsdom, scene mocked)', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    )
    native.hold = false
    localStorage.clear()
    window.history.replaceState(null, '', '/?experience=library')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
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
  const figure = () => host.querySelector<HTMLElement>('.prototype-hero')!
  const viewport = () => host.querySelector<HTMLElement>('.live-viewport')!
  /** Lets the mocked delivery finish: each act flushes the promises and the renders they cause. */
  async function imageCurrent() {
    for (let i = 0; i < 20 && figure().dataset.imageState !== 'current-native-library'; i++)
      await act(async () => {})
    expect(figure().dataset.imageState).toBe('current-native-library')
  }
  async function mount() {
    await act(async () =>
      root.render(
        <StrictMode>
          <ImageConfigurator />
        </StrictMode>,
      ),
    )
    if (!native.hold) await imageCurrent()
  }
  const open = () => act(async () => button('Explore in 360°').click())
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))
  /** Open on the current image, with the live view ready under it. */
  async function openCovered() {
    await mount()
    await open()
    click('Scene ready')
    expect(viewport().classList).toContain('is-covered')
  }

  it('keeps the rendered image on the stage until the camera leaves its pose', async () => {
    await mount()
    await open()
    expect(figure().hidden).toBe(false)
    expect(viewport().classList).toContain('is-covered')
    // The loading screen over the image while the view prepares, gone once it can be explored.
    expect(host.querySelector('.live-loading')).not.toBeNull()
    click('Scene ready')
    advance(LIVE_FADE_MS)
    expect(host.querySelector('.live-viewport-loading')).toBeNull()
    expect(host.querySelector('.stage')!.classList).toContain('is-live')
    expect(figure().hidden).toBe(false)
    expect(viewport().className).toBe('live-viewport is-ready is-covered')
    expect(viewport().textContent).toContain('Showing the rendered image · Drag to explore')
    expect(viewport().textContent).not.toContain('Not a saved render')
    // No timer lifts it, and Reset view leaves the camera where it is.
    advance(5000)
    click('Reset view')
    expect(viewport().classList).toContain('is-covered')
    click('Camera moved')
    expect(viewport().className).toBe('live-viewport is-ready is-lifting')
    expect(figure().hidden).toBe(false)
    advance(LIVE_FADE_MS - 1)
    expect(figure().hidden).toBe(false)
    advance(1)
    expect(figure().hidden).toBe(true)
    expect(viewport().className).toBe('live-viewport is-ready')
    expect(viewport().textContent).toContain('Live concept preview · Not a saved render')
    // Once per opening: nothing brings the image back.
    click('Camera moved')
    click('Reset view')
    advance(1000)
    expect(figure().hidden).toBe(true)
  })

  it('hands the scene the image its first trace starts from, only while it is the design’s own', async () => {
    const entryImage = () =>
      host.querySelector<HTMLElement>('[data-live-scene]')!.dataset.entryImage
    await openCovered()
    expect(entryImage()).toMatch(/^blob:/)
    tab('Exterior')
    click('Bronze')
    expect(entryImage()).toBeUndefined()
    // The edited design's own image, at the same camera, once it arrives.
    await imageCurrent()
    expect(entryImage()).toMatch(/^blob:/)
  })

  it('opens without an image to start from while there is none of the design', async () => {
    native.hold = true
    await mount()
    await open()
    expect(host.querySelector<HTMLElement>('[data-live-scene]')!.dataset.entryImage).toBeUndefined()
  })

  it('lifts it as soon as an edit makes it a different design’s image', async () => {
    await openCovered()
    tab('Exterior')
    click('Bronze')
    expect(viewport().classList).toContain('is-lifting')
    expect(figure().hidden).toBe(false)
    advance(LIVE_FADE_MS)
    expect(figure().hidden).toBe(true)
    // The edited design's own image arriving later does not cover the live view again.
    await imageCurrent()
    expect(figure().hidden).toBe(true)
    expect(viewport().className).toBe('live-viewport is-ready')
  })

  it('lifts it for dimensions and for auto-rotation', async () => {
    await openCovered()
    click('Show dimensions')
    expect(viewport().classList).toContain('is-lifting')
    advance(LIVE_FADE_MS)
    click('Show dimensions')
    click('Close the 360° View')
    await open()
    expect(viewport().classList).toContain('is-covered')
    click('Rotate automatically')
    expect(viewport().classList).toContain('is-lifting')
  })

  it('opens without the image while it is not the selected design’s', async () => {
    native.hold = true
    await mount()
    expect(figure().dataset.imageState).toBe('pending')
    await open()
    expect(viewport().className).toBe('live-viewport')
    expect(host.querySelector('.live-viewport-loading')).not.toBeNull()
    click('Scene ready')
    expect(figure().hidden).toBe(true)
  })

  it('opens with dimensions shown as before, without the image', async () => {
    await openCovered()
    click('Show dimensions')
    advance(LIVE_FADE_MS)
    click('Close the 360° View')
    advance(LIVE_FADE_MS)
    await open()
    expect(viewport().className).toBe('live-viewport is-ready')
    expect(figure().hidden).toBe(true)
  })

  it('falls back to the loading veil when lifted before the view has drawn', async () => {
    await mount()
    await open()
    expect(viewport().classList).toContain('is-covered')
    tab('Exterior')
    click('Bronze')
    expect(viewport().className).toBe('live-viewport')
    expect(host.querySelector('.live-viewport-loading')?.textContent).toContain(
      'Preparing your live 360° view…',
    )
    expect(figure().hidden).toBe(false)
    await imageCurrent()
    expect(viewport().className).toBe('live-viewport')
  })

  it('fades the live view off the gallery image when closed', async () => {
    await openCovered()
    click('Camera moved')
    advance(LIVE_FADE_MS)
    click('Close the 360° View')
    expect(button('Explore in 360°')).toBeDefined()
    expect(host.querySelector<HTMLElement>('[data-live-scene]')!.dataset.active).toBe('false')
    expect(figure().hidden).toBe(false)
    expect(viewport().hidden).toBe(false)
    expect(viewport().classList).toContain('is-leaving')
    // The stage keeps its size under the fade: the gallery's status row waits for it to end.
    expect(host.querySelector('.native-image-status-slot')).toBeNull()
    advance(LIVE_FADE_MS)
    expect(viewport().hidden).toBe(true)
    expect(viewport().classList).not.toContain('is-leaving')
    expect(host.querySelector('.native-image-status-slot')).not.toBeNull()
    // Reopening on the same image covers again: each opening starts at its pose.
    await open()
    expect(viewport().hidden).toBe(false)
    expect(viewport().className).toBe('live-viewport is-ready is-covered')
    expect(figure().hidden).toBe(false)
  })

  it('closes over the image itself at once', async () => {
    await openCovered()
    click('Close the 360° View')
    expect(viewport().hidden).toBe(true)
    expect(viewport().classList).not.toContain('is-leaving')
    expect(figure().hidden).toBe(false)
  })

  it('closes at once with no image to return to', async () => {
    native.hold = true
    await mount()
    await open()
    click('Scene ready')
    click('Close the 360° View')
    expect(viewport().hidden).toBe(true)
    expect(host.querySelector('.native-image-status-slot')).not.toBeNull()
  })

  it('keeps the image through the floor plan and back', async () => {
    await openCovered()
    click('Floor plan')
    expect(host.querySelector<HTMLElement>('[data-live-scene]')!.dataset.active).toBe('false')
    click('Exterior')
    expect(host.querySelector<HTMLElement>('[data-live-scene]')!.dataset.active).toBe('true')
    expect(viewport().classList).toContain('is-covered')
    expect(figure().hidden).toBe(false)
  })

  it('cuts instead of fading under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    await openCovered()
    click('Camera moved')
    expect(viewport().className).toBe('live-viewport is-ready')
    expect(figure().hidden).toBe(true)
    click('Close the 360° View')
    expect(viewport().hidden).toBe(true)
    expect(figure().hidden).toBe(false)
    await open()
    click('Show dimensions')
    expect(viewport().className).toBe('live-viewport is-ready')
    expect(figure().hidden).toBe(true)
  })
})
