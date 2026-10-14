import { describe, expect, it } from 'vitest'
import { lightingAt, noise, surfacePixels, type Surface } from './visuals'

describe('local material generation', () => {
  const surfaces: Surface[] = ['cedar', 'oak', 'rubber', 'stone', 'plaster', 'metal']
  it.each(surfaces)('creates repeatable opaque %s detail without external assets', (surface) => {
    const pixels = surfacePixels(surface, 32)
    expect(pixels).toHaveLength(32 * 32 * 4)
    expect(pixels).toEqual(surfacePixels(surface, 32))
    const shades = new Set<number>()
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i + 3]).toBe(255)
      expect(pixels[i]).toBe(pixels[i + 1])
      shades.add(pixels[i])
    }
    expect(shades.size).toBeGreaterThan(5)
  })
  it('uses stable, bounded noise for instanced planting', () => {
    for (let i = 0; i < 4800; i++) {
      expect(noise(i, 7)).toBeGreaterThanOrEqual(0)
      expect(noise(i, 7)).toBeLessThanOrEqual(1)
      expect(noise(i, 7)).toBe(noise(i, 7))
    }
    expect(noise(0, 7)).not.toBe(noise(1, 7))
  })
})

describe('time-of-day lighting', () => {
  it('transitions continuously through dawn, golden hour, and evening', () => {
    let previous = lightingAt(6)
    for (let time = 6; time <= 21; time += 0.01) {
      const current = lightingAt(time)
      for (const key of ['daylight', 'warmth', 'elevation'] as const) {
        expect(current[key]).toBeGreaterThanOrEqual(0)
        expect(current[key]).toBeLessThanOrEqual(1)
        expect(Math.abs(current[key] - previous[key])).toBeLessThan(0.02)
      }
      previous = current
    }
    expect(lightingAt(12).daylight).toBe(1)
    expect(lightingAt(21).daylight).toBe(0)
    expect(lightingAt(18).warmth).toBeGreaterThan(lightingAt(12).warmth)
  })
})
