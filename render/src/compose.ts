import sharp from 'sharp'
import { MATTE_GREY, type RenderCapture } from '../../src/render-harness/job'
import type { LayerKind } from '../../src/lib/stills'

export type Raster = { data: Buffer; width: number; height: number; channels: 3 | 4 }

async function decode(dataUrl: string): Promise<Raster> {
  const { data, info } = await sharp(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: 3 }
}

/**
 * Per-pixel transmittance through the glazing or opening: how much of the backstop (and so of
 * the room) shows. The mattes are linear and untone-mapped, so the difference between the black
 * and grey backstops divided by the grey level is exactly that fraction; everything in front of
 * the room (frames, glass reflections, the sky) cancels out.
 */
export function transmittance(black: Raster, grey: Raster): Float32Array {
  const t = new Float32Array(black.width * black.height)
  for (let i = 0; i < t.length; i++) {
    let sum = 0
    for (let c = 0; c < 3; c++) sum += grey.data[i * 3 + c] - black.data[i * 3 + c]
    t[i] = Math.min(1, Math.max(0, sum / 3 / 255 / MATTE_GREY))
  }
  return t
}

/** Grows a mask by `radius` pixels (separable max filter), so soft edges are never cut. */
export function dilate(mask: Float32Array, width: number, height: number, radius: number) {
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let m = 0
        for (let d = -radius; d <= radius; d++) {
          const xx = horizontal ? x + d : x,
            yy = horizontal ? y : y + d
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
          const v = src[yy * width + xx]
          if (v > m) m = v
        }
        out[y * width + x] = m
      }
    return out
  }
  return pass(pass(mask, true), false)
}

/**
 * Turns a harness capture into the layer image.
 *
 * - `full`: the color render.
 * - `shell`: RGBA. Alpha is the opacity in front of the room (1 - transmittance); color is the
 *   render with a black room divided by that alpha, so the browser's alpha blending over the
 *   interior layer reproduces reflection plus transmitted room.
 * - `interior`: RGB, with everything that is never seen through the opening flattened to one
 *   color (which compresses to almost nothing). The mask is dilated generously because shells
 *   with additions in front only ever hide more of it.
 */
export async function compose(capture: RenderCapture, kind: LayerKind): Promise<Raster> {
  const color = await decode(capture.color)
  if (kind === 'full') return color
  if (!capture.matteBlack || !capture.matteGrey) throw new Error(`A ${kind} layer needs mattes.`)
  const t = transmittance(await decode(capture.matteBlack), await decode(capture.matteGrey))
  const { width, height } = color
  if (kind === 'shell') {
    const out = Buffer.alloc(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      const alpha = 1 - t[i]
      for (let c = 0; c < 3; c++)
        out[i * 4 + c] =
          alpha > 0.004 ? Math.min(255, Math.round(color.data[i * 3 + c] / alpha)) : 0
      out[i * 4 + 3] = Math.round(alpha * 255)
    }
    return { data: out, width, height, channels: 4 }
  }
  const radius = Math.max(4, Math.round(width / 300))
  const visible = dilate(t, width, height, radius)
  const out = Buffer.from(color.data)
  for (let i = 0; i < width * height; i++) if (visible[i] < 0.004) out.fill(0x30, i * 3, i * 3 + 3)
  return { data: out, width, height, channels: 3 }
}
