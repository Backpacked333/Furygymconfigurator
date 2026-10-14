import {
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  createPilotModel,
  FEET_PER_METER,
  measuredBounds,
  type PilotModelContract,
} from './modelAdapter'

const contract: PilotModelContract = {
  id: 'synthetic-contract-test-not-a-comparison-asset',
  sourceUnits: 'meters',
  sourceUp: '+y',
  sourceForward: '-x',
  expectedDimensionsMeters: [2, 1, 0.5],
  dimensionToleranceMeters: 0.00001,
}
function fixture() {
  const geometry = new BoxGeometry(2, 1, 0.5)
  geometry.setAttribute('uv1', geometry.getAttribute('uv').clone())
  geometry.setAttribute(
    'tangent',
    new Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 4), 4),
  )
  const material = new MeshStandardMaterial()
  const mesh = new Mesh(geometry, material)
  mesh.position.set(4, 3, -7)
  const scene = new Group()
  scene.add(mesh)
  return { scene, mesh, geometry, material }
}

describe('Q11 static GLB adapter contract (synthetic tests, not visual evidence)', () => {
  it('converts meters exactly once, aligns -X to +Z and grounds the measured geometry', () => {
    const { scene, mesh } = fixture()
    const model = createPilotModel(scene, contract)
    const dims = model.dimensionsFeet
    expect(dims[0]).toBeCloseTo(0.5 * FEET_PER_METER, 10)
    expect(dims[1]).toBeCloseTo(FEET_PER_METER, 10)
    expect(dims[2]).toBeCloseTo(2 * FEET_PER_METER, 10)
    expect(model.envelope.min.y).toBeCloseTo(0, 10)
    expect(model.envelope.getCenter(new Vector3()).x).toBeCloseTo(0, 10)
    expect(model.envelope.getCenter(new Vector3()).z).toBeCloseTo(0, 10)
    const oriented = model.root.children[0].children[0]
    expect(new Vector3(-1, 0, 0).transformDirection(oriented.matrixWorld).z).toBeCloseTo(1, 10)
    expect(mesh.position.toArray()).toEqual([4, 3, -7])
    expect(scene.parent).toBeNull()
    expect(() => createPilotModel(model.root, contract)).toThrow(/twice/)
    model.release()
  })

  it('preserves index, tangents, secondary UVs, material groups and borrowed ownership', () => {
    const { scene, geometry, material } = fixture()
    const disposeGeometry = vi.spyOn(geometry, 'dispose')
    const disposeMaterial = vi.spyOn(material, 'dispose')
    const model = createPilotModel(scene, contract)
    const meshes: Mesh[] = []
    model.root.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o)
    })
    expect(meshes[0].geometry).toBe(geometry)
    expect(meshes[0].material).toBe(material)
    expect(meshes[0].geometry.index).not.toBeNull()
    expect(Object.keys(meshes[0].geometry.attributes)).toEqual([
      'position',
      'normal',
      'uv',
      'uv1',
      'tangent',
    ])
    expect(meshes[0].geometry.groups).toHaveLength(6)
    model.release()
    model.release()
    expect(disposeGeometry).not.toHaveBeenCalled()
    expect(disposeMaterial).not.toHaveBeenCalled()
    geometry.dispose()
    material.dispose()
  })

  it('refuses dimension drift rather than squeezing an asset into a SKU envelope', () => {
    const { scene } = fixture()
    expect(() =>
      createPilotModel(scene, { ...contract, expectedDimensionsMeters: [1, 1, 1] }),
    ).toThrow(/dimensions/)
    expect(() => createPilotModel(scene, { ...contract, dimensionToleranceMeters: NaN })).toThrow(
      /contract/,
    )
    expect(() =>
      createPilotModel(scene, {
        ...contract,
        expectedDimensionsMeters: [],
      } as unknown as PilotModelContract),
    ).toThrow(/contract/)
    expect(() =>
      createPilotModel(scene, { ...contract, sourceUp: '+z' } as unknown as PilotModelContract),
    ).toThrow(/contract/)
  })

  it('rejects empty, deformed and non-finite geometry rather than reporting false bounds', () => {
    expect(() => measuredBounds(new Group())).toThrow(/empty/)
    const { scene, geometry } = fixture()
    geometry.morphAttributes.position = [geometry.getAttribute('position').clone()]
    expect(() => measuredBounds(scene)).toThrow(/static/)
    geometry.morphAttributes = {}
    geometry.getAttribute('position').setX(0, NaN)
    expect(() => measuredBounds(scene)).toThrow(/Non-finite/)
  })
})
