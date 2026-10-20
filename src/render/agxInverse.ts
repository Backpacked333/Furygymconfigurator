import { DataTexture, DataUtils, HalfFloatType, NearestFilter, RGBAFormat } from 'three/webgpu'
import tableUrl from './agxInverse.bin?url'

/**
 * Blender's AgX "Medium High Contrast" view, inverted: from an 8-bit library image's code values
 * back to the scene-linear light Cycles rendered (scripts/agx-inverse.py builds the table from
 * Blender 4.5.0's own OpenColorIO config, which the library's renders used).
 *
 * The table is sampled on a shaper of the code values c, u = acos(1 - 2 c^SHAPER) / π, finer near
 * black and near white where the curve is steepest, and holds log2 of linear Rec.709: SIZE³
 * entries, red fastest, three float16 each. Read tetrahedrally, as colour tables are (a grey stays
 * grey), it is within about 1% of OpenColorIO's own inverse up to a few times middle grey's light.
 * Near white an 8-bit image holds little of the light (a level spans a large step), so a seed gives
 * those pixels no weight.
 */
export const AGX_INVERSE_SIZE = 25
export const AGX_INVERSE_SHAPER = 0.6

/** The table as log2 linear values, three per entry. */
export function decodeAgxInverse(buffer: ArrayBuffer) {
  const half = new Uint16Array(buffer)
  if (half.length !== AGX_INVERSE_SIZE ** 3 * 3) throw new Error('agxInverse.bin: unexpected size')
  return Float32Array.from(half, (bits) => DataUtils.fromHalfFloat(bits))
}

/** A code value's position in the table, in entries (0 to SIZE - 1). */
export function agxInverseCoordinate(code: number) {
  const c = Math.min(1, Math.max(0, code)) ** AGX_INVERSE_SHAPER
  return (Math.acos(1 - 2 * c) / Math.PI) * (AGX_INVERSE_SIZE - 1)
}

/**
 * The linear Rec.709 light behind code values `rgb` (each 0–1), interpolated tetrahedrally in
 * the shaped table: the arithmetic the GPU seed does (history.ts ImageSeedKernel), for tests.
 */
export function invertAgx(table: Float32Array, rgb: readonly [number, number, number]) {
  const n = AGX_INVERSE_SIZE
  const at = rgb.map(agxInverseCoordinate)
  const base = at.map((v) => Math.min(n - 2, Math.floor(v)))
  const f = at.map((v, i) => v - base[i])
  const entry = (corner: readonly number[], c: number) =>
    table[(((base[2] + corner[2]) * n + (base[1] + corner[1])) * n + (base[0] + corner[0])) * 3 + c]
  // The tetrahedron holding the point: walk from the cell's first corner to its last along the
  // axes in order of the fraction, largest first.
  const order = [0, 1, 2].sort((a, b) => f[b] - f[a])
  const first = [0, 0, 0]
  const second = [0, 0, 0]
  first[order[0]] = 1
  second[order[0]] = second[order[1]] = 1
  const [a, b, c] = order.map((axis) => f[axis])
  return [0, 1, 2].map(
    (ch) =>
      2 **
      ((1 - a) * entry([0, 0, 0], ch) +
        (a - b) * entry(first, ch) +
        (b - c) * entry(second, ch) +
        c * entry([1, 1, 1], ch)),
  ) as [number, number, number]
}

let loading: Promise<DataTexture> | null = null

/**
 * The table as a texture for the seed kernel, fetched once: RGBA half float (alpha unused), SIZE
 * wide and SIZE² tall, blue's slices stacked down it (entry r, g, b at x = r, y = g + SIZE · b). A
 * 2D texture rather than a 3D one: some Dawn backends initialize and upload 3D textures through a
 * 2D view, which is invalid (pathtrace.ts works around the same for the tracer's GGX table).
 * Rejects where it cannot be fetched; the view then simply starts unseeded.
 */
export function loadAgxInverse() {
  loading ??= fetch(tableUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`agxInverse.bin: ${response.status}`)
      return response.arrayBuffer()
    })
    .then((buffer) => {
      const rgb = new Uint16Array(buffer)
      const n = AGX_INVERSE_SIZE
      if (rgb.length !== n ** 3 * 3) throw new Error('agxInverse.bin: unexpected size')
      const rgba = new Uint16Array(n ** 3 * 4)
      for (let i = 0; i < n ** 3; i++) {
        rgba.set(rgb.subarray(i * 3, i * 3 + 3), i * 4)
        rgba[i * 4 + 3] = 0x3c00
      }
      const texture = new DataTexture(rgba, n, n * n)
      texture.format = RGBAFormat
      texture.type = HalfFloatType
      texture.minFilter = texture.magFilter = NearestFilter
      texture.generateMipmaps = false
      texture.needsUpdate = true
      return texture
    })
  loading.catch(() => {
    loading = null
  })
  return loading
}
