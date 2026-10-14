import { describe, expect, it } from 'vitest'
import {
  SKY_PRESETS,
  SOLAR,
  horizonRadiance,
  lightingAt,
  nightAt,
  noise,
  skyRadiance,
  sunAt,
  sunlightAt,
} from './visuals'

describe('instancing noise', () => {
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

describe('sun path', () => {
  it('rises at sunrise, peaks near midday, and sets into twilight', () => {
    expect(sunAt(SOLAR.sunrise).elevation).toBeCloseTo(0, 6)
    expect(sunAt(SOLAR.sunset).elevation).toBeCloseTo(0, 6)
    const noon = (SOLAR.sunrise + SOLAR.sunset) / 2
    expect(sunAt(noon).elevation).toBeCloseTo(SOLAR.maxElevation, 6)
    expect(sunAt(21).elevation).toBeLessThan(0)
    for (let time = 6; time <= 21; time += 0.25) {
      const [x, y, z] = sunAt(time).direction
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6)
      // The sun always stays in front of the glazed facade.
      expect(z).toBeGreaterThan(0)
    }
    expect(sunAt(8).direction[0]).toBeGreaterThan(0)
    expect(sunAt(19).direction[0]).toBeLessThan(0)
  })
})

describe('physical sky', () => {
  const sky = SKY_PRESETS.courtyard
  it('produces a blue zenith and a warmer, dimmer sun at golden hour', () => {
    const noonSun = sunAt(13.25).direction
    const [r, , b] = skyRadiance([0, 1, 0], noonSun, sky)
    expect(b).toBeGreaterThan(r)
    const noon = sunlightAt(13.25, sky)
    const evening = sunlightAt(19.5, sky)
    expect(evening.intensity).toBeLessThan(noon.intensity)
    expect(evening.color[0]).toBeGreaterThanOrEqual(evening.color[2])
    expect(evening.color[2] / evening.color[0]).toBeLessThan(noon.color[2] / noon.color[0])
    for (const c of [...noon.color, ...evening.color]) {
      expect(c).toBeGreaterThan(0)
      expect(c).toBeLessThanOrEqual(1)
    }
  })
  it('fades sunlight smoothly to zero after dark and reports night', () => {
    let previous = sunlightAt(6, sky).intensity
    for (let time = 6; time <= 21; time += 0.05) {
      const { intensity } = sunlightAt(time, sky)
      expect(Number.isFinite(intensity)).toBe(true)
      expect(Math.abs(intensity - previous)).toBeLessThan(0.08)
      previous = intensity
    }
    expect(sunlightAt(21, sky).intensity).toBe(0)
    expect(nightAt(12)).toBe(0)
    expect(nightAt(21)).toBeGreaterThan(0.5)
  })
  it('gives finite, positive horizon fog colors for every surrounding', () => {
    for (const preset of Object.values(SKY_PRESETS)) {
      for (const time of [6, 9, 13, 18, 20.5, 21]) {
        for (const channel of horizonRadiance(sunAt(time).direction, preset)) {
          expect(Number.isFinite(channel)).toBe(true)
          expect(channel).toBeGreaterThan(0)
        }
      }
    }
  })
})
