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
import {
  GBuffer,
  MultiViewHistory,
  ViewHistory,
  historyWeights,
  materialHistoryWeight,
} from './history'

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
    const save = (x: number, z: number, signature = 1) => {
      gbuffer.position.set(x, 0, z)
      history.store(renderer, targets, gbuffer, signature)
    }
    const reuse = (x: number, z: number, signature = 1) => {
      gbuffer.position.set(x, 0, z)
      return history.seed(renderer, targets, gbuffer, signature, 1024)
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
    expect(f.reuse(0, 20, 2)).toBe(false)
    f.save(0, 20, 2)
    expect(f.dispose).toHaveBeenCalledTimes(1)
    f.targets.outputTarget.setSize(900, 600, 1)
    f.save(0, 20, 2)
    expect(f.dispose).toHaveBeenCalledTimes(2)
    f.history.clear()
    expect(f.reuse(0, 20, 2)).toBe(false)
  })
  it('does not allocate history beyond the memory ceiling', () => {
    const f = fixture(3840, 2160)
    f.save(0, 20)
    expect(f.store).not.toHaveBeenCalled()
    expect(f.reuse(0, 20)).toBe(false)
  })
})
