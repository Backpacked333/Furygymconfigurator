/**
 * The page scripts/atlas-check.mjs drives: three-gpu-pathtracer's texture atlas, as patched to draw
 * each texture itself, against the same atlas built from clones (as it did before), on a real
 * WebGPU device. The textures are set up as the app's scans are (materials.ts): decoded bitmaps,
 * flipY off, repeat set, sRGB or linear, mipmapped.
 */
import {
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  WebGPURenderer,
  type StorageTexture,
} from 'three/webgpu'
import { AtlasTexture } from 'three-gpu-pathtracer/src/webgpu/AtlasTexture.js'

declare global {
  interface Window {
    checkAtlas: () => Promise<unknown>
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

async function scan(size: number, seed: number, color: boolean) {
  const pixels = new ImageData(size, size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      pixels.data.set(
        [(x * 7 + seed * 31) % 256, (y * 13 + seed * 17) % 256, ((x ^ y) * 5 + seed) % 256, 255],
        i,
      )
    }
  const bitmap = await createImageBitmap(pixels, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
  const texture = new Texture(bitmap)
  texture.flipY = false
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.repeat.set(1 / 3, 1 / 3)
  texture.colorSpace = color ? SRGBColorSpace : NoColorSpace
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

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

async function pages(renderer: WebGPURenderer, atlas: AtlasTexture) {
  const out: Uint8Array[] = []
  for (let page = 0; page < atlas.pageCount; page++) {
    const data = await (renderer.backend as unknown as Backend).copyTextureToBuffer(
      atlas.texture as unknown as StorageTexture,
      0,
      0,
      atlas.width,
      atlas.height,
      page,
    )
    out.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  return out
}

window.checkAtlas = async () => {
  const renderer = new WebGPURenderer({
    canvas: document.createElement('canvas'),
    antialias: false,
  })
  await renderer.init()
  const textures = await Promise.all([
    scan(256, 1, true),
    scan(256, 2, false),
    scan(128, 3, true),
    scan(128, 4, false),
    scan(64, 5, true),
  ])
  // Uploaded first, as the raster's first frames upload the scans before the tracer starts.
  for (const texture of textures) {
    renderer.initTexture(texture)
    // Drawn by the raster, a texture's matrix holds its repeat: the atlas must set it aside.
    texture.updateMatrix()
  }
  // The old path, while the pixels were kept: a clone of each, drawn with an identity transform.
  const clones = textures.map((texture) => {
    const clone = texture.clone()
    clone.matrixAutoUpdate = false
    clone.matrix.identity()
    return clone
  })
  const cloned = new AtlasTexture()
  cloned.setTextures(renderer, clones)
  // The new path after the app freed the pixels (materials.ts releaseDecoded): only the GPU copy
  // and the size are left.
  for (const texture of textures) {
    const bitmap = texture.image as ImageBitmap
    texture.image = {
      width: bitmap.width,
      height: bitmap.height,
      released: true,
    } as unknown as ImageBitmap
    bitmap.close()
  }
  const direct = new AtlasTexture()
  direct.setTextures(renderer, textures)
  const a = await pages(renderer, direct)
  const b = await pages(renderer, cloned)
  let differing = 0
  let total = 0
  for (let page = 0; page < a.length; page++)
    for (let i = 0; i < a[page].length; i++) {
      total++
      if (a[page][i] !== b[page][i]) differing++
    }
  // The originals' own uv transforms are untouched by the atlas build.
  const transformsKept = textures.every(
    (t) => t.matrixAutoUpdate && t.repeat.x === 1 / 3 && t.repeat.y === 1 / 3,
  )
  const blank = a.every((page) => page.every((v) => v === 0))
  return { pages: a.length, bytes: total, differing, transformsKept, blank }
}
