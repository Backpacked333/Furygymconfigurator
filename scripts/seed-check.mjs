#!/usr/bin/env node
/**
 * Runs the 360° view's Cycles-image seed kernel (history.ts ImageSeedKernel) on SwiftShader's
 * WebGPU in headless Chromium and checks it against the CPU's reading of the same table: its WGSL
 * compiles, each pixel's light matches invertAgx (within 1%: the GPU's float32 acos is coarse near
 * black and white, where the shaper evaluates it), rows land the right way
 * up, an image larger than the view is averaged, and near-white pixels seed nothing.
 *
 *   node scripts/seed-check.mjs
 *
 * Exits non-zero on any mismatch.
 */
import { withPage } from './convergence/browser.mjs'

const results = await withPage('scripts/convergence/seed.ts', async (page) => {
  await page.waitForFunction(() => typeof window.checkSeed === 'function')
  return page.evaluate(() => window.checkSeed())
})
console.log(JSON.stringify(results, null, 1))
const failed = Object.values(results).some(
  (result) => result.worstRelativeError > 0.01 || result.wrongCounts.length > 0,
)
process.exit(failed ? 1 : 0)
