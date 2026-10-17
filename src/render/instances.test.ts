// @vitest-environment jsdom
import { InstancedMesh, MeshStandardMaterial, PlaneGeometry, Scene } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'
import { skyLook } from '../lib/visuals'
import { captureScene, stableJson } from './cloud'
import { drawInstances, fillInstances, stillInstances } from './instances'
import { partsSignature, sceneParts } from './pathtrace'
import { DENSITY, thinned } from './scenery'
import { shrubShape, treeShape } from './vegetation'

// The sky map takes seconds to compute: a scene capture gets a tiny one.
vi.mock('./pathtrace', async (original) => {
  const actual = await original<typeof import('./pathtrace')>()
  const { DataTexture, FloatType, RGBAFormat } = await import('three/webgpu')
  const sky = new DataTexture(new Float32Array(8).fill(0.5), 2, 1, RGBAFormat, FloatType)
  return { ...actual, environmentTexture: () => sky }
})

const look = skyLook('residences', 16.5)
const card = new PlaneGeometry(0.3, 0.3)
const leaf = new MeshStandardMaterial({ color: '#557744' })

/** A hedge of `count` leaf cards, drawn as the first `drawn` of them. */
function hedge(count: number, drawn: number) {
  const scene = new Scene()
  const mesh = new InstancedMesh(card, leaf, count)
  mesh.userData = { parts: 'hedge' }
  const matrices = treeShape(3, 'courtyard', count).leaves
  fillInstances(mesh, matrices, drawn)
  scene.add(mesh)
  scene.updateMatrixWorld()
  return { scene, mesh }
}

describe('plants thinned by the raster tier', () => {
  it('are built at full density, and each tier draws the first of them', () => {
    for (const quality of ['ultra', 'high', 'lite'] as const) {
      const { count, drawn } = thinned(1500, quality, 300)
      expect(count).toBe(1800)
      expect(drawn).toBe(Math.round(1500 * DENSITY[quality]) + 300)
      expect(drawn).toBeLessThanOrEqual(count)
    }
    // Placed by their own index: a tier's cards are the first of the full set, as it always drew.
    const full = treeShape(1, 'courtyard', 1800).leaves
    const high = treeShape(1, 'courtyard', 1275).leaves
    expect(full.slice(0, 1275).map((m) => m.elements)).toEqual(high.map((m) => m.elements))
    const shrub = shrubShape(2, 1.2, 1.4, 190)
    const lite = shrubShape(2, 1.2, 1.4, 92)
    expect(shrub.leaves.slice(0, lite.leaves.length).map((m) => m.elements)).toEqual(
      lite.leaves.map((m) => m.elements),
    )
  })

  it('are captured and signed whole for the stills, whatever the tier draws', async () => {
    const ultra = hedge(1800, 1800)
    const lite = hedge(1800, 675)
    expect(lite.mesh.count).toBe(675)
    expect(stillInstances(lite.mesh)).toBe(1800)
    const [a, b] = await Promise.all([
      captureScene(ultra.scene, look),
      captureScene(lite.scene, look),
    ])
    expect(stableJson(b.scene)).toBe(stableJson(a.scene))
    expect([...b.blobs.keys()].sort()).toEqual([...a.blobs.keys()].sort())
    const key = 'residences'
    expect(partsSignature(sceneParts(lite.scene, 'exterior'), key)).toBe(
      partsSignature(sceneParts(ultra.scene, 'exterior'), key),
    )
  })

  it('change tier without touching what the stills see', () => {
    const { scene, mesh } = hedge(1800, 1800)
    const signed = partsSignature(sceneParts(scene, 'exterior'), 'k')
    const version = mesh.instanceMatrix.version
    drawInstances(mesh, 675)
    expect(mesh.count).toBe(675)
    expect(mesh.instanceMatrix.version).toBe(version)
    expect(partsSignature(sceneParts(scene, 'exterior'), 'k')).toBe(signed)
    // Never more than were put on it.
    drawInstances(mesh, 5000)
    expect(mesh.count).toBe(1800)
    // Its bounds hold every instance.
    const bounds = new InstancedMesh(card, leaf, 1800)
    bounds.instanceMatrix.array.set(mesh.instanceMatrix.array)
    bounds.computeBoundingSphere()
    expect(mesh.boundingSphere!.radius).toBeCloseTo(bounds.boundingSphere!.radius, 5)
  })
})
