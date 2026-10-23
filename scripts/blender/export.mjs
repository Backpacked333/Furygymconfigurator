// Usage: node scripts/blender/export.mjs <preset|config.json> <exterior|interior> <out.json>
/* global console, process */
import { readFileSync, writeFileSync } from 'node:fs'
import { runnerImport } from 'vite'

const [source = 'studio-strength', view = 'exterior', out = 'scene.json'] = process.argv.slice(2)
const { module } = await runnerImport('./scripts/blender/scene.ts')
const config = source.endsWith('.json')
  ? JSON.parse(readFileSync(source, 'utf8'))
  : module.presets[source]
if (!config) throw new Error(`Unknown preset ${source}: ${Object.keys(module.presets).join(', ')}`)
const scene = module.exportScene(config, view)
writeFileSync(out, JSON.stringify(scene))
console.log(
  `${out}: ${scene.meshes.length} materials, ${scene.meshes.reduce((n, m) => n + m.vertices, 0)} vertices`,
)
// Texture loads started by the material library keep retrying in Node; nothing else is pending.
process.exit(0)
