import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { ANGLES } from '../../src/lib/cameras'
import { everyConfiguration, layersFor } from '../../src/lib/stills'
import { psnr } from './audit'
import { compose } from './compose'
import { jobFor, settingsFrom } from './jobs'
import { WebGpuPlaywrightRenderer } from './renderers/webgpu-playwright'

/**
 * A layer's key leaves out the fields it cannot show, and the batch renders one representative
 * configuration per key. This renders each sampled layer from the real configuration and from
 * its representative: if they differ, the key leaves out something visible.
 */
const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: '../dist' },
    samples: { type: 'string', default: '14' },
    pages: { type: 'string', default: '2' },
    threshold: { type: 'string', default: '42' },
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
const step = Math.floor(all.length / Number(args.samples)) + 7
const renderer = new WebGpuPlaywrightRenderer({
  dist: resolve(args.dist!),
  pages: Number(args.pages),
  allowFallback: args['allow-fallback'],
  webgl: args.webgl,
})
await renderer.init()
let failures = 0
try {
  for (let i = 0; i < Number(args.samples); i++) {
    const config = all[(i * step) % all.length]
    const angle = ANGLES[i % ANGLES.length]
    for (const layer of layersFor(config, angle)) {
      const representative = await compose(
        await renderer.render(jobFor(layer, settings)),
        layer.kind,
      )
      const actual = await compose(
        await renderer.render(jobFor({ ...layer, config }, settings, `${layer.key}-actual`)),
        layer.kind,
      )
      const db = psnr(representative, actual)
      const ok = db >= Number(args.threshold)
      if (!ok) failures++
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${angle}:${layer.kind} ${db.toFixed(1)} dB`)
    }
  }
} finally {
  await renderer.close()
}
if (failures) {
  console.error(`${failures} layers show inputs their keys leave out.`)
  process.exit(1)
}
