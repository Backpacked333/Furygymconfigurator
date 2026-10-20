/// <reference lib="webworker" />
import { buildBVH, type BVHRequest } from './bvhBuild'

/** Builds the path tracer's geometry BVHs off the main thread (bvhWarmup.ts). */
self.onmessage = ({ data }: MessageEvent<{ id: number; request: BVHRequest }>) => {
  try {
    const result = buildBVH(data.request)
    self.postMessage({ id: data.id, result }, [...result.roots, result.index.buffer])
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) })
  }
}
