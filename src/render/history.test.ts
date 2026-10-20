import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Scene,
  StorageTexture,
  type WebGPURenderer,
} from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_SETTLE_SAMPLES } from './adaptive'
import {
  GBuffer,
  HISTORY_SHARE,
  MultiViewHistory,
  RESTYLED_SAMPLES,
  ViewHistory,
  historyCap,
  historyWeights,
  materialHistoryWeight,
  type HistoryKeys,
} from './history'

const keys = (scene: number, surfaces = scene): HistoryKeys => ({ scene, surfaces })

const standard = (roughness: number, metalness = 0) => {
  const m = new MeshStandardNodeMaterial()
  m.roughness = roughness
  m.metalness = metalness
  return m
}

describe('history weights', () => {
  it('reuses rough dielectrics and leaves per-texel roughness and metalness to the GPU', () => {
    expect(materialHistoryWeight(standard(1))).toBe(1)
    // Raster roughness and metalness (maps included) are applied per pixel in the G-buffer.
    expect(materialHistoryWeight(standard(0.1, 1))).toBe(1)
  })

  it('never reuses glass, unlit surfaces, or stand-ins that trace as mirrors', () => {
    const glass = new MeshPhysicalNodeMaterial()
    glass.transmission = 1
    expect(materialHistoryWeight(glass)).toBe(0)
    // Unlit meshes (helpers, the raster sky) are hidden from the tracer.
    expect(materialHistoryWeight(new MeshBasicNodeMaterial())).toBe(0)
    const mirror = new MeshBasicNodeMaterial()
    mirror.userData.pathTrace = { color: new Color('#e3ebe5'), metalness: 1, roughness: 0.015 }
    expect(materialHistoryWeight(mirror)).toBe(0)
  })

  it('weighs stand-ins and clear coats by how much their reflection moves with the eye', () => {
    const leaf = new MeshStandardNodeMaterial()
    leaf.userData.pathTrace = { color: new Color('#5f7a3c'), roughness: 0.7 }
    expect(materialHistoryWeight(leaf)).toBe(1)
    const lacquer = new MeshPhysicalNodeMaterial()
    lacquer.roughness = 1
    lacquer.clearcoat = 0.6
    expect(materialHistoryWeight(lacquer)).toBeCloseTo(0.4)
  })

  it('gives nothing to meshes the tracer excludes, however deep', () => {
    const scene = new Scene()
    const helpers = new Group()
    helpers.userData.pathTrace = false
    const inner = new Group()
    const line = new Mesh(new BoxGeometry(), standard(1))
    inner.add(line)
    helpers.add(inner)
    const wall = new Mesh(new BoxGeometry(), standard(1))
    const pane = new MeshPhysicalNodeMaterial()
    pane.transmission = 1
    const framed = new Mesh(new BoxGeometry(), [standard(1), pane])
    scene.add(helpers, wall, framed)
    const weights = historyWeights(scene)
    expect(weights.get(line)).toBe(0)
    expect(weights.get(wall)).toBe(1)
    // A mesh with any glass in it is reused nowhere.
    expect(weights.get(framed)).toBe(0)
  })
})

describe('multi-view retention (GPU copies mocked)', () => {
  afterEach(() => vi.restoreAllMocks())
  function fixture(width = 1000, height = 600) {
    const store = vi.spyOn(ViewHistory.prototype, 'store').mockImplementation(() => {})
    const seed = vi.spyOn(ViewHistory.prototype, 'seed').mockReturnValue(true)
    const dispose = vi.spyOn(ViewHistory.prototype, 'dispose').mockImplementation(() => {})
    const history = new MultiViewHistory()
    const gbuffer = new GBuffer()
    const renderer = {} as WebGPURenderer
    const targets = {
      outputTarget: new StorageTexture(width, height),
      sampleCountTarget: new StorageTexture(width, height),
    }
    const save = (x: number, z: number, traced = keys(1)) => {
      gbuffer.position.set(x, 0, z)
      history.store(renderer, targets, gbuffer, traced)
    }
    const reuse = (x: number, z: number, traced = keys(1)) => {
      gbuffer.position.set(x, 0, z)
      return history.seed(renderer, targets, gbuffer, traced, 1024)
    }
    return { history, store, seed, dispose, save, reuse, targets }
  }
  it('revisits an older matching angle instead of the most recently stored one', () => {
    const f = fixture()
    f.save(0, 20)
    f.save(20, 0)
    f.save(0, -20)
    expect(f.reuse(0, 20)).toBe(true)
    expect(f.seed.mock.instances[0]).toBe(f.store.mock.instances[0])
    f.history.dispose()
    expect(f.dispose).toHaveBeenCalledTimes(3)
  })
  it('evicts the least recently used view and replaces nearby views rather than growing', () => {
    const f = fixture()
    f.save(0, 20)
    f.save(20, 0)
    f.save(0, -20)
    f.reuse(0, 20)
    f.save(-20, 0)
    expect(f.store.mock.instances[3]).toBe(f.store.mock.instances[1])
    f.save(-20.01, 0)
    expect(f.store.mock.instances[4]).toBe(f.store.mock.instances[3])
    f.history.dispose()
    expect(f.dispose).toHaveBeenCalledTimes(3)
  })
  it('rejects old lighting/geometry signatures and releases incompatible-size storage', () => {
    const f = fixture()
    f.save(0, 20)
    expect(f.reuse(0, 20, keys(2))).toBe(false)
    f.save(0, 20, keys(2))
    expect(f.dispose).toHaveBeenCalledTimes(1)
    f.targets.outputTarget.setSize(900, 600, 1)
    f.save(0, 20, keys(2))
    expect(f.dispose).toHaveBeenCalledTimes(2)
    f.history.clear()
    expect(f.reuse(0, 20, keys(2))).toBe(false)
  })
  it('keeps the orbit across an edit of surfaces alone, and seeds from it', () => {
    const f = fixture()
    f.save(0, 20, keys(1, 1))
    f.save(20, 0, keys(1, 1))
    // A finish edit: the next views are of other surfaces, the scene is the same.
    f.save(0, -20, keys(1, 2))
    expect(f.dispose).not.toHaveBeenCalled()
    expect(f.reuse(0, 20, keys(1, 2))).toBe(true)
    expect(f.seed).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      keys(1, 2),
      1024,
    )
    // Another scene (a door, a light, the time of day): all of it goes.
    f.save(0, 20, keys(3, 2))
    expect(f.dispose).toHaveBeenCalledTimes(3)
  })
  it('seeds from a view of the surfaces on screen before a slightly nearer one of the old', () => {
    const f = fixture()
    f.save(0, 20, keys(1, 1))
    f.save(5, 19, keys(1, 2))
    const [old, current] = f.store.mock.instances
    // Nearer the old view, but not by much: the current surfaces win.
    expect(f.reuse(2, 19, keys(1, 2))).toBe(true)
    expect(f.seed.mock.instances.at(-1)).toBe(current)
    // Asked for the old surfaces (say, the edit undone), the old view wins.
    expect(f.reuse(2, 19, keys(1, 1))).toBe(true)
    expect(f.seed.mock.instances.at(-1)).toBe(old)
    // Far nearer an old view than the only current one, across the unit: still the nearest.
    f.save(0, -20, keys(1, 3))
    expect(f.reuse(1, 20, keys(1, 3))).toBe(true)
    expect(f.seed.mock.instances.at(-1)).toBe(old)
  })
  it('does not allocate history beyond the memory ceiling', () => {
    const f = fixture(3840, 2160)
    f.save(0, 20)
    expect(f.store).not.toHaveBeenCalled()
    expect(f.reuse(0, 20)).toBe(false)
  })
})

describe('how much a view inherits', () => {
  it('takes up to three quarters of the target from a view of the same surfaces', () => {
    expect(HISTORY_SHARE).toBe(0.75)
    expect(historyCap(1024, true)).toBe(768)
    expect(historyCap(256, true)).toBe(192)
  })

  it('takes a few samples at most from a view of other surfaces, never more than settling needs', () => {
    // The adaptive sampler compares images from MIN_SETTLE_SAMPLES on: a seed no larger converges
    // away instead of being retired with the old light in it.
    expect(RESTYLED_SAMPLES).toBeLessThanOrEqual(MIN_SETTLE_SAMPLES)
    expect(historyCap(1024, false)).toBe(16)
    expect(historyCap(256, false)).toBe(16)
    // Lite's target: a sixteenth of it.
    expect(historyCap(128, false)).toBe(8)
    expect(historyCap(8, false)).toBe(0)
  })
})

describe('a stored view seeding the next (GPU dispatch mocked)', () => {
  afterEach(() => vi.restoreAllMocks())
  function fixture() {
    const renderer = { compute: vi.fn(), copyTextureToTexture: vi.fn() }
    const targets = {
      outputTarget: new StorageTexture(64, 32),
      sampleCountTarget: new StorageTexture(64, 32),
    }
    const gbuffer = new GBuffer()
    const history = new ViewHistory()
    const seed = (traced: HistoryKeys, target = 1024) =>
      history.seed(renderer as unknown as WebGPURenderer, targets, gbuffer, traced, target)
    history.store(renderer as unknown as WebGPURenderer, targets, gbuffer, keys(1, 1))
    const kernel = () =>
      (history as unknown as { kernel: { cap: number; restyled: number } }).kernel
    return { renderer, seed, kernel, history }
  }

  it('passes on its full share for the same surfaces, as camera moves always have', () => {
    const f = fixture()
    expect(f.seed(keys(1, 1))).toBe(true)
    expect(f.renderer.compute).toHaveBeenCalledOnce()
    expect(f.kernel().cap).toBe(768)
    expect(f.kernel().restyled).toBe(0)
  })

  it('passes on a few samples, no more than its own surfaces allowed, after a surface edit', () => {
    const f = fixture()
    expect(f.seed(keys(1, 2))).toBe(true)
    expect(f.kernel().cap).toBe(16)
    expect(f.kernel().restyled).toBe(1)
    expect(f.seed(keys(1, 2), 128)).toBe(true)
    expect(f.kernel().cap).toBe(8)
  })

  it('passes on nothing for another scene, or when the target leaves nothing to pass on', () => {
    const f = fixture()
    expect(f.seed(keys(2, 1))).toBe(false)
    expect(f.seed(keys(1, 2), 8)).toBe(false)
    expect(f.renderer.compute).not.toHaveBeenCalled()
    f.history.clear()
    expect(f.seed(keys(1, 1))).toBe(false)
  })
})
