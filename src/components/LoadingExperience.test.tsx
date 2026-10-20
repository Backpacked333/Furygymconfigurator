// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildAnimation, WorkProgress } from './LoadingExperience'
import { SceneLoading } from './SceneLoading'

describe('shared loading surfaces', () => {
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
    vi.restoreAllMocks()
  })
  it('stops the animation in a hidden browser tab and resumes when visible', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    act(() => root.render(<BuildAnimation />))
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(container.querySelector('iframe')?.tabIndex).toBe(-1)
    hidden.mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.querySelector('iframe')).toBeNull()
    hidden.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
  })
  it.each(['engine', 'renderer', 'shaders'] as const)(
    'shows an observed %s startup stage, not a fake percentage',
    (phase) => {
      act(() => root.render(<SceneLoading phase={phase} />))
      expect(container.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(
        false,
      )
      expect(container.querySelector('iframe')?.src).toContain('no-excuses.html')
      expect(container.querySelector('.loading-steps .is-active')).not.toBeNull()
    },
  )
  it('removes the startup illustration only when the scene has drawn', () => {
    act(() => root.render(<SceneLoading phase="ready" />))
    expect(container.innerHTML).toBe('')
  })
  it.each([undefined, NaN, Infinity])('leaves unknown progress indeterminate (%s)', (fraction) => {
    act(() => root.render(<WorkProgress label="Waiting" fraction={fraction} />))
    expect(container.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false)
  })
})
