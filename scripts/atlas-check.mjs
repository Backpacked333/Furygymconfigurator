#!/usr/bin/env node
/**
 * Checks, on SwiftShader's WebGPU in headless Chromium, that three-gpu-pathtracer's texture atlas
 * drawn from the textures themselves (the patch in patches/) holds exactly the bytes it held when
 * drawn from clones: the clones only re-uploaded the same pixels, which the 360° view no longer
 * keeps decoded.
 *
 *   node scripts/atlas-check.mjs
 *
 * Exits non-zero on any differing byte.
 */
import { withPage } from './convergence/browser.mjs'

const result = await withPage('scripts/convergence/atlas.ts', async (page) => {
  await page.waitForFunction(() => typeof window.checkAtlas === 'function')
  return page.evaluate(() => window.checkAtlas())
})
console.log(JSON.stringify(result))
process.exit(result.differing === 0 && !result.blank && result.transformsKept ? 0 : 1)
