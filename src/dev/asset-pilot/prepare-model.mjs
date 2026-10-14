import process from 'node:process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { Buffer } from 'node:buffer'
import { resolve, sep } from 'node:path'

// node src/dev/asset-pilot/prepare-model.mjs /outside/repo/assets /outside/repo/tools
const root = fileURLToPath(new URL('../../../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('./provenance.json', import.meta.url)))
if (process.argv.length !== 4)
  throw new Error('Expected output directory and isolated tool installation.')
const output = resolve(process.argv[2])
const tools = resolve(process.argv[3], 'node_modules/@gltf-transform')
if (output === resolve(root) || output.startsWith(resolve(root) + sep))
  throw new Error('Generated assets must stay outside the repository.')
await mkdir(output, { recursive: true })
for (const [name, expected] of Object.entries(manifest.model.toolVersions)) {
  const pkg = JSON.parse(await readFile(resolve(tools, name, 'package.json')))
  if (pkg.version !== expected) throw new Error(`${name} must be ${expected}, not ${pkg.version}`)
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fetched = await globalThis.fetch(manifest.model.sourceUrl, {
  signal: globalThis.AbortSignal.timeout(60000),
})
if (!fetched.ok) throw new Error(`Source download failed: HTTP ${fetched.status}`)
const source = Buffer.from(await fetched.arrayBuffer())
if (source.length !== manifest.model.sourceBytes || sha256(source) !== manifest.model.sourceSha256)
  throw new Error('Source content drift: stop and review provenance.')
await writeFile(resolve(output, 'source.glb'), source)
const cli = resolve(tools, 'cli/bin/cli.js')
const commands = [
  ['dedup', 'source.glb', 'dedup.glb'],
  ['prune', 'dedup.glb', 'optimized.glb'],
]
for (const [command, input, target] of commands)
  execFileSync(process.execPath, [cli, command, resolve(output, input), resolve(output, target)], {
    stdio: 'inherit',
    timeout: 120000,
  })
const optimized = await readFile(resolve(output, 'optimized.glb'))
if (sha256(optimized) !== manifest.model.optimizedSha256)
  throw new Error(
    'Optimizer output drift: inspect tool dependencies and preservation before proceeding.',
  )
await writeFile(
  resolve(output, 'conversion.json'),
  JSON.stringify(
    {
      version: manifest.version,
      sourceUrl: manifest.model.sourceUrl,
      license: manifest.model.license,
      sourceSha256: sha256(source),
      sourceBytes: source.length,
      optimizedSha256: sha256(optimized),
      optimizedBytes: optimized.length,
      versions: manifest.model.toolVersions,
      commands,
    },
    null,
    2,
  ) + '\n',
)
