import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MotionShutter, RELEASE_MS, SHUTTER, shutterAfter } from './motionBlur'

describe('motion blur shutter', () => {
  it('is a 180° shutter while the camera moves', () => {
    expect(SHUTTER).toBe(0.5)
    expect(shutterAfter(0)).toBe(0.5)
  })

  it('lets go smoothly once the camera rests, and is exactly 0 after RELEASE_MS', () => {
    let previous = shutterAfter(0)
    for (let ms = 5; ms < RELEASE_MS; ms += 5) {
      const s = shutterAfter(ms)
      expect(s).toBeLessThan(previous)
      expect(s).toBeGreaterThan(0)
      previous = s
    }
    expect(shutterAfter(RELEASE_MS)).toBe(0)
    expect(shutterAfter(RELEASE_MS + 1)).toBe(0)
    expect(shutterAfter(Infinity)).toBe(0)
    expect(shutterAfter(NaN)).toBe(0)
    expect(RELEASE_MS).toBeLessThanOrEqual(150)
  })

  it('is 0 at rest, open on a frame that moved, and shut again a moment after', () => {
    const shutter = new MotionShutter()
    expect(shutter.frame(1000, false)).toBe(0)
    expect(shutter.frame(1016, true)).toBe(SHUTTER)
    expect(shutter.frame(1032, true)).toBe(SHUTTER)
    const easing = shutter.frame(1048, false)
    expect(easing).toBeGreaterThan(0)
    expect(easing).toBeLessThan(SHUTTER)
    expect(shutter.frame(1032 + RELEASE_MS, false)).toBe(0)
    expect(shutter.frame(5000, false)).toBe(0)
  })

  it('keeps the frame after a cut sharp', () => {
    const shutter = new MotionShutter()
    shutter.frame(1000, true)
    shutter.cut()
    expect(shutter.frame(1016, false)).toBe(0)
  })

  // pipeline.ts scales three's motionBlur by n / (n + 1): r186 adds n taps to the centre one and
  // divides by n. Should three fix that, this fails, and the correction must go.
  it("matches three's motionBlur, whose sum the pipeline corrects", () => {
    const source = readFileSync('node_modules/three/examples/jsm/tsl/display/MotionBlur.js', 'utf8')
    expect(source).toContain("start: int( 1 ), end: numSamples, type: 'int', condition: '<='")
    expect(source).toContain('colorResult.divAssign( fSamples )')
  })
})
