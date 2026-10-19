import { describe, expect, it } from 'vitest'
import { PASS_SETTINGS } from './pipeline'

describe('at-rest quality in the 360 view', () => {
  it('only ever adds work at rest, never removes it', () => {
    expect(PASS_SETTINGS.aoSamples.rest).toBeGreaterThan(PASS_SETTINGS.aoSamples.standard)
    expect(PASS_SETTINGS.giSlices.rest).toBeGreaterThan(PASS_SETTINGS.giSlices.standard)
    expect(PASS_SETTINGS.giSteps.rest).toBeGreaterThan(PASS_SETTINGS.giSteps.standard)
    for (const tier of ['high', 'ultra'] as const)
      expect(PASS_SETTINGS.settle[tier].rest).toBeGreaterThan(PASS_SETTINGS.settle[tier].standard)
  })
  it('keeps the standard settings the live view had before', () => {
    expect(PASS_SETTINGS.aoSamples.standard).toBe(16)
    expect(PASS_SETTINGS.giSlices.standard).toBe(2)
    expect(PASS_SETTINGS.giSteps.standard).toBe(10)
    expect(PASS_SETTINGS.settle.high.standard).toBe(28)
    expect(PASS_SETTINGS.settle.ultra.standard).toBe(40)
  })
})
