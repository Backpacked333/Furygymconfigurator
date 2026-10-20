/**
 * The page scripts/seed-check.mjs drives: the 360° view's Cycles-image seed (history.ts
 * ImageSeedKernel, through ViewHistory.storeImage) on a real WebGPU device, its output read back
 * and compared with the CPU's reading of the same table (agxInverse.ts invertAgx).
 */
import {
  NearestFilter,
  NoColorSpace,
  Texture,
  WebGPURenderer,
  type StorageTexture,
} from 'three/webgpu'
import { decodeAgxInverse, invertAgx, loadAgxInverse } from '../../src/render/agxInverse'
import tableUrl from '../../src/render/agxInverse.bin?url'
import { GBuffer, ViewHistory } from '../../src/render/history'

type Backend = {
  copyTextureToBuffer: (
    t: StorageTexture,
    x: number,
    y: number,
    w: number,
    h: number,
    face: number,
  ) => Promise<ArrayBufferView>
}

declare global {
  interface Window {
    checkSeed: () => Promise<unknown>
  }
}

// This Chromium predates the texture-view swizzle three r186 passes on some views.
const gpuTexture = (globalThis as unknown as { GPUTexture: { prototype: Record<string, unknown> } })
  .GPUTexture.prototype
const createView = gpuTexture.createView as (this: unknown, descriptor?: object) => unknown
gpuTexture.createView = function (this: unknown, descriptor?: Record<string, unknown>) {
  if (descriptor && 'swizzle' in descriptor) {
    const copy = { ...descriptor }
    delete copy.swizzle
    return createView.call(this, copy)
  }
  return createView.call(this, descriptor)
}

/** An image of `width` × `height` whose code value at (x, y), rows top down, is `code(x, y)`. */
async function image(width: number, height: number, code: (x: number, y: number) => number[]) {
  const pixels = new ImageData(width, height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.data.set([...code(x, y), 255], (y * width + x) * 4)
  const bitmap = await createImageBitmap(pixels, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  // As ProgressiveRenderer's entrySeed reads the library image.
  const texture = new Texture(bitmap)
  texture.flipY = false
  texture.colorSpace = NoColorSpace
  texture.generateMipmaps = false
  texture.minFilter = texture.magFilter = NearestFilter
  texture.needsUpdate = true
  return texture
}

/** Rows of 256-byte-aligned texels, as copyTextureToBuffer returns them. */
const stride = (width: number, bytes: number) => Math.ceil((width * bytes) / 256) * 256

window.checkSeed = async () => {
  const renderer = new WebGPURenderer({
    canvas: document.createElement('canvas'),
    antialias: false,
  })
  await renderer.init()
  const table = decodeAgxInverse(await (await fetch(tableUrl)).arrayBuffer())
  const lut = await loadAgxInverse()
  const backend = renderer.backend as unknown as Backend
  // Codes spread over the range, a different one per channel, and white at the top of the last
  // column only, so rows read upside down would show.
  const W = 16
  const H = 8
  const code = (x: number, y: number) =>
    x === W - 1 && y < 3 ? [255, 255, 255] : [8 + x * 15, 4 + y * 30, 40 + ((x * 7 + y * 13) % 200)]
  const source = await image(W, H, code)
  const results: Record<string, unknown> = {}
  for (const [width, height] of [
    [16, 8],
    [8, 4],
  ]) {
    const history = new ViewHistory()
    const gbuffer = new GBuffer()
    gbuffer.target.setSize(width, height)
    history.storeImage(
      renderer,
      { image: source, table: lut, count: 16, ceiling: 0.94 },
      gbuffer,
      { scene: 1, surfaces: 1 },
      width,
      height,
    )
    const stored = history as unknown as { color: StorageTexture; counts: StorageTexture }
    const color = new Float32Array(
      (await backend.copyTextureToBuffer(stored.color, 0, 0, width, height, 0)).buffer,
    )
    const counts = new Uint32Array(
      (await backend.copyTextureToBuffer(stored.counts, 0, 0, width, height, 0)).buffer,
    )
    let worst = 0
    const wrongCounts: string[] = []
    const scale = W / width
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        // The image pixels this one covers, averaged, as the kernel does.
        const taps: number[][] = []
        for (let j = 0; j < scale; j++)
          for (let i = 0; i < scale; i++) taps.push(code(x * scale + i, y * scale + j))
        const mean = [0, 1, 2].map(
          (c) => taps.reduce((sum, tap) => sum + tap[c], 0) / taps.length / 255,
        ) as [number, number, number]
        const expected = invertAgx(table, mean)
        const at = (y * stride(width, 16)) / 4 + x * 4
        for (let c = 0; c < 3; c++)
          worst = Math.max(worst, Math.abs(color[at + c] / expected[c] - 1))
        // Counts are the tracer's, rows bottom up.
        const n = counts[((height - 1 - y) * stride(width, 4)) / 4 + x]
        const saturated = taps.some((tap) => Math.max(...tap) / 255 >= 0.94)
        if (n !== (saturated ? 0 : 16)) wrongCounts.push(`${x},${y}: ${n}`)
      }
    results[`${width}x${height}`] = { worstRelativeError: worst, wrongCounts }
    history.dispose()
    gbuffer.dispose()
  }
  return results
}
