import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_TIMEOUT_MS,
  captureCapability,
  createCaptureProvider,
  createCaptureRegistry,
  type CaptureRequest,
  type CaptureTransaction,
} from './capture'
import { createPresentationStore, type PresentationToken } from './presentation'
import type { DeviceProfile } from '../render/quality'

const token: PresentationToken = {
  revision: 1,
  generation: 3,
  view: 'exterior',
  camera: 'camera-1',
  material: 'maps-2',
  presentation: 'sun-3',
  quality: 'high',
  preview: false,
}
const capable: DeviceProfile = {
  backend: 'webgpu',
  hardware: 'capable',
  maxTextureSize: 8192,
  memoryBudgetMB: 1536,
}
function png(width = 3840, height = 2160) {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  bytes.set([73, 72, 68, 82], 12)
  const data = new DataView(bytes.buffer)
  data.setUint32(16, width)
  data.setUint32(20, height)
  return new Blob([bytes], { type: 'image/png' })
}
function fixture(overrides: Partial<CaptureTransaction> = {}) {
  const state = createPresentationStore({
    token: { ...token },
    stage: 'settled',
    reasons: [],
    animating: false,
    rendered: { width: 1600, height: 900 },
  })
  const request: CaptureRequest = {
    token: { ...token },
    mode: 'presentation',
    framing: 'center-crop',
    width: 3840,
    height: 2160,
  }
  const render = vi.fn(() => ({ width: 3840, height: 2160 }))
  const encode = vi.fn(async () => png())
  const restore = vi.fn()
  const prepare = vi.fn(() => ({ frames: 3, render, encode, restore, ...overrides }))
  const nextFrame = vi.fn(async () => {})
  const provider = createCaptureProvider({
    generation: 3,
    profile: capable,
    getState: state.get,
    subscribe: state.subscribe,
    prepare,
    nextFrame,
  })
  return { state, request, render, encode, restore, prepare, nextFrame, provider }
}
afterEach(() => vi.useRealTimers())

describe('native capture capability budget', () => {
  it.each([
    [{ width: 900, height: 1800 }, 4096, 128],
    [{ width: 1600, height: 900 }, 4096, 16],
    [{ width: 600, height: 600 }, 128, 128],
  ] as const)(
    'offers admitted aspect-preserving alternatives for %o',
    (size, maxTextureSize, memoryBudgetMB) => {
      const profile = { ...capable, hardware: 'software' as const, maxTextureSize, memoryBudgetMB }
      const capability = captureCapability(size, profile)
      expect(capability.allowed).toBe(false)
      expect(capability.alternatives.length).toBeGreaterThan(0)
      for (const alternative of capability.alternatives) {
        expect(alternative.width).toBeLessThan(size.width)
        expect(alternative.height).toBe(Math.round((alternative.width * size.height) / size.width))
        expect(captureCapability(alternative, profile).allowed).toBe(true)
      }
    },
  )
  it('allows native 4K only under the capable policy budget', () => {
    expect(captureCapability({ width: 3840, height: 2160 }, capable).allowed).toBe(true)
    expect(
      captureCapability(
        { width: 3840, height: 2160 },
        { ...capable, hardware: 'software', memoryBudgetMB: 128 },
      ),
    ).toMatchObject({
      allowed: false,
      alternatives: [
        { width: 1280, height: 720 },
        { width: 960, height: 540 },
      ],
    })
    expect(
      captureCapability({ width: 3840, height: 2160 }, { ...capable, hardware: 'unknown' }).allowed,
    ).toBe(false)
    expect(
      captureCapability({ width: 3840, height: 2160 }, { ...capable, maxTextureSize: 2048 })
        .allowed,
    ).toBe(false)
    expect(
      captureCapability({ width: 3840, height: 2160 }, { ...capable, memoryBudgetMB: 64 }).allowed,
    ).toBe(false)
  })
  it.each([0, -1, NaN, Infinity, 1.5])(
    'rejects invalid dimension %s before allocation',
    (width) => {
      expect(captureCapability({ width, height: 2160 }, capable).allowed).toBe(false)
    },
  )
})

describe('capture transaction', () => {
  it('accepts only pixel-rounded current-view resizing for very wide viewports', async () => {
    const f = fixture({
      render: () => ({ width: 960, height: 62 }),
      encode: async () => png(960, 62),
    })
    f.state.set({ ...f.state.get(), rendered: { width: 5118, height: 333 } })
    const request = {
      ...f.request,
      mode: 'current' as const,
      framing: 'current' as const,
      width: 960,
      height: 62,
    }
    expect((await f.provider.capture({ ...request, height: 58 })).status).toBe('unavailable')
    expect((await f.provider.capture(request)).status).toBe('ready')
  })
  it('renders native dimensions, independently reads encoded dimensions and restores on success', async () => {
    const f = fixture()
    const progress = vi.fn()
    const result = await f.provider.capture({ ...f.request, onProgress: progress })
    expect(result).toMatchObject({
      status: 'ready',
      rendered: { width: 3840, height: 2160 },
      encoded: { width: 3840, height: 2160 },
      provenance: { native: true, token },
    })
    expect(f.render).toHaveBeenCalledTimes(3)
    expect(f.restore).toHaveBeenCalledTimes(1)
    expect(progress.mock.calls.map((call) => call[0])).toEqual([
      'waiting',
      'rendering',
      'rendering',
      'rendering',
      'encoding',
    ])
  })
  it('preserves honest degraded readiness reasons', async () => {
    const f = fixture()
    f.state.set({ ...f.state.get(), stage: 'degraded', reasons: ['Wood texture fallback'] })
    expect(await f.provider.capture(f.request)).toMatchObject({
      status: 'degraded',
      reasons: ['Wood texture fallback'],
    })
  })
  it.each(['preview', 'animation', 'plan'] as const)(
    'refuses %s before preparing resources',
    async (mode) => {
      const f = fixture()
      f.state.set({
        ...f.state.get(),
        animating: mode === 'animation',
        token: {
          ...token,
          preview: mode === 'preview',
          view: mode === 'plan' ? 'plan' : 'exterior',
        },
      })
      expect(await f.provider.capture(f.request)).toMatchObject({ status: 'unavailable' })
      expect(f.prepare).not.toHaveBeenCalled()
    },
  )
  it.each(Object.keys(token) as (keyof PresentationToken)[])(
    'rejects stale %s before rendering',
    async (key) => {
      const f = fixture()
      f.request.token = { ...token, [key]: key === 'preview' ? false : 'changed' }
      if (key === 'preview') f.request.token.preview = true
      const result = await f.provider.capture(f.request)
      expect(result.status).not.toBe('ready')
      expect(f.prepare).not.toHaveBeenCalled()
    },
  )
  it('rejects current-view aspect changes and unpreviewed framing', async () => {
    const f = fixture()
    expect(
      await f.provider.capture({
        ...f.request,
        mode: 'current',
        framing: 'current',
        width: 1000,
        height: 1000,
      }),
    ).toMatchObject({ status: 'unavailable' })
    expect(await f.provider.capture({ ...f.request, framing: 'current' })).toMatchObject({
      status: 'unavailable',
    })
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it('supports current-view native capture at the viewport aspect', async () => {
    const f = fixture({
      render: () => ({ width: 1600, height: 900 }),
      encode: async () => png(1600, 900),
    })
    expect(
      await f.provider.capture({
        ...f.request,
        mode: 'current',
        framing: 'current',
        width: 1600,
        height: 900,
      }),
    ).toMatchObject({ status: 'ready', rendered: { width: 1600, height: 900 } })
    expect(f.restore).toHaveBeenCalledTimes(1)
  })
  it('waits on notifications without driving render frames', async () => {
    const f = fixture()
    f.state.set({ ...f.state.get(), stage: 'refining' })
    const pending = f.provider.capture(f.request)
    expect(f.nextFrame).not.toHaveBeenCalled()
    expect(f.render).not.toHaveBeenCalled()
    f.state.set({ ...f.state.get(), stage: 'settled' })
    expect((await pending).status).toBe('ready')
  })
  it('cancels a waiting capture when generation is lost', async () => {
    const f = fixture()
    f.state.set({ ...f.state.get(), stage: 'refining' })
    const pending = f.provider.capture(f.request)
    f.state.set({ ...f.state.get(), stage: 'lost' })
    expect((await pending).status).toBe('cancelled')
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it.each(['current', 'presentation'] as const)(
    'bounds the %s wait and releases listeners',
    async (mode) => {
      vi.useFakeTimers()
      const f = fixture()
      f.state.set({ ...f.state.get(), stage: 'refining' })
      const pending = f.provider.capture({
        ...f.request,
        mode,
        framing: mode === 'current' ? 'current' : 'center-crop',
      })
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS[mode])
      expect(await pending).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('time budget'),
      })
      expect(f.prepare).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )
  it('rejects stale encoding results and restores exactly once', async () => {
    let finish!: (blob: Blob) => void
    const encode = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve
        }),
    )
    const f = fixture({ frames: 1, encode })
    const pending = f.provider.capture(f.request)
    expect(encode).toHaveBeenCalledOnce()
    f.state.set({ ...f.state.get(), token: { ...token, revision: 2 } })
    expect((await pending).status).toBe('cancelled')
    finish(png())
    expect(f.restore).toHaveBeenCalledTimes(1)
  })
  it('cancels caller-aborted and superseded providers without accepting late blobs', async () => {
    const f = fixture({ frames: 1, encode: () => new Promise(() => {}) })
    const controller = new AbortController()
    const pending = f.provider.capture({ ...f.request, signal: controller.signal })
    controller.abort()
    expect((await pending).status).toBe('cancelled')
    expect(f.restore).toHaveBeenCalledTimes(1)
    const second = f.provider.capture(f.request)
    f.provider.dispose()
    expect(f.restore).toHaveBeenCalledTimes(2)
    expect((await second).status).toBe('cancelled')
    expect(f.restore).toHaveBeenCalledTimes(2)
    expect((await f.provider.capture(f.request)).status).toBe('unavailable')
  })
  it('refuses concurrent capture', async () => {
    const f = fixture({ frames: 1, encode: () => new Promise(() => {}) })
    const pending = f.provider.capture(f.request)
    expect((await f.provider.capture(f.request)).status).toBe('unavailable')
    f.provider.dispose()
    await pending
  })
  it.each(['render', 'encoding', 'empty', 'dimensions', 'header', 'restoration'] as const)(
    'restores after %s failure',
    async (failure) => {
      const fail = () => {
        throw new Error('test failure')
      }
      const f = fixture({
        ...(failure === 'render' ? { render: fail } : {}),
        ...(failure === 'encoding' ? { encode: async () => fail() } : {}),
        ...(failure === 'empty' ? { encode: async () => null } : {}),
        ...(failure === 'dimensions' ? { encode: async () => png(1920, 1080) } : {}),
        ...(failure === 'header'
          ? { encode: async () => new Blob(['invalid'], { type: 'image/png' }) }
          : {}),
      })
      if (failure === 'restoration') f.restore.mockImplementation(fail)
      expect((await f.provider.capture(f.request)).status).toBe('unavailable')
      expect(f.restore).toHaveBeenCalledTimes(1)
    },
  )
  it('keeps an immutable request snapshot despite caller mutation', async () => {
    const f = fixture()
    const pending = f.provider.capture(f.request)
    f.request.token.revision = 99
    expect(await pending).toMatchObject({ status: 'ready', provenance: { token: { revision: 1 } } })
  })
})

describe('generation-safe registry', () => {
  it('does not let a stale cleanup unregister the new provider', () => {
    const registry = createCaptureRegistry()
    const first = fixture().provider,
      second = fixture().provider
    const oldCleanup = registry.register(first)
    const cleanup = registry.register(second)
    oldCleanup()
    expect(registry.get()).toBe(second)
    cleanup()
    expect(registry.get()).toBeNull()
  })
})
