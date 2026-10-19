import type { Raster } from './compose'

/** Peak signal-to-noise ratio (dB) between two equal-size RGB(A) rasters, over a pixel subset. */
export function psnr(a: Raster, b: Raster, include?: (i: number) => boolean): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Sizes differ.')
  let sum = 0,
    n = 0
  for (let i = 0; i < a.width * a.height; i++) {
    if (include && !include(i)) continue
    for (let c = 0; c < 3; c++) {
      const d = a.data[i * a.channels + c] - b.data[i * b.channels + c]
      sum += d * d
    }
    n += 3
  }
  if (!n || !sum) return Infinity
  return 10 * Math.log10((255 * 255) / (sum / n))
}

/** Straight-alpha `top` over opaque `bottom`, as the browser stacks the two images. */
export function over(top: Raster, bottom: Raster): Raster {
  const out = Buffer.alloc(bottom.width * bottom.height * 3)
  for (let i = 0; i < bottom.width * bottom.height; i++) {
    const alpha = top.data[i * 4 + 3] / 255
    for (let c = 0; c < 3; c++)
      out[i * 3 + c] = Math.round(
        top.data[i * 4 + c] * alpha + bottom.data[i * 3 + c] * (1 - alpha),
      )
  }
  return { data: out, width: bottom.width, height: bottom.height, channels: 3 }
}
