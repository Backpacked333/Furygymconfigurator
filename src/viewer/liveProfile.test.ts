import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { historyCapacity } from '../render/historyCache'
import { STRICT_REFERENCE_SETTINGS } from '../render/prototype/strictReference'
import {
  CLEAN_MS,
  CLEAN_SAMPLES,
  LIGHT,
  UPGRADE_MS,
  UPGRADE_SHOW_SAMPLES,
  deviceTier,
  upgradePlan,
  MIN_BUDGET_SCALE,
  REFERENCE_PIXELS,
  budgetPixels,
  liveProfile,
  requestedTraceScale,
  settleSamples,
  traceScale,
} from './liveProfile'

describe("the 360° view's trace scale", () => {
  it('traces Lite at half, whatever the canvas or the request', () => {
    expect(traceScale('lite', 3000, 2000, null)).toBe(0.5)
    expect(traceScale('lite', 640, 400, null)).toBe(0.5)
    expect(traceScale('lite', 1545, 966, 0.75)).toBe(0.5)
  })

  it("traces High and Ultra at the canvas's own resolution up to the Cycles image's pixels", () => {
    expect(REFERENCE_PIXELS).toBe(1920 * 1200)
    expect(traceScale('ultra', 1545, 966, null)).toBe(1)
    expect(traceScale('high', 1920, 1200, null)).toBe(1)
    expect(traceScale('high', 0, 0, null)).toBe(1)
  })

  it('caps larger canvases at the reference, rounded as the tracer sizes itself', () => {
    for (const [width, height] of [
      [2976, 1860],
      [2616, 1635],
      [3840, 2400],
      [1977, 1236],
    ])
      for (const quality of ['high', 'ultra'] as const) {
        const scale = traceScale(quality, width, height, null)
        expect(scale).toBeLessThan(1)
        // The tracer and PathTraceSession.syncSize both floor scale × buffer.
        const traced = Math.floor(scale * width) * Math.floor(scale * height)
        expect(traced).toBeLessThanOrEqual(REFERENCE_PIXELS)
        expect(traced).toBeGreaterThan(0.99 * REFERENCE_PIXELS)
      }
  })

  it('leaves room for history on a large canvas, which at full resolution keeps none', () => {
    const scale = traceScale('ultra', 2976, 1860, null)
    expect(historyCapacity(2976, 1860)).toBe(0)
    expect(
      historyCapacity(Math.floor(scale * 2976), Math.floor(scale * 1860)),
    ).toBeGreaterThanOrEqual(1)
  })

  it('takes ?traceScale= from 0.5 to 1 on High and Ultra, ignoring anything else', () => {
    expect(requestedTraceScale('?traceScale=0.75')).toBe(0.75)
    expect(requestedTraceScale('?traceScale=0.5')).toBe(0.5)
    expect(requestedTraceScale('?traceScale=1')).toBe(1)
    for (const search of [
      '',
      '?traceScale=',
      '?traceScale=%20',
      '?traceScale=0.2',
      '?traceScale=1.5',
      '?traceScale=abc',
      '?traceScale=Infinity',
    ])
      expect(requestedTraceScale(search)).toBeNull()
    expect(traceScale('ultra', 1545, 966, 0.75)).toBe(0.75)
    expect(traceScale('high', 3840, 2400, 1)).toBe(1)
  })
})

/** The gallery's Cycles recipe, as the render server sets it up. */
const BLENDER = readFileSync('render-server/fury_render/blender.py', 'utf8')
const PROTOCOL = readFileSync('render-server/fury_render/protocol.py', 'utf8')
/** The value a recipe line assigns, e.g. `c.sample_clamp_indirect = 10`. */
const assigned = (source: string, name: string) => {
  const found = new RegExp(`^\\s*(?:c\\.)?${name} = (\\w+)$`, 'm').exec(source)
  if (!found) throw new Error(`${name} is not assigned`)
  return found[1]
}

describe("the 360° view's live profile", () => {
  it('names no trace scale of its own: the canvas decides it at each start', () => {
    for (const quality of ['lite', 'high', 'ultra'] as const)
      expect(liveProfile(quality)).not.toHaveProperty('renderScale')
  })

  it("traces High and Ultra as deep as the gallery's Cycles images, one tracer vertex more", () => {
    const bounces = Number(assigned(PROTOCOL, 'BOUNCES'))
    expect(bounces).toBe(6)
    // Every per-type limit is the overall one, so a single tracer counter matches all of them.
    for (const name of ['max_bounces', 'diffuse_bounces', 'glossy_bounces', 'transmission_bounces'])
      expect(assigned(BLENDER, name)).toBe('BOUNCES')
    expect(assigned(BLENDER, 'volume_bounces')).toBe('0')
    expect(STRICT_REFERENCE_SETTINGS.bounces).toMatchObject({
      max: bounces,
      diffuse: bounces,
      glossy: bounces,
      transmission: bounces,
      volume: 0,
    })
    for (const quality of ['high', 'ultra'] as const)
      expect(liveProfile(quality).maxBounces).toBe(bounces + 1)
    // Lite keeps its budget: Cycles' 3.
    expect(liveProfile('lite').maxBounces).toBe(4)
  })

  it("counts as the installed tracer does: the camera's hit is bounce 0", () => {
    // A tracer upgrade that counts otherwise would make the +1 above wrong.
    const kernel = readFileSync(
      'node_modules/three-gpu-pathtracer/src/webgpu/compute/wavefront/MaterialKernel.js',
      'utf8',
    )
    expect(kernel).toContain('rayQueue.elements[ rayIndex ].currentBounce = 0u;')
    expect(kernel).toContain('let newBounce = input.currentBounce + 1u;')
    expect(kernel).toMatch(/var isTerminated = newBounce >= maxBounces \|\|/)
  })

  it('clamps every tier as the Cycles recipe does', () => {
    const direct = Number(assigned(BLENDER, 'sample_clamp_direct'))
    const indirect = Number(assigned(BLENDER, 'sample_clamp_indirect'))
    expect([direct, indirect]).toEqual([
      STRICT_REFERENCE_SETTINGS.clamp.direct,
      STRICT_REFERENCE_SETTINGS.clamp.indirect,
    ])
    for (const quality of ['lite', 'high', 'ultra'] as const)
      expect(liveProfile(quality)).toMatchObject({ clampDirect: direct, clampIndirect: indirect })
  })
})

describe('"fast and stable": fitting the trace to what a sample costs on the device', () => {
  it('traces as many pixels as give a clean image within CLEAN_MS', () => {
    // 156 ms per megapixel-sample: 16 samples of a megapixel take 2.5 s.
    const cost = CLEAN_MS / CLEAN_SAMPLES
    expect(budgetPixels(cost)).toBeCloseTo(1e6)
    const scale = traceScale('ultra', 2421, 1512, null, cost)
    const traced = Math.floor(scale * 2421) * Math.floor(scale * 1512)
    expect(traced).toBeLessThanOrEqual(1e6)
    expect(traced).toBeGreaterThan(0.99e6)
  })

  it('changes nothing for a fast GPU or an unknown one, and never goes below half', () => {
    const full = traceScale('ultra', 2421, 1512, null)
    expect(traceScale('ultra', 2421, 1512, null, null)).toBe(full)
    expect(traceScale('ultra', 2421, 1512, null, 5)).toBe(full)
    expect(traceScale('ultra', 2421, 1512, null, 1e6)).toBe(MIN_BUDGET_SCALE)
    // A pinned ?traceScale and Lite are as before.
    expect(traceScale('ultra', 2421, 1512, 0.75, 1e6)).toBe(0.75)
    expect(traceScale('lite', 2421, 1512, null, 1e6)).toBe(0.5)
  })

  it('settles at what SETTLE_MS buys, between 64 and 1024 samples', () => {
    expect(settleSamples(0.5)).toBe(64)
    expect(settleSamples(10)).toBe(120)
    expect(settleSamples(500)).toBe(1024)
  })
})

describe('device tiers: light on slow GPUs, a full-quality upgrade on decent and fast ones', () => {
  it('ranks a device by what a clean full-depth image at the Cycles cap costs it', () => {
    expect(deviceTier(null)).toBe('unknown')
    expect(deviceTier(40)).toBe('fast')
    expect(deviceTier(300)).toBe('decent')
    // The user's Mac, measured: 1061 ms per megapixel-sample.
    expect(deviceTier(1061)).toBe('slow')
  })

  it('traces light on slow GPUs: four bounces, down to 0.35 across, settling from 16 samples', () => {
    expect(LIGHT.maxBounces).toBe(4)
    expect(traceScale('ultra', 2329, 1456, null, 1061, LIGHT.floor)).toBe(LIGHT.floor)
    expect(settleSamples(1.1, LIGHT.leastSettle)).toBe(16)
    expect(settleSamples(1.1)).toBe(64)
  })

  it('upgrades at full resolution only where the first shown image comes within UPGRADE_MS', () => {
    const decent = upgradePlan(300, 2329, 1456)
    expect(decent.scale).toBe(1)
    expect(decent.affordable).toBe(true)
    // What UPGRADE_MS buys (44 samples here), never under 64.
    expect(Math.floor(UPGRADE_MS / ((300 * 2329 * 1456) / 1e6))).toBe(44)
    expect(decent.target).toBe(64)
    expect(upgradePlan(5, 2329, 1456).target).toBe(1024)
    // The Mac: 32 samples of 3.4 MP at 1061 ms take far longer.
    expect(upgradePlan(1061, 2329, 1456).affordable).toBe(false)
    expect(UPGRADE_SHOW_SAMPLES).toBe(32)
  })
})
