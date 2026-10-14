import { AgXToneMapping, RectAreaLightNode, WebGPURenderer } from 'three/webgpu'
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js'

import { requestedBackend, type Backend, type Quality, type DeviceProfile } from './quality'

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
export async function createRenderer(
  canvas: HTMLCanvasElement,
  options: {
    forceWebGL?: boolean
    signal?: AbortSignal
  } = {},
) {
  installTextureViewShim()
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    forceWebGL: options.forceWebGL || requestedBackend() === 'webgl2',
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let aborted = false
  let rejectAbort: (reason: Error) => void = () => {}
  const abort = () => {
    aborted = true
    rejectAbort(new Error('Renderer initialization was cancelled'))
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const initialized = renderer.init().then(() => {
      if (aborted) {
        void renderer.dispose().catch(() => {})
        throw new Error('Renderer initialization expired')
      }
    })
    await Promise.race([
      initialized,
      new Promise<never>((_, reject) => {
        rejectAbort = reject
        timer = setTimeout(abort, 12000)
        if (options.signal?.aborted) abort()
      }),
    ])
  } catch (error) {
    // An unfinished init is released by its completion handler, not raced against disposal.
    if (!aborted) void renderer.dispose().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
  // Linearly transformed cosine tables for physically based rectangular area lights.
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = 1
  return renderer
}

export function observeRendererLoss(renderer: WebGPURenderer, report: (reason: string) => void) {
  let active = true
  let reported = false
  const previous = renderer.onDeviceLost
  const previousError = renderer.onError
  const fail = (reason: string) => {
    if (active && !reported) {
      reported = true
      report(reason)
    }
  }
  const loss: typeof renderer.onDeviceLost = (info) => {
    if (!active) return
    previous.call(renderer, info)
    fail(`${info.api}: ${info.message || 'Graphics device lost'}`)
  }
  const error: typeof renderer.onError = (message) => fail(message)
  renderer.onDeviceLost = loss
  renderer.onError = error
  const contextLost = (event: Event) => {
    event.preventDefault()
    fail('WebGL context lost')
  }
  renderer.domElement.addEventListener('webglcontextlost', contextLost)
  return () => {
    active = false
    renderer.domElement.removeEventListener('webglcontextlost', contextLost)
    if (renderer.onDeviceLost === loss) renderer.onDeviceLost = previous
    if (renderer.onError === error) renderer.onError = previousError
  }
}

/** Coarse policy hints only: this does not certify latency, VRAM, or 4K visual quality. */
export function deviceProfile(renderer: WebGPURenderer): DeviceProfile {
  const backend = renderer.backend as unknown as {
    device?: {
      limits?: { maxTextureDimension2D?: number }
      adapterInfo?: { device?: string; description?: string }
    }
    gl?: WebGL2RenderingContext
  }
  let description = ''
  let limit = backend.device?.limits?.maxTextureDimension2D ?? 2048
  if (backend.device?.adapterInfo)
    description = `${backend.device.adapterInfo.device} ${backend.device.adapterInfo.description}`
  if (backend.gl) {
    limit = backend.gl.getParameter(backend.gl.MAX_TEXTURE_SIZE) as number
    const ext = backend.gl.getExtension('WEBGL_debug_renderer_info')
    if (ext) description = backend.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string
  }
  const software = /swiftshader|llvmpipe|software|lavapipe/i.test(description)
  const capable = !software && limit >= 4096 && /nvidia|radeon|apple m\d|geforce/i.test(description)
  return {
    backend: backendOf(renderer),
    hardware: software ? 'software' : capable ? 'capable' : 'unknown',
    maxTextureSize: limit,
    memoryBudgetMB: capable ? 1536 : software ? 128 : 256,
  }
}

export function backendOf(renderer: WebGPURenderer): Backend {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'
}
