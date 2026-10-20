import { constants } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { build as viteBuild, type Plugin } from 'vite'
import { parsePreparedDisplayBuild } from '../../display/session'
import { stableDisplayJson, type DisplayBuild } from '../../display/contract'
import { TEXTURE_SETS } from '../textureSets'

export const DISPLAY_SOURCE = '/home/ubuntu/Documents/fury-display'
export const DISPLAY_HANDOFF = '/home/ubuntu/Documents/fury-display-handoff'
export const DISPLAY_CHROME = '/opt/.devin/chrome/chrome/linux-137.0.7118.2/chrome-linux64/chrome'
export const DISPLAY_PYTHON = '/usr/bin/python3.10'
export const DISPLAY_NODE = '/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node'
export const RESOURCE_BOUNDS = Object.freeze({
  file: 16 * 1024 * 1024,
  total: 128 * 1024 * 1024,
  requests: 512,
  sources: 2600,
})
export const sha = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export type ByteRecord = { name: string; bytes: number; digest: string }
export type DisplayResource = { bytes: Buffer; mediaType: string }
export const manifestHash = (records: ByteRecord[]) =>
  sha(stableDisplayJson([...records].sort((a, b) => a.name.localeCompare(b.name))))

export async function trustedBytes(path: string, root: string, max = RESOURCE_BOUNDS.file) {
  if ((await realpath(path)) !== path || !path.startsWith(`${root}/`))
    throw new Error('Display file escapes trusted root.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 1 || before.size > max)
      throw new Error('Display file bound/type.')
    const bytes = Buffer.alloc(before.size)
    for (let offset = 0; offset < bytes.length;) {
      const n = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!n.bytesRead) throw new Error('Display file truncated.')
      offset += n.bytesRead
    }
    const after = await file.stat()
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Display file changed while reading.')
    return bytes
  } finally {
    await file.close()
  }
}
const record = (name: string, bytes: Buffer): ByteRecord => ({
  name,
  bytes: bytes.length,
  digest: sha(bytes),
})

/** Real executable/font/OS observations, read-only: NO executable is run by preparation. */
async function runtimeFiles() {
  const paths: string[] = [],
    aliases: ByteRecord[] = []
  const walk = async (directory: string, depth = 0) => {
    if (depth > 8 || paths.length > 1024) throw new Error('Runtime closure bound.')
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const actual = await realpath(path)
        if (!(await stat(actual)).isFile()) throw new Error('Unexpected runtime file.')
        paths.push(actual)
        if (path !== actual) aliases.push(record(`symlink:${path}`, Buffer.from(actual)))
      }
    }
  }
  await walk(DISPLAY_CHROME.slice(0, DISPLAY_CHROME.lastIndexOf('/')))
  await walk('/usr/share/fonts')
  await walk('/etc/fonts')
  paths.push(DISPLAY_PYTHON, DISPLAY_NODE, '/usr/lib/os-release', '/etc/ld.so.cache')
  const records: ByteRecord[] = []
  for (const path of [...new Set(paths)].sort()) {
    if ((await realpath(path)) !== path) throw new Error('Runtime executable changed.')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024)
        throw new Error('Runtime file bound.')
      const hash = createHash('sha256'),
        chunk = Buffer.alloc(1024 * 1024)
      let offset = 0
      while (offset < before.size) {
        const n = await file.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset)
        if (!n.bytesRead) throw new Error('Runtime file truncated.')
        offset += n.bytesRead
        hash.update(chunk.subarray(0, n.bytesRead))
      }
      const after = await file.stat()
      if (
        after.mtimeMs !== before.mtimeMs ||
        after.size !== before.size ||
        after.ino !== before.ino
      )
        throw new Error('Runtime changed during hashing.')
      records.push({ name: path, bytes: before.size, digest: `sha256:${hash.digest('hex')}` })
    } finally {
      await file.close()
    }
  }
  return [...records, ...aliases]
}
export function assertDisplayBrowserModule(name: string) {
  if (/[?%#\\]/.test(name) || name.split('/').some((v) => v === '.' || v === '..'))
    throw new Error('Noncanonical display module.')
  if (name === 'src/lib/stillsManifest.ts') return // only its camera re-export; emitted code prohibited below
  if (name.startsWith('node_modules/')) {
    if (
      !/^node_modules\/(three|react|@react-three\/fiber|react-use-measure|its-fine|suspend-react|scheduler|zustand|use-sync-external-store|lz-string|zod)\//.test(
        name,
      )
    )
      throw new Error('Forbidden display dependency.')
    return
  }
  if (
    /\.(test|spec)\.|cloud|export|prefetch|siblings|pathtrace|bake|Storage|useConfig|traceStatus/i.test(
      name,
    )
  )
    throw new Error('Forbidden display module.')
  const allow =
    name.startsWith('src/domain/') ||
    /^src\/display\/(contract|session|readiness)\.ts$/.test(name) ||
    /^src\/lib\/(config|visuals|products|recovery)\.ts$/.test(name) ||
    /^src\/components\/(StudioModel|Atmosphere|Landscape|InteriorProbe|Mirror|InteriorLights|Equipment|Parts|useInstances|Surroundings)\.tsx?$/.test(
      name,
    ) ||
    /^src\/render\/display\/(browser\/(entry\.ts|scene\.tsx|resources\.ts|display\.html)|input\.ts|revisions\.ts|observation\.ts)$/.test(
      name,
    ) ||
    /^src\/render\/prototype\/(privateScene|p03Contract)\.ts$/.test(name) ||
    (/^src\/render\/[^/]+\.tsx?$/.test(name) && !/session|stills?/i.test(name))
  if (!allow) throw new Error(`Unapproved display browser module: ${name}`)
}
export type PreparedDisplay = {
  build: DisplayBuild
  resources: ReadonlyMap<string, DisplayResource>
  manifests: {
    sources: ByteRecord[]
    assets: ByteRecord[]
    bundle: ByteRecord[]
    runtime: ByteRecord[]
  }
  revalidate(): Promise<void>
}

export async function prepareDisplayBuild(): Promise<PreparedDisplay> {
  if (process.execPath !== DISPLAY_NODE || process.version !== 'v24.22.0')
    throw new Error('Pinned display Node runtime required.')
  if ((await realpath(DISPLAY_SOURCE)) !== DISPLAY_SOURCE)
    throw new Error('Candidate root changed.')
  const dependencies = await realpath(join(DISPLAY_SOURCE, 'node_modules'))
  const sources = new Map<string, { root: string; record: ByteRecord }>()
  const track = async (path: string, root: string, name: string) => {
    const bytes = await trustedBytes(path, root)
    const next = record(name, bytes),
      prior = sources.get(path)
    if (prior && prior.record.digest !== next.digest)
      throw new Error('Source changed during private compilation.')
    sources.set(path, { root, record: next })
    if (
      sources.size > RESOURCE_BOUNDS.sources ||
      [...sources.values()].reduce((n, v) => n + v.record.bytes, 0) > RESOURCE_BOUNDS.total
    )
      throw new Error('Source closure bound.')
    return bytes
  }
  const own = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.name === '__pycache__') continue
      if (entry.isDirectory()) await own(path)
      else if (!/\.test\.|^test_/.test(entry.name))
        await track(path, DISPLAY_SOURCE, relative(DISPLAY_SOURCE, path))
    }
  }
  await own(join(DISPLAY_SOURCE, 'src/render/display'))
  for (const name of [
    'package.json',
    'package-lock.json',
    'public/textures/sources.json',
    'scripts/build-textures.py',
    'src/render/prototype/capture/artifacts.ts',
    'src/render/prototype/capture/contract.ts',
    'src/display/operator.ts',
  ])
    await track(join(DISPLAY_SOURCE, name), DISPLAY_SOURCE, name)
  for (const name of ['vite', 'rollup', 'esbuild'])
    await track(
      join(dependencies, `${name}/package.json`),
      dependencies,
      `node_modules/${name}/package.json`,
    )
  const graph = (): Plugin => ({
    name: 'fury-display-private-closure',
    enforce: 'pre',
    async load(id) {
      if (id.startsWith('\0') || id.startsWith('vite/')) return null
      const path = id.split('?')[0]
      if (!path.startsWith('/')) throw new Error('External private module.')
      const actual = await realpath(path),
        dependency = actual.startsWith(`${dependencies}/`)
      const name = dependency
        ? `node_modules/${relative(dependencies, actual)}`
        : relative(DISPLAY_SOURCE, actual)
      assertDisplayBrowserModule(name)
      await track(actual, dependency ? dependencies : DISPLAY_SOURCE, name)
      return null
    },
    generateBundle(_opts, bundle) {
      for (const item of Object.values(bundle))
        if (item.type === 'chunk') {
          if (
            Object.entries(item.modules).some(
              ([name, info]) =>
                /\/src\/lib\/(recovery|stillsManifest)\.ts$/.test(name) && info.renderedLength > 0,
            )
          )
            throw new Error('Legacy storage/still emitted.')
          if (
            [...item.imports, ...item.dynamicImports].some((name) =>
              /^(https?:|data:|file:|node:|\/\/)/.test(name),
            )
          )
            throw new Error('External bundle import.')
        }
    },
  })
  const resources = new Map<string, DisplayResource>(),
    assets: ByteRecord[] = []
  for (const [set, info] of Object.entries(TEXTURE_SETS))
    for (const channel of 'detailOnly' in info ? ['normal', 'arm'] : ['albedo', 'normal', 'arm']) {
      const name = `public/textures/${set}/${channel}.webp`
      const bytes = await track(join(DISPLAY_SOURCE, name), DISPLAY_SOURCE, name)
      assets.push(record(name, bytes))
      resources.set(`/textures/${set}/${channel}.webp`, { bytes, mediaType: 'image/webp' })
    }
  const output = await viteBuild({
    configFile: false,
    envFile: false,
    publicDir: false,
    root: join(DISPLAY_SOURCE, 'src/render/display/browser'),
    base: '/',
    logLevel: 'silent',
    cacheDir: join(DISPLAY_HANDOFF, 'renderer-vite-cache'),
    esbuild: { jsx: 'automatic' },
    resolve: { conditions: ['production', 'module', 'browser'] },
    plugins: [graph()],
    worker: { format: 'es', plugins: () => [graph()] },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({
        BASE_URL: '/',
        MODE: 'production',
        DEV: false,
        PROD: true,
        SSR: false,
      }),
    },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'es2022',
      minify: false,
      assetsInlineLimit: 0,
      sourcemap: false,
      rollupOptions: { input: join(DISPLAY_SOURCE, 'src/render/display/browser/display.html') },
    },
  })
  if ('on' in output) throw new Error('Watch mode prohibited.')
  const bundle: ByteRecord[] = []
  for (const result of Array.isArray(output) ? output : [output])
    for (const item of result.output) {
      if (
        !/^(display\.html|assets\/[A-Za-z0-9_.-]+\.(js|css))$/.test(item.fileName) ||
        item.fileName.includes('..')
      )
        throw new Error('Unexpected private output.')
      const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source)
      if (bytes.length > RESOURCE_BOUNDS.file || resources.has(`/${item.fileName}`))
        throw new Error('Private output bound/duplicate.')
      resources.set(`/${item.fileName}`, {
        bytes,
        mediaType: item.fileName.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : 'text/javascript; charset=utf-8',
      })
      bundle.push(record(item.fileName, bytes))
    }
  if (
    !resources.has('/display.html') ||
    !bundle.some((item) => /siteLight\.worker.*\.js$/.test(item.name))
  )
    throw new Error('Private entry/worker missing.')
  if (
    [...resources.values()].reduce((n, v) => n + v.bytes.length, 0) > RESOURCE_BOUNDS.total ||
    resources.size > 256
  )
    throw new Error('Private resource closure bound.')
  const three = JSON.parse(
    (
      await track(
        join(dependencies, 'three/package.json'),
        dependencies,
        'node_modules/three/package.json',
      )
    ).toString(),
  ) as { version: string }
  // The verifier/publication/auth boundary participates in current-build cache identity too.
  await own(join(DISPLAY_SOURCE, 'src/image-service/display'))
  const sourceRecords = [...sources.values()]
    .map((v) => v.record)
    .filter((v) => !v.name.endsWith('.webp'))
  const runtime = await runtimeFiles()
  const policy = {
    executable: DISPLAY_CHROME,
    supervisor: DISPLAY_PYTHON,
    files: runtime,
    launch: 'owned-headless-webgpu-no-fallback-pipe-cdp@1',
    environment: { LANG: 'C.UTF-8', TZ: 'UTC', PATH: '/usr/bin:/bin' },
    fontPolicy: 'actual-host-fontconfig-and-font-bytes; generic-sans; font/art-rights-hold',
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    gpuPolicy: 'positive-nonfallback-adapter-vendor-and-CDP-device-match; no-software-or-unknown',
    lifetimeMs: 600000,
    idleMs: 30000,
    jobMs: 180000,
    resources: RESOURCE_BOUNDS,
  }
  const build = parsePreparedDisplayBuild({
    sourceManifestDigest: manifestHash(sourceRecords),
    assetManifestDigest: manifestHash(assets),
    bundleDigest: manifestHash(bundle),
    lockfileDigest: sources.get(join(DISPLAY_SOURCE, 'package-lock.json'))!.record.digest,
    runtimePolicyDigest: sha(stableDisplayJson(policy)),
    threeRevision: three.version.match(/^0\.(\d+)\./)?.[1],
  })
  const resourceHashes = new Map([...resources].map(([name, v]) => [name, sha(v.bytes)]))
  const revalidate = async () => {
    if (resources.size !== resourceHashes.size)
      throw new Error('Prepared resource membership changed.')
    for (const [name, hash] of resourceHashes)
      if (sha(resources.get(name)!.bytes) !== hash) throw new Error('Prepared resource changed.')
    for (const [path, entry] of sources)
      if (sha(await trustedBytes(path, entry.root)) !== entry.record.digest)
        throw new Error('Private source/asset changed.')
    if (manifestHash(await runtimeFiles()) !== manifestHash(runtime))
      throw new Error('Runtime/font/executable changed.')
  }
  await revalidate()
  return {
    build,
    resources,
    manifests: { sources: sourceRecords, assets, bundle, runtime },
    revalidate,
  }
}
