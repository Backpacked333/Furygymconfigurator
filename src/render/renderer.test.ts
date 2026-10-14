// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebGPURenderer } from 'three/webgpu'
import { backendOf, createRenderer, deviceProfile, observeRendererLoss } from './renderer'

const mock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  options: vi.fn(),
}))
vi.mock('three/webgpu', () => ({
  WebGPURenderer: class {
    init = mock.init
    dispose = mock.dispose
    constructor(options: unknown) {
      mock.options(options)
    }
  },
  AgXToneMapping: 4,
  RectAreaLightNode: { setLTC: vi.fn() },
}))
vi.mock('three/addons/lights/RectAreaLightTexturesLib.js', () => ({
  RectAreaLightTexturesLib: { init: vi.fn() },
}))
beforeEach(() => {
  mock.init.mockReset().mockResolvedValue(undefined)
  mock.dispose.mockClear()
  mock.options.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('renderer initialization lifetime', () => {
  it('initializes the requested fallback backend before exposing it', async () => {
    await createRenderer(document.createElement('canvas'), { forceWebGL: true })
    expect(mock.init).toHaveBeenCalledOnce()
    expect(mock.options).toHaveBeenCalledWith(expect.objectContaining({ forceWebGL: true }))
    expect(mock.dispose).not.toHaveBeenCalled()
  })
  it('releases failed initialization', async () => {
    mock.init.mockRejectedValue(new Error('backend failed'))
    await expect(createRenderer(document.createElement('canvas'))).rejects.toThrow('backend failed')
    expect(mock.dispose).toHaveBeenCalledOnce()
  })
  it('bounds init and disposes a late successful device without exposing it', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    mock.init.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const pending = createRenderer(document.createElement('canvas'))
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(12000)
    await rejected
    expect(mock.dispose).not.toHaveBeenCalled()
    finish()
    await Promise.resolve()
    expect(mock.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('supports cancellation during initialization', async () => {
    let finish!: () => void
    mock.init.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const pending = createRenderer(document.createElement('canvas'), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    finish()
    await Promise.resolve()
    expect(mock.dispose).toHaveBeenCalledOnce()
  })
})

describe('generation-scoped loss observations', () => {
  function fixture() {
    const original = vi.fn()
    const originalError = vi.fn()
    const renderer = {
      domElement: document.createElement('canvas'),
      onDeviceLost: original,
      onError: originalError,
    } as unknown as WebGPURenderer
    const report = vi.fn()
    const stop = observeRendererLoss(renderer, report)
    return { renderer, report, stop, original, originalError }
  }
  it('reports actual context loss once and prevents default context handling', () => {
    const f = fixture()
    const event = new Event('webglcontextlost', { cancelable: true })
    f.renderer.domElement.dispatchEvent(event)
    f.renderer.domElement.dispatchEvent(new Event('webglcontextlost'))
    expect(f.report).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    f.stop()
  })
  it('wraps device loss/error callbacks and removes its hooks on intentional teardown', () => {
    const f = fixture()
    const loss = f.renderer.onDeviceLost
    f.renderer.onError('allocation failed')
    expect(f.report).toHaveBeenCalledWith('allocation failed')
    f.stop()
    expect(f.renderer.onDeviceLost).toBe(f.original)
    expect(f.renderer.onError).toBe(f.originalError)
    loss({
      api: 'WebGPU',
      message: 'destroyed',
      reason: 'destroyed',
      originalEvent: new Event('lost'),
    })
    f.renderer.domElement.dispatchEvent(new Event('webglcontextlost'))
    expect(f.report).toHaveBeenCalledTimes(1)
  })
  it('forwards real WebGPU loss with its backend identity', () => {
    const f = fixture()
    f.renderer.onDeviceLost({
      api: 'WebGPU',
      message: 'driver reset',
      reason: 'unknown',
      originalEvent: new Event('lost'),
    })
    expect(f.original).toHaveBeenCalledOnce()
    expect(f.report).toHaveBeenCalledWith('WebGPU: driver reset')
    f.stop()
  })
  it('does not mistake unknown hardware or API presence for a capable GPU', () => {
    const renderer = {
      backend: { isWebGPUBackend: true, device: { limits: { maxTextureDimension2D: 8192 } } },
    } as unknown as WebGPURenderer
    expect(deviceProfile(renderer).hardware).toBe('unknown')
    expect(backendOf(renderer)).toBe('webgpu')
    expect(backendOf({ backend: {} } as WebGPURenderer)).toBe('webgl2')
  })
})
