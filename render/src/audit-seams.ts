import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { CAMERA_PRESETS, EXTERIOR_ANGLES } from '../../src/lib/cameras'
import { everyConfiguration, layersFor } from '../../src/lib/stills'
import { over, psnr } from './audit'
import { compose } from './compose'
import { jobFor, settingsFrom } from './jobs'
import { WebGpuPlaywrightRenderer } from './renderers/webgpu-playwright'

/**
 * Renders sample configurations both ways, as one full image and as the interior and shell
 * layers stacked like the browser stacks them, and fails when they differ visibly, overall or
 * near the edges of the see-through region where a matte error would show.
 */
const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: '../dist' },
    samples: { type: 'string', default: '12' },
    pages: { type: 'string', default: '2' },
    threshold: { type: 'string', default: '40' },
    'allow-fallback': { type: 'boolean', default: false },
    webgl: { type: 'boolean', default: false },
    quality: { type: 'string' },
    frames: { type: 'string' },
    scale: { type: 'string' },
    width: { type: 'string' },
  },
})
const settings = settingsFrom(args)

const all = [...everyConfiguration()]
const step = Math.floor(all.length / Number(args.samples))
const samples = all.filter((_, i) => i % step === 0).slice(0, Number(args.samples))
const angles = EXTERIOR_ANGLES.filter((a) => CAMERA_PRESETS[a].seesInterior)
const renderer = new WebGpuPlaywrightRenderer({
  dist: resolve(args.dist!),
  pages: Number(args.pages),
  allowFallback: args['allow-fallback'],
  webgl: args.webgl,
})
await renderer.init()
let worst = Infinity
try {
  for (const [i, config] of samples.entries()) {
    const angle = angles[i % angles.length]
    const [interior, shell] = layersFor(config, angle)
    const full = await compose(
      await renderer.render(jobFor({ ...interior, kind: 'full', config }, settings, 'full')),
      'full',
    )
    const bottom = await compose(await renderer.render(jobFor(interior, settings)), 'interior')
    const top = await compose(await renderer.render(jobFor(shell, settings)), 'shell')
    const stacked = over(top, bottom)
    const edge = (p: number) => {
      const a = top.data[p * 4 + 3]
      return a > 3 && a < 252
    }
    const overall = psnr(full, stacked),
      seams = psnr(full, stacked, edge)
    worst = Math.min(worst, overall, seams)
    console.log(
      `${angle} sample ${i}: ${overall.toFixed(1)} dB overall, ${seams.toFixed(1)} dB at seams`,
    )
  }
} finally {
  await renderer.close()
}
if (worst < Number(args.threshold)) {
  console.error(`Seam audit failed: worst ${worst.toFixed(1)} dB < ${args.threshold} dB.`)
  process.exit(1)
}
console.log(`Seam audit passed: worst ${worst.toFixed(1)} dB.`)
