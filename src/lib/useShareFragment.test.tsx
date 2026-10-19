// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAGMENT_INTERVAL_MS, useShareFragment } from './useShareFragment'

const opened = vi.fn((value: string) => value !== 'broken')
function Probe({ encoded }: { encoded: string }) {
  useShareFragment(encoded, opened)
  return null
}

describe('share fragment in the address bar', () => {
  let root: Root
  let replace: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    replace = vi.spyOn(window.history, 'replaceState')
    opened.mockClear()
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    replace.mockRestore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const render = (encoded: string) => act(() => root.render(<Probe encoded={encoded} />))
  const written = () => replace.mock.calls.map((call: unknown[]) => String(call[2]).split('#c=')[1])

  it('writes the first design at once, then at most twice a second, ending on the latest', () => {
    render('a')
    expect(written()).toEqual(['a'])
    for (const value of ['b', 'c', 'd', 'e']) render(value)
    expect(written()).toEqual(['a'])
    act(() => vi.advanceTimersByTime(FRAGMENT_INTERVAL_MS))
    expect(written()).toEqual(['a', 'e'])
  })

  it('flushes a pending design when the page is hidden', () => {
    render('a')
    render('b')
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(written()).toEqual(['a', 'b'])
    act(() => vi.advanceTimersByTime(FRAGMENT_INTERVAL_MS))
    expect(written()).toEqual(['a', 'b'])
  })

  it('opens a design the user navigates to, but not other fragments', () => {
    render('a')
    act(() => {
      window.location.hash = '#configuration'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(opened).not.toHaveBeenCalled()
    act(() => {
      window.location.hash = '#c=shared'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(opened).toHaveBeenCalledWith('shared')
  })

  it("reads the encoding's + signs as written, so the current design never reopens itself", () => {
    render('x+y')
    act(() => {
      window.location.hash = '#c=x+y'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(opened).not.toHaveBeenCalled()
    act(() => {
      window.location.hash = '#c=p+q'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(opened).toHaveBeenCalledWith('p+q')
  })

  it('puts the design on screen back in the address bar when a link cannot be opened', () => {
    render('a')
    act(() => {
      window.location.hash = '#c=broken'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(opened).toHaveBeenCalledWith('broken')
    expect(written()).toEqual(['a', 'a'])
  })

  it('writes a pending design when the app unmounts', () => {
    render('a')
    render('b')
    act(() => root.unmount())
    expect(written()).toEqual(['a', 'b'])
    root = createRoot(document.createElement('div'))
  })

  it('never throws when the browser rate-limits history updates', () => {
    replace.mockImplementation(() => {
      throw new DOMException('Attempt to use history.replaceState() more than 100 times')
    })
    expect(() => render('a')).not.toThrow()
    expect(() => act(() => vi.advanceTimersByTime(FRAGMENT_INTERVAL_MS))).not.toThrow()
  })
})
