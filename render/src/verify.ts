import { parseArgs } from 'node:util'
import { RENDERER_ID, SCENE_VERSION, readyPath } from '../../src/lib/renderKey'
import { enumerateLayers } from '../../src/lib/stills'
import { layerFiles } from './encode'
import { storageFrom } from './storage'

/**
 * Checks that every file of every layer the app can request is published, then writes the ready
 * marker the app looks for before it uses pre-rendered stills. Deploy only after this passes:
 * with the marker, no configuration can point at a missing image.
 */
const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'out' },
    r2: { type: 'boolean', default: false },
    'no-mark': { type: 'boolean', default: false },
  },
})

const storage = storageFrom(args)
const layers = enumerateLayers()
const published = await storage.list(`${RENDERER_ID}/`)
const missing = layers.flatMap((l) =>
  layerFiles(l.key, RENDERER_ID)
    .filter((f) => !published.has(f.path))
    .map((f) => `${l.angle}:${l.kind} ${f.path}`),
)
if (missing.length) {
  console.error(`${missing.length} files missing in ${storage.describe()}, for example:`)
  console.error(missing.slice(0, 20).join('\n'))
  process.exit(1)
}
console.log(`All ${layers.length} layers published in ${storage.describe()}.`)
if (!args['no-mark']) {
  await storage.put(
    readyPath(),
    JSON.stringify({
      renderer: RENDERER_ID,
      scene: SCENE_VERSION,
      layers: layers.length,
      verified: new Date().toISOString(),
    }),
    'application/json',
    false,
  )
  console.log(`Wrote ${readyPath()}.`)
}
