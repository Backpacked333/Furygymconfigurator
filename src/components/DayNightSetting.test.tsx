// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DayNightSetting } from './DayNightSetting'

it('exposes only Day/Night and never mutates restored time before an explicit selection', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'),
    root = createRoot(host),
    change = vi.fn()
  try {
    act(() => root.render(<DayNightSetting time={20.5} label="Lighting" onChange={change} />))
    expect(host.querySelector('input[type=range]')).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(2)
    expect(host.querySelector('[aria-pressed=true]')?.textContent).toContain('Night')
    expect(change).not.toHaveBeenCalled()
    act(() => host.querySelectorAll('button')[0].click())
    expect(change).toHaveBeenCalledWith(12)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
