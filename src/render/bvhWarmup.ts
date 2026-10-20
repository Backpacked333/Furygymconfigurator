import type { BufferGeometry, Mesh, Object3D } from 'three/webgpu'
import { attachBVH, bvhRequest, type BVHRequest, type BVHResult } from './bvhBuild'

/**
 * The path tracer's first scene capture builds a BVH for every mesh's geometry on the main thread,
 * the 360° view's longest task. Built beforehand in a worker, from copies of the arrays, they are
 * already on the geometries when it runs: its `setScene` skips any geometry that has one.
 *
 * Geometries below MIN_TRIANGLES are left to it (they build in well under a millisecond), as is any
 * geometry whose arrays changed while its BVH was being built (an edit replaced it).
 */
export const MIN_TRIANGLES = 2000

type Build = (request: BVHRequest) => Promise<BVHResult>

let worker: Worker | null = null
let next = 0
const pending = new Map<number, { resolve: (r: BVHResult) => void; reject: (e: Error) => void }>()

/** Builds in the shared worker, started on first use. */
const inWorker: Build = (request) => {
  if (!worker) {
    worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) task?.reject(new Error(data.error))
      else task?.resolve(data.result)
    }
    worker.onerror = (event) => {
      for (const task of pending.values()) task.reject(new Error(event.message))
      pending.clear()
    }
  }
  const id = ++next
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, request }, [
      request.position.buffer,
      ...(request.index ? [request.index.buffer] : []),
    ])
  })
}

const triangles = (geometry: BufferGeometry) =>
  (geometry.getIndex()?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3

/** The geometries under `root` the tracer would build a BVH for, largest first. */
export function geometriesToWarm(root: Object3D) {
  const found = new Set<BufferGeometry>()
  root.traverse((child) => {
    const mesh = child as Mesh & { isSkinnedMesh?: boolean }
    const geometry = mesh.geometry as (BufferGeometry & { boundsTree?: unknown }) | undefined
    if (!mesh.isMesh || mesh.isSkinnedMesh || !geometry?.isBufferGeometry) return
    if (geometry.boundsTree || triangles(geometry) < MIN_TRIANGLES) return
    found.add(geometry)
  })
  return [...found].sort((a, b) => triangles(b) - triangles(a))
}

/**
 * Builds the BVHs of `root`'s geometries one at a time off the main thread. Resolves with how many
 * it attached; never rejects (a geometry that fails is left to the tracer's own build).
 */
export async function warmBVHs(root: Object3D, build: Build = inWorker) {
  let attached = 0
  for (const geometry of geometriesToWarm(root)) {
    const target = geometry as BufferGeometry & { boundsTree?: unknown }
    const position = geometry.getAttribute('position')?.array
    const index = geometry.getIndex()?.array
    const request = bvhRequest(geometry)
    if (!request) continue
    try {
      const result = await build(request)
      // Replaced, or built meanwhile (the tracer started without waiting): leave it.
      if (target.boundsTree) continue
      if (geometry.getAttribute('position')?.array !== position) continue
      if (geometry.getIndex()?.array !== index) continue
      attachBVH(geometry, result)
      attached++
    } catch {
      // The tracer builds this one itself.
    }
  }
  return attached
}
