#!/usr/bin/env node
/**
 * Measures how fast the path tracer converges under different settings, on a small gym-like
 * interior (scripts/convergence/page.ts), in headless Chromium on SwiftShader's WebGPU. Slow (a
 * CPU traces it) but exact: the real tracer, its real kernels.
 *
 *   node scripts/convergence.mjs [--variants <json>] [--repeat <n>]
 *
 * Each variant is traced `repeat` times (unstable noise, so each run draws other samples) and the
 * error at each checkpoint averaged: RMSE of luminance against a 1024-sample reference, relative to
 * its mean. Lower is better; equal errors at equal samples mean no gain. A setting that changes
 * the converged image (bias) shows as an error that stops falling with more samples.
 */
import { parseArgs } from 'node:util'
import { withPage } from './convergence/browser.mjs'

const { values } = parseArgs({
  options: {
    variants: { type: 'string' },
    repeat: { type: 'string', default: '3' },
  },
})
const variants = values.variants
  ? JSON.parse(values.variants)
  : [
      { random: 'blue' },
      { random: 'sobol' },
      { random: 'blue', view: 'equipment' },
      { random: 'sobol', view: 'equipment' },
    ]

await withPage('scripts/convergence/page.ts', async (page) => {
  await page.waitForFunction(() => typeof window.converge === 'function')
  const runs = []
  for (let i = 0; i < Number(values.repeat); i++)
    runs.push(await page.evaluate((v) => window.converge(v), variants))
  for (const [index, variant] of variants.entries()) {
    const errors = {}
    let seconds = 0
    for (const run of runs) {
      seconds += run[index].seconds / runs.length
      for (const [samples, error] of Object.entries(run[index].errors))
        errors[samples] = (errors[samples] ?? 0) + error / runs.length
    }
    const row = Object.entries(errors)
      .map(([samples, error]) => `${samples} spp ${(error * 100).toFixed(1)}%`)
      .join('  ')
    console.log(`${JSON.stringify(variant)}  ${row}  (${seconds.toFixed(1)} s)`)
  }
})
