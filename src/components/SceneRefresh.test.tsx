// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, setFamily } from '../lib/config'
import { SceneRefresh } from './SceneRefresh'

const { invalidate, scene } = vi.hoisted(() => ({ invalidate: vi.fn(), scene: {} }))
vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: { invalidate: () => void; scene: object }) => unknown) =>
    selector({ invalidate, scene }),
}))
const { invalidateShadows } = vi.hoisted(() => ({ invalidateShadows: vi.fn() }))
vi.mock('@fury/viewer360/3d', () => ({ invalidateShadows }))

describe('on-demand scene redraw', () => {
  let container: HTMLDivElement
  let root: Root
  let props: ComponentProps<typeof SceneRefresh>

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    invalidate.mockClear()
    invalidateShadows.mockClear()
    container = document.createElement('div')
    root = createRoot(container)
    props = {
      active: true,
      config: structuredClone(DEFAULT_CONFIG),
      view: 'exterior',
      dimensions: true,
      unit: 'ft',
      quality: 'high',
      autoRotate: false,
    }
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidateShadows).toHaveBeenCalledTimes(1)
    invalidate.mockClear()
    invalidateShadows.mockClear()
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

  it('redraws after the equipment package changes', () => {
    props.config = { ...props.config, package: 'empty' }
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('redraws after switching product families', () => {
    props.config = setFamily(props.config, 'container')
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('redraws after a Container opening changes', () => {
    props.config = setFamily(props.config, 'container')
    act(() => root.render(<SceneRefresh {...props} />))
    invalidate.mockClear()
    props.config = { ...props.config, containerOpening: 'full' }
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it.each([
    { dimensions: false },
    { unit: 'm' },
    { view: 'interior' },
    { quality: 'lite' },
    { autoRotate: true },
    { active: false },
  ] as const)('redraws after display options change: %o', (change) => {
    act(() => root.render(<SceneRefresh {...props} {...change} />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not continuously redraw unchanged configurations', () => {
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidate).not.toHaveBeenCalled()
    expect(invalidateShadows).not.toHaveBeenCalled()
  })

  it('redraws when the scene shows again after the floor plan', () => {
    act(() => root.render(<SceneRefresh {...props} active={false} />))
    invalidate.mockClear()
    act(() => root.render(<SceneRefresh {...props} active />))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('redraws shadow maps whenever the scene changes', () => {
    props.config = { ...props.config, lighting: 'night' }
    act(() => root.render(<SceneRefresh {...props} />))
    expect(invalidateShadows).toHaveBeenCalledTimes(1)
    expect(invalidateShadows).toHaveBeenCalledWith(scene)
  })
})
