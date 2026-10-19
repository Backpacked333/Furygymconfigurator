import type { Quality } from './quality'

/**
 * Every cost knob of a tier, in one place. The viewer uses the rendering ones; products read the
 * content ones (`density`, `shadowMapSize`, `probe`, `textures`) through `useTier()` so their
 * scenes scale with the device the same way the renderer does.
 */
export type TierSpec = {
  /** Upper bound of the canvas pixel ratio. */
  dpr: number
  /** While the camera moves: pixel ratio of the frame and its multisampling. */
  motion: { dpr: number; samples: number }
  /** Multisampling of the Lite tier's single pass (High and Ultra resolve edges temporally). */
  samples: number
  /** Frames drawn after a change so temporal AA, AO, and GI converge. */
  settleFrames: number
  ao: { samples: number } | null
  gi: { slices: number; steps: number } | null
  /** Sun shadow map, in pixels per side. */
  shadowMapSize: number
  /** Room light probe: cube face size and diffuse bounces per capture. */
  probe: { size: number; passes: number }
  /** Sky reflection map, per cube face. */
  environmentSize: number
  /** Texture resolution the product should load: light copies, live copies, or full scans. */
  textures: 'light' | 'live' | 'full'
  /** Fraction of decorative instances (grass, foliage) to draw. */
  density: number
}

export const TIERS: Record<Quality, TierSpec> = {
  lite: {
    dpr: 1,
    motion: { dpr: 1, samples: 4 },
    samples: 4,
    settleFrames: 1,
    ao: null,
    gi: null,
    shadowMapSize: 1024,
    probe: { size: 64, passes: 1 },
    environmentSize: 128,
    textures: 'live',
    density: 0.25,
  },
  // One forward pass, like Lite, at a sharper pixel ratio: every shader compiles once, and the
  // same pass draws while moving, so there is never a second compile on the first drag.
  high: {
    dpr: 1.5,
    motion: { dpr: 1, samples: 4 },
    samples: 4,
    settleFrames: 1,
    ao: null,
    gi: null,
    shadowMapSize: 2048,
    probe: { size: 128, passes: 1 },
    environmentSize: 256,
    textures: 'live',
    density: 0.6,
  },
  // The full post-processing pipeline: a depth/normal pre-pass, AO, bloom, temporal AA and GI.
  // Each pass compiles the scene's shaders again, so it is opt-in (and what stills render with).
  ultra: {
    dpr: 1.5,
    motion: { dpr: 1, samples: 2 },
    samples: 4,
    settleFrames: 20,
    ao: { samples: 16 },
    gi: { slices: 2, steps: 10 },
    shadowMapSize: 2048,
    probe: { size: 128, passes: 1 },
    environmentSize: 512,
    textures: 'full',
    density: 1,
  },
}

/**
 * Pre-rendered stills: time is free offline, so every knob is at its best. Built on Ultra so the
 * pipeline's shape (and the look) matches the live view's best tier.
 */
export const STILL_TIER: TierSpec = {
  ...TIERS.ultra,
  settleFrames: 64,
  ao: { samples: 32 },
  gi: { slices: 3, steps: 16 },
  shadowMapSize: 4096,
  probe: { size: 192, passes: 3 },
  environmentSize: 512,
  textures: 'full',
  density: 1,
}
