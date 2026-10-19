import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as viteBuild, type Plugin } from 'vite'
import { ExclusiveDirectory, digest, jsonBytes } from './artifacts'
import {
  CAPTURE_LIMITS,
  CaptureContractError,
  captureBuildSchema,
  type CaptureBuild,
} from './contract'

// Native-only module: the adapter imports its file URL, never a Vite config bundle.
export const SOURCE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(
  /\/$/,
  '',
)
export const HANDOFF_ROOT = '/home/ubuntu/Documents/fury-p03-handoff'
export const BUILD_PATH = '/__capture_bootstrap.json'
export const PAGE_PATH = '/worker.html?renderer=webgl2'
export type ByteRecord = Readonly<{ name: string; bytes: number; digest: string }>
export type StaticResource = Readonly<{ bytes: Buffer; mediaType: string }>
export type PreparedCapture = {
  build: CaptureBuild
  resources: ReadonlyMap<string, StaticResource>
  manifests: { sources: ByteRecord[]; assets: ByteRecord[]; bundle: ByteRecord[] }
  revalidate: () => Promise<void>
}
const record = (name: string, bytes: Buffer): ByteRecord => ({
  name,
  bytes: bytes.length,
  digest: digest(bytes),
})
export const manifestDigest = (records: readonly ByteRecord[]) =>
  digest(JSON.stringify([...records].sort((a, b) => a.name.localeCompare(b.name))))

export async function readTrustedFile(
  path: string,
  root: string,
  max = CAPTURE_LIMITS.assetBytes as number,
) {
  const actual = await realpath(path)
  if (actual !== path || !actual.startsWith(`${root}/`))
    throw new CaptureContractError('asset-failed', 'Trusted file escapes its real root.')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > max)
      throw new CaptureContractError('limit-exceeded', 'Trusted file size/type rejected.')
    // Fixed-size read prevents growth after stat from turning readFile into an unbounded allocation.
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const got = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!got.bytesRead) throw new CaptureContractError('asset-failed', 'Trusted file truncated.')
      offset += got.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
      throw new CaptureContractError('asset-failed', 'Trusted file changed during snapshot.')
    return bytes
  } finally {
    await handle.close()
  }
}

/** A browser graph gate, not a production build plugin. Unknown project directories fail closed. */
export function assertBrowserModule(name: string) {
  // Pure camera-module re-export only; generateBundle additionally requires zero emitted code.
  if (name === 'src/lib/stillsManifest.ts') return
  if (name.startsWith('node_modules/')) {
    if (/(?:three-gpu-pathtracer|oidn-web|jspdf|puppeteer|playwright)/i.test(name))
      throw new CaptureContractError('invalid-input', 'Forbidden browser dependency.')
    return
  }
  if (
    /\.(?:test|spec)\./.test(name) ||
    /(?:cloud|export|stills?|prefetch|siblings|session|pathtrace|bake|Storage|useConfig|traceStatus)/i.test(
      name,
    )
  )
    throw new CaptureContractError('invalid-input', 'Forbidden legacy browser graph module.')
  const allowed =
    name.startsWith('src/domain/') ||
    /^src\/lib\/(?:config|visuals|products|recovery)\.ts$/.test(name) ||
    /^src\/components\/(?:StudioModel|Atmosphere|Landscape|InteriorProbe|Mirror|InteriorLights|Equipment|Parts|useInstances|Surroundings)\.tsx?$/.test(
      name,
    ) ||
    (name.startsWith('src/render/') && !name.startsWith('src/render/prototype/')) ||
    /^src\/render\/prototype\/capture\/contract\.ts$/.test(name) ||
    /^src\/render\/prototype\/(?:privateScene|p03Contract)\.ts$/.test(name) ||
    /^src\/render\/prototype\/capture\/browser\/(?:scene\.tsx|worker\.ts|worker\.html|entry\.ts|control\.ts|resources\.ts)$/.test(
      name,
    )
  if (!allowed)
    throw new CaptureContractError('invalid-input', 'Unapproved private browser graph module.')
}

// Exact existing authored texture sets, not arbitrary URLs or recursive public-directory serving.
const textureSets = [
  'rubber_tiles',
  'laminate_floor_02',
  'granite_tile_04',
  'beige_wall_001',
  'oak_veneer_01',
  'hinoki_planks',
  'teak_veneer',
  'leather_white',
  'rough_linen',
  'rubberized_track',
  'painted_metal_shutter',
  'concrete_pavement',
  'leafy_grass',
  'dry_ground_01',
  'clean_pebbles',
  'bark_platanus',
  'concrete_slab_wall',
  'concrete_wall_001',
  'red_brick_03',
  'herringbone_pavement',
  'concrete_floor_worn_001',
  'plywood',
  'japanese_cedar_planks',
  'white_stucco',
  'powder_coat',
  'brushed_metal',
  'knurling',
] as const
const detailOnly = new Set<string>(['powder_coat', 'brushed_metal', 'knurling'])

/** Config-free in-memory build: never invokes app config, dev middleware, .env, HMR or public APIs. */
export async function prepareCaptureBuild(fence: () => void): Promise<PreparedCapture> {
  const root = await realpath(SOURCE_ROOT)
  if (root !== SOURCE_ROOT)
    throw new CaptureContractError('invalid-input', 'Unexpected source root.')
  const dependencies = await realpath(join(root, 'node_modules'))
  const sourceFiles = new Map<string, { root: string; record: ByteRecord }>()
  const track = async (path: string, base: string, name: string) => {
    const bytes = await readTrustedFile(path, base)
    fence()
    const next = record(name, bytes),
      prior = sourceFiles.get(path)
    if (prior && prior.record.digest !== next.digest)
      throw new CaptureContractError('identity-mismatch', 'Sources changed during build.')
    sourceFiles.set(path, { root: base, record: next })
    if (
      sourceFiles.size > 2400 ||
      [...sourceFiles.values()].reduce((n, entry) => n + entry.record.bytes, 0) >
        CAPTURE_LIMITS.totalAssetBytes
    )
      throw new CaptureContractError('limit-exceeded', 'Source closure exceeds cap.')
    return bytes
  }
  const graphPlugin = (): Plugin => ({
    name: 'fury-private-closure',
    enforce: 'pre',
    async load(id) {
      if (id.startsWith('\0') || id.startsWith('vite/')) return null
      const path = id.split('?')[0]
      if (!path.startsWith('/'))
        throw new CaptureContractError('invalid-input', 'External module denied.')
      const actual = await realpath(path)
      fence()
      let name: string, base: string
      if (actual.startsWith(`${dependencies}/`)) {
        name = `node_modules/${relative(dependencies, actual)}`
        base = dependencies
      } else {
        name = relative(root, actual)
        base = root
      }
      assertBrowserModule(name)
      await track(actual, base, name)
      return null
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle))
        if (item.type === 'chunk') {
          // Pure unused legacy re-exports may be read for tree shaking, never emitted/used.
          if (
            Object.entries(item.modules).some(
              ([name, info]) =>
                /\/src\/lib\/(?:recovery|stillsManifest)\.ts$/.test(name) &&
                info.renderedLength > 0,
            )
          )
            throw new CaptureContractError(
              'invalid-input',
              'Legacy storage/still helpers must be tree-shaken.',
            )
          for (const imported of [...item.imports, ...item.dynamicImports])
            if (/^(?:https?:|data:|file:|node:|\/\/)/.test(imported))
              throw new CaptureContractError('network-denied', 'External bundle import denied.')
        }
    },
  })
  for (const name of [
    'package.json',
    'package-lock.json',
    'public/textures/sources.json',
    'scripts/build-textures.py',
    'scripts/prototype-capture.ts',
    ...['host.ts', 'artifacts.ts', 'runner.ts', 'runner-browser.ts'].map(
      (name) => `src/render/prototype/capture/${name}`,
    ),
  ]) {
    await track(join(root, name), root, name)
    fence()
  }
  const resources = new Map<string, StaticResource>(),
    assetRecords: ByteRecord[] = []
  let assetSize = 0
  for (const set of textureSets)
    for (const channel of ['albedo', 'normal', 'arm']) {
      if (channel === 'albedo' && detailOnly.has(set)) continue
      const name = `public/textures/${set}/${channel}.webp`,
        path = join(root, name)
      const bytes = await readTrustedFile(path, root)
      fence()
      const entry = record(name, bytes)
      sourceFiles.set(path, { root, record: entry })
      assetRecords.push(entry)
      resources.set(`/textures/${set}/${channel}.webp`, { bytes, mediaType: 'image/webp' })
      assetSize += bytes.length
      if (assetSize > CAPTURE_LIMITS.totalAssetBytes)
        throw new CaptureContractError('limit-exceeded', 'Asset byte cap exceeded.')
    }
  const output = await viteBuild({
    root: join(root, 'src/render/prototype/capture/browser'),
    configFile: false,
    envFile: false,
    publicDir: false,
    base: '/',
    logLevel: 'silent',
    cacheDir: join(HANDOFF_ROOT, 'capture-build-cache'),
    esbuild: { jsx: 'automatic' },
    plugins: [graphPlugin()],
    worker: { format: 'es', plugins: () => [graphPlugin()] },
    define: {
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
      rollupOptions: { input: join(root, 'src/render/prototype/capture/browser/worker.html') },
    },
  })
  fence()
  if ('on' in output) throw new CaptureContractError('invalid-input', 'Watch build denied.')
  const bundles = Array.isArray(output) ? output : [output]
  const bundleRecords: ByteRecord[] = []
  for (const bundle of bundles)
    for (const item of bundle.output) {
      if (
        !/^(?:worker\.html|assets\/[a-zA-Z0-9_.-]+\.(?:js|css))$/.test(item.fileName) ||
        item.fileName.includes('..')
      )
        throw new CaptureContractError('asset-failed', 'Unexpected build resource.')
      const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source)
      if (bytes.length > CAPTURE_LIMITS.assetBytes)
        throw new CaptureContractError('limit-exceeded', 'Bundle resource too large.')
      const path = `/${item.fileName}`
      if (resources.has(path))
        throw new CaptureContractError('asset-failed', 'Duplicate build resource.')
      resources.set(path, {
        bytes,
        mediaType: path.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : path.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/javascript; charset=utf-8',
      })
      bundleRecords.push(record(item.fileName, bytes))
    }
  if (!resources.has(PAGE_PATH.split('?')[0]))
    throw new CaptureContractError('asset-failed', 'Missing private page.')
  const threePackage = JSON.parse(
    (
      await track(
        join(dependencies, 'three/package.json'),
        dependencies,
        'node_modules/three/package.json',
      )
    ).toString(),
  ) as { version?: string }
  const revision = threePackage.version?.match(/^0\.(\d+)\./)?.[1]
  const sourceRecords = [...sourceFiles.values()]
    .map((entry) => entry.record)
    .filter((entry) => !entry.name.endsWith('.webp'))
  const build = captureBuildSchema.parse({
    sourceManifestDigest: manifestDigest(sourceRecords),
    assetManifestDigest: manifestDigest(assetRecords),
    bundleDigest: manifestDigest(bundleRecords),
    lockfileDigest: sourceFiles.get(join(root, 'package-lock.json'))!.record.digest,
    threeRevision: revision,
  })
  resources.set(BUILD_PATH, { bytes: jsonBytes(build), mediaType: 'application/json' })
  if (
    resources.size > 256 ||
    [...resources.values()].reduce((n, resource) => n + resource.bytes.length, 0) >
      CAPTURE_LIMITS.totalAssetBytes
  )
    throw new CaptureContractError('limit-exceeded', 'Resource closure exceeds cap.')
  const resourceRecords = new Map(
    [...resources].map(([path, resource]) => [path, record(path, resource.bytes)]),
  )
  const revalidate = async () => {
    if (
      resources.size !== resourceRecords.size ||
      manifestDigest(sourceRecords) !== build.sourceManifestDigest ||
      manifestDigest(assetRecords) !== build.assetManifestDigest ||
      manifestDigest(bundleRecords) !== build.bundleDigest
    )
      throw new CaptureContractError('identity-mismatch', 'Prepared closure changed.')
    for (const [path, expected] of resourceRecords) {
      const resource = resources.get(path)
      if (
        !resource ||
        resource.bytes.length !== expected.bytes ||
        digest(resource.bytes) !== expected.digest
      )
        throw new CaptureContractError('identity-mismatch', 'Prepared resource bytes changed.')
    }
    for (const [path, entry] of sourceFiles) {
      const bytes = await readTrustedFile(path, entry.root)
      fence()
      if (digest(bytes) !== entry.record.digest)
        throw new CaptureContractError('identity-mismatch', 'Source/asset changed after build.')
    }
  }
  await revalidate()
  fence()
  return {
    build,
    resources,
    manifests: { sources: sourceRecords, assets: assetRecords, bundle: bundleRecords },
    revalidate,
  }
}

export async function saveBuildManifests(
  directory: ExclusiveDirectory,
  prepared: PreparedCapture,
  fence: () => void,
) {
  for (const [kind, records] of Object.entries(prepared.manifests)) {
    const sorted = [...records].sort((a, b) => a.name.localeCompare(b.name))
    for (let i = 0; i < sorted.length; i += 80) {
      await directory.write(
        `${kind}-${String(i / 80).padStart(3, '0')}.json`,
        jsonBytes(sorted.slice(i, i + 80)),
      )
      fence()
    }
  }
  await directory.write('build.json', jsonBytes(prepared.build))
  fence()
}

export type CaptureHost = {
  origin: string
  pageUrl: string
  allow: (url: string, method: string, redirected?: boolean) => boolean
  assertHealthy: () => void
  close: () => Promise<void>
  stats: () => { requests: number; bytes: number; denied: number }
}
export async function startCaptureHost(
  resources: ReadonlyMap<string, StaticResource>,
  onDenied: () => void,
): Promise<CaptureHost> {
  // Copy bytes; callers cannot change already-authorized served content after admission.
  const snapshot = new Map(
    [...resources].map(([path, value]) => [path, { ...value, bytes: Buffer.from(value.bytes) }]),
  )
  let origin = '',
    requests = 0,
    transferred = 0,
    denied = 0
  const fail = () => {
    denied++
    onDenied()
  }
  const allow = (url: string, method: string, redirected = false) => {
    if (redirected || method !== 'GET' || !url.startsWith(`${origin}/`)) return false
    const path = url.slice(origin.length)
    if (path === PAGE_PATH) return snapshot.has(path.split('?')[0])
    return (
      !/[?%#\\]/.test(path) &&
      !path.split('/').some((part) => part === '.' || part === '..') &&
      snapshot.has(path)
    )
  }
  const server: Server = createServer((request, response) => {
    const path = request.url ?? ''
    const headers = request.headers
    const sensitive = new Set([
      'host',
      'origin',
      'content-length',
      'transfer-encoding',
      'sec-fetch-site',
    ])
    const counts = new Map<string, number>()
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const key = request.rawHeaders[i].toLowerCase()
      if (sensitive.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (
      [...counts.values()].some((count) => count > 1) ||
      (headers['sec-fetch-site'] &&
        !['none', 'same-origin'].includes(String(headers['sec-fetch-site']))) ||
      ++requests > CAPTURE_LIMITS.resourceRequests ||
      request.socket.remoteAddress !== '127.0.0.1' ||
      headers.host !== origin.slice(7) ||
      (headers.origin && headers.origin !== origin) ||
      Object.keys(headers).some((key) => key === 'forwarded' || key.startsWith('x-forwarded-')) ||
      headers['transfer-encoding'] ||
      (headers['content-length'] && headers['content-length'] !== '0') ||
      !allow(`${origin}${path}`, request.method ?? '')
    ) {
      fail()
      response.writeHead(403, { Connection: 'close' })
      response.end()
      return
    }
    const resource = snapshot.get(path.split('?')[0])!
    transferred += resource.bytes.length
    if (transferred > CAPTURE_LIMITS.totalAssetBytes) {
      fail()
      response.writeHead(429)
      response.end()
      return
    }
    response.writeHead(200, {
      'Content-Type': resource.mediaType,
      'Content-Length': resource.bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; worker-src 'self'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    response.end(resource.bytes)
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.keepAliveTimeout = 1000
  server.maxConnections = 12
  server.on('upgrade', (_request, socket) => {
    fail()
    socket.destroy()
  })
  server.on('clientError', (_error, socket) => {
    fail()
    socket.destroy()
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback bind failed.')
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    pageUrl: `${origin}${PAGE_PATH}`,
    allow,
    assertHealthy() {
      if (denied) throw new CaptureContractError('network-denied', 'A resource request was denied.')
    },
    stats: () => ({ requests, bytes: transferred, denied }),
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections()
        server.close(() => resolvePromise())
      }),
  }
}

export function assertOutsideSource(path: string) {
  const resolved = resolve(path)
  const protectedRoots = [
    SOURCE_ROOT,
    ...[
      'fury-real',
      'fury-real-handoff',
      'fury-next',
      'fury-ui',
      'fury-capture',
      'fury-capture-handoff',
    ].map((name) => join(dirname(SOURCE_ROOT), name)),
  ]
  if (
    resolved !== path ||
    protectedRoots.some((root) => path === root || path.startsWith(`${root}/`)) ||
    dirname(path) === path
  )
    throw new CaptureContractError(
      'invalid-input',
      'State must be outside source at an explicit real path.',
    )
}
