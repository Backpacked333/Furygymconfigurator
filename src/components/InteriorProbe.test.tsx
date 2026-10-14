// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InteriorProbe } from './InteriorProbe'
import { DEFAULT_CONFIG } from '../lib/config'
import type { Quality } from '../render/quality'

const mock = vi.hoisted(() => ({
  frame: () => {},
  invalidate: vi.fn(),
  generated: [] as { size: number; target: object | undefined }[],
  targets: [] as { texture: string; dispose: ReturnType<typeof vi.fn> }[],
  events: [] as string[],
  generators: [] as ReturnType<typeof vi.fn>[],
  listeners: new Set<(change: string) => void>(),
}))
vi.mock('@react-three/fiber', () => ({
  useThree: () => state,
  useFrame: (frame: () => void) => {
    mock.frame = frame
  },
}))
vi.mock('three/webgpu', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PMREMGenerator: class {
    dispose = vi.fn()
    constructor() {
      mock.generators.push(this.dispose)
    }
    fromScene(
      _scene: unknown,
      _sigma: number,
      _near: number,
      _far: number,
      options: { size: number; renderTarget?: object },
    ) {
      mock.generated.push({ size: options.size, target: options.renderTarget })
      if (options.renderTarget) return options.renderTarget
      const texture = `target-${mock.targets.length}`
      const target = { texture, dispose: vi.fn(() => mock.events.push(`dispose:${texture}`)) }
      mock.targets.push(target)
      return target
    }
  },
  RendererUtils: { saveRendererState: () => ({}), restoreRendererState: () => {} },
}))
vi.mock('../render/materials', () => ({
  setInteriorEnvironment: (texture: string | null) => {
    mock.events.push(`bind:${texture}`)
  },
  onMaterialsChanged: (listener: (change: string) => void) => {
    mock.listeners.add(listener)
    return () => mock.listeners.delete(listener)
  },
}))
const state = { gl: {}, scene: { traverse: () => {} }, invalidate: mock.invalidate }

describe('probe scheduling and size ownership (PMREM double)', () => {
  let root: Root
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    mock.invalidate.mockClear()
    mock.generated.length = 0
    mock.targets.length = 0
    mock.events.length = 0
    mock.generators.length = 0
    mock.listeners.clear()
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const mount = (quality: Quality) =>
    act(() =>
      root.render(
        <StrictMode>
          <InteriorProbe config={DEFAULT_CONFIG} quality={quality} />
        </StrictMode>,
      ),
    )
  const capture = () => {
    act(() => vi.advanceTimersByTime(250))
    mock.frame()
    mock.frame()
  }
  it('uses one cancellable wake-up and no frame-driven polling or perpetual idle submissions', () => {
    mount('lite')
    expect(mock.generators[0]).toHaveBeenCalledOnce()
    expect(mock.listeners.size).toBe(1)
    act(() => vi.advanceTimersByTime(249))
    mock.frame()
    expect(mock.generated).toHaveLength(0)
    expect(mock.invalidate).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(mock.invalidate).toHaveBeenCalledTimes(1)
    mock.frame()
    mock.frame()
    expect(mock.generated).toHaveLength(2)
    mock.frame()
    act(() => vi.advanceTimersByTime(10000))
    mock.frame()
    expect(mock.generated).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('replaces both ping-pong targets on Lite/High size changes and rebinds before disposal', () => {
    mount('lite')
    capture()
    expect(mock.generated.map((g) => g.size)).toEqual([64, 64])
    mount('high')
    capture()
    expect(mock.generated.slice(2).map((g) => g.target)).toEqual([undefined, undefined])
    expect(mock.targets.slice(0, 2).every((t) => t.dispose.mock.calls.length === 1)).toBe(true)
    expect(mock.events.indexOf('bind:target-2')).toBeLessThan(
      mock.events.indexOf('dispose:target-0'),
    )
    mount('ultra')
    capture()
    expect(mock.targets).toHaveLength(4)
    expect(mock.generated.slice(4).every((g) => !!g.target)).toBe(true)
    mount('lite')
    capture()
    expect(mock.targets).toHaveLength(6)
    expect(mock.targets.slice(2, 4).every((t) => t.dispose.mock.calls.length === 1)).toBe(true)
  })
  it('debounces texture changes and clears callbacks, timers and all owned targets on unmount', () => {
    mount('high')
    capture()
    mock.listeners.forEach((listener) => listener('textures'))
    act(() => vi.advanceTimersByTime(100))
    mock.listeners.forEach((listener) => listener('textures'))
    expect(vi.getTimerCount()).toBe(1)
    act(() => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
    expect(mock.listeners.size).toBe(0)
    expect(mock.targets.every((t) => t.dispose.mock.calls.length === 1)).toBe(true)
    expect(mock.generators.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(mock.events.at(-3)).toBe('bind:null')
  })
})
