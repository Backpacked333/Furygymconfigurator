// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PerspectiveCamera, Scene } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skyLook } from '../lib/visuals'
import { ProgressiveRenderer } from './ProgressiveRenderer'

const mocks = vi.hoisted(() => ({
  frames: new Map<number, () => void>(),
  state: {} as Record<string, unknown>,
  backend: 'webgpu',
  load: vi.fn(),
  keepDecoded: vi.fn(),
  signature: 1,
  beginFrame: vi.fn(),
  pipe: { render: vi.fn(), dispose: vi.fn(), setPlace: vi.fn(), settleFrames: 10 },
  present: { capture: vi.fn(), render: vi.fn(), dispose: vi.fn() },
  trace: {
    begin: vi.fn(),
    halt: vi.fn(),
    step: vi.fn(),
    view: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  },
}))
vi.mock('@react-three/fiber', () => ({
  useThree: () => mocks.state,
  useFrame: (callback: () => void, priority = 0) => mocks.frames.set(priority, callback),
}))
vi.mock('../render/materials', () => ({
  onMaterialsChanged: () => () => {},
  keepDecodedTextures: mocks.keepDecoded,
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
    constructor() {
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
    mocks.backend = 'webgpu'
    mocks.signature = 1
    mocks.load.mockResolvedValue({})
    mocks.keepDecoded.mockResolvedValue([])
    mocks.trace.step.mockReturnValue(true)
    mocks.trace.view.mockReturnValue({ from: null, to: {}, t: 1 })
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    canvas = document.createElement('canvas')
    camera = new PerspectiveCamera()
    mocks.state = {
      gl: { domElement: canvas },
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

  it('keeps scans decoded for the tracer before tracing and releases them on unmount', async () => {
    let restored!: () => void
    mocks.keepDecoded.mockImplementationOnce(
      () => new Promise<void>((resolve) => (restored = resolve)),
    )
    await render()
    expect(mocks.keepDecoded).toHaveBeenCalledWith(true)
    settle()
    expect(mocks.trace.begin).not.toHaveBeenCalled()
    await act(async () => restored())
    settle()
    expect(mocks.trace.begin).toHaveBeenCalledOnce()
    act(() => root.unmount())
    expect(mocks.keepDecoded).toHaveBeenLastCalledWith(false)
    root = createRoot(host)
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
})
