import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { ANGLES, type AngleId } from '../../src/lib/cameras'
import { RENDERER_ID } from '../../src/lib/renderKey'
import { enumerateLayers, type Layer } from '../../src/lib/stills'
import { compose } from './compose'
import { encodeLayer, layerFiles } from './encode'
import { WebGpuPlaywrightRenderer } from './renderers/webgpu-playwright'
import type { StillRenderer } from './renderers/types'
import { jobFor, settingsFrom } from './jobs'
import { storageFrom, type Storage } from './storage'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'out' },
    r2: { type: 'boolean', default: false },
    dist: { type: 'string', default: '../dist' },
    angles: { type: 'string' },
    kinds: { type: 'string' },
    limit: { type: 'string' },
    shard: { type: 'string', default: '0/1' },
    pages: { type: 'string', default: '3' },
    quality: { type: 'string' },
    frames: { type: 'string' },
    scale: { type: 'string' },
    width: { type: 'string' },
    'allow-fallback': { type: 'boolean', default: false },
    webgl: { type: 'boolean', default: false },
    count: { type: 'boolean', default: false },
  },
})

/** The layers this run is responsible for: filtered, then this shard's share, then the limit. */
function selectLayers(): Layer[] {
  const angles = args.angles ? (args.angles.split(',') as AngleId[]) : ANGLES
  const kinds = args.kinds?.split(',')
  const [index, total] = args.shard!.split('/').map(Number)
  let layers = enumerateLayers(angles).filter((l) => !kinds || kinds.includes(l.kind))
  layers = layers.filter((_, i) => i % total === index)
  if (args.limit) layers = layers.slice(0, Number(args.limit))
  return layers
}

async function renderLayer(renderer: StillRenderer, storage: Storage, layer: Layer) {
  const capture = await renderer.render(jobFor(layer, settingsFrom(args)))
  const raster = await compose(capture, layer.kind)
  const files = await encodeLayer(raster, layer.key, renderer.id)
  // Smallest first: the 2048 WebP, written last, marks the layer complete.
  for (const file of files) await storage.put(file.path, file.body, file.contentType)
  return { ms: capture.ms, bytes: files.reduce((sum, f) => sum + f.body.length, 0) }
}

async function main() {
  const layers = selectLayers()
  const byKind = layers.reduce<Record<string, number>>((m, l) => {
    m[`${l.angle}:${l.kind}`] = (m[`${l.angle}:${l.kind}`] ?? 0) + 1
    return m
  }, {})
  console.log(`${layers.length} layers in this run`, byKind)
  if (args.count) return

  const storage = storageFrom(args)
  const published = await storage.list(`${RENDERER_ID}/`)
  const todo = layers.filter((l) => !published.has(layerFiles(l.key, RENDERER_ID).at(-1)!.path))
  console.log(`${layers.length - todo.length} already published in ${storage.describe()}`)
  if (!todo.length) return

  const renderer = new WebGpuPlaywrightRenderer({
    dist: resolve(args.dist!),
    pages: Number(args.pages),
    allowFallback: args['allow-fallback'],
    webgl: args.webgl,
  })
  await renderer.init()
  const started = Date.now()
  let done = 0,
    failed = 0
  try {
    // One job in flight per render page; encoding and uploads overlap the next render.
    const workers = Array.from({ length: Number(args.pages) }, async () => {
      while (todo.length) {
        const layer = todo.shift()!
        try {
          const { ms, bytes } = await renderLayer(renderer, storage, layer)
          done++
          const rate = (Date.now() - started) / done
          console.log(
            `${done}/${done + todo.length} ${layer.angle}:${layer.kind} ${layer.key} ${ms}ms ${Math.round(bytes / 1024)}kB · ~${Math.round((rate * todo.length) / 60000)} min left`,
          )
        } catch (error) {
          failed++
          console.error(`Failed ${layer.key}: ${(error as Error).message}`)
        }
      }
    })
    await Promise.all(workers)
  } finally {
    await renderer.close()
  }
  console.log(
    `Rendered ${done}, failed ${failed}, in ${Math.round((Date.now() - started) / 1000)}s`,
  )
  if (failed) process.exitCode = 1
}

await main()
