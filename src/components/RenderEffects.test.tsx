// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Blob as NodeBlob } from 'node:buffer'
import { PerspectiveCamera, Vector2, Vector4 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderEffects } from './RenderEffects'
import { createCaptureRegistry, type CaptureRequest } from '../lib/capture'
import { createPresentationStore } from '../lib/presentation'

const mock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  render: vi.fn(),
  dispose: vi.fn(),
  reset: vi.fn(),
  resize: vi.fn(),
}))
vi.mock('@react-three/fiber', () => ({ useThree: () => mock.state, useFrame: vi.fn() }))
vi.mock('../render/pipeline', () => ({
  createPipeline: () => ({
    render: mock.render,
    dispose: mock.dispose,
    resetHistory: mock.reset,
    resize: mock.resize,
    settleFrames: 1,
  }),
}))
vi.mock('../render/materials', () => ({ onMaterialsChanged: () => () => {} }))
vi.mock('../render/renderer', () => ({
  deviceProfile: () => ({
    hardware: 'capable',
    maxTextureSize: 8192,
    memoryBudgetMB: 1536,
    backend: 'webgpu',
  }),
  observeRendererLoss: () => () => {},
}))
vi.mock('three/webgpu', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RendererUtils: {
    saveRendererState: (r: RendererDouble) => ({
      pixelRatio: r.ratio,
      target: r.target,
      exposure: r.toneMappingExposure,
      scissorTest: r.scissorTest,
    }),
    restoreRendererState: (
      r: RendererDouble,
      s: { pixelRatio: number; target: object | null; exposure: number; scissorTest: boolean },
    ) => {
      r.ratio = s.pixelRatio
      r.target = s.target
      r.toneMappingExposure = s.exposure
      r.scissorTest = s.scissorTest
    },
  },
}))

class RendererDouble {
  size = new Vector2(1600, 1200)
  ratio = 1.5
  viewport = new Vector4(2, 3, 1590, 1190)
  scissor = new Vector4(4, 5, 1580, 1180)
  scissorTest = true
  toneMappingExposure = 1.2
  target: object | null = { original: true }
  domElement = {
    toBlob: (done: (blob: Blob) => void) => {
      const bytes = new Uint8Array(24)
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
      bytes.set([73, 72, 68, 82], 12)
      const data = new DataView(bytes.buffer)
      data.setUint32(16, this.size.x * this.ratio)
      data.setUint32(20, this.size.y * this.ratio)
      done(new NodeBlob([bytes], { type: 'image/png' }) as unknown as Blob)
    },
  }
  getSize(v: Vector2) {
    return v.copy(this.size)
  }
  getDrawingBufferSize(v: Vector2) {
    return v.copy(this.size).multiplyScalar(this.ratio)
  }
  getViewport(v: Vector4) {
    return v.copy(this.viewport)
  }
  getScissor(v: Vector4) {
    return v.copy(this.scissor)
  }
  setSize(w: number, h: number) {
    this.size.set(w, h)
  }
  setPixelRatio(ratio: number) {
    this.ratio = ratio
  }
  setViewport(x: Vector4 | number, y?: number, w?: number, h?: number) {
    if (x instanceof Vector4) this.viewport.copy(x)
    else this.viewport.set(x, y!, w!, h!)
  }
  setScissor(x: Vector4 | number, y?: number, w?: number, h?: number) {
    if (x instanceof Vector4) this.scissor.copy(x)
    else this.scissor.set(x, y!, w!, h!)
  }
  setScissorTest(value: boolean) {
    this.scissorTest = value
  }
  setRenderTarget(target: object | null) {
    this.target = target
  }
}

describe('same-renderer capture state restoration (renderer double, not GPU evidence)', () => {
  let root: Root
  let gl: RendererDouble
  let camera: PerspectiveCamera
  let registry: ReturnType<typeof createCaptureRegistry>
  let store: ReturnType<typeof createPresentationStore>
  let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>
  let controls: { enabled: boolean }
  const mount = (qualityMode: 'auto' | 'high' = 'auto') =>
    act(() =>
      root.render(
        <RenderEffects
          quality="high"
          qualityMode={qualityMode}
          presentation={store}
          onCaptureProvider={registry.register}
          onError={onError}
        />,
      ),
    )
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    mock.render.mockReset()
    mock.dispose.mockReset()
    mock.reset.mockReset()
    mock.resize.mockReset()
    gl = new RendererDouble()
    camera = new PerspectiveCamera(32, 4 / 3, 0.1, 300)
    camera.position.set(20, 12, 45)
    controls = { enabled: true }
    mock.state = {
      gl,
      camera,
      scene: {},
      controls,
      invalidate: vi.fn(),
      size: { width: 1600, height: 1200 },
      viewport: { dpr: 1.5 },
      get: () => mock.state,
    }
    store = createPresentationStore({
      token: {
        generation: 1,
        revision: 1,
        view: 'exterior',
        camera: 'fixed',
        material: 'ready',
        presentation: 'day',
        quality: 'high',
        preview: false,
      },
      stage: 'settled',
      reasons: [],
      animating: false,
      rendered: { width: 2400, height: 1800 },
    })
    registry = createCaptureRegistry()
    onError = vi.fn()
    root = createRoot(document.createElement('div'))
    mount()
    store.set({ ...store.get(), stage: 'settled' })
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })
  const request = (): CaptureRequest => ({
    token: { ...store.get().token },
    mode: 'presentation',
    framing: 'center-crop',
    width: 3840,
    height: 2160,
  })
  const restored = () => {
    expect(gl.size.toArray()).toEqual([1600, 1200])
    expect(gl.ratio).toBe(1.5)
    expect(gl.viewport.toArray()).toEqual([2, 3, 1590, 1190])
    expect(gl.scissor.toArray()).toEqual([4, 5, 1580, 1180])
    expect(gl.scissorTest).toBe(true)
    expect(gl.target).toEqual({ original: true })
    expect(camera.fov).toBe(32)
    expect(camera.aspect).toBe(4 / 3)
    expect(camera.position.toArray()).toEqual([20, 12, 45])
    expect(controls.enabled).toBe(true)
    expect(store.capturing).toBe(false)
  }
  it('renders at requested native dimensions with crop FOV, then restores every saved field', async () => {
    mock.render.mockImplementation(() => {
      expect(gl.size.toArray()).toEqual([3840, 2160])
      expect(gl.ratio).toBe(1)
      expect(gl.target).toBeNull()
      expect(gl.scissorTest).toBe(false)
      expect(camera.aspect).toBe(16 / 9)
      expect(camera.fov).toBeLessThan(32)
      expect(controls.enabled).toBe(false)
    })
    expect(await registry.get()!.capture(request())).toMatchObject({
      status: 'ready',
      rendered: { width: 3840, height: 2160 },
      encoded: { width: 3840, height: 2160 },
    })
    restored()
  })
  it('restores after rendering failure and forwards recovery to Scene', async () => {
    mock.render.mockImplementation(() => {
      throw new Error('device lost')
    })
    expect((await registry.get()!.capture(request())).status).toBe('unavailable')
    expect(onError).toHaveBeenCalledOnce()
    restored()
  })
  it('cancels on resize and restores to the new live viewport rather than stale dimensions', async () => {
    gl.domElement.toBlob = () => {}
    const pending = registry.get()!.capture(request())
    mock.state.size = { width: 1200, height: 800 }
    mock.state.viewport = { dpr: 2 }
    mount()
    expect((await pending).status).toBe('cancelled')
    expect(gl.size.toArray()).toEqual([1200, 800])
    expect(gl.ratio).toBe(2)
    expect(camera.aspect).toBe(1.5)
    expect(controls.enabled).toBe(true)
  })
  it('changing only Auto policy does not rebuild pipelines or discard the provider', () => {
    const provider = registry.get()
    mount('high')
    expect(registry.get()).toBe(provider)
    expect(mock.dispose).not.toHaveBeenCalled()
  })
  it('cancels pending encoding when the presentation starts refining again', async () => {
    gl.domElement.toBlob = () => {}
    const pending = registry.get()!.capture(request())
    store.reset()
    expect((await pending).status).toBe('cancelled')
    restored()
  })
})
