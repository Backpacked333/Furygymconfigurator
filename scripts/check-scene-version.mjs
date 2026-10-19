// Guards the pre-rendered stills against drift. Render keys include SCENE_VERSION, so stills are
// re-rendered only when it changes; this fails when anything that shapes the picture changed
// since the version was last recorded, so a visual change can never ship over old stills.
//
//   node scripts/check-scene-version.mjs           check (CI)
//   node scripts/check-scene-version.mjs --accept  record the current files and version
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const RECORD = join(root, 'render/scene-version.json')
/** Everything the harness draws with: models, materials, lighting, post-processing, textures. */
const INPUTS = [
  'src/render',
  'src/render-harness',
  'src/viewer',
  'src/components/Atmosphere.tsx',
  'src/components/Equipment.tsx',
  'src/components/InteriorLights.tsx',
  'src/components/InteriorProbe.tsx',
  'src/components/Landscape.tsx',
  'src/components/environments',
  'src/components/Mirror.tsx',
  'src/components/Parts.tsx',
  'src/components/StudioModel.tsx',
  'src/lib/cameras.ts',
  'src/lib/config.ts',
  'src/lib/lighting.ts',
  'src/lib/stills.ts',
  'src/lib/visuals.ts',
  'public/textures',
]

function files(path) {
  const full = join(root, path)
  let stat
  try {
    stat = statSync(full)
  } catch {
    return []
  }
  if (!stat.isDirectory()) return /\.test\.tsx?$/.test(path) ? [] : [path]
  return readdirSync(full)
    .sort()
    .flatMap((name) => files(join(path, name)))
}

const hash = createHash('sha256')
for (const file of INPUTS.flatMap(files)) {
  hash.update(relative(root, join(root, file)))
  hash.update('\0')
  hash.update(readFileSync(join(root, file)))
}
const tree = hash.digest('hex')
const version = Number(
  readFileSync(join(root, 'src/lib/renderKey.ts'), 'utf8').match(/SCENE_VERSION = (\d+)/)[1],
)

if (process.argv.includes('--accept')) {
  writeFileSync(RECORD, `${JSON.stringify({ sceneVersion: version, tree }, null, 2)}\n`)
  console.log(`Recorded scene version ${version}.`)
  process.exit(0)
}
let record = null
try {
  record = JSON.parse(readFileSync(RECORD, 'utf8'))
} catch {
  /* No record yet. */
}
if (record?.tree === tree && record.sceneVersion === version) {
  console.log(`Scene version ${version} matches the render inputs.`)
  process.exit(0)
}
console.error(
  record?.sceneVersion !== version
    ? `SCENE_VERSION is ${version} but ${record?.sceneVersion ?? 'nothing'} was recorded.`
    : 'Files that shape the rendered picture changed since SCENE_VERSION was recorded.',
)
console.error(
  [
    'If the picture changes, bump SCENE_VERSION in src/lib/renderKey.ts and re-render the stills',
    '(render/README.md). If it does not (a refactor, a comment), keep the version.',
    'Either way, record the result with: npm run scene-version:accept',
  ].join('\n'),
)
process.exit(1)
