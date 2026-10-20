// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PerspectiveCamera, Scene, Vector3, type Vector2 } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skyLook } from '../lib/visuals'
import { textureProgress } from '../render/progress'
import { ProgressiveRenderer } from './ProgressiveRenderer'

const mocks = vi.hoisted(() => ({
  frames: new Map<number, () => void>(),
  state: {} as Record<string, unknown>,
  backend: 'webgpu',
  load: vi.fn(),
  signature: 1,
  /** The canvas's drawing buffer, in device pixels. */
  buffer: { w: 1000, h: 625 },
  beginFrame: vi.fn(),
  pipe: {
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
  trace: {
    begin: vi.fn(),
    halt: vi.fn(),
    step: vi.fn(),
    view: vi.fn(),
    invalidate: vi.fn(),
    texturesChanged: vi.fn(),
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
vi.mock('../render/pipeline', () => ({ createPipeline: () => mocks.pipe }))
vi.mock('../render/renderer', () => ({
  backendOf: () => mocks.backend,
  beginFrame: mocks.beginFrame,
  FRAME_BEGIN: -1000,
}))
vi.mock('./presentation', () => ({ createProgressivePresentation: () => mocks.present }))
vi.mock('../render/pathtrace', () => ({
  loadTracerModule: mocks.load,
  sceneSignature: () => mocks.signature,
  lookKey: () => 'look',
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
  const frame = () =>
    act(() => {
      now += 32
      for (const [, callback] of [...mocks.frames].sort(([a], [b]) => a - b)) callback()
    })
  const settle = () => {
    for (let i = 0; i < 15; i++) frame()
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
    mocks.backend = 'webgpu'
    mocks.signature = 1
    mocks.buffer = { w: 1000, h: 625 }
    mocks.load.mockResolvedValue({})
    mocks.trace.step.mockReturnValue(true)
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
      expect(now).toBeGreaterThanOrEqual(150)
    })

  it('refines Lite on a budget: a reduced-scale trace with fewer samples and bounces', async () => {
    await render({ quality: 'lite' })
    settle()
    expect(mocks.session).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
      expect.objectContaining({ maxBounces: 4 }),
    )
    expect(mocks.trace.begin).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      128,
      0.5,
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

  it('keeps decoded scans while its tracer lives, and releases them when it goes', async () => {
    await render()
    settle()
    expect(mocks.keepDecoded).toHaveBeenCalledWith(true)
    expect(mocks.keepDecoded.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.session.mock.invocationCallOrder[0],
    )
    act(() => root.unmount())
    expect(mocks.keepDecoded).toHaveBeenLastCalledWith(false)
    root = createRoot(host)
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
})
