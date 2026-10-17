import { describe, expect, it } from 'vitest'
import {
  CLOUD_LAYER,
  DAYLIGHT_EXPOSURE,
  INTERIOR_EXPOSURE,
  NIGHT_EXPOSURE,
  SKY_PRESETS,
  SOLAR,
  STUDIO_BACKDROP,
  cloudySkyRadiance,
  environmentRadiance,
  equirectRadiance,
  exposureAt,
  horizonRadiance,
  nightAt,
  noise,
  skyLook,
  skyRadiance,
  studioRadiance,
  sunAt,
  sunlightAt,
  type Vec3,
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

describe('path-traced environment', () => {
  const luminance = ([r, g, b]: Vec3) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  it('matches the clear sky exactly where there are no clouds', () => {
    const sun = sunAt(11).direction
    const clear = { coverage: 0, ...CLOUD_LAYER }
    for (const d of [
      [0, 1, 0],
      [0.6, 0.3, 0.2],
      [-0.4, 0.1, 0.9],
    ] as Vec3[]) {
      const a = skyRadiance(d, sun, SKY_PRESETS.campus)
      const b = cloudySkyRadiance(d, sun, SKY_PRESETS.campus, clear)
      for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i], 12)
    }
  })
  it('draws soft, bright, finite clouds over part of an overcast-leaning sky', () => {
    const sun = sunAt(12).direction
    const layer = { coverage: 0.6, ...CLOUD_LAYER }
    let clouded = 0,
      samples = 0
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2
      const d: Vec3 = [Math.cos(a) * 0.8, 0.45, Math.sin(a) * 0.8]
      const sky = skyRadiance(d, sun, SKY_PRESETS.residences)
      const cloudy = cloudySkyRadiance(d, sun, SKY_PRESETS.residences, layer)
      for (const c of cloudy) expect(Number.isFinite(c) && c >= 0).toBe(true)
      samples++
      // Clouds whiten the sky: red rises relative to blue.
      if (cloudy[0] / cloudy[2] > (sky[0] / sky[2]) * 1.05) clouded++
    }
    expect(clouded).toBeGreaterThan(samples * 0.05)
    expect(clouded).toBeLessThan(samples)
  })
  it('sees sunlit ground below the horizon and a brighter sky toward the sun', () => {
    const look = skyLook('backyard', 13)
    expect(environmentRadiance([0.3, -0.5, 0.2], look)).toEqual(look.ground)
    const sun = look.sunlight.direction
    const toward = environmentRadiance([sun[0], Math.max(0.05, sun[1] * 0.5), sun[2]], look)
    const away = environmentRadiance([-sun[0], Math.max(0.05, sun[1] * 0.5), -sun[2]], look)
    expect(luminance(toward)).toBeGreaterThan(luminance(away))
    // Daylit ground is a dim, warm-to-neutral reflector, far below the sun's irradiance.
    expect(luminance(look.ground)).toBeGreaterThan(0.01)
    expect(luminance(look.ground)).toBeLessThan(2)
  })
  it('lays out equirect maps the way the path tracer samples them', () => {
    const width = 64,
      height = 32
    // Encode the direction itself to check the mapping.
    const data = equirectRadiance(width, height, (d) => [d[0], d[1], d[2]])
    const at = (col: number, row: number) => {
      const o = (row * width + col) * 4
      return [data[o], data[o + 1], data[o + 2], data[o + 3]]
    }
    expect(at(0, 0)[1]).toBeLessThan(-0.99) // first row looks straight down
    expect(at(0, height - 1)[1]).toBeGreaterThan(0.99) // last row looks straight up
    const mid = height / 2
    expect(at(width / 2, mid)[0]).toBeGreaterThan(0.99) // u = 0.5 looks along +x
    expect(at((width * 3) / 4, mid)[2]).toBeGreaterThan(0.99) // u = 0.75 looks along +z
    expect(at(3, 5)[3]).toBe(1)
  })
  it('places the studio softboxes where the raster capture renders them', () => {
    // The key light hangs overhead, slightly in front.
    const key = studioRadiance([0, 1, 0.2])
    expect(key[0]).toBeCloseTo(5.5, 6)
    expect(studioRadiance([0, -1, 0])).toEqual(STUDIO_BACKDROP)
    // The low front strip light is wide and shallow.
    expect(studioRadiance([0, 0.15, 1])[0]).toBeCloseTo(1.6, 6)
    expect(studioRadiance([0, 0.3, 1])).toEqual(STUDIO_BACKDROP)
  })
})

describe('camera exposure', () => {
  it('is fixed by the time of day alone, outside and in the room', () => {
    // The live view and every still take it from here; nothing about the device enters it.
    expect(exposureAt.length).toBe(1)
    const noon = exposureAt(12)
    expect(noon.exterior).toBe(DAYLIGHT_EXPOSURE)
    expect(noon.interior).toBeCloseTo(DAYLIGHT_EXPOSURE * INTERIOR_EXPOSURE, 12)
    expect(exposureAt(12)).toEqual(noon)
    // A camera inside opens up, by less than a stop.
    expect(INTERIOR_EXPOSURE).toBeGreaterThan(1)
    expect(INTERIOR_EXPOSURE).toBeLessThan(2)
  })
  it('opens up after dark, smoothly, as eyes adapt', () => {
    expect(exposureAt(22).exterior).toBeCloseTo(DAYLIGHT_EXPOSURE * (1 + NIGHT_EXPOSURE), 6)
    let previous = exposureAt(18).exterior
    for (let time = 18; time <= 22; time += 0.05) {
      const { exterior, interior } = exposureAt(time)
      expect(exterior).toBeGreaterThanOrEqual(previous - 1e-12)
      expect(exterior - previous).toBeLessThan(0.2 * DAYLIGHT_EXPOSURE)
      expect(interior / exterior).toBeCloseTo(INTERIOR_EXPOSURE, 12)
      previous = exterior
    }
  })
})
