import { AgXToneMapping, RectAreaLightNode, WebGPURenderer } from 'three/webgpu'
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js'

import { requestedBackend, type Backend, type Quality } from './quality'

export type { Backend, Quality }

let viewShimInstalled = false
type ViewDescriptor = Record<string, unknown> & { swizzle?: unknown }
type TextureLike = { createView: (this: unknown, descriptor?: ViewDescriptor) => unknown }

/**
 * three r186 always requests the identity component swizzle ('rgba') on texture views. Some
 * Chromium releases expose an older, incompatible `swizzle` member and reject the call, which
 * loses the device. Identity swizzle is a no-op, so drop it before it reaches the browser.
 */
function installTextureViewShim() {
  const gpuTexture = (globalThis as { GPUTexture?: { prototype: TextureLike } }).GPUTexture
  if (viewShimInstalled || !gpuTexture) return
  viewShimInstalled = true
  const createView = gpuTexture.prototype.createView
  gpuTexture.prototype.createView = function (this: unknown, descriptor?: ViewDescriptor) {
    if (descriptor?.swizzle === 'rgba') {
      const { swizzle: _identity, ...rest } = descriptor
      void _identity
      return createView.call(this, rest)
    }
    return createView.call(this, descriptor)
  }
}

/** useFrame priorities: lower runs first; positive priorities take over R3F's own render. */
export const FRAME_BEGIN = -1000
export const FRAME_ENVIRONMENT = -900

type FrameInternals = {
  _animation?: { stop?: () => void }
  _nodes?: { nodeFrame?: { update: () => void; frameId: number } }
}
const demandDriven = new WeakSet<WebGPURenderer>()

/**
 * WebGPURenderer advances its per-frame node state (the frame id that gates render passes, light
 * uniforms, and temporal AA) from a requestAnimationFrame loop that never stops, so an idle page
 * with on-demand rendering would still wake 60-120 times a second. Stop that loop; `beginFrame`
 * advances the same state before every frame that draws. Leaves the loop running if three's
 * internals ever change shape.
 */
export function stopIdleLoop(renderer: WebGPURenderer) {
  const internals = renderer as unknown as FrameInternals
  if (typeof internals._animation?.stop !== 'function' || !internals._nodes?.nodeFrame) return
  internals._animation.stop()
  demandDriven.add(renderer)
}

/** Starts a new frame of node state. Call before anything that renders the scene. */
export function beginFrame(renderer: WebGPURenderer) {
  if (!demandDriven.has(renderer)) return
  const nodeFrame = (renderer as unknown as FrameInternals)._nodes!.nodeFrame!
  if (renderer.info.autoReset) renderer.info.reset()
  nodeFrame.update()
  ;(renderer.info as { frame: number }).frame = nodeFrame.frameId
}

type Capabilities = { getUniformBufferLimit?: () => number }

/**
 * three puts an instanced mesh's matrices in a uniform block of its own when they fit, and names
 * that block in the shader, so every tree crown, hedge, and grass patch builds a pipeline of its
 * own and a change of surroundings builds them all again. Per-instance vertex attributes carry the same
 * matrices with shader code that every instanced mesh sharing a material reuses. Nothing else in
 * the scene uses the limit (no skinned meshes or ranged instancing).
 */
export function shareInstancedShaders(renderer: WebGPURenderer) {
  const backend = renderer.backend as { isWebGPUBackend?: boolean; capabilities?: Capabilities }
  // three's WebGL backend never frees a vertex array object, and each would keep a replaced mesh's
  // matrix buffer alive; there the per-mesh uniform blocks, freed with the mesh, are kept.
  if (!backend.isWebGPUBackend) return
  const capabilities = backend.capabilities
  if (typeof capabilities?.getUniformBufferLimit === 'function')
    capabilities.getUniformBufferLimit = () => 0
}

/**
 * One renderer for both GPU APIs: three's WebGPURenderer runs natively on WebGPU and falls back
 * to its WebGL 2 backend automatically, so every material and post effect is authored once in TSL.
 */
export async function createRenderer(canvas: HTMLCanvasElement) {
  installTextureViewShim()
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    forceWebGL: requestedBackend() === 'webgl2',
  })
  await renderer.init()
  stopIdleLoop(renderer)
  shareInstancedShaders(renderer)
  // Linearly transformed cosine tables for physically based rectangular area lights.
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = 1
  return renderer
}

export function backendOf(renderer: WebGPURenderer): Backend {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'
}

/**
 * A stable name for this device's GPU, used to remember the tier it settled on. WebGPU reports
 * vendor and architecture; WebGL the unmasked renderer string where the browser exposes it.
 */
export function gpuKey(renderer: WebGPURenderer): string {
  const backend = renderer.backend as {
    isWebGPUBackend?: boolean
    device?: { adapterInfo?: { vendor?: string; architecture?: string; device?: string } }
    gl?: WebGL2RenderingContext
  }
  try {
    if (backend.isWebGPUBackend) {
      const info = backend.device?.adapterInfo
      return `webgpu:${info?.vendor ?? ''}:${info?.architecture ?? ''}:${info?.device ?? ''}`
    }
    const gl = backend.gl
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return `webgl:${ext && gl ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''}`
  } catch {
    return 'unknown'
  }
}
