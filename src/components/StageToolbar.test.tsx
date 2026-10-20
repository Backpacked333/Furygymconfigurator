// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../lib/config'
import { StageToolbar } from './StageToolbar'

describe('the stage toolbar', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const handlers = () => ({
    onChange: vi.fn<(config: Config) => void>(),
    onMoreSettings: vi.fn(),
    onToggleLive: vi.fn(),
    onDimensions: vi.fn(),
    onAutoRotate: vi.fn(),
    onReset: vi.fn(),
    onDownload: vi.fn(),
    onFullscreen: vi.fn(),
  })
  const show = (live: boolean, on = handlers(), fullscreen: boolean | null = false) => {
    act(() =>
      root.render(
        <StageToolbar
          live={live}
          interior={false}
          config={DEFAULT_CONFIG}
          dimensions={false}
          autoRotate={false}
          downloading={false}
          fullscreen={fullscreen}
          {...on}
        />,
      ),
    )
    return on
  }
  const labels = () =>
    [...container.querySelectorAll('.stage-toolbar button')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent!.trim(),
    )
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent!.trim()) === label,
    )!
  const click = (element: HTMLElement) => act(() => element.click())

  it('offers Adjust scene, the 360° View, Download and Full screen over a still', () => {
    show(false)
    expect(labels()).toEqual(['Adjust scene', '360° View', 'Download image', 'Full screen'])
    expect(button('360° View').getAttribute('aria-pressed')).toBe('false')
  })

  it("adds the live view's tools in the 360° View, which it then closes", () => {
    const on = show(true)
    expect(labels()).toEqual([
      'Adjust scene',
      'Close the 360° View',
      'Show dimensions',
      'Reset view',
      'Rotate automatically',
      'Download image',
      'Full screen',
    ])
    expect(button('Close the 360° View').getAttribute('aria-pressed')).toBe('true')
    click(button('Close the 360° View'))
    click(button('Reset view'))
    click(button('Download image'))
    expect(on.onToggleLive).toHaveBeenCalledOnce()
    expect(on.onReset).toHaveBeenCalledOnce()
    expect(on.onDownload).toHaveBeenCalledOnce()
  })

  it('leaves out Full screen where the browser cannot show it', () => {
    show(false, handlers(), null)
    expect(labels()).not.toContain('Full screen')
  })

  it('opens the setting and time of day, and closes on Escape with the focus back', () => {
    const on = show(false)
    const adjust = button('Adjust scene')
    click(adjust)
    const dialog = document.querySelector('[role=dialog][aria-label="Adjust scene"]')!
    expect(dialog).not.toBeNull()
    expect(adjust.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.textContent).toContain('Residential courtyard')
    expect(dialog.querySelectorAll('.scene-settings button')).toHaveLength(4)
    expect(dialog.querySelector('input[type="range"]')).toBeNull()
    click(button('Desert retreat'))
    expect(on.onChange).toHaveBeenCalledWith({ ...DEFAULT_CONFIG, environment: 'desert' })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(document.activeElement).toBe(adjust)
  })

  it('closes the popover when the focus moves on past it', () => {
    show(false)
    click(button('Adjust scene'))
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    act(() => button('Download image').focus())
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
})
