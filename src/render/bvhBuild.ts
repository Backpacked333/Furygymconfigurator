import { Box3, BufferAttribute, BufferGeometry } from 'three'
import { MeshBVH, SAH } from 'three-mesh-bvh'

/**
 * A geometry's BVH, built as three-gpu-pathtracer builds it in `setScene` (WebGPUPathTracer.js:
 * `new MeshBVH( child.geometry, { strategy: SAH, targetLeafSize: 5 } )`), but from copies of its
 * arrays, so the build can run in a worker (bvh.worker.ts) while the raster keeps drawing from the
 * originals. Attached back with `attachBVH`, the result is the same BVH and the same reordered
 * index the tracer's own build leaves on the geometry.
 */
export const TRACER_BVH_OPTIONS = { strategy: SAH, targetLeafSize: 5 } as const

type Index = Uint16Array | Uint32Array
export type BVHRequest = {
  position: Float32Array
  itemSize: number
  index: Index | null
  groups: { start: number; count: number; materialIndex?: number }[]
  drawRange: { start: number; count: number }
}
export type BVHResult = { roots: ArrayBuffer[]; index: Index }

/** What a worker needs to build `geometry`'s BVH, copied, or null where it cannot (interleaved). */
export function bvhRequest(geometry: BufferGeometry): BVHRequest | null {
  const position = geometry.getAttribute('position') as BufferAttribute | undefined
  const index = geometry.getIndex()
  if (!position || !(position.array instanceof Float32Array)) return null
  if (
    (position as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute
  )
    return null
  if (index && !(index.array instanceof Uint16Array || index.array instanceof Uint32Array))
    return null
  return {
    position: position.array.slice(),
    itemSize: position.itemSize,
    index: index ? (index.array as Index).slice() : null,
    groups: geometry.groups.map(({ start, count, materialIndex }) => ({
      start,
      count,
      materialIndex,
    })),
    drawRange: { start: geometry.drawRange.start, count: geometry.drawRange.count },
  }
}

/** Builds the BVH a request describes (in a worker, or here in tests). */
export function buildBVH(request: BVHRequest): BVHResult {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(request.position, request.itemSize))
  if (request.index) geometry.setIndex(new BufferAttribute(request.index, 1))
  for (const { start, count, materialIndex } of request.groups)
    geometry.addGroup(start, count, materialIndex)
  geometry.setDrawRange(request.drawRange.start, request.drawRange.count)
  const bvh = new MeshBVH(geometry, TRACER_BVH_OPTIONS)
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false })
  return { roots: serialized.roots, index: serialized.index as Index }
}

/**
 * Puts a built BVH on `geometry`, as the tracer's own build would have left it: the reordered (or
 * new) index, the BVH as `boundsTree`, and the bounding box if it had none.
 */
export function attachBVH(geometry: BufferGeometry, result: BVHResult) {
  const bvh = MeshBVH.deserialize(
    { version: 1, roots: result.roots, index: result.index, indirectBuffer: null } as Parameters<
      typeof MeshBVH.deserialize
    >[0],
    geometry,
    { setIndex: true },
  )
  if (!geometry.boundingBox) geometry.boundingBox = bvh.getBoundingBox(new Box3())
  // `boundsTree` is typed by drei's own copy of three-mesh-bvh; the tracer reads this one's.
  ;(geometry as unknown as { boundsTree?: MeshBVH }).boundsTree = bvh
  return bvh
}
