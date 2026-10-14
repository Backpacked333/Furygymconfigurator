// @vitest-environment jsdom
import { act, lazy, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneBoundary, SceneLoading } from './SceneBoundary'

describe('LOAD-05 Scene chunk containment', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('contains rejected lazy imports outside the lazy subtree and permits plan/retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Scene = lazy(async () => {
      throw new Error('offline chunk')
    })
    const onRetry = vi.fn(),
      onPlan = vi.fn(),
      onFailure = vi.fn()
    await act(async () => {
      root.render(
        <>
          <input defaultValue="preserved project" />
          <SceneBoundary {...{ onRetry, onPlan, onFailure }} attempts={0}>
            <Suspense fallback={<SceneLoading onPlan={onPlan} />}>
              <Scene />
            </Suspense>
          </SceneBoundary>
        </>,
      )
    })
    expect(host.querySelector('input')?.value).toBe('preserved project')
    expect(host.textContent).toContain('Your design has not been reset')
    expect(onFailure).toHaveBeenCalledOnce()
    act(() => host.querySelector<HTMLButtonElement>('.secondary')!.click())
    act(() => host.querySelector<HTMLButtonElement>('.primary')!.click())
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onPlan).toHaveBeenCalledOnce()
  })

  it('keeps the plan route available even when a chunk never settles', () => {
    vi.useFakeTimers()
    const onPlan = vi.fn()
    act(() => root.render(<SceneLoading onPlan={onPlan} />))
    act(() => vi.advanceTimersByTime(12_000))
    expect(host.textContent).toContain('longer than expected')
    act(() => host.querySelector('button')!.click())
    expect(onPlan).toHaveBeenCalledOnce()
  })
})
