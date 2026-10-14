import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import process from 'node:process'
import console from 'node:console'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, process.argv[2] ?? 'dist')
const read = (path) => readFileSync(resolve(dist, path))
const graph = JSON.parse(read('build-graph.json'))
const chunks = new Map(graph.map((chunk) => [chunk.file, chunk]))
const staticClosure = (roots) => {
  const result = new Set()
  const visit = (name) => {
    if (result.has(name)) return
    const chunk = chunks.get(name)
    assert(chunk, `Missing chunk ${name}`)
    result.add(name)
    chunk.imports.forEach(visit)
  }
  roots.forEach(visit)
  return [...result].map((name) => chunks.get(name))
}
const shell = staticClosure(graph.filter((chunk) => chunk.isEntry).map((chunk) => chunk.file))
const shellModules = shell.flatMap((chunk) => chunk.modules)
const heavy = /node_modules\/(three|@react-three|three-stdlib|jspdf|html2canvas)\//
assert(
  !shellModules.some((id) => heavy.test(id)),
  `Eager shell dependency: ${shellModules.filter((id) => heavy.test(id)).join(', ')}`,
)
const shellBytes = shell.reduce((sum, chunk) => sum + gzipSync(read(chunk.file)).length, 0)
assert(shellBytes <= 150_000, `Static shell ${shellBytes} gzip bytes exceeds 150 kB`)
const scene = graph.find((chunk) => chunk.modules.includes('src/components/Scene.tsx'))
assert(scene && !shell.includes(scene), 'Scene must be reachable only through a dynamic edge')
assert(
  shell.some((chunk) => chunk.dynamicImports.includes(scene.file)),
  'Shell does not dynamically request Scene',
)
const sceneClosure = staticClosure([scene.file])
assert(
  !sceneClosure.some((chunk) =>
    chunk.modules.some((id) => /node_modules\/(jspdf|html2canvas)\//.test(id)),
  ),
  'Scene eagerly depends on PDF',
)
const pdf = graph.find((chunk) => chunk.modules.some((id) => id.startsWith('node_modules/jspdf/')))
assert(
  pdf && !shell.includes(pdf) && !sceneClosure.includes(pdf),
  'PDF belongs behind export intent',
)
const html = read('index.html').toString()
assert(!html.includes(pdf.file), 'HTML preloads PDF')
assert(!html.includes(scene.file), 'HTML preloads Scene instead of letting the shell stage it')

const manifest = JSON.parse(readFileSync(resolve(root, 'public/textures/manifest.json')))
const builtManifest = Object.values(JSON.parse(read('.vite/manifest.json')))
const sceneSource = sceneClosure.map((chunk) => read(chunk.file).toString()).join('\n')
let totalEncodedBytes = 0
let decodedBytes = 0
for (const [key, map] of Object.entries(manifest.maps)) {
  const file = builtManifest.find(
    (asset) =>
      asset.file.startsWith(`assets/${key.replace('/', '-')}-`) && asset.file.endsWith('.webp'),
  )?.file
  assert(file, `Missing hashed asset for ${key}`)
  assert(
    sceneSource.includes(file.split('/').at(-1)),
    `Scene has no versioned reference for ${key}`,
  )
  assert.equal(
    createHash('sha256').update(read(file)).digest('hex'),
    map.sha256,
    `Mixed texture revision: ${key}`,
  )
  assert.equal(read(file).length, map.encodedBytes)
  totalEncodedBytes += map.encodedBytes
  decodedBytes += map.decodedBytesRGBA
}
const cache = JSON.parse(readFileSync(resolve(root, 'vercel.json')))
for (const rule of cache.headers) {
  if (rule.source.startsWith('/textures/'))
    assert(
      !JSON.stringify(rule.headers).includes('immutable'),
      'Unversioned texture cannot be immutable',
    )
}
console.log(
  JSON.stringify(
    {
      result: 'passed',
      shellGzipBytes: shellBytes,
      shellFiles: shell.map((chunk) => chunk.file),
      sceneStaticGzipBytes: sceneClosure
        .filter((chunk) => !shell.includes(chunk))
        .reduce((sum, chunk) => sum + gzipSync(read(chunk.file)).length, 0),
      pdfGzipBytes: gzipSync(read(pdf.file)).length,
      versionedMaps: Object.keys(manifest.maps).length,
      catalogEncodedBytes: totalEncodedBytes,
      catalogDecodedBytesRGBA: decodedBytes,
      note: 'Catalog totals are not first-view requests or measured GPU memory. Browser fault/timing evidence is separate.',
    },
    null,
    2,
  ),
)
