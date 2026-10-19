// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import { DONE_MS, LONG_WAIT_MS, PILL_DELAY_MS, RenderStatus } from './RenderStatus'

describe('the honest render status', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  const show = (props: Partial<ComponentProps<typeof RenderStatus>> = {}) =>
    act(() =>
      root.render(
        <RenderStatus
          pending
          swaps={0}
          what="Graphite"
          config={DEFAULT_CONFIG}
          progress={{ kind: 'stage', stage: 'requesting' }}
          {...props}
        />,
      ),
    )
  const tick = (time = PILL_DELAY_MS) => act(() => vi.advanceTimersByTime(time))
  const bar = () => container.querySelector('[role=progressbar]')!

  it('mounts no animation or waiting message for an instant cached swap', () => {
    show()
    tick(PILL_DELAY_MS - 50)
    show({ pending: false, swaps: 1 })
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[role=status]')?.textContent).toBe('')
  })

  it('never invents a cloud percentage or countdown, however long the request takes', () => {
    show({ newCombination: true })
    tick()
    expect(container.textContent).toContain('You’ve got taste.')
    expect(container.textContent).not.toContain('haven’t seen')
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(container.querySelector('iframe')?.src).toContain('interactive=0')
    expect(bar().hasAttribute('aria-valuenow')).toBe(false)
    tick(120_000)
    expect(bar().hasAttribute('aria-valuenow')).toBe(false)
    expect(container.textContent).not.toContain('almost there')
    expect(container.textContent).toContain('taking longer than usual')
  })

  it('shows measured samples, then finishing and decoding without claiming completion', () => {
    show({ progress: { kind: 'measured', fraction: 0.37, remainingMs: 1000 } })
    tick()
    expect(bar().getAttribute('aria-valuenow')).toBe('37')
    tick(5000)
    expect(bar().getAttribute('aria-valuenow')).toBe('37')
    show({ progress: { kind: 'measured', fraction: 1, remainingMs: 0 } })
    expect(bar().getAttribute('aria-label')).toBe('Finishing your rendered image')
    expect(bar().hasAttribute('aria-valuenow')).toBe(false)
    show({ decoding: true })
    expect(bar().getAttribute('aria-label')).toBe('Preparing your image for display')
    show({ pending: false, swaps: 1 })
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[role=status]')?.textContent).toBe('Your view is ready')
    tick(DONE_MS)
    expect(container.querySelector('[role=status]')?.textContent).toBe('')
  })

  it('labels upload progress as assets rather than overall render completion', () => {
    show({ progress: { kind: 'stage', stage: 'uploading', completed: 3, total: 4 } })
    tick()
    expect(bar().getAttribute('aria-valuenow')).toBe('75')
    expect(bar().getAttribute('aria-label')).toContain('Sending scene assets')
    show({ progress: { kind: 'stage', stage: 'requesting' } })
    expect(bar().hasAttribute('aria-valuenow')).toBe(false)
  })

  it('resets the delay and measured progress when the visitor changes designs during a wait', () => {
    show({ requestKey: 'a', progress: { kind: 'measured', fraction: 0.9, remainingMs: null } })
    tick()
    show({ requestKey: 'b', progress: { kind: 'measured', fraction: 0.1, remainingMs: null } })
    expect(container.querySelector('iframe')).toBeNull()
    tick()
    expect(bar().getAttribute('aria-valuenow')).toBe('10')
  })

  it('offers recovery on failure and on a long wait, never a false success', () => {
    const onRetry = vi.fn()
    const onPlan = vi.fn()
    show({ unavailable: true, onRetry, onPlan })
    tick()
    const buttons = container.querySelectorAll('button')
    act(() => buttons[0].click())
    act(() => buttons[1].click())
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onPlan).toHaveBeenCalledOnce()
    show({ pending: false })
    expect(container.querySelector('[role=status]')?.textContent).toBe('')
    show({ onRetry, onPlan })
    tick(LONG_WAIT_MS)
    expect(container.querySelectorAll('button')).toHaveLength(2)
  })
})
