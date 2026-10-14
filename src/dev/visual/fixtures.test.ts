import { describe, expect, it } from 'vitest'
import { configSchema } from '../../lib/config'
import {
  CAPTURE_PROFILES,
  VISUAL_FIXTURES,
  cropForOutput,
  fixtureHash,
  resolveFixture,
} from './fixtures'
import { COVERAGE_LEDGER, PRODUCT_FACTS, VISUAL_RUBRIC } from './coverage'

describe('deterministic visual fixture recipes', () => {
  it('covers VF01–VF12 in order without duplicate IDs', () => {
    expect(VISUAL_FIXTURES.map((f) => f.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `VF${String(i + 1).padStart(2, '0')}`),
    )
    expect(VISUAL_FIXTURES.slice(0, 9).map((f) => f.references)).toEqual(
      Array.from({ length: 9 }, (_, i) => [`R${String(i + 1).padStart(2, '0')}`]),
    )
  })
  it.each(VISUAL_FIXTURES)(
    '$id keeps a valid v2 baseline and a separate parent-v3 candidate for every shot',
    (fixture) => {
      expect(new Set(fixture.shots.map((s) => s.id)).size).toBe(fixture.shots.length)
      for (const shot of fixture.shots) {
        const { baseConfig, candidate } = resolveFixture(fixture.id, shot.id)
        expect(configSchema.safeParse(baseConfig).success).toBe(true)
        expect(baseConfig.v).toBe(2)
        expect('openingConcept' in baseConfig).toBe(false)
        expect(candidate.v).toBe(3)
        if (candidate.openingConcept !== 'standard') expect(candidate.family).toBe('container')
        expect(candidate.addons.gazebo).toBe(false)
        expect([20, 40]).toContain(candidate.length)
        expect(fixture.geometryStatus).toBe('candidate-not-rendered')
      }
    },
  )
  it('preserves exact parent concepts without silently substituting baseline features', () => {
    expect(resolveFixture('VF05').baseConfig.addons.deck).toBe(false)
    expect(resolveFixture('VF05').candidate.addons.deck).toBe(true)
    expect(resolveFixture('VF07').candidate.addons).toMatchObject({ roof: true, stairs: true })
    expect(resolveFixture('VF08').candidate.presentation.context).toBe('custom-wellness')
    expect(resolveFixture('VF08').candidate.family).toBe('studio')
    expect(resolveFixture('VF09').candidate.presentation.context).toBe('sunken-lounge')
    for (const id of ['VF04', 'VF05', 'VF09'] as const) {
      const fixture = VISUAL_FIXTURES.find((f) => f.id === id)!
      expect(
        new Set(
          fixture.shots.map((s) => resolveFixture(id, s.id).candidate.presentation.openingPose),
        ),
      ).toEqual(new Set(['open', 'closed']))
    }
  })
  it('returns isolated deep copies and repeatable SHA-256 recipe hashes', async () => {
    const before = await fixtureHash('VF01')
    const copy = resolveFixture('VF01')
    copy.baseConfig.items[0].x = 100
    copy.candidate.addons.roof = false
    copy.shot.camera.position[0] = 999
    expect(await fixtureHash('VF01')).toBe(before)
    expect(before).toMatch(/^[a-f0-9]{64}$/)
    expect(await fixtureHash('VF01', 'roof-landing')).not.toBe(before)
    expect(() => resolveFixture('VF01', 'missing')).toThrow('Unknown shot')
  })
  it('pins camera, time, exposure, readiness and 100% in-bounds crop rectangles', () => {
    for (const fixture of VISUAL_FIXTURES) {
      expect(fixture.assetVersion).toContain('15f36b81')
      expect(fixture.readiness.required).toBe('settled')
      for (const shot of fixture.shots) {
        expect(shot.camera.position).not.toEqual(shot.camera.target)
        expect([...shot.camera.position, ...shot.camera.target].every(Number.isFinite)).toBe(true)
        expect(shot.camera.fov).toBeGreaterThanOrEqual(30)
        expect(shot.camera.fov).toBeLessThanOrEqual(70)
        expect(shot.time).toBeGreaterThanOrEqual(6)
        expect(shot.time).toBeLessThanOrEqual(21)
        expect(shot.exposure).toBe(1)
        for (const crop of shot.crops) {
          const [x, y, w, h] = crop.rect
          expect(crop.inspectAt).toBe('100%')
          expect(x).toBeGreaterThanOrEqual(0)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(w * h).toBeGreaterThan(0)
          expect(x + w).toBeLessThanOrEqual(1920)
          expect(y + h).toBeLessThanOrEqual(1080)
        }
      }
    }
  })
  it('separates native 4K capture from DPR and rejects mismatched crop framing', () => {
    expect(CAPTURE_PROFILES.find((p) => p.id === 'presentation-native-4k')).toMatchObject({
      output: [3840, 2160],
      expectedBuffer: [3840, 2160],
      mode: 'presentation',
    })
    expect(CAPTURE_PROFILES.find((p) => p.id === 'laptop-dpr2')?.expectedBuffer).toEqual([
      2880, 1800,
    ])
    const crop = VISUAL_FIXTURES[0].shots[0].crops[0]
    expect(cropForOutput(crop, 3840, 2160).rect).toEqual(crop.rect.map((v) => v * 2))
    expect(() => cropForOutput(crop, 1440, 900)).toThrow('16:9')
    expect(() => cropForOutput(crop, -1920, -1080)).toThrow()
  })
  it('retains construction, mirror, contact, movement and recovery detail shots', () => {
    const shots = VISUAL_FIXTURES.flatMap((f) => f.shots.map((s) => s.id))
    expect(shots).toEqual(
      expect.arrayContaining([
        'studio-chalk',
        'studio-obsidian',
        'container-hardware-chalk',
        'container-hardware-obsidian',
        'neutral-day',
        'neutral-warm',
        'glass-grazing-evening',
        'mirror-metal-interior',
        'rack-rear-oblique',
        'bench-floor-contact',
        'reformer-rear',
        'sauna-plunge-rear',
      ]),
    )
  })
})

describe('reference truth and honest review state', () => {
  it('traces every original to control, persisted fields, plan, 3D, export, owner and acceptance', () => {
    expect(new Set(COVERAGE_LEDGER.map((r) => r.reference)).size).toBe(9)
    for (const row of COVERAGE_LEDGER) {
      expect(
        row.userPath.length *
          row.planImpact.length *
          row.states3d.length *
          row.exportWording.length,
      ).toBeGreaterThan(0)
      expect(row.owner).not.toBe('')
      expect(row.storedFields.length).toBeGreaterThan(0)
      expect(row.acceptance.length).toBeGreaterThan(0)
      expect(VISUAL_FIXTURES.find((f) => f.id === row.fixture)?.references).toContain(row.reference)
    }
  })
  it('does not fabricate configured prices or certify imagery / visual outcomes', () => {
    expect(
      PRODUCT_FACTS.every((p) => p.configuredTotal === null && p.nominalFeet.width === 8),
    ).toBe(true)
    expect(PRODUCT_FACTS.map((p) => p.startingUSD)).toEqual([20000, 35000])
    expect(VISUAL_RUBRIC.premium.status).toBe('NOT REVIEWED')
    expect(VISUAL_RUBRIC.lite.scores).toBeNull()
    expect(VISUAL_RUBRIC.dimensions).toHaveLength(9)
  })
})
