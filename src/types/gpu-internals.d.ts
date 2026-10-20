/**
 * Internals of three-mesh-bvh and three-gpu-pathtracer used to write compute kernels the same way
 * the path tracer writes its own, and to test the patched scene packing (tracerPatches.test.ts).
 * Neither package publishes types for these modules.
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

declare module 'three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js' {
  import type { Object3D, StorageBufferAttribute, StructTypeNode } from 'three/webgpu'
  /** three-mesh-bvh's NodeProxy: a stable stand-in for the node it currently holds. */
  type Proxied<T> = { readonly proxyNode: T }
  /** The scene as the tracer's kernels read it: its BVHs, transforms and materials, packed. */
  export class PathtracerBVHComputeData {
    constructor(root: Object3D, options?: object)
    /** The packed layouts: transform, material and (after update) attributes. */
    readonly structs: Record<string, Proxied<StructTypeNode>>
    /** The packed buffers: transforms, nodes, index, attributes and materials. */
    readonly storage: Record<string, Proxied<{ value: StorageBufferAttribute }>>
    update(): void
    updateMaterials(): void
    updateTransforms(): void
    dispose(): void
  }
}

declare module 'three-gpu-pathtracer/src/core/utils/GeometryPreparationUtils.js' {
  import type { BufferGeometry } from 'three/webgpu'
  /** Adds what the tracer packs and a geometry lacks: an index, and the named attributes. */
  export function setCommonAttributes(geometry: BufferGeometry, attributes: string[]): void
}

declare module 'three-gpu-pathtracer/src/webgpu/AtlasTexture.js' {
  import type { Texture, WebGPURenderer } from 'three/webgpu'
  /** Every texture the tracer's materials use, packed into the pages of one array texture. */
  export class AtlasTexture {
    readonly width: number
    readonly height: number
    readonly pageCount: number
    readonly texture: Texture
    setTextures(renderer: WebGPURenderer, textures: Texture[]): void
    dispose(): void
  }
}
