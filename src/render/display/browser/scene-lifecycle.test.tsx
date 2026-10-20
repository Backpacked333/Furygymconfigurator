// @vitest-environment jsdom
/** CPU orchestration tests. All renderer/root/PNG boundaries are INERT test doubles.
 * No actual WebGPU, browser start, capture, service publication or qualification. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three/webgpu'
import { bindDisplay, DISPLAY_PROTOCOL } from '../../../display/contract'
import { defaultDesign, type DesignEnvelope } from '../../../domain/design'
import { createSceneDesignFixtures } from '../../../domain/designFixtures'
import type { RigObservation } from '../observation'
import { createDisplayScene } from './scene'

const test = vi.hoisted(() => ({
  create: vi.fn(),
  root: vi.fn(),
  advance: vi.fn(),
  wait: vi.fn(),
  pipelines: [] as {
    warm: ReturnType<typeof vi.fn>
    render: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }[],
  observations: [] as import('../observation').RigObservation[],
  configurations: [] as unknown[],
  current: null as unknown,
  observer: null as unknown,
  change: null as unknown,
  late: false,
  failWarm: false,
  holdMirror: false,
}))
vi.mock('@react-three/fiber', () => ({
  createRoot: test.root,
  extend: vi.fn(),
  useFrame: vi.fn(),
  unmountComponentAtNode: (_canvas: unknown, done: () => void) => {
    unmount()
    done()
  },
}))
vi.mock('../../renderer', () => ({
  createRenderer: test.create,
  backendOf: () => 'webgpu',
  beginFrame: vi.fn(),
}))
vi.mock('../../materials', () => ({
  whenMaterialLoaded: test.wait,
  materialLoaded: () => true,
  setMaxAnisotropy: vi.fn(),
  onMaterialsChanged: (fn: unknown) => {
    test.change = fn
    return () => {}
  },
}))
vi.mock('../../pipeline', () => ({
  createPipeline: (renderer: { compileAsync: () => Promise<void> }) => {
    const value = {
      setPlace: vi.fn(),
      shutter: { value: 0 },
      settleFrames: 40,
      warm: vi.fn(async () => {
        if (test.failWarm) throw new Error('test shader failure')
        await renderer.compileAsync()
      }),
      render: vi.fn(() => {
        if (test.late) {
          test.late = false
          ;(test.change as (kind: string) => void)('textures')
        }
      }),
      dispose: vi.fn(),
    }
    test.pipelines.push(value)
    return value
  },
}))
vi.mock('../../../components/StudioModel', () => ({ StudioModel: () => null }))
vi.mock('../../../components/Atmosphere', () => ({ Atmosphere: () => null }))
vi.mock('../../../components/InteriorProbe', () => ({
  InteriorProbe: () => null,
  SiteProbe: () => null,
}))
vi.mock('../../../components/Landscape', () => ({ Landscape: () => null }))
vi.mock('../../siteLightNode', () => ({ disposePrivateSiteFieldWorker: vi.fn() }))
vi.mock('./resources', () => ({
  observeDisplayResources: () => ({
    ready: () => true,
    wait: async () => {},
    close: vi.fn(),
    check: vi.fn(),
  }),
}))
const h = `sha256:${'1'.repeat(64)}` as const
const build = {
  sourceManifestDigest: h,
  assetManifestDigest: h,
  bundleDigest: h,
  lockfileDigest: h,
  runtimePolicyDigest: h,
  threeRevision: THREE.REVISION,
}
const sessionId = 'scene_test_session_00000000000000'
let scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: { setSize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
let unmount = vi.fn()
let unit: THREE.Group
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.clearAllMocks()
  test.pipelines = []
  test.observations = []
  test.configurations = []
  test.late = false
  test.failWarm = false
  test.holdMirror = false
  const adapter = {
    info: {
      vendor: 'NVIDIA',
      architecture: 'TEST ONLY',
      device: 'TEST',
      description: 'INERT MOCK',
      isFallbackAdapter: false,
    },
    isFallbackAdapter: false,
  }
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Chrome/137.0.7118.2',
  })
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => adapter },
  })
  vi.stubGlobal('createImageBitmap', async () => ({
    width: camera.aspect === 1.6 ? 1600 : 1200,
    height: camera.aspect === 1.6 ? 1000 : 1500,
    close() {},
  }))
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
  ) {
    // This is deliberately NOT a valid PNG. Only tests the scene encoder boundary, never exported.
    const bytes = new Uint8Array(44)
    callback({
      arrayBuffer: async () => bytes.buffer,
      size: 44,
      type: 'image/png',
    } as unknown as Blob)
  })
  const device = Object.assign(new EventTarget(), {
    queue: { onSubmittedWorkDone: async () => {} },
    destroy: vi.fn(),
  })
  renderer = { setSize: vi.fn(), dispose: vi.fn() }
  test.create.mockImplementation(async () => {
    await (
      navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }
    ).gpu.requestAdapter()
    return {
      ...renderer,
      backend: { device },
      compileAsync: async () => {},
      info: { calls: 0 },
      debug: {},
      getMaxAnisotropy: () => 1,
      setPixelRatio: vi.fn(),
    }
  })
  unmount = vi.fn()
  test.root.mockImplementation(() => ({
    configure: vi.fn(async (state: { scene?: THREE.Scene; camera?: THREE.PerspectiveCamera }) => {
      if (state.scene && state.camera) {
        scene = state.scene
        camera = state.camera
        unit = new THREE.Group()
        unit.userData.unit = true
        scene.add(unit)
      }
    }),
    render: (element: {
      props: { children: { props: { config: { mirror: boolean }; observation: RigObservation } } }
    }) => {
      const { config, observation } = element.props.children.props
      test.observations.push(observation)
      test.configurations.push(config)
      test.observer = observation
      unit.clear()
      for (let n = 0; n < 12; n++)
        unit.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial()))
      if (config.mirror && !test.holdMirror) {
        const material = new THREE.MeshStandardNodeMaterial()
        material.userData.pathTrace = true
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material)
        mesh.userData.noProbe = true
        unit.add(mesh)
      }
      observation.complete('react-commit')
      observation.complete('site-field')
      return { getState: () => ({ advance: test.advance }) }
    },
    unmount,
  }))
  test.advance.mockImplementation(() => {
    const observer = test.observer as RigObservation
    if (observer.permitted('environment')) observer.complete('environment')
    if (observer.permitted('interior-probe')) observer.complete('interior-probe')
    if (observer.permitted('site-probe')) observer.complete('site-probe')
  })
  test.wait.mockResolvedValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})
async function job(design: DesignEnvelope, revision: number) {
  return {
    protocol: DISPLAY_PROTOCOL,
    jobId: 'job_test_000000000000000000000000',
    sessionId,
    binding: await bindDisplay(design, build),
    design,
    revision,
  }
}
async function settle<T>(promise: Promise<T>) {
  let result: T | undefined,
    error: unknown,
    done = false
  void promise.then(
    (value) => {
      result = value
      done = true
    },
    (value) => {
      error = value
      done = true
    },
  )
  await vi.waitFor(() => expect(done).toBe(true), { timeout: 20_000, interval: 25 })
  if (error) throw error
  return result!
}
describe(
  'actual reusable scene driver with inert resource/root/renderer boundaries',
  { timeout: 30_000 },
  () => {
    it('retains one renderer/root/scene across fixtures A→B→A, named view/aspect changes, and reconstructs temporal history every revision', async () => {
      const driver = await createDisplayScene(build, sessionId)
      const fixtures = createSceneDesignFixtures().map((f) => f.design)
      const designs = [
        ...fixtures,
        fixtures[0],
        {
          ...defaultDesign(),
          presentation: {
            ...defaultDesign().presentation,
            aspect: 'tall' as const,
            cameraRef: fixtures[1].presentation.cameraRef,
          },
        },
      ]
      let retained: THREE.Scene | undefined
      for (let i = 0; i < designs.length; i++) {
        const reply = await settle(driver.render(await job(designs[i], i + 1)))
        expect(reply.receipt.revision).toBe(i + 1)
        expect(reply.receipt.readiness.revision).toBe(i + 1)
        expect(reply.receipt.readiness.postReadyFrames).toBeGreaterThanOrEqual(2)
        retained ??= scene
        expect(scene).toBe(retained)
        expect(test.configurations.at(-1)).toMatchObject({
          family: designs[i].config.product.family,
        })
      }
      expect(test.create).toHaveBeenCalledOnce()
      expect(test.root).toHaveBeenCalledOnce()
      expect(renderer.setSize).toHaveBeenLastCalledWith(1200, 1500, false)
      expect(test.pipelines).toHaveLength(designs.length)
      expect(test.pipelines.slice(0, -1).every((p) => p.dispose.mock.calls.length === 1)).toBe(true)
      const first = test.observations[0]
      expect(first.active()).toBe(false)
      first.complete('environment')
      expect(test.observations.at(-1)!.active()).toBe(false)
      await driver.close()
      expect(unmount).toHaveBeenCalledOnce()
      expect(renderer.dispose).toHaveBeenCalledOnce()
    }, 30_000)
    it('resource notifications discard history and fence the old epoch before settling', async () => {
      const driver = await createDisplayScene(build, sessionId)
      test.late = true
      await settle(driver.render(await job(defaultDesign(), 1)))
      expect(test.pipelines).toHaveLength(2)
      expect(test.pipelines[0].dispose).toHaveBeenCalledOnce()
      expect(test.observations[0].active()).toBe(false)
      expect(test.wait.mock.calls.length).toBeGreaterThanOrEqual(24)
      await driver.close()
    })
    it('does not acknowledge an effect-created mirror that has not mounted; bounded failure poisons subsequent reuse', async () => {
      const driver = await createDisplayScene(build, sessionId)
      test.holdMirror = true
      const design = createSceneDesignFixtures().find(
        (f) => f.design.config.appearance.mirror,
      )!.design
      await expect(settle(driver.render(await job(design, 1)))).rejects.toThrow(
        'Display readiness/frame cap',
      )
      expect(test.wait).not.toHaveBeenCalled()
      await expect(driver.render(await job(defaultDesign(), 2))).rejects.toThrow()
      await driver.close()
    })
    it('warm/compile failure never encodes or reuses the scene', async () => {
      const driver = await createDisplayScene(build, sessionId)
      test.failWarm = true
      await expect(settle(driver.render(await job(defaultDesign(), 1)))).rejects.toThrow(
        'shader failure',
      )
      expect(HTMLCanvasElement.prototype.toBlob).not.toHaveBeenCalled()
      await expect(driver.render(await job(defaultDesign(), 2))).rejects.toThrow()
      await driver.close()
    })
  },
)
