import type { InstancedMesh, Matrix4 } from 'three/webgpu'

/**
 * Instanced plants thinned by the raster tier. Grass, hedges, shrubs and tree crowns are built at
 * full density (scenery.ts DENSITY.ultra) and each tier draws the first of their instances, which
 * thin the set evenly (each is placed by its own index). The path-traced stills capture and sign
 * every instance (cloud.ts, pathtrace.ts), so a still of a design is the same whatever tier the
 * visitor's raster runs at: a still rendered for an edit on a phone matches one baked or rendered
 * on a desktop, and the server's cache serves both.
 */

/** Every instance put on each mesh, however many it draws. */
const built = new WeakMap<InstancedMesh, number>()

/** Puts a set of instances on a mesh, all of them, and draws the first `drawn`. */
export function fillInstances(mesh: InstancedMesh, matrices: Matrix4[], drawn = matrices.length) {
  matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix))
  mesh.instanceMatrix.needsUpdate = true
  built.set(mesh, matrices.length)
  // Bounded by every instance: the bounds hold at any tier.
  mesh.count = matrices.length
  mesh.computeBoundingSphere()
  drawInstances(mesh, drawn)
}

/** Draws the first `drawn` of a mesh's instances: a tier change, touching nothing else. */
export function drawInstances(mesh: InstancedMesh, drawn: number) {
  mesh.count = Math.max(0, Math.min(drawn, built.get(mesh) ?? mesh.count))
}

/** A mesh's instances as the stills capture and sign them: every one put on it. */
export const stillInstances = (mesh: InstancedMesh) => built.get(mesh) ?? mesh.count
