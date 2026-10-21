// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PerspectiveCamera, Scene, Vector3, type Vector2 } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skyLook } from '../lib/visuals'
import type { GalleryCamera } from '../render/gallery'
import { liveLoading, textureProgress, traceProgress } from '../render/progress'
import { ProgressiveRenderer, REST_MS, TRIM_AFTER_MS } from './ProgressiveRenderer'
import { bootStats } from './bootStats'
import { forgetTraceCosts, recordTraceCost } from './traceRate'

const mocks = vi.hoisted(() => ({
  frames: new Map<number, () => void>(),
  state: {} as Record<string, unknown>,
  backend: 'webgpu',
  load: vi.fn(),
  signature: 1,
  /** The canvas's drawing buffer, in device pixels. */
  buffer: { w: 1000, h: 625 },
  beginFrame: vi.fn(),
  /** createPipeline: the tier's own pipeline, or the lean one when asked for no GI. */
  create: vi.fn(),
  pipe: {
    render: vi.fn(),
    warm: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
    setPlace: vi.fn(),
    settleFrames: 10,
  },
  lean: {
    render: vi.fn(),
    warm: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
    setPlace: vi.fn(),
    settleFrames: 10,
  },
  materialListeners: new Set<(change: 'textures' | 'probe') => void>(),
  keepDecoded: vi.fn((keep: boolean) => Promise.resolve(keep ? [] : [])),
  session: vi.fn(),
  present: { capture: vi.fn(), render: vi.fn(), dispose: vi.fn() },
  /** The inverse-AgX table's load. */
  table: vi.fn(),
  /** The worker's BVH builds (bvhWarmup.ts). */
  warm: vi.fn(() => Promise.resolve(0)),
  /** The sky map built in a worker (pathtrace.ts prepareEnvironment). */
  sky: vi.fn(() => Promise.resolve()),
  trace: {
    storeImage: vi.fn<(...args: unknown[]) => boolean>(() => true),
    begin: vi.fn(),
    halt: vi.fn(),
    step: vi.fn(),
    view: vi.fn(),
    progress: vi.fn(() => ({ shown: 0, target: 1024 })),
    pacing: { passes: 1, latencyFloor: Infinity },
    prepareDenoiser: vi.fn(() => Promise.resolve()),
    started: true,
    samplesPerSecond: null as number | null,
    settleAt: vi.fn(),
    retarget: vi.fn(),
    invalidate: vi.fn(),
    texturesChanged: vi.fn(),
    trim: vi.fn(),
    dispose: vi.fn(),
  },
}))
vi.mock('@react-three/fiber', () => ({
  useThree: () => mocks.state,
  useFrame: (callback: () => void, priority = 0) => mocks.frames.set(priority, callback),
}))
vi.mock('../render/materials', () => ({
  keepDecodedTextures: mocks.keepDecoded,
  onMaterialsChanged: (listener: (change: 'textures' | 'probe') => void) => {
    mocks.materialListeners.add(listener)
    return () => mocks.materialListeners.delete(listener)
  },
}))
vi.mock('../render/pipeline', () => ({
  createPipeline: (...args: unknown[]) => mocks.create(...args),
}))
vi.mock('../render/renderer', () => ({
  backendOf: () => mocks.backend,
  beginFrame: mocks.beginFrame,
  FRAME_BEGIN: -1000,
}))
vi.mock('./presentation', () => ({ createProgressivePresentation: () => mocks.present }))
vi.mock('../render/agxInverse', () => ({ loadAgxInverse: mocks.table }))
vi.mock('../render/bvhWarmup', () => ({ warmBVHs: mocks.warm }))
vi.mock('../render/pathtrace', () => ({
  loadTracerModule: mocks.load,
  sceneSignature: () => mocks.signature,
  lookKey: () => 'look',
  prepareEnvironment: mocks.sky,
  trimEnvironments: vi.fn(),
  PathTraceSession: class {
    constructor(...args: unknown[]) {
      mocks.session(...args)
      return mocks.trace
    }
  },
}))

describe('progressive viewer lifecycle (mock GPU, not a visual/performance test)', () => {
  let root: Root, host: HTMLDivElement, canvas: HTMLCanvasElement, camera: PerspectiveCamera
  let now: number
  const ready = vi.fn(),
    status = vi.fn(),
    invalidate = vi.fn()
  const look = skyLook('backyard', 16.5)
  let props: Parameters<typeof ProgressiveRenderer>[0]
  /** One display frame, `ms` after the last. */
  const frame = (ms = 32) =>
    act(() => {
      now += ms
      for (const [, callback] of [...mocks.frames].sort(([a], [b]) => a - b)) callback()
    })
  const settle = () => {
    for (let i = 0; i < 15; i++) frame()
  }
  /** A held drag of `frames` frames `ms` apart, each turning the camera a little. */
  const drag = (frames: number, ms: number, during?: (frame: number) => number | void) => {
    act(() => canvas.dispatchEvent(new Event('pointerdown')))
    for (let i = 0; i < frames; i++) {
      camera.position.x += 0.01
      frame(during?.(i) ?? ms)
    }
    act(() => window.dispatchEvent(new Event('pointerup')))
  }
  const render = async (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch }
    await act(async () => root.render(<ProgressiveRenderer {...props} />))
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    mocks.frames.clear()
    mocks.materialListeners.clear()
    mocks.pipe.settleFrames = 10
    liveLoading.restart()
    mocks.create.mockImplementation((...args: unknown[]) =>
      (args[4] as { gi?: boolean } | undefined)?.gi === false ? mocks.lean : mocks.pipe,
    )
    mocks.lean.warm.mockReset()
    mocks.pipe.render.mockReset()
    mocks.backend = 'webgpu'
    mocks.signature = 1
    mocks.buffer = { w: 1000, h: 625 }
    mocks.load.mockResolvedValue({})
    mocks.trace.step.mockReturnValue(true)
    mocks.trace.started = true
    mocks.trace.samplesPerSecond = null
    forgetTraceCosts()
    mocks.trace.view.mockReturnValue({ from: null, to: {}, t: 1 })
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    canvas = document.createElement('canvas')
    camera = new PerspectiveCamera()
    mocks.state = {
      gl: {
        domElement: canvas,
        getDrawingBufferSize: (target: Vector2) => target.set(mocks.buffer.w, mocks.buffer.h),
      },
      scene: new Scene(),
      camera,
      invalidate,
      size: { width: 1000, height: 625 },
      viewport: { dpr: 1 },
    }
    host = document.createElement('div')
    root = createRoot(host)
    props = {
      active: true,
      revision: 'one',
      look,
      quality: 'high',
      place: 'exterior',
      onReady: ready,
      onStatus: status,
    }
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps raster interaction, then captures it and refines only after rest', async () => {
    await render()
    frame()
    expect(mocks.pipe.render).toHaveBeenCalled()
    expect(ready).toHaveBeenCalledOnce()
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(1)
    expect(mocks.present.capture).toHaveBeenCalledTimes(1)
    expect(mocks.present.render).toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith('refining')
    camera.position.x = 1
    frame()
    expect(mocks.trace.halt).toHaveBeenCalled()
    expect(status).toHaveBeenLastCalledWith('interactive')
  })

  it('never starts or shows a trace while the camera keeps orbiting slowly (auto-rotate)', async () => {
    // A trace is pinned to the pose it started from, so one shown while the view turns would drift
    // out of register with the scene; it waits for the camera to stop, however slowly it turns.
    camera.position.set(0, 6, 20)
    camera.lookAt(0, 0, 0)
    await render()
    // three-stdlib's auto-rotate turns 2π/3600 × speed a frame, at CameraRig's speed of 0.45.
    const perFrame = ((2 * Math.PI) / 3600) * 0.45
    const up = new Vector3(0, 1, 0)
    for (let i = 0; i < 300; i++) {
      camera.position.applyAxisAngle(up, perFrame)
      camera.lookAt(0, 0, 0)
      frame()
    }
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    expect(mocks.present.capture).not.toHaveBeenCalled()
    expect(mocks.present.render).not.toHaveBeenCalled()
    // Every one of those frames was drawn by the raster pipeline.
    expect(mocks.pipe.render).toHaveBeenCalledTimes(300)
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledOnce()
    expect(mocks.present.render).toHaveBeenCalled()
  })

  it('does not start a trace while a pointer is held; release starts a fresh rest window', async () => {
    await render()
    act(() => canvas.dispatchEvent(new Event('pointerdown')))
    settle()
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new Event('pointerup')))
    frame()
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledOnce()
  })

  it('fences the displayed trace on edits and same-aspect resize, without remounting the session', async () => {
    await render()
    settle()
    mocks.present.render.mockClear()
    await render({ revision: 'door-removed' })
    frame()
    expect(mocks.present.render).not.toHaveBeenCalled()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
    mocks.state.size = { width: 800, height: 500 }
    await render()
    frame()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(3)
    expect(mocks.load).toHaveBeenCalledOnce()
  })

  it('stops GPU work when closed or the document is hidden and resumes on return', async () => {
    await render()
    settle()
    await render({ active: false })
    mocks.trace.step.mockClear()
    mocks.pipe.render.mockClear()
    settle()
    expect(mocks.trace.step).not.toHaveBeenCalled()
    expect(mocks.pipe.render).not.toHaveBeenCalled()
    await render({ active: true })
    settle()
    expect(mocks.trace.step).toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    mocks.trace.step.mockClear()
    settle()
    expect(mocks.trace.step).not.toHaveBeenCalled()
  })

  it('interrupts stale tracing when deferred scene geometry mounts without a config change', async () => {
    await render()
    settle()
    mocks.present.render.mockClear()
    mocks.signature = 2
    frame()
    expect(mocks.present.render).not.toHaveBeenCalled()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
  })

  it('retains WebGL interaction without loading a WebGPU tracer', async () => {
    mocks.backend = 'webgl2'
    await render()
    settle()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.pipe.render).toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith('raster-only')
  })

  describe('the first trace at the entry pose, from the design’s Cycles image', () => {
    // The test camera's own pose: at the origin, looking down -z, at its default field of view.
    const entry = {
      pose: { position: [0, 0, 0], target: [0, 0, -5], fov: 50 } as GalleryCamera,
      image: 'blob:entry',
    }
    let decoded: (() => void) | null
    beforeEach(() => {
      decoded = null
      mocks.table.mockResolvedValue({ isTexture: true })
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(new Blob(['webp'])))),
      )
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(
          () =>
            new Promise((resolve) => {
              decoded = () => resolve({ width: 1920, height: 1200, close: vi.fn() })
            }),
        ),
      )
    })
    /** Lets the fetch and the table settle, leaving the decode to `decoded`. */
    const flush = () => act(async () => {})

    it('waits for the image to decode, then keeps it as a traced view before the first start', async () => {
      await render({ entry })
      await flush()
      settle()
      expect(mocks.trace.begin).not.toHaveBeenCalled()
      decoded!()
      await flush()
      settle()
      expect(mocks.trace.storeImage).toHaveBeenCalledOnce()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      expect(mocks.trace.storeImage.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.trace.begin.mock.invocationCallOrder[0],
      )
      const [, lens, , seed, scale] = mocks.trace.storeImage.mock.lastCall! as unknown as [
        unknown,
        PerspectiveCamera,
        unknown,
        { count: number; ceiling: number; image: { flipY: boolean; colorSpace: string } },
        number,
      ]
      // The image's own camera, at its own aspect, and the scale the start traces at.
      expect(lens.fov).toBe(50)
      expect(lens.aspect).toBeCloseTo(1920 / 1200)
      expect(lens.position.toArray()).toEqual([0, 0, 0])
      expect(seed).toMatchObject({ count: 16, ceiling: 0.94 })
      expect(seed.image).toMatchObject({ flipY: false, colorSpace: '' })
      expect(scale).toBe(mocks.trace.begin.mock.lastCall![4])
      // Once: later starts at the pose begin from what the view traced since.
      camera.position.x = 1
      frame()
      camera.position.x = 0
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
      expect(mocks.trace.storeImage).toHaveBeenCalledOnce()
    })

    it('starts unseeded rather than wait more than 800 ms for it', async () => {
      await render({ entry })
      await flush()
      for (let i = 0; i < 40 && !mocks.trace.begin.mock.calls.length; i++) frame()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      expect(now).toBeGreaterThanOrEqual(800)
      expect(now).toBeLessThan(800 + 3 * 32)
      decoded!()
      await flush()
      settle()
      expect(mocks.trace.storeImage).not.toHaveBeenCalled()
    })

    it('uses Lite’s smaller share of samples for it', async () => {
      await render({ entry, quality: 'lite' })
      await flush()
      decoded!()
      await flush()
      settle()
      expect(mocks.trace.storeImage.mock.lastCall![3]).toMatchObject({ count: 8 })
    })

    it('never seeds a start away from the pose, or without an image, or under ?cyclesSeed=0', async () => {
      camera.position.x = 2
      await render({ entry })
      await flush()
      decoded!()
      await flush()
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      expect(mocks.trace.storeImage).not.toHaveBeenCalled()
      act(() => root.unmount())
      root = createRoot(host)
      camera.position.x = 0
      vi.clearAllMocks()
      await render({ entry: undefined })
      settle()
      expect(fetch).not.toHaveBeenCalled()
      expect(mocks.trace.storeImage).not.toHaveBeenCalled()
      act(() => root.unmount())
      root = createRoot(host)
      window.history.replaceState(null, '', '/?cyclesSeed=0')
      try {
        await render({ entry })
        await flush()
        settle()
        expect(fetch).not.toHaveBeenCalled()
        expect(mocks.trace.storeImage).not.toHaveBeenCalled()
        expect(mocks.trace.begin).toHaveBeenCalled()
      } finally {
        window.history.replaceState(null, '', '/')
      }
    })

    it('starts unseeded when the image cannot be read', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
      )
      await render({ entry })
      await flush()
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      expect(now).toBeLessThan(800)
      expect(mocks.trace.storeImage).not.toHaveBeenCalled()
    })
  })

  it('publishes a resting view’s refinement, and idles it on a move', async () => {
    mocks.trace.progress.mockReturnValue({ shown: 32, target: 1024 })
    await render()
    settle()
    expect(traceProgress.get()).toMatchObject({ phase: 'refining', stage: 'reflections' })
    mocks.trace.step.mockReturnValue(false)
    frame()
    expect(traceProgress.get()).toMatchObject({ phase: 'done', fill: 1 })
    camera.position.x = 1
    frame()
    expect(traceProgress.get()).toEqual({ phase: 'idle' })
    settle()
    await render({ active: false })
    expect(traceProgress.get()).toEqual({ phase: 'idle' })
  })

  it('fits a first visit to the GPU once its rate is measured: settles, keeps the cost, starts over once', async () => {
    mocks.buffer = { w: 2421, h: 1512 }
    await render()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledOnce()
    const first = mocks.trace.begin.mock.lastCall![4] as number
    expect(mocks.trace.settleAt).not.toHaveBeenCalled()
    // 0.6 samples a second at ~2.3 MP: far too slow for a clean image in 2.5 s.
    mocks.trace.samplesPerSecond = 0.6
    frame()
    expect(mocks.trace.settleAt).toHaveBeenLastCalledWith(64)
    expect(Object.keys(window.localStorage).some((key) => key.startsWith('fury:trace-cost:'))).toBe(
      true,
    )
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
    const fitted = mocks.trace.begin.mock.lastCall![4] as number
    expect(fitted).toBeLessThan(first)
    // The next start knows the cost: it settles from its start (then again as it measures its
    // own rate), and never starts over for it again.
    expect(mocks.trace.settleAt.mock.calls.length).toBeGreaterThanOrEqual(2)
    frame()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
  })

  describe('device tiers (traceRate.ts costs, under this GPU, tier and depth)', () => {
    const FULL = '?|high|7'

    it('traces a known slow GPU light from its first start, on the lean raster', async () => {
      recordTraceCost(FULL, 1061)
      mocks.buffer = { w: 2329, h: 1456 }
      await render()
      expect(mocks.create.mock.calls[0][4]).toEqual({ reflections: false, gi: false })
      settle()
      const call = mocks.trace.begin.mock.lastCall!
      expect(call[5]).toBe(4)
      expect(call[4]).toBeCloseTo(0.35, 2)
      // Settles at what 12 s buys at its cost (about 27 samples here), from 16 up.
      const settleTarget = mocks.trace.settleAt.mock.lastCall![0] as number
      expect(settleTarget).toBeGreaterThanOrEqual(16)
      expect(settleTarget).toBeLessThan(64)
    })

    it('refines a settled view on a decent GPU after a rest, and a move cancels it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        recordTraceCost(FULL, 300)
        await render()
        settle()
        expect(mocks.trace.begin.mock.lastCall![5]).toBe(7)
        mocks.trace.samplesPerSecond = 5
        mocks.trace.progress.mockReturnValue({ shown: 64, target: 64 })
        mocks.trace.step.mockReturnValue(false)
        frame()
        act(() => vi.advanceTimersByTime(999))
        expect(mocks.trace.retarget).not.toHaveBeenCalled()
        act(() => vi.advanceTimersByTime(1))
        expect(mocks.trace.retarget).toHaveBeenCalledWith(64 + 225)
        // Once per view.
        frame()
        act(() => vi.advanceTimersByTime(2000))
        expect(mocks.trace.retarget).toHaveBeenCalledOnce()
        // A new view that moves before its rest is over is never upgraded.
        camera.position.x = 1
        settle()
        frame()
        camera.position.x = 2
        frame()
        act(() => vi.advanceTimersByTime(2000))
        expect(mocks.trace.retarget).toHaveBeenCalledOnce()
      } finally {
        mocks.trace.progress.mockReturnValue({ shown: 0, target: 1024 })
        mocks.trace.step.mockReturnValue(true)
        vi.useRealTimers()
      }
    })

    it('never upgrades a slow GPU', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        recordTraceCost(FULL, 1061)
        await render()
        settle()
        mocks.trace.samplesPerSecond = 2
        mocks.trace.progress.mockReturnValue({ shown: 16, target: 16 })
        mocks.trace.step.mockReturnValue(false)
        frame()
        act(() => vi.advanceTimersByTime(5000))
        expect(mocks.trace.retarget).not.toHaveBeenCalled()
      } finally {
        mocks.trace.progress.mockReturnValue({ shown: 0, target: 1024 })
        mocks.trace.step.mockReturnValue(true)
        vi.useRealTimers()
      }
    })

    it('starts a first visit over light once it measures the GPU slow', async () => {
      mocks.buffer = { w: 2329, h: 1456 }
      await render()
      settle()
      expect(mocks.trace.begin.mock.lastCall![5]).toBe(7)
      // 0.4 samples a second at ~2.3 MP: over 1000 ms per megapixel-sample.
      mocks.trace.samplesPerSecond = 0.4
      frame()
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
      expect(mocks.trace.begin.mock.lastCall![5]).toBe(4)
    })
  })

  it('tells ?bootStats=1 why each trace stopped', async () => {
    const restart = vi.spyOn(bootStats, 'restart').mockImplementation(() => {})
    await render()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(1)
    // Scans arriving mid-trace.
    act(() => textureProgress.update(1, 1))
    frame()
    expect(restart).toHaveBeenLastCalledWith('scans arrived')
    settle()
    camera.position.x = 1
    frame()
    expect(restart).toHaveBeenLastCalledWith('camera moved')
    settle()
    act(() => canvas.dispatchEvent(new Event('pointerdown')))
    expect(restart).toHaveBeenLastCalledWith('pointer or wheel')
    // Each stop counted once.
    expect(restart).toHaveBeenCalledTimes(3)
  })

  it('holds the first start until the BVHs, sky map and denoiser network are ready, never later ones', async () => {
    let built!: (n: number) => void
    let sky!: () => void
    let network!: () => void
    mocks.warm.mockImplementationOnce(() => new Promise((resolve) => (built = resolve)))
    mocks.sky.mockImplementationOnce(() => new Promise<void>((resolve) => (sky = resolve)))
    mocks.trace.prepareDenoiser.mockImplementationOnce(
      () => new Promise<void>((resolve) => (network = resolve)),
    )
    await render()
    expect(mocks.warm).toHaveBeenCalledWith(mocks.state.scene)
    expect(mocks.sky).toHaveBeenCalledWith(look)
    expect(mocks.trace.prepareDenoiser).toHaveBeenCalledOnce()
    settle()
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    await act(async () => built(3))
    settle()
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    await act(async () => sky())
    settle()
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    await act(async () => network())
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledOnce()
    // Later starts never wait on it.
    camera.position.x = 1
    frame()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
    expect(mocks.warm).toHaveBeenCalledOnce()
  })

  it('frees a closed view’s memory after 30 s, never sooner, and not if it reopens first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await render()
      settle()
      await render({ active: false })
      act(() => vi.advanceTimersByTime(TRIM_AFTER_MS - 1))
      expect(mocks.trace.trim).not.toHaveBeenCalled()
      // Back before then: everything kept, and no trim pending.
      await render({ active: true })
      act(() => vi.advanceTimersByTime(TRIM_AFTER_MS))
      expect(mocks.trace.trim).not.toHaveBeenCalled()
      await render({ active: false })
      act(() => vi.advanceTimersByTime(TRIM_AFTER_MS))
      expect(mocks.trace.trim).toHaveBeenCalledOnce()
      expect(TRIM_AFTER_MS).toBe(30000)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('the loading screen’s steps', () => {
    it('says materials while scans arrive, then the tracer before its first start', async () => {
      await render()
      expect(liveLoading.get()).toBe('materials')
      act(() => textureProgress.update(2, 0))
      // Even at rest with every scan in, a start waits for the frame after the announcement.
      const frameNumber = () => mocks.beginFrame.mock.calls.length
      let announcedIn = -1
      const stop = liveLoading.subscribe(() => {
        if (liveLoading.get() === 'tracer') announcedIn = frameNumber()
      })
      let begunIn = -1
      mocks.trace.begin.mockImplementation(() => void (begunIn = frameNumber()))
      settle()
      expect(liveLoading.get()).toBe('materials')
      expect(mocks.trace.begin).not.toHaveBeenCalled()
      act(() => textureProgress.update(0, 2))
      frame()
      // The screen says it first; the long start comes in a later frame (after the rest the
      // scans' arrival restarted).
      expect(liveLoading.get()).toBe('tracer')
      expect(mocks.trace.begin).not.toHaveBeenCalled()
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      stop()
      expect(announcedIn).toBeGreaterThan(0)
      expect(begunIn).toBeGreaterThan(announcedIn)
      expect(liveLoading.get()).toBe('ready')
    })

    it('stays up until the first batch has finished, which builds the tracer’s kernels', async () => {
      mocks.trace.started = false
      await render()
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      expect(liveLoading.get()).toBe('tracer')
      frame()
      expect(liveLoading.get()).toBe('tracer')
      mocks.trace.started = true
      frame()
      expect(liveLoading.get()).toBe('ready')
    })

    it('is done at once where the view cannot trace (WebGL)', async () => {
      mocks.backend = 'webgl2'
      await render()
      frame()
      expect(liveLoading.get()).toBe('ready')
    })

    it('never keeps the visitor waiting past 15 s', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        act(() => textureProgress.update(1, 0))
        await render()
        settle()
        act(() => vi.advanceTimersByTime(14999))
        expect(liveLoading.get()).toBe('materials')
        act(() => vi.advanceTimersByTime(1))
        expect(liveLoading.get()).toBe('ready')
      } finally {
        act(() => textureProgress.update(0, 1))
        vi.useRealTimers()
      }
    })
  })

  it('returns to raster rendering if refinement fails', async () => {
    mocks.trace.step.mockImplementation(() => {
      throw new Error('device failure')
    })
    await render()
    settle()
    expect(status).toHaveBeenLastCalledWith('raster-only')
    expect(mocks.pipe.render).toHaveBeenCalled()
    expect(mocks.present.render).not.toHaveBeenCalled()
  })
  /** R3F's demand loop: a frame runs only when something asked for one since the last. */
  const demandLoop = (intervalMs: number, limit = 200) => {
    let frames = 0
    while (frames < limit && invalidate.mock.calls.length > 0) {
      invalidate.mockClear()
      act(() => {
        now += intervalMs
        for (const [, callback] of [...mocks.frames].sort(([a], [b]) => a - b)) callback()
      })
      frames++
      if (mocks.trace.begin.mock.calls.length) break
    }
    return frames
  }

  for (const [quality, settleFrames] of [
    ['lite', 1],
    ['high', 28],
    ['ultra', 40],
  ] as const)
    it(`starts refining a resting view under the demand loop at 60 Hz (${quality})`, async () => {
      mocks.pipe.settleFrames = settleFrames
      await render({ quality })
      demandLoop(1000 / 60)
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      // The rest window and three raster frames: the start waits no longer than that.
      expect(REST_MS).toBe(150)
      expect(now).toBeGreaterThanOrEqual(REST_MS)
      expect(now).toBeLessThan(REST_MS + 2 * (1000 / 60))
    })

  it('paces the live session: early first images, a quick first fade, larger batches at rest', async () => {
    await render({ quality: 'high' })
    settle()
    expect(mocks.session.mock.lastCall![3]).toMatchObject({
      earlyImages: true,
      random: 'sobol',
      timeline: true,
      fadeMs: 260,
      firstFadeMs: 120,
      batchMs: 12,
      maxPasses: 32,
      restBatch: { afterMs: 1000, batchMs: 24, maxPasses: 64 },
    })
  })

  it('keeps Lite batches small at rest, and ?firstImage=8 restores the first image at 8 samples', async () => {
    window.history.replaceState(null, '', '/?firstImage=8&sampler=blue')
    try {
      await render({ quality: 'lite' })
      settle()
      expect(mocks.session.mock.lastCall![3]).toMatchObject({
        earlyImages: false,
        random: 'blue',
        batchMs: 12,
      })
      expect(mocks.session.mock.lastCall![3].restBatch).toBeUndefined()
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('refines Lite on a budget: a reduced-scale trace with fewer samples and bounces', async () => {
    await render({ quality: 'lite' })
    settle()
    expect(mocks.session).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
      expect.objectContaining({ maxBounces: 4, clampDirect: 0, clampIndirect: 10 }),
    )
    expect(mocks.trace.begin).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      128,
      0.5,
      4,
    )
  })

  for (const quality of ['high', 'ultra'] as const)
    it(`traces ${quality} as deep as the gallery's Cycles images, with their clamps`, async () => {
      await render({ quality })
      settle()
      expect(mocks.session).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        true,
        expect.objectContaining({ maxBounces: 7, clampDirect: 0, clampIndirect: 10 }),
      )
    })

  it("traces High and Ultra at the canvas's resolution, up to the Cycles image's pixels", async () => {
    mocks.buffer = { w: 1500, h: 938 }
    await render({ quality: 'ultra' })
    settle()
    // The scale is named at each start, never fixed when the session is made.
    expect(mocks.session.mock.lastCall![3]).not.toHaveProperty('renderScale')
    expect(mocks.trace.begin).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      1024,
      1,
      7,
    )
    // A larger canvas (a 5K display): capped at 1920×1200's pixels, read again after the resize.
    mocks.buffer = { w: 2976, h: 1860 }
    mocks.state.size = { width: 1984, height: 1240 }
    await render()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
    expect(mocks.trace.begin.mock.lastCall![4]).toBeCloseTo(
      Math.sqrt((1920 * 1200) / (2976 * 1860)),
      6,
    )
  })

  it('takes ?traceScale= as the trace scale on Ultra, for comparing on a device', async () => {
    window.history.replaceState(null, '', '?traceScale=0.75')
    try {
      await render({ quality: 'ultra' })
      settle()
      expect(mocks.trace.begin.mock.lastCall![4]).toBe(0.75)
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('times each start in the performance timeline, and never fails a trace over it', async () => {
    const timed = vi.spyOn(performance, 'measure')
    await render()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledOnce()
    expect(timed).toHaveBeenCalledWith(
      'fury:trace-begin',
      expect.objectContaining({ start: expect.any(Number) }),
    )
    timed.mockImplementation(() => {
      throw new TypeError('User Timing is unavailable')
    })
    camera.position.x = 1
    frame()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
    expect(status).toHaveBeenLastCalledWith('refining')
    expect(status).not.toHaveBeenCalledWith('raster-only')
  })

  it('keeps no decoded scans: its tracer packs them from their GPU copies', async () => {
    await render()
    settle()
    expect(mocks.session).toHaveBeenCalled()
    expect(mocks.trace.begin).toHaveBeenCalled()
    act(() => root.unmount())
    expect(mocks.keepDecoded).not.toHaveBeenCalled()
    root = createRoot(host)
  })

  it('settles its temporal passes again on a probe’s new light while not tracing', async () => {
    // WebGL: raster only, so the view is never tracing and draws until its passes have settled.
    mocks.backend = 'webgl2'
    await render()
    demandLoop(1000 / 60)
    mocks.pipe.render.mockClear()
    invalidate.mockClear()
    act(() => mocks.materialListeners.forEach((listener) => listener('probe')))
    expect(invalidate).toHaveBeenCalled()
    demandLoop(1000 / 60)
    expect(mocks.pipe.render.mock.calls.length).toBeGreaterThanOrEqual(mocks.pipe.settleFrames)
  })

  it('never restarts a trace for probe captures, only for streamed textures', async () => {
    await render()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledOnce()
    mocks.trace.halt.mockClear()
    act(() => mocks.materialListeners.forEach((listener) => listener('probe')))
    frame()
    expect(mocks.trace.halt).not.toHaveBeenCalled()
    expect(mocks.trace.texturesChanged).not.toHaveBeenCalled()
    act(() => mocks.materialListeners.forEach((listener) => listener('textures')))
    expect(mocks.trace.texturesChanged).toHaveBeenCalledOnce()
    frame()
    expect(mocks.trace.halt).toHaveBeenCalled()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
  })

  it('tells the tracer scans arrived, which keeps its scene and its orbit, never re-capturing', async () => {
    await render()
    settle()
    expect(mocks.session).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
      expect.objectContaining({ multiView: true, keepHistoryAcrossSurfaces: true }),
    )
    // Both ways scans arrive: the material library's change, and the loading progress.
    act(() => mocks.materialListeners.forEach((listener) => listener('textures')))
    act(() => textureProgress.update(1, 1))
    expect(mocks.trace.texturesChanged).toHaveBeenCalledTimes(2)
    expect(mocks.trace.invalidate).not.toHaveBeenCalled()
    frame()
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
  })

  it('compiles shaders before its first frame', async () => {
    let warmed!: () => void
    mocks.pipe.warm.mockImplementationOnce(() => new Promise<void>((resolve) => (warmed = resolve)))
    await render()
    frame()
    expect(mocks.pipe.render).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    await act(async () => warmed())
    frame()
    expect(mocks.pipe.render).toHaveBeenCalled()
    expect(ready).toHaveBeenCalledOnce()
  })

  describe("Ultra's frame guard (mocked clock)", () => {
    const LEAN = { reflections: false, gi: false }
    /** The lean pipeline's compile, held until the test lets it finish. */
    const holdCompile = () => {
      let finish!: () => void
      mocks.lean.warm.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      )
      return () => act(async () => finish())
    }

    for (const quality of ['lite', 'high', 'ultra'] as const)
      it(`builds the ${quality} tier's own pipeline, asking for no extras`, async () => {
        await render({ quality })
        expect(mocks.create).toHaveBeenCalledOnce()
        expect(mocks.create.mock.calls[0]).toEqual([
          mocks.state.gl,
          mocks.state.scene,
          camera,
          quality,
        ])
      })

    it('drops screen-space GI and reflections at the next rest after slow moves, once', async () => {
      const compiled = holdCompile()
      await render({ quality: 'ultra' })
      settle()
      // 60 ms frames while dragging: too slow, but nothing is rebuilt mid-drag.
      drag(40, 60)
      expect(mocks.create).toHaveBeenCalledOnce()
      frame()
      expect(mocks.create).toHaveBeenCalledTimes(2)
      expect(mocks.create).toHaveBeenLastCalledWith(
        mocks.state.gl,
        mocks.state.scene,
        camera,
        'ultra',
        LEAN,
      )
      // The scene keeps its tier: the tracer's session is the same one, never remade.
      expect(mocks.session).toHaveBeenCalledOnce()
      // The current pipeline draws on while the lean one compiles.
      mocks.pipe.render.mockClear()
      drag(5, 16)
      expect(mocks.pipe.render).toHaveBeenCalledTimes(5)
      expect(mocks.pipe.dispose).not.toHaveBeenCalled()
      // Ready while the view rests, part of the way to starting a trace.
      frame()
      frame()
      frame()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      await compiled()
      frame()
      expect(mocks.pipe.dispose).toHaveBeenCalledOnce()
      // Its temporal passes settle from scratch before the next trace captures a frame of it.
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledTimes(2)
      const capture = mocks.trace.begin.mock.invocationCallOrder[1]
      const leanFrames = mocks.lean.render.mock.invocationCallOrder.filter((at) => at < capture)
      expect(leanFrames.length).toBeGreaterThanOrEqual(3)
      mocks.pipe.render.mockClear()
      drag(40, 60)
      expect(mocks.lean.render).toHaveBeenCalled()
      expect(mocks.pipe.render).not.toHaveBeenCalled()
      settle()
      // Once per session.
      expect(mocks.create).toHaveBeenCalledTimes(2)
    })

    it('swaps in a pipeline that finished compiling mid-drag only once the view rests', async () => {
      const compiled = holdCompile()
      await render({ quality: 'ultra' })
      settle()
      drag(40, 60)
      frame()
      expect(mocks.create).toHaveBeenCalledTimes(2)
      act(() => canvas.dispatchEvent(new Event('pointerdown')))
      camera.position.x += 0.01
      frame(16)
      await compiled()
      for (let i = 0; i < 5; i++) {
        camera.position.x += 0.01
        frame(16)
      }
      expect(mocks.pipe.dispose).not.toHaveBeenCalled()
      expect(mocks.lean.render).not.toHaveBeenCalled()
      act(() => window.dispatchEvent(new Event('pointerup')))
      frame()
      expect(mocks.pipe.dispose).toHaveBeenCalledOnce()
      expect(mocks.lean.render).toHaveBeenCalledOnce()
    })

    for (const [quality, ms] of [
      ['ultra', 1000 / 60],
      ['high', 120],
      ['lite', 120],
    ] as const)
      it(`keeps the ${quality} pipeline at ${Math.round(ms)} ms frames`, async () => {
        await render({ quality })
        settle()
        for (let i = 0; i < 5; i++) {
          drag(60, ms)
          settle()
        }
        expect(mocks.create).toHaveBeenCalledOnce()
      })

    it('leaves frames that stop a trace, and the next, out of its measure', async () => {
      // Turning out of a resting trace without a pointer (auto-rotate, keys): the frame that halts
      // the trace and the one after carry its GPU work and halt, not the raster's own cost.
      await render({ quality: 'ultra' })
      settle()
      for (let i = 0; i < 30; i++) {
        for (const ms of [400, 400, 16]) {
          camera.position.x += 0.01
          frame(ms)
        }
        settle()
      }
      expect(mocks.trace.begin.mock.calls.length).toBeGreaterThan(30)
      expect(mocks.create).toHaveBeenCalledOnce()
    })

    it('leaves the frames after scans arrive out of its measure, while they upload', async () => {
      await render({ quality: 'ultra' })
      settle()
      // Mid-drag, scans arrive every 13 frames; the 8 frames after each are slow, the rest smooth.
      drag(13 * 12, 16, (i) => {
        if (i % 13 === 0) mocks.materialListeners.forEach((listener) => listener('textures'))
        return i % 13 <= 8 ? 200 : 16
      })
      settle()
      expect(mocks.create).toHaveBeenCalledOnce()
    })

    it('keeps tracing through a view offset a background compile leaves on the camera', async () => {
      // A fractional pixel ratio: the drawing buffer's aspect is not quite the canvas's. TRAA
      // leaves the camera at the drawing buffer's after each render (setViewOffset sets the
      // aspect; clearViewOffset keeps it), so that is the aspect a still view holds.
      mocks.buffer = { w: 1500, h: 937 }
      mocks.pipe.render.mockImplementation(() => {
        camera.setViewOffset(1500, 937, 0.3, -0.2, 1500, 937)
        camera.clearViewOffset()
      })
      camera.aspect = 1000 / 625
      camera.updateProjectionMatrix()
      await render({ quality: 'ultra' })
      settle()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      mocks.trace.halt.mockClear()
      // TRAA's jitter, with the aspect of a target not sized yet, as its first update leaves them
      // when it runs outside a pipeline render.
      camera.setViewOffset(1, 1, -0.19, 0.28, 1, 1)
      frame()
      frame()
      expect(mocks.trace.halt).not.toHaveBeenCalled()
      expect(mocks.trace.begin).toHaveBeenCalledOnce()
      expect(camera.view?.enabled ?? false).toBe(false)
      expect(camera.aspect).toBeCloseTo(1500 / 937, 10)
    })

    it('disposes a lean pipeline still compiling when the view closes', async () => {
      const compiled = holdCompile()
      await render({ quality: 'ultra' })
      settle()
      drag(40, 60)
      frame()
      expect(mocks.create).toHaveBeenCalledTimes(2)
      act(() => root.unmount())
      expect(mocks.lean.dispose).not.toHaveBeenCalled()
      await compiled()
      expect(mocks.lean.dispose).toHaveBeenCalledOnce()
      expect(mocks.lean.render).not.toHaveBeenCalled()
      root = createRoot(host)
    })

    it('disposes a compiled lean pipeline that never took over when the view closes', async () => {
      const compiled = holdCompile()
      await render({ quality: 'ultra' })
      settle()
      drag(40, 60)
      frame()
      act(() => canvas.dispatchEvent(new Event('pointerdown')))
      await compiled()
      act(() => root.unmount())
      expect(mocks.lean.dispose).toHaveBeenCalledOnce()
      expect(mocks.pipe.dispose).toHaveBeenCalledOnce()
      root = createRoot(host)
    })
  })
})
