// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageToolbarView, type StageToolbarViewProps } from './StageToolbarView'

describe('renderer-free toolbar slots and accessibility', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    Reflect.deleteProperty(document, 'fullscreenElement')
    Reflect.deleteProperty(document, 'exitFullscreen')
    vi.unstubAllGlobals()
  })
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find(
      (item) => (item.getAttribute('aria-label') ?? item.textContent) === label,
    )!
  const show = (extra: Partial<StageToolbarViewProps> = {}) => {
    const props: StageToolbarViewProps = {
      live: false,
      interior: false,
      settings: (
        <>
          <div className="section-label">Setting</div>
          <button aria-pressed="true">Draft courtyard</button>
        </>
      ),
      onMoreSettings: vi.fn(),
      onToggleLive: vi.fn(),
      onDownload: vi.fn(),
      fullscreen: null,
      onFullscreen: vi.fn(),
      ...extra,
    }
    act(() => root.render(<StageToolbarView {...props} />))
    return props
  }
  it('keeps default v3 button labels and hides unsupported fullscreen', () => {
    show()
    expect(
      [...host.querySelectorAll('.stage-toolbar button')].map(
        (item) => item.getAttribute('aria-label') ?? item.textContent,
      ),
    ).toEqual(['Adjust scene', '360° View', 'Download image'])
  })
  it('signals intent to open the 360° view on pointer or focus, and not once it is open', () => {
    const onLiveIntent = vi.fn()
    show({ onLiveIntent })
    const live = button('360° View')
    act(() => live.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    expect(onLiveIntent).toHaveBeenCalledTimes(1)
    act(() => live.focus())
    expect(onLiveIntent).toHaveBeenCalledTimes(2)
    act(() => live.blur())
    show({ onLiveIntent, live: true })
    act(() => button('Close the 360° View').focus())
    expect(onLiveIntent).toHaveBeenCalledTimes(2)
  })
  it('keeps the scene trigger named when responsive styling hides its visible label', () => {
    show()
    const trigger = host.querySelector<HTMLButtonElement>('.stage-toolbar > button')!
    const label = trigger.querySelector('span')!
    label.style.display = 'none'
    expect(getComputedStyle(label).display).toBe('none')
    expect(trigger.getAttribute('aria-label')).toBe('Adjust scene')
    expect(trigger.getAttribute('title')).toBe('Adjust scene')
    act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-label')).toBe('Adjust scene')
  })
  it('focuses the chosen setting, closes on Escape and cleans up adapter activation', () => {
    const leave = vi.fn(),
      activate = vi.fn(() => leave)
    show({ onSettingsOpen: activate })
    const trigger = button('Adjust scene')
    act(() => trigger.click())
    expect(document.activeElement).toBe(button('Draft courtyard'))
    expect(activate).toHaveBeenCalledOnce()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(leave).toHaveBeenCalledOnce()
  })
  it('keeps the popover within fullscreen and wires exit without rendering dependencies', () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: host })
    const props = show({ fullscreen: true })
    act(() => button('Adjust scene').click())
    expect(host.querySelector('[role="dialog"][aria-label="Adjust scene"]')).not.toBeNull()
    expect(button('Exit full screen').getAttribute('aria-pressed')).toBe('true')
    act(() => {
      button('Exit full screen').dispatchEvent(new Event('pointerdown', { bubbles: true }))
      button('Exit full screen').click()
    })
    expect(props.onFullscreen).toHaveBeenCalledOnce()
    expect(document.querySelector('[aria-label="Adjust scene"][role="dialog"]')).toBeNull()
  })
  it('exits fullscreen before handing focus to settings outside the stage', async () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: host })
    let finishExit!: () => void
    const exit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishExit = resolve
        }),
    )
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    const props = show({ fullscreen: true })
    act(() => button('Adjust scene').click())
    act(() => button('All setting options ').click())
    expect(exit).toHaveBeenCalledOnce()
    expect(props.onMoreSettings).not.toHaveBeenCalled()
    await act(async () => finishExit())
    expect(props.onMoreSettings).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(button('Adjust scene'))
    expect(button('Adjust scene').getAttribute('aria-expanded')).toBe('false')
  })
  it('keeps fullscreen exit failure visible inside the popover without losing keyboard focus', async () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: host })
    const exit = vi.fn().mockRejectedValue(new Error('Fullscreen exit denied'))
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    const props = show({ fullscreen: true })
    act(() => button('Adjust scene').click())
    const more = button('All setting options ')
    await act(async () => {
      more.focus()
      more.click()
    })
    expect(props.onMoreSettings).not.toHaveBeenCalled()
    expect(host.querySelector('.scene-popover [role="status"]')?.textContent).toContain(
      'Exit full screen to open all setting options',
    )
    expect(document.activeElement).toBe(more)
    expect(button('Adjust scene').getAttribute('aria-expanded')).toBe('true')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.activeElement).toBe(button('Adjust scene'))
  })
  it('exposes disabled reasons without no-op clicks and opens all setting options', () => {
    const props = show({
      liveDisabledReason: 'No approved live renderer.',
      downloadLabel: 'Download mock diagnostic',
      downloadDisabledReason: 'Previous diagnostic is not selected.',
    })
    for (const [label, reason] of [
      ['360° View', 'No approved live renderer.'],
      ['Download mock diagnostic', 'Previous diagnostic is not selected.'],
    ]) {
      const control = button(label)
      expect(control.disabled).toBe(true)
      expect(document.getElementById(control.getAttribute('aria-describedby')!)?.textContent).toBe(
        reason,
      )
      act(() => control.click())
    }
    expect(props.onDownload).not.toHaveBeenCalled()
    expect(props.onToggleLive).not.toHaveBeenCalled()
    act(() => button('Adjust scene').click())
    act(() => button('All setting options ').click())
    expect(props.onMoreSettings).toHaveBeenCalledOnce()
    expect(button('Adjust scene').getAttribute('aria-expanded')).toBe('false')
  })
})
