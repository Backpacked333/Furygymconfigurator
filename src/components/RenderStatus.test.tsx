// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DONE_MS, PILL_DELAY_MS, RenderStatus } from './RenderStatus'

describe('the render status', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as never
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  const show = (pending: boolean, swaps: number) =>
    act(() =>
      root.render(
        <RenderStatus
          pending={pending}
          swaps={swaps}
          what="Graphite"
          progress={{ kind: 'estimate', startedAt: performance.now(), expectedMs: 4000 }}
        />,
      ),
    )
  const pill = () => container.querySelector('.render-pill') as HTMLElement
  const said = () => container.querySelector('[role=status]')!.textContent

  it('stays out of sight for a still that comes at once', () => {
    show(true, 0)
    act(() => vi.advanceTimersByTime(PILL_DELAY_MS - 50))
    show(false, 1)
    expect(pill().dataset.phase).toBe('hidden')
    expect(said()).toBe('')
  })

  it('says what is rendering and about how long, then that it is updated', () => {
    show(true, 0)
    act(() => vi.advanceTimersByTime(PILL_DELAY_MS))
    expect(pill().dataset.phase).toBe('rendering')
    expect(pill().textContent).toMatch(/^Rendering Graphite · about \d s$/)
    expect(said()).toBe('Rendering Graphite')
    show(false, 1)
    expect(pill().dataset.phase).toBe('done')
    expect(pill().textContent).toBe('Updated')
    expect(said()).toBe('Updated')
    act(() => vi.advanceTimersByTime(DONE_MS))
    expect(pill().dataset.phase).toBe('hidden')
  })

  it('never says updated when no still came', () => {
    show(true, 2)
    act(() => vi.advanceTimersByTime(PILL_DELAY_MS))
    show(false, 2)
    expect(pill().dataset.phase).toBe('hidden')
  })
})
