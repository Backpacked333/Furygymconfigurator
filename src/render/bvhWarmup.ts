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

/** Workers building at once: the largest geometries build side by side, a core kept for the page. */
export const POOL_SIZE = Math.max(
  1,
  Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1),
)

type Task = { resolve: (r: BVHResult) => void; reject: (e: Error) => void }
const pool: { worker: Worker; pending: Map<number, Task> }[] = []
let next = 0

/** Builds in the pool's workers, started on first use, each taking the next request in turn. */
const inWorker: Build = (request) => {
  const id = ++next
  const slot = id % POOL_SIZE
  if (!pool[slot]) {
    const worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' })
    const pending = new Map<number, Task>()
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
    pool[slot] = { worker, pending }
  }
  const { worker, pending } = pool[slot]
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, request }, [
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
 * Builds the BVHs of `root`'s geometries off the main thread, largest first, `concurrency` at a
 * time. Resolves with how many it attached; never rejects (a geometry that fails is left to the
 * tracer's own build).
 */
export async function warmBVHs(root: Object3D, build: Build = inWorker, concurrency = POOL_SIZE) {
  let attached = 0
  const queue = geometriesToWarm(root)
  // Up to `concurrency` builds at once, each taking the largest geometry left.
  const lane = async () => {
    for (let geometry = queue.shift(); geometry; geometry = queue.shift())
      if (await warmOne(geometry, build)) attached++
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane))
  return attached
}

/** Builds and attaches one geometry's BVH; false if it was left to the tracer. */
async function warmOne(geometry: BufferGeometry, build: Build) {
  const target = geometry as BufferGeometry & { boundsTree?: unknown }
  const position = geometry.getAttribute('position')?.array
  const index = geometry.getIndex()?.array
  const request = bvhRequest(geometry)
  if (!request) return false
  try {
    const result = await build(request)
    // Replaced, or built meanwhile (the tracer started without waiting): leave it.
    if (target.boundsTree) return false
    if (geometry.getAttribute('position')?.array !== position) return false
    if (geometry.getIndex()?.array !== index) return false
    attachBVH(geometry, result)
    return true
  } catch {
    // The tracer builds this one itself.
    return false
  }
}
