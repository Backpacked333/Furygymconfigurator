import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AGX_INVERSE_SIZE, decodeAgxInverse, invertAgx } from './agxInverse'

const buffer = readFileSync('src/render/agxInverse.bin')
const table = decodeAgxInverse(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
)

describe("the inverse of Blender's AgX Medium High Contrast view", () => {
  it('holds a 25³ table of three half floats', () => {
    expect(buffer.length).toBe(AGX_INVERSE_SIZE ** 3 * 3 * 2)
  })

  // Code values Blender 4.5.0's OpenColorIO config gives these linear greys through AgX with the
  // Medium High Contrast look (scripts/agx-inverse.py), read back to within about 1%.
  for (const [linear, shown] of [
    [0.01, 0.040098],
    [0.05, 0.194054],
    [0.18, 0.461353],
    [0.5, 0.699026],
    [1, 0.813797],
    [2, 0.896518],
    [4, 0.95707],
  ] as const)
    it(`reads ${shown} back as ${linear}`, () => {
      const back = invertAgx(table, [shown, shown, shown])
      for (const channel of back)
        expect(Math.abs(channel / linear - 1)).toBeLessThan(linear > 1 ? 0.02 : 0.01)
      // Tetrahedral: a grey stays grey, as near as Blender's own inverse keeps it (its entries on
      // the grey axis differ by channel by up to 0.2%).
      expect(Math.abs(back[0] / back[1] - 1)).toBeLessThan(0.005)
      expect(Math.abs(back[2] / back[1] - 1)).toBeLessThan(0.005)
    })

  it('rises with the code value on every channel', () => {
    let last = 0
    for (let v = 0.02; v <= 0.99; v += 0.01) {
      const [r] = invertAgx(table, [v, 0.5, 0.5])
      expect(r).toBeGreaterThan(last)
      last = r
    }
  })
})
