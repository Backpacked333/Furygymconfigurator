import { MeshBasicNodeMaterial, type Mesh, type Object3D } from 'three/webgpu'

/** Writes nothing, colour or depth: what an object casting only its shadow is drawn with. */
export const unseen = new MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false })

/**
 * Draws an object's meshes as nothing but their shadow, until the returned function puts their
 * materials back. A radiance capture taken from inside the unit looks through it this way and
 * still sees its shadow on the paving: the shadow pass draws casters with its own material, where
 * hiding the unit (`visible = false`) dropped it from the shadow maps drawn for the capture, and the
 * paving it shades was captured in full sun.
 */
export function shadowOnly(object: Object3D) {
  const swapped: [Mesh, Mesh['material']][] = []
  object.traverse((part) => {
    const mesh = part as Mesh
    if (!mesh.isMesh) return
    swapped.push([mesh, mesh.material])
    mesh.material = unseen
  })
  return () => swapped.forEach(([mesh, material]) => (mesh.material = material))
}
