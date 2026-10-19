import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, configSchema, setFamily, type Config } from './config'
import { ANGLES, CAMERA_PRESETS, exteriorFraming, stillPose, type AngleId } from './cameras'
import { canonicalJson, hash128, renderKey } from './renderKey'
import { enumerateLayers, everyConfiguration, layersFor, type Layer } from './stills'
import { effectiveLighting, effectiveLights, sceneTime } from './lighting'
import { nightAt } from './visuals'
import { interiorBounds } from '../render/architecture'

const studio = (): Config => structuredClone(DEFAULT_CONFIG)
const container = (): Config => setFamily(studio(), 'container')
const keys = (c: Config, angle: AngleId) => layersFor(c, angle).map((l) => l.key)
const keyOf = (c: Config, angle: AngleId, kind: Layer['kind']) =>
  layersFor(c, angle).find((l) => l.kind === kind)!.key

describe('render keys', () => {
  it('hash canonical JSON, independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}',
    )
    expect(renderKey({ a: 1, b: 2 })).toBe(renderKey({ b: 2, a: 1 }))
    expect(renderKey({ a: 1 })).not.toBe(renderKey({ a: 1 }, 'cycles-4'))
    expect(hash128('')).toMatch(/^[0-9a-f]{32}$/)
    expect(hash128('a')).not.toBe(hash128('b'))
  })
  it('stay stable for the default build (a change here means every still is re-rendered)', () => {
    expect(keys(studio(), 'hero')).toMatchInlineSnapshot(`
      [
        "d2b2795c2cf67fe6fca3592591546d6c",
        "18832353395403d9365f2442af54470c",
      ]
    `)
  })
})

describe('layers show exactly what an angle can see', () => {
  it('stacks an interior under the shell where the inside shows, one image elsewhere', () => {
    for (const angle of ANGLES) {
      const kinds = layersFor(studio(), angle).map((l) => l.kind)
      const preset = CAMERA_PRESETS[angle]
      expect(kinds).toEqual(
        preset.view === 'exterior' && preset.seesInterior ? ['interior', 'shell'] : ['full'],
      )
    }
  })
  it('keeps exterior shells and the rear when only the interior changes', () => {
    const changed: Config = { ...studio(), package: 'cardio', flooring: 'oak', mirror: true }
    for (const angle of ['hero', 'front', 'frontLeft', 'aerial'] as const) {
      expect(keyOf(changed, angle, 'shell')).toBe(keyOf(studio(), angle, 'shell'))
      expect(keyOf(changed, angle, 'interior')).not.toBe(keyOf(studio(), angle, 'interior'))
    }
    expect(keys(changed, 'rear')).toEqual(keys(studio(), 'rear'))
    expect(keys(changed, 'interiorHero')).not.toEqual(keys(studio(), 'interiorHero'))
  })
  it('keeps interiors when only the outside changes, except chalk paint', () => {
    const outside: Config = {
      ...studio(),
      finish: 'olive',
      accent: true,
      addons: { deck: false, gazebo: false, roof: true, stairs: true },
    }
    expect(keyOf(outside, 'hero', 'interior')).toBe(keyOf(studio(), 'hero', 'interior'))
    expect(keys(outside, 'interiorHero')).toEqual(keys(studio(), 'interiorHero'))
    expect(keyOf(outside, 'hero', 'shell')).not.toBe(keyOf(studio(), 'hero', 'shell'))
    const chalk: Config = { ...studio(), finish: 'chalk' }
    expect(keyOf(chalk, 'hero', 'interior')).not.toBe(keyOf(studio(), 'hero', 'interior'))
  })
  it('ignores layout inquiries, and lights by day and in the studio', () => {
    const base = studio()
    expect(keys({ ...base, studioLayout: 'stacked' }, 'hero')).toEqual(keys(base, 'hero'))
    expect(keys({ ...base, lights: false }, 'hero')).toEqual(keys(base, 'hero'))
    const night: Config = { ...base, lighting: 'night' }
    expect(keys({ ...night, lights: false }, 'hero')).not.toEqual(keys(night, 'hero'))
    const backdrop: Config = { ...base, environment: 'studio' }
    expect(keys({ ...backdrop, lighting: 'night', lights: false }, 'hero')).toEqual(
      keys(backdrop, 'hero'),
    )
  })
  it('sees the deck from inside only when looking out', () => {
    const deck: Config = { ...studio(), addons: { ...studio().addons, deck: true } }
    expect(keys(deck, 'interiorHero')).toEqual(keys(studio(), 'interiorHero'))
    expect(keys(deck, 'interiorReverse')).not.toEqual(keys(studio(), 'interiorReverse'))
  })
  it('renders a valid representative whose own layers have the same key', () => {
    const samples = [
      studio(),
      { ...container(), containerOpening: 'partial', integratedFinish: true, finish: 'chalk' },
      {
        ...studio(),
        environment: 'rooftop',
        lighting: 'night',
        lights: false,
        addons: { deck: true, gazebo: true, roof: true, stairs: true },
        package: 'recovery',
        mirror: true,
        accent: true,
      },
      { ...container(), length: 40, environment: 'studio', flooring: 'stone' },
    ] satisfies Config[]
    for (const c of samples)
      for (const angle of ANGLES)
        for (const l of layersFor(c, angle)) {
          expect(configSchema.safeParse(l.config).success).toBe(true)
          expect(layersFor(l.config, angle).find((x) => x.kind === l.kind)!.key).toBe(l.key)
        }
  })
})

describe('the full set of layers', () => {
  let layers: Map<string, Layer>
  const angles = ['rear', 'interiorReverse', 'hero'] as const
  beforeAll(() => {
    layers = new Map(enumerateLayers(angles).map((l) => [l.key, l]))
  }, 60_000)
  it('covers every layer of every configuration', () => {
    let i = 0
    for (const c of everyConfiguration()) {
      // A spread sample: every 97th configuration, which visits every option value.
      if (i++ % 97) continue
      for (const angle of angles)
        for (const l of layersFor(c, angle)) expect(layers.has(l.key)).toBe(true)
    }
  })
  it('collapses what an angle cannot show', () => {
    const count = (angle: AngleId) => [...layers.values()].filter((l) => l.angle === angle).length
    // 320 shells (Studio additions and accent, Container openings) under 10 lighting moods.
    expect(count('rear')).toBe(3200)
    expect(count('hero')).toBeLessThan(10_000)
  })
})

describe('cameras', () => {
  it('frame the live view for the additions chosen and stills for the largest build', () => {
    const plain = studio(),
      full: Config = { ...plain, addons: { deck: true, gazebo: true, roof: true, stairs: true } }
    const hero = CAMERA_PRESETS.hero.direction!
    const live = exteriorFraming(plain, 32, 16 / 9, hero)
    expect(exteriorFraming(full, 32, 16 / 9, hero).position).not.toEqual(live.position)
    expect(stillPose(plain, 'hero')).toEqual(stillPose(full, 'hero'))
    expect(live.target).toEqual([0, 3.5, 0])
  })
  it('keep every still camera above ground, outside exteriors and inside interiors', () => {
    for (const c of [studio(), container(), { ...studio(), length: 40 as const }])
      for (const angle of ANGLES) {
        const { position } = stillPose(c, angle)
        expect(position[1]).toBeGreaterThan(2)
        const inside =
          Math.abs(position[0]) < c.length / 2 - 0.6 &&
          position[2] > interiorBounds(c).back &&
          position[2] < interiorBounds(c).front &&
          position[1] < interiorBounds(c).ceiling
        expect(inside).toBe(CAMERA_PRESETS[angle].view === 'interior')
      }
  })
})

describe('lighting', () => {
  it('maps Day and Night to day light and blue-hour darkness', () => {
    expect(nightAt(sceneTime({ environment: 'courtyard', lighting: 'day' }))).toBe(0)
    expect(nightAt(sceneTime({ environment: 'courtyard', lighting: 'night' }))).toBeGreaterThan(0.8)
    expect(effectiveLighting({ environment: 'studio', lighting: 'night' })).toBe('day')
    expect(effectiveLights({ environment: 'rooftop', lighting: 'day', lights: false })).toBe(true)
    expect(effectiveLights({ environment: 'rooftop', lighting: 'night', lights: false })).toBe(
      false,
    )
  })
})
