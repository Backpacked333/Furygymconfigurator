import sharp from 'sharp'
import { STILL_ASPECT, STILL_WIDTHS } from '../../src/lib/cameras'
import { layerPath, type StillFormat } from '../../src/lib/renderKey'
import type { Raster } from './compose'

export const FORMATS: StillFormat[] = ['avif', 'webp']
export const CONTENT_TYPES: Record<StillFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
}

export type EncodedFile = { path: string; body: Buffer; contentType: string }

/** Every published file of a layer, largest last, so a present 2048 WebP marks a complete layer. */
export function layerFiles(key: string, renderer: string) {
  return STILL_WIDTHS.flatMap((width) =>
    FORMATS.map((format) => ({ width, format, path: layerPath(key, width, format, renderer) })),
  )
}

/**
 * Downscales the supersampled render (Lanczos, alpha-aware) to each published width and encodes
 * AVIF and WebP. Quality favors small files: the stage shows one still at a time and swaps fast.
 */
export async function encodeLayer(
  raster: Raster,
  key: string,
  renderer: string,
): Promise<EncodedFile[]> {
  const files: EncodedFile[] = []
  for (const { width, format, path } of layerFiles(key, renderer)) {
    const image = sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: raster.channels },
    }).resize(width, Math.round(width / STILL_ASPECT), { kernel: 'lanczos3', fit: 'fill' })
    const body =
      format === 'avif'
        ? await image.avif({ quality: width >= 2048 ? 58 : 52, effort: 5 }).toBuffer()
        : await image.webp({ quality: 80, alphaQuality: 90, effort: 5 }).toBuffer()
    files.push({ path, body, contentType: CONTENT_TYPES[format] })
  }
  return files
}
