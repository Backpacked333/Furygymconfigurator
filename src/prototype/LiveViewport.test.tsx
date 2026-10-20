// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign } from '../domain/design'
import type { ViewerStatus } from '../viewer/ProgressiveRenderer'
import { LIVE_FADE_MS, LiveViewport } from './LiveViewport'

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
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
    vi.unstubAllGlobals()
  })

  it('keeps the loading veil and the disclaimer with no image under it, as before', async () => {
    await render()
    expect(viewport().className).toBe('live-viewport')
    expect(host.querySelector('.live-viewport-loading')?.textContent).toContain(
      'Preparing your live 360° view…',
    )
    expect(host.textContent).toContain('Live concept preview · Not a saved render')
    click('Scene ready')
    click('Scene interactive')
    expect(host.querySelector('.live-viewport-loading')).toBeNull()
    expect(status()).toBe('Drag to explore · Scroll to zoom')
  })

  it('draws over the rendered image with a compact status and no veil or disclaimer', async () => {
    await render({ curtain: 'still' })
    expect(viewport().classList).toContain('is-covered')
    expect(viewport().hidden).toBe(false)
    expect(host.querySelector('.live-viewport-loading')).toBeNull()
    expect(status()).toBe('Preparing your live 360° view…')
    expect(host.textContent).not.toContain('Not a saved render')
    click('Scene ready')
    click('Scene interactive')
    expect(viewport().className).toBe('live-viewport is-ready is-covered')
    expect(status()).toBe('Showing the rendered image · Drag to explore')
    expect(host.textContent).not.toContain('Not a saved render')
  })

  it('fades the live view in over the image once it lifts, saying what is shown', async () => {
    await render({ curtain: 'still' })
    click('Scene ready')
    click('Scene interactive')
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
