import { describe, expect, it } from 'vitest'
import { STILL_TIER, TIERS } from './tiers'

describe('tier specs', () => {
  it('cost more at each tier up, never less', () => {
    const order = [TIERS.lite, TIERS.high, TIERS.ultra]
    for (let i = 1; i < order.length; i++) {
      expect(order[i].dpr).toBeGreaterThanOrEqual(order[i - 1].dpr)
      expect(order[i].settleFrames).toBeGreaterThanOrEqual(order[i - 1].settleFrames)
      expect(order[i].shadowMapSize).toBeGreaterThanOrEqual(order[i - 1].shadowMapSize)
      expect(order[i].density).toBeGreaterThanOrEqual(order[i - 1].density)
    }
  })
  it('keep motion frames light on every tier: native pixels at most, little multisampling', () => {
    for (const spec of Object.values(TIERS)) {
      expect(spec.motion.dpr).toBeLessThanOrEqual(1)
      expect(spec.motion.samples).toBeLessThanOrEqual(4)
    }
  })
  it('never render the live view at full Retina density', () => {
    for (const spec of Object.values(TIERS)) expect(spec.dpr).toBeLessThanOrEqual(1.5)
  })
  it('converge within a third of a second at 60 fps', () => {
    for (const spec of Object.values(TIERS)) expect(spec.settleFrames).toBeLessThanOrEqual(20)
  })
  it('give stills every knob at least at its Ultra setting', () => {
    expect(STILL_TIER.ao!.samples).toBeGreaterThanOrEqual(TIERS.ultra.ao!.samples)
    expect(STILL_TIER.gi!.steps).toBeGreaterThanOrEqual(TIERS.ultra.gi!.steps)
    expect(STILL_TIER.shadowMapSize).toBeGreaterThanOrEqual(TIERS.ultra.shadowMapSize)
    expect(STILL_TIER.probe.passes).toBeGreaterThanOrEqual(TIERS.ultra.probe.passes)
    expect(STILL_TIER.density).toBe(1)
  })
})
