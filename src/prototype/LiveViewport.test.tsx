// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign } from '../domain/design'
import {
  liveLoading,
  refineProgress,
  sceneProgress,
  textureProgress,
  traceProgress,
} from '../render/progress'
import type { ViewerStatus } from '../viewer/ProgressiveRenderer'
import { LIVE_FADE_MS, LiveViewport, REFINED_SHOWN_MS } from './LiveViewport'

const scene = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
vi.mock('./LiveDesignScene', () => ({
  default: (props: {
    onReady: () => void
    onStatus: (status: ViewerStatus) => void
    onUnavailable: () => void
    onLeaveEntry?: () => void
  }) => {
    scene.props = props
    return (
      <div>
        <canvas />
        <button onClick={props.onReady}>Scene ready</button>
        <button onClick={() => props.onStatus('interactive')}>Scene interactive</button>
        <button onClick={props.onUnavailable}>Scene unavailable</button>
        <button onClick={props.onLeaveEntry}>Camera moved</button>
        <button onClick={() => liveLoading.set('materials')}>Scene mounted</button>
        <button onClick={() => liveLoading.set('tracer')}>Scans in</button>
        <button onClick={() => liveLoading.set('ready')}>Trace started</button>
      </div>
    )
  },
}))

describe('live viewport over the gallery image (jsdom, scene mocked)', () => {
  let host: HTMLDivElement, root: Root
  let props: ComponentProps<typeof LiveViewport>
  const render = async (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch }
    await act(async () => root.render(<LiveViewport {...props} />))
  }
  const viewport = () => host.querySelector<HTMLElement>('.live-viewport')!
  const status = () =>
    [...host.querySelectorAll('[role=status]')].map((item) => item.textContent).join(' | ')
  const click = (text: string) =>
    act(() =>
      [...host.querySelectorAll('button')].find((item) => item.textContent === text)!.click(),
    )
  /** The view draws, its first trace starts, and the loading screen has faded out. */
  const opened = () => {
    click('Scene ready')
    click('Scene interactive')
    click('Trace started')
    act(() => vi.advanceTimersByTime(LIVE_FADE_MS))
  }
  const steps = () =>
    [...host.querySelectorAll('.live-loading-steps li')].map(
      (item) => `${item.className || 'pending'}:${item.textContent}`,
    )
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    sceneProgress.set('engine')
    traceProgress.set({ phase: 'idle' })
    scene.props = null
    props = {
      design: defaultDesign(),
      active: true,
      unit: 'ft',
      dimensions: false,
      autoRotate: false,
      reset: 0,
      curtain: null,
      leaving: false,
      onReadyChange: vi.fn(),
      onLeaveEntry: vi.fn(),
    }
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

  it('keeps the loading veil and the disclaimer with no image under it, as before', async () => {
    await render()
    expect(viewport().className).toBe('live-viewport')
    expect(host.querySelector('.live-viewport-loading')?.textContent).toContain(
      'Preparing your live 360° view…',
    )
    expect(host.textContent).toContain('Live concept preview · Not a saved render')
    opened()
    expect(host.querySelector('.live-viewport-loading')).toBeNull()
    expect(status()).toBe('Drag to explore · Scroll to zoom')
  })

  it('shows each loading step as it happens, until the first trace has started', async () => {
    await render({ curtain: 'still' })
    expect(steps()).toEqual([
      'is-active:Loading the 3D engine',
      'pending:Building the scene',
      'pending:Preparing materials and light',
      'pending:Starting the path tracer',
    ])
    expect(host.querySelector('.live-loading .sr-only')?.textContent).toBe('Loading the 3D engine')
    // The renderer is up and the scene is mounting.
    act(() => sceneProgress.set('shaders'))
    expect(steps()[1]).toBe('is-active:Building the scene')
    click('Scene mounted')
    expect(steps().slice(0, 3)).toEqual([
      'is-done:Loading the 3D engine',
      'is-done:Building the scene',
      'is-active:Preparing materials and light',
    ])
    // Scans arriving fill the bar: only those asked for since this view opened count.
    expect(host.querySelector('.live-loading-bar')?.classList).toContain('is-waiting')
    act(() => textureProgress.update(4, 0))
    act(() => textureProgress.update(0, 1))
    expect(host.querySelector<HTMLElement>('.live-loading-bar i')!.style.transform).toBe(
      'scaleX(0.25)',
    )
    click('Scans in')
    expect(steps()[3]).toBe('is-active:Starting the path tracer')
    // Drawn, but the tracer's first start (its longest task) is still to come: the screen stays.
    click('Scene ready')
    click('Scene interactive')
    expect(host.querySelector('.live-loading')).not.toBeNull()
    expect(status()).not.toContain('Showing the rendered image')
    click('Trace started')
    expect(host.querySelector('.live-loading')?.classList).toContain('is-done')
    expect(host.querySelector('.live-loading .sr-only')?.textContent).toBe('Ready')
    act(() => vi.advanceTimersByTime(LIVE_FADE_MS))
    expect(host.querySelector('.live-loading')).toBeNull()
    expect(status()).toBe('Showing the rendered image · Drag to explore')
  })

  it('shows a resting view refining in a pill, naming what is resolving, then fades it', async () => {
    const pill = () => host.querySelector<HTMLElement>('.live-refine')!
    const shown = () => pill().classList.contains('is-shown')
    await render()
    opened()
    expect(shown()).toBe(false)
    act(() => traceProgress.set(refineProgress(4, 1024, false)))
    expect(shown()).toBe(true)
    expect(pill().textContent).toBe('Refining · Light')
    expect(pill().getAttribute('aria-valuenow')).toBe(
      String(Math.round((Math.log2(5) / Math.log2(1025)) * 100)),
    )
    act(() => traceProgress.set(refineProgress(32, 1024, false)))
    expect(pill().textContent).toBe('Refining · Reflections')
    act(() => traceProgress.set(refineProgress(256, 1024, false)))
    expect(pill().textContent).toBe('Refining · Fine detail')
    // The camera moves: gone at once.
    act(() => traceProgress.set({ phase: 'idle' }))
    expect(shown()).toBe(false)
    act(() => traceProgress.set(refineProgress(1024, 1024, true)))
    expect(shown()).toBe(true)
    expect(pill().className).toContain('is-done')
    expect(pill().textContent).toBe('Fully refined')
    expect(pill().getAttribute('aria-valuenow')).toBe('100')
    act(() => vi.advanceTimersByTime(REFINED_SHOWN_MS - 1))
    expect(shown()).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(shown()).toBe(false)
    // The next rest shows it again.
    act(() => traceProgress.set(refineProgress(2, 1024, false)))
    expect(shown()).toBe(true)
  })

  it('never shows the pill over the rendered image or the loading screen', async () => {
    await render({ curtain: 'still' })
    act(() => traceProgress.set(refineProgress(8, 1024, false)))
    expect(host.querySelector('.live-refine')!.classList).not.toContain('is-shown')
    opened()
    expect(host.querySelector('.live-refine')!.classList).not.toContain('is-shown')
    await render({ curtain: null })
    expect(host.querySelector('.live-refine')!.classList).toContain('is-shown')
  })

  it('starts the steps over for a new view', async () => {
    act(() => liveLoading.set('ready'))
    await render()
    expect(steps()[0]).toBe('is-active:Loading the 3D engine')
  })

  it('draws over the rendered image with a compact status and no disclaimer', async () => {
    await render({ curtain: 'still' })
    expect(viewport().classList).toContain('is-covered')
    expect(viewport().hidden).toBe(false)
    // The loading screen, over the image, until the view can be explored.
    expect(host.querySelector('.live-loading')?.textContent).toContain(
      'Preparing your live 360° view…',
    )
    expect(host.textContent).not.toContain('Not a saved render')
    opened()
    expect(host.querySelector('.live-viewport-loading')).toBeNull()
    expect(viewport().className).toBe('live-viewport is-ready is-covered')
    expect(status()).toBe('Showing the rendered image · Drag to explore')
    expect(host.textContent).not.toContain('Not a saved render')
  })

  it('fades the live view in over the image once it lifts, saying what is shown', async () => {
    await render({ curtain: 'still' })
    opened()
    await render({ curtain: 'lifting' })
    expect(viewport().className).toBe('live-viewport is-ready is-lifting')
    expect(status()).toBe('Drag to explore · Scroll to zoom')
    expect(host.textContent).toContain('Live concept preview · Not a saved render')
    await render({ curtain: null })
    expect(viewport().className).toBe('live-viewport is-ready')
  })

  it('reports a failure over the image instead of covering it', async () => {
    await render({ curtain: 'still' })
    click('Scene unavailable')
    expect(viewport().classList).not.toContain('is-covered')
    expect(host.querySelector('.live-viewport-loading')?.textContent).toContain(
      'Live 3D is unavailable on this device.',
    )
    expect(props.onReadyChange).toHaveBeenLastCalledWith(false)
  })

  it('stays up, inactive, while its last frame fades off the gallery', async () => {
    await render()
    click('Scene ready')
    await render({ active: false, leaving: true })
    expect(viewport().hidden).toBe(false)
    expect(viewport().classList).toContain('is-leaving')
    expect(scene.props?.active).toBe(false)
    await render({ leaving: false })
    expect(viewport().hidden).toBe(true)
    expect(viewport().classList).not.toContain('is-leaving')
  })

  it('passes the scene its entry report but none of the gallery curtain', async () => {
    await render({ curtain: 'still', leaving: true })
    expect(Object.keys(scene.props!)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(curtain|leaving|onReadyChange)$/)]),
    )
    click('Camera moved')
    expect(props.onLeaveEntry).toHaveBeenCalledTimes(1)
  })
})

describe('live viewport crossfade styles', () => {
  const css = readFileSync('src/prototype/prototype.css', 'utf8')
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }
  it('hides the covered canvas by opacity alone, so it keeps focus, keys and pointer input', () => {
    const covered = rule('.live-viewport.is-covered canvas')
    expect(covered).toContain('opacity: 0;')
    expect(covered).not.toMatch(/visibility|display|pointer-events/)
    // And no other rule hides the covered canvas some other way.
    expect(css.match(/is-covered canvas/g)).toHaveLength(1)
  })
  it('keeps the scene loading and update notices off the image', () => {
    expect(css).toMatch(
      /\.live-viewport\.is-covered \.scene-loading,\s*\.live-viewport\.is-covered \.scene-activity,\s*\.live-viewport\.is-lifting \.scene-loading \{\s*display: none;/,
    )
    // A renderer that cannot start still says so legibly over the image.
    expect(rule('.live-viewport.is-covered .graphics-fallback')).toContain('background:')
  })
  it('fades either way over LIVE_FADE_MS', () => {
    expect(rule('.live-viewport.is-lifting canvas')).toContain(`still-in ${LIVE_FADE_MS}ms`)
    expect(rule('.live-viewport.is-leaving')).toContain(`still-out ${LIVE_FADE_MS}ms`)
  })
})
