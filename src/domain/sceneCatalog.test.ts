import { describe, expect, it } from 'vitest'
import {
  DRAFT_LOOKS,
  SCENE_LANDSCAPES,
  resolveLook,
  sceneLook,
  sceneSelection,
} from './presentation'

describe('four landscapes with Day and Night only', () => {
  it('offers exactly four landscapes, including Studio, and eight canonical looks', () => {
    expect(SCENE_LANDSCAPES.map((x) => x.id)).toEqual(['residences', 'campus', 'desert', 'studio'])
    expect(DRAFT_LOOKS).toHaveLength(8)
    for (const landscape of SCENE_LANDSCAPES) {
      for (const lighting of ['day', 'night'] as const) {
        const ref = sceneLook(landscape.id, lighting)
        expect(sceneSelection(ref)).toEqual({ landscape: landscape.id, lighting })
      }
    }
  })
  it('retains old Neutral studio identities without offering another lighting mode', () => {
    expect(resolveLook('studio-neutral-draft@1').preview).toEqual({
      environment: 'studio',
      time: 12,
      lights: true,
    })
    expect(sceneSelection('studio-neutral-draft@1')).toEqual({
      landscape: 'studio',
      lighting: 'day',
    })
    expect(DRAFT_LOOKS.map((x) => x.ref)).not.toContain('studio-neutral-draft@1')
  })
  it('rejects unsupported landscapes and time-of-day presets at runtime', () => {
    // @ts-expect-error untrusted runtime input
    expect(() => sceneLook('backyard', 'day')).toThrow()
    // @ts-expect-error untrusted runtime input
    expect(() => sceneLook('studio', 'dusk')).toThrow()
  })
})
