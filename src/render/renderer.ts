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
  // Linearly transformed cosine tables for physically based rectangular area lights.
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = 1
  return renderer
}

export function backendOf(renderer: WebGPURenderer): Backend {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'
}
