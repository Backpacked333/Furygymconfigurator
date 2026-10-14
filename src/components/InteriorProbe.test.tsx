// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InteriorProbe } from './InteriorProbe'
import { DEFAULT_CONFIG } from '../lib/config'
import type { Quality } from '../render/quality'
import {
  createPresentationStore,
  type AssetReadiness,
  type PresentationStore,
} from '../lib/presentation'
import { DirectionalLight, Object3D } from 'three/webgpu'

const mock = vi.hoisted(() => ({
  frame: () => {},
  invalidate: vi.fn(),
  generated: [] as { size: number; target: object | undefined }[],
  targets: [] as { texture: string; dispose: ReturnType<typeof vi.fn> }[],
  events: [] as string[],
  generators: [] as ReturnType<typeof vi.fn>[],
  listeners: new Set<(change: string) => void>(),
  captureError: null as Error | null,
  restore: vi.fn(),
  objects: [] as Object3D[],
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
      if (mock.captureError) throw mock.captureError
      if (options.renderTarget) return options.renderTarget
      const texture = `target-${mock.targets.length}`
      const target = { texture, dispose: vi.fn(() => mock.events.push(`dispose:${texture}`)) }
      mock.targets.push(target)
      return target
    }
  },
  RendererUtils: { saveRendererState: () => ({}), restoreRendererState: mock.restore },
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
const state = {
  gl: {},
  scene: { traverse: (visit: (object: Object3D) => void) => mock.objects.forEach(visit) },
  invalidate: mock.invalidate,
}

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
    mock.captureError = null
    mock.restore.mockReset()
    mock.objects.length = 0
    state.gl = {}
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const mount = (
    quality: Quality,
    assets?: AssetReadiness,
    presentation?: PresentationStore,
    onError?: (error: unknown) => void,
  ) =>
    act(() =>
      root.render(
        <StrictMode>
          <InteriorProbe
            config={DEFAULT_CONFIG}
            quality={quality}
            assets={assets}
            presentation={presentation}
            onError={onError}
          />
        </StrictMode>,
      ),
    )
  const capture = () => {
    act(() => vi.advanceTimersByTime(250))
    mock.frame()
    mock.frame()
  }
  const readiness = (pending: number, revision = '1', degraded = false): AssetReadiness => ({
    pending,
    revision,
    degraded,
  })
  const presentation = (generation = 1) => {
    const store = createPresentationStore({
      token: {
        revision: 1,
        generation,
        view: 'exterior',
        camera: '1',
        material: '1',
        presentation: '1',
        quality: 'lite',
        preview: false,
      },
      stage: 'refining',
      animating: false,
      reasons: [],
      rendered: { width: 1440, height: 900 },
    })
    store.reset = vi.fn(() => store.set({ ...store.get(), stage: 'refining' }))
    return store
  }
  const notifyTextures = () => mock.listeners.forEach((listener) => listener('textures'))
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
  it('waits without timers or submissions through 42 slow map waves, then captures only the final state', () => {
    const store = presentation()
    for (let pending = 42; pending > 0; pending--) {
      mount('lite', readiness(pending, String(43 - pending)), store)
      notifyTextures()
      act(() => vi.advanceTimersByTime(8000))
      mock.frame()
      expect(vi.getTimerCount()).toBe(0)
      expect(store.probePending).toBe(true)
    }
    expect(mock.generated).toHaveLength(0)
    expect(mock.invalidate).not.toHaveBeenCalled()
    mount('lite', readiness(0, '43'), store)
    notifyTextures()
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(249))
    mock.frame()
    expect(mock.generated).toHaveLength(0)
    act(() => vi.advanceTimersByTime(1))
    mock.frame()
    expect(store.probePending).toBe(true)
    mock.frame()
    expect(store.probePending).toBe(false)
    expect(mock.generated).toHaveLength(2)
    expect(store.reset).toHaveBeenCalledTimes(2)
    act(() => vi.advanceTimersByTime(10000))
    mock.frame()
    expect(mock.generated).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('settles once on terminal fallback failures rather than waiting for all-source success', () => {
    const store = presentation()
    mount('lite', readiness(2), store)
    mount('lite', readiness(0, '2', true), store)
    capture()
    expect(mock.generated).toHaveLength(2)
    expect(store.probePending).toBe(false)
    mount('lite', readiness(0, '2', true), store)
    capture()
    expect(mock.generated).toHaveLength(2)
  })
  it('cancels an already-armed wake-up when an asset retry becomes pending', () => {
    const store = presentation()
    mount('lite', readiness(0), store)
    act(() => vi.advanceTimersByTime(200))
    mount('lite', readiness(3, '2'), store)
    notifyTextures()
    act(() => vi.advanceTimersByTime(30000))
    mock.frame()
    expect(mock.generated).toHaveLength(0)
    expect(mock.invalidate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    mount('lite', readiness(0, '3'), store)
    capture()
    expect(mock.generated).toHaveLength(2)
    expect(store.probePending).toBe(false)
  })
  it('suspends the remaining bounce if loading resumes between probe frames', () => {
    const store = presentation()
    mount('lite', readiness(0), store)
    act(() => vi.advanceTimersByTime(250))
    mock.frame()
    expect(mock.generated).toHaveLength(1)
    mount('lite', readiness(1, '2'), store)
    mock.frame()
    act(() => vi.advanceTimersByTime(10000))
    mock.frame()
    expect(mock.generated).toHaveLength(1)
    expect(store.probePending).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    mount('lite', readiness(0, '3'), store)
    capture()
    expect(mock.generated).toHaveLength(3)
    expect(store.probePending).toBe(false)
  })
  it.each(['lost', 'generation'] as const)(
    'cancels an armed probe when %s supersedes it',
    (reason) => {
      const store = presentation()
      mount('lite', readiness(0), store)
      if (reason === 'lost') store.set({ ...store.get(), stage: 'lost' })
      else store.set({ ...store.get(), token: { ...store.get().token, generation: 2 } })
      notifyTextures()
      capture()
      expect(mock.generated).toHaveLength(0)
      expect(mock.invalidate).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(store.probePending).toBe(false)
      const recovered = presentation(2)
      state.gl = {}
      mount('lite', readiness(0), recovered)
      capture()
      expect(mock.generated).toHaveLength(2)
      expect(mock.generators.slice(0, -1).every((dispose) => dispose.mock.calls.length === 1)).toBe(
        true,
      )
    },
  )
  it('resumes a temporarily lost same-generation store without polling (StrictMode cleanup replay)', () => {
    const store = presentation()
    store.set({ ...store.get(), stage: 'lost' })
    mount('lite', readiness(0), store)
    expect(vi.getTimerCount()).toBe(0)
    store.set({ ...store.get(), stage: 'initializing' })
    capture()
    expect(mock.generated).toHaveLength(2)
  })
  it('removes waiting-generation observers on unmount', () => {
    const store = presentation()
    mount('lite', readiness(42), store)
    act(() => root.render(null))
    expect(store.probePending).toBe(false)
    expect(mock.listeners.size).toBe(0)
    store.probePending = true
    store.set({ ...store.get(), stage: 'lost' })
    expect(store.probePending).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(mock.generated).toHaveLength(0)
    expect(mock.generators.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
  })
  it.each(['capture', 'restore'] as const)(
    'bounds %s failure, restores hidden/shadow state, and does not retry a failed generation',
    (phase) => {
      const store = presentation()
      const onError = vi.fn()
      const hidden = new Object3D()
      hidden.userData.noProbe = true
      const light = new DirectionalLight()
      light.castShadow = true
      mock.objects.push(hidden, light)
      if (phase === 'capture') mock.captureError = new Error('capture failed')
      else
        mock.restore.mockImplementation(() => {
          throw new Error('restore failed')
        })
      mount('lite', readiness(0), store, onError)
      capture()
      expect(hidden.visible).toBe(true)
      expect(light.shadow.autoUpdate).toBe(true)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(store.get().stage).toBe('lost')
      expect(store.probePending).toBe(false)
      expect(mock.targets.every((target) => target.dispose.mock.calls.length === 1)).toBe(true)
      store.set({ ...store.get(), stage: 'refining' })
      mount('lite', readiness(0, 'retry'), store, onError)
      notifyTextures()
      capture()
      expect(mock.generated).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
