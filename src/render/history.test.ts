import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Scene,
} from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { historyWeights, materialHistoryWeight } from './history'

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
