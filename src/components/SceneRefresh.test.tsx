// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import { SceneRefresh } from './SceneRefresh'

const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }))
vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: { invalidate: () => void }) => unknown) => selector({ invalidate }),
}))

describe('on-demand scene redraw', () => {
  let container: HTMLDivElement
  let root: Root
  let props: ComponentProps<typeof SceneRefresh>

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    invalidate.mockClear()
    container = document.createElement('div')
    root = createRoot(container)
    props = {
      config: structuredClone(DEFAULT_CONFIG),
      view: 'exterior',
      dimensions: true,
      unit: 'ft',
      quality: 'high',
      autoRotate: false,
    }
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
    invalidate.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })

  it.each(['mirror', 'lights'] as const)('redraws when %s is removed', (option) => {
    props.config = { ...props.config, [option]: false }
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('redraws after all equipment is removed', () => {
    props.config = { ...props.config, items: [] }
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it.each([
    { dimensions: false },
    { unit: 'm' },
    { view: 'interior' },
    { quality: 'lite' },
    { autoRotate: true },
  ] as const)('redraws after display options change: %o', (change) => {
    act(() => root.render(<SceneRefresh {...props} {...change} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not continuously redraw unchanged configurations', () => {
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).not.toHaveBeenCalled()
  })
})
