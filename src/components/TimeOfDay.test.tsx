// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeOfDay } from './TimeOfDay'

describe('lighting gestures', () => {
  let host: HTMLDivElement
  let root: Root
  const change = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    change.mockClear()
    act(() => root.render(<TimeOfDay time={16.5} label="Light" onChange={change} />))
    input().setPointerCapture = vi.fn()
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })
  const input = () => host.querySelector('input')!
  const event = (type: string, key?: string) =>
    act(() =>
      input().dispatchEvent(
        key ? new KeyboardEvent(type, { bubbles: true, key }) : new Event(type, { bubbles: true }),
      ),
    )
  const slide = (value: number) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input(),
        String(value),
      )
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })

  it('updates the clock immediately but commits one change per pointer drag', () => {
    event('pointerdown')
    slide(18)
    slide(19)
    expect(input().getAttribute('aria-valuetext')).toBe('19:00')
    expect(change).not.toHaveBeenCalled()
    event('pointerup')
    expect(change).toHaveBeenCalledExactlyOnceWith(19)
    event('focusout')
    expect(change).toHaveBeenCalledTimes(1)
  })
  it('groups repeated keyboard steps until keyup', () => {
    event('keydown', 'ArrowRight')
    slide(17)
    event('keydown', 'ArrowRight')
    slide(17.5)
    expect(change).not.toHaveBeenCalled()
    event('keyup', 'ArrowRight')
    expect(change).toHaveBeenCalledExactlyOnceWith(17.5)
  })
  it('cancels an interrupted pointer gesture and accepts direct assistive input', () => {
    event('pointerdown')
    slide(19)
    event('pointercancel')
    expect(input().value).toBe('16.5')
    expect(change).not.toHaveBeenCalled()
    slide(18)
    expect(change).toHaveBeenCalledExactlyOnceWith(18)
  })
  it('does not commit a gesture returned to its original value', () => {
    event('pointerdown')
    slide(18)
    slide(16.5)
    event('pointerup')
    expect(change).not.toHaveBeenCalled()
  })
})
