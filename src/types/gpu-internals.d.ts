/**
 * Internals of three-mesh-bvh and three-gpu-pathtracer used to write compute kernels the same way
 * the path tracer writes its own. Neither package publishes types for these modules.
 */
declare module 'three-mesh-bvh/src/webgpu/nodes/WGSLTagFnNode.js' {
  /** A WGSL function whose `${}` slots bind TSL nodes (textures, buffers) by reference. */
  export function wgslTagFn(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): (parameters: Record<string, unknown>) => unknown
}

declare module 'three-gpu-pathtracer/src/webgpu/compute/ComputeKernel.js' {
  import type { ComputeNode } from 'three/webgpu'
  export class ComputeKernel {
    constructor(fn: unknown, options?: { workgroupSize?: number[]; context?: object })
    readonly kernel: ComputeNode
    setWorkgroupSize(x?: number, y?: number, z?: number): this
    defineUniformAccessors(parameters: Record<string, unknown>): void
    getDispatchSize(x?: number, y?: number, z?: number): number[]
    dispose(): void
  }
}
