import { Box3, Group, Mesh, Object3D, Vector3 } from 'three'

export const FEET_PER_METER = 1 / 0.3048
const unitTag = 'furyAssetPilotUnits'

export type PilotModelContract = {
  id: string
  sourceUnits: 'meters'
  sourceUp: '+y'
  sourceForward: '+z' | '-z' | '+x' | '-x'
  expectedDimensionsMeters: readonly [number, number, number]
  dimensionToleranceMeters: number
}

/** Static vertex bounds, not transformed local AABBs or nominal catalog dimensions. */
export function measuredBounds(root: Object3D) {
  root.updateMatrixWorld(true)
  const bounds = new Box3()
  const point = new Vector3()
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    if (
      'isSkinnedMesh' in object ||
      'isInstancedMesh' in object ||
      Object.keys(object.geometry.morphAttributes).length
    )
      throw new Error('Pilot supports static meshes only; animated/deformed bounds need review.')
    const position = object.geometry.getAttribute('position')
    if (!position || position.itemSize !== 3) throw new Error('Missing VEC3 positions.')
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld)
      if (!point.toArray().every(Number.isFinite)) throw new Error('Non-finite model vertex.')
      bounds.expandByPoint(point)
    }
  })
  if (bounds.isEmpty()) throw new Error('Cannot measure an empty model.')
  return bounds
}

/** Borrow geometry/materials; retain indices, all attributes, groups and the source hierarchy. */
export function createPilotModel(source: Object3D, contract: PilotModelContract) {
  if (
    contract.sourceUnits !== 'meters' ||
    contract.sourceUp !== '+y' ||
    !Number.isFinite(contract.dimensionToleranceMeters) ||
    contract.dimensionToleranceMeters < 0 ||
    contract.expectedDimensionsMeters.length !== 3 ||
    !contract.expectedDimensionsMeters.every((v) => Number.isFinite(v) && v > 0)
  )
    throw new Error('Invalid metric source contract.')
  source.traverse((object) => {
    if (object.userData[unitTag]) throw new Error('Pilot unit conversion cannot be applied twice.')
  })
  const clone = source.clone(true)
  const sourceBounds = measuredBounds(clone)
  const size = sourceBounds.getSize(new Vector3()).toArray()
  if (
    size.some(
      (v, i) =>
        Math.abs(v - contract.expectedDimensionsMeters[i]) > contract.dimensionToleranceMeters,
    )
  )
    throw new Error('Source dimensions differ from provenance; do not silently scale to fit.')
  const yaw = { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 }[
    contract.sourceForward
  ]
  if (yaw === undefined) throw new Error('Unsupported source forward axis.')
  const oriented = new Group()
  oriented.rotation.y = yaw
  oriented.add(clone)
  const orientedBounds = measuredBounds(oriented)
  const centered = new Group()
  centered.position.set(
    -(orientedBounds.min.x + orientedBounds.max.x) / 2,
    -orientedBounds.min.y,
    -(orientedBounds.min.z + orientedBounds.max.z) / 2,
  )
  centered.add(oriented)
  const root = new Group()
  root.name = `Q11:${contract.id}`
  root.userData[unitTag] = 'feet'
  root.scale.setScalar(FEET_PER_METER)
  root.add(centered)
  const envelope = measuredBounds(root)
  return {
    root,
    envelope,
    dimensionsFeet: envelope.getSize(new Vector3()).toArray(),
    lod: 'single-source-LOD; no simplification or distance switching measured' as const,
    release() {
      root.removeFromParent()
      root.clear()
    },
  }
}
