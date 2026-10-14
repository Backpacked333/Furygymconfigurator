import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu'
import { createPipeline } from './pipeline'

const mock = vi.hoisted(() => {
  const resources: {
    kind: string
    dispose: ReturnType<typeof vi.fn>
    setSize: ReturnType<typeof vi.fn>
  }[] = []
  const disposed: string[] = []
  const settings = { fail: '', renderFail: false }
  function node(): unknown {
    const values = new Map<string | symbol, unknown>()
    return new Proxy(() => node(), {
      get: (_, key) => {
        if (!values.has(key)) values.set(key, node())
        return values.get(key)
      },
      set: (_, key, value) => {
        values.set(key, value)
        return true
      },
    })
  }
  function tracked(kind: string) {
    if (settings.fail === kind) throw new Error(`Failed ${kind}`)
    const resource = Object.assign(node() as object, {
      kind,
      dispose: vi.fn(() => disposed.push(kind)),
      setSize: vi.fn(),
      _separableBlurMaterials: [{}],
      render: vi.fn(() => {
        if (settings.renderFail) throw new Error('Render failed')
      }),
    }) as (typeof resources)[number]
    resources.push(resource)
    return resource
  }
  return { resources, disposed, settings, node, tracked, restore: vi.fn() }
})
vi.mock('three/webgpu', () => ({
  RenderPipeline: class {
    constructor() {
      return mock.tracked('pipeline')
    }
  },
  RendererUtils: { saveRendererState: () => ({}), restoreRendererState: mock.restore },
  UnsignedByteType: 1,
}))
vi.mock('three/tsl', () => ({
  builtinAOContext: mock.node,
  diffuseColor: mock.node(),
  emissive: mock.node(),
  float: mock.node,
  interleavedGradientNoise: mock.node,
  mix: mock.node,
  mrt: mock.node,
  normalView: mock.node(),
  output: mock.node(),
  packNormalToRGB: mock.node,
  pass: () => mock.tracked('pass'),
  renderOutput: mock.node,
  rtt: () => mock.tracked('rtt'),
  sample: mock.node,
  screenCoordinate: mock.node(),
  screenUV: mock.node(),
  smoothstep: mock.node,
  unpackRGBToNormal: mock.node,
  vec3: mock.node,
  vec4: mock.node,
  velocity: mock.node(),
}))
vi.mock('three/addons/tsl/display/GTAONode.js', () => ({ ao: () => mock.tracked('ao') }))
vi.mock('three/addons/tsl/display/BloomNode.js', () => ({ bloom: () => mock.tracked('bloom') }))
vi.mock('three/addons/tsl/display/SSGINode.js', () => ({ ssgi: () => mock.tracked('ssgi') }))
vi.mock('three/addons/tsl/display/TRAANode.js', () => ({ traa: () => mock.tracked('traa') }))

describe('pipeline resource ownership', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    mock.resources.length = 0
    mock.disposed.length = 0
    mock.settings.fail = ''
    mock.settings.renderFail = false
    mock.restore.mockClear()
    vi.stubGlobal('window', { location: { search: '' } })
  })
  const renderer = { xr: { enabled: true } } as WebGPURenderer
  const scene = {} as Scene
  const camera = {
    isPerspectiveCamera: true,
    view: { enabled: false },
    updateProjectionMatrix: vi.fn(),
  } as unknown as Camera
  it.each([
    ['lite', ['pipeline', 'pass']],
    ['high', ['pipeline', 'pass', 'ao', 'pass', 'bloom', 'rtt', 'traa']],
    ['ultra', ['pipeline', 'pass', 'ao', 'pass', 'bloom', 'ssgi', 'rtt', 'traa']],
  ] as const)(
    'owns every pass/effect/intermediate of %s and disposes once in reverse order',
    (tier, kinds) => {
      const pipeline = createPipeline(renderer, scene, camera, tier)
      expect(mock.resources.map((r) => r.kind)).toEqual(kinds)
      pipeline.dispose()
      pipeline.dispose()
      expect(mock.disposed).toEqual([...kinds].reverse())
      expect(mock.resources.every((r) => r.dispose.mock.calls.length === 1)).toBe(true)
    },
  )
  it.each(['pass', 'ao', 'bloom', 'ssgi', 'rtt', 'traa'])(
    'cleans partial construction on %s failure',
    (kind) => {
      mock.settings.fail = kind
      expect(() => createPipeline(renderer, scene, camera, 'ultra')).toThrow(`Failed ${kind}`)
      expect(mock.resources.every((r) => r.dispose.mock.calls.length === 1)).toBe(true)
    },
  )
  it('only resets temporal history on an explicit reset or drawing-buffer size change', () => {
    const pipeline = createPipeline(renderer, scene, camera, 'high')
    const history = mock.resources.find((r) => r.kind === 'traa')!
    pipeline.resize(1600, 900)
    pipeline.resize(1600, 900)
    expect(history.setSize).toHaveBeenCalledTimes(1)
    pipeline.resetHistory()
    pipeline.resize(3840, 2160)
    expect(history.setSize).toHaveBeenCalledTimes(3)
    pipeline.dispose()
  })
  it('shrinks every owned pass/effect/input buffer immediately after large capture', () => {
    const pipeline = createPipeline(renderer, scene, camera, 'ultra')
    pipeline.resize(3840, 2160)
    pipeline.resize(1600, 900)
    pipeline.resize(1600, 900)
    for (const resource of mock.resources.filter((r) => !['pipeline', 'traa'].includes(r.kind))) {
      expect(resource.setSize).toHaveBeenCalledTimes(2)
      expect(resource.setSize).toHaveBeenLastCalledWith(1600, 900)
    }
    expect(mock.resources.find((r) => r.kind === 'traa')!.setSize).toHaveBeenLastCalledWith(1, 1)
  })
  it('restores renderer and camera view state even on render submission error', () => {
    const pipeline = createPipeline(renderer, scene, camera, 'high')
    mock.settings.renderFail = true
    expect(() => pipeline.render()).toThrow('Render failed')
    expect(mock.restore).toHaveBeenCalledOnce()
    expect((camera as unknown as { view: unknown }).view).toEqual({ enabled: false })
    pipeline.dispose()
  })
})
