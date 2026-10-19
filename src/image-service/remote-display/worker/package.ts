import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { build as viteBuild, type Plugin } from 'vite'
import { freezeDesignValue } from '../../../domain/design'
import { displayBuildSchema, stableDisplayJson } from '../../../display/contract'
import {
  assertDisplayBrowserModule,
  manifestHash,
  sha,
  RESOURCE_BOUNDS,
  type ByteRecord,
} from '../../../render/display/build'
import { TEXTURE_SETS } from '../../../render/textureSets'

/** Source location is private and trusted, never accepted from a browser request. */
export const CLOUD_SOURCE = fileURLToPath(new URL('../../../../', import.meta.url)).replace(
  /\/$/,
  '',
)
export const CLOUD_RUNTIME_POLICY = freezeDesignValue({
  kind: 'external-private-display-runtime-candidate@1',
  dispatchAllowed: false,
  runtime: 'vm',
  uid: 'non-root-required',
  chromeVersion: '137.0.7118.2',
  launch: 'owned-headless-webgpu-no-fallback-pipe-cdp@1',
  browserCommand: 'byte-equal-to-frozen-supervisor-except-private-portable-paths',
  environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
  gpu: 'positive-page-and-CDP-device-match; software-and-unknown-denied',
  process: 'pidfd-parent-identity-subreaper-owned-descendant-reaping',
  network: 'private-loopback-only; provider-policy-unproven',
  imageDigest: null,
  runtimeFilesDigest: null,
  fontFilesDigest: null,
  sdkLaunchPin: null,
  sdkAuditPin: 'modal==1.1.4',
  sdkAuditSource: 'sha256:baa8a10faf6bfe18a7e1710604d5273bc8484e43fce7a1ef88bdd8d7157a07a9',
  observations: 'none; requirements and package compilation are not runtime evidence',
  lifetimeMs: 600000,
  idleMs: 30000,
  jobMs: 180000,
  rights: 'font/art/engineering/visual-review-holds-remain',
})

export type PortablePackage = {
  build: ReturnType<typeof displayBuildSchema.parse>
  packageDigest: string
  records: readonly ByteRecord[]
  /** Copies only: callers cannot mutate the preparation's trusted bytes. */
  files(): ReadonlyMap<string, Buffer>
  revalidate(): Promise<void>
}
const record = (name: string, bytes: Uint8Array): ByteRecord => ({
  name,
  bytes: bytes.length,
  digest: sha(bytes),
})
export function assertPortableName(name: string) {
  if (
    !/^[A-Za-z0-9_@./-]+$/.test(name) ||
    name.startsWith('/') ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    /(?:^|\/)(?:\.git|operator|captures|stills?|__pycache__)(?:\/|$)/i.test(name)
  )
    throw new Error('Noncanonical portable package member.')
}
/** No source symlinks/hardlinks and no TOCTOU truncation or mutation accepted. */
export async function packageBytes(path: string, root: string): Promise<Buffer> {
  if (!path.startsWith(`${root}/`) || (await realpath(path)) !== path)
    throw new Error('Package path denied.')
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > RESOURCE_BOUNDS.file
    )
      throw new Error('Package file bound/type/link denied.')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await fd.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new Error('Package file truncated.')
      offset += read.bytesRead
    }
    const after = await fd.stat()
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.nlink !== 1
    )
      throw new Error('Package file changed.')
    return bytes
  } finally {
    await fd.close()
  }
}

/** Compile only. Does not write a runtime image, execute a browser, import Modal or contact a provider. */
export async function preparePortablePackage(): Promise<PortablePackage> {
  const root = CLOUD_SOURCE
  if ((await realpath(root)) !== root) throw new Error('Cloud source root changed.')
  const dependencies = await realpath(join(root, 'node_modules'))
  const files = new Map<string, Buffer>()
  const tracked = new Map<string, { path: string; root: string; digest: string }>()
  const members = new Map<string, string[]>()
  const add = (name: string, bytes: Buffer) => {
    assertPortableName(name)
    const prior = files.get(name)
    if (prior && sha(prior) !== sha(bytes)) throw new Error('Package changed during preparation.')
    files.set(name, bytes)
    if (
      bytes.length > RESOURCE_BOUNDS.file ||
      files.size > RESOURCE_BOUNDS.sources ||
      [...files.values()].reduce((n, b) => n + b.length, 0) > RESOURCE_BOUNDS.total
    )
      throw new Error('Package closure bound.')
    return bytes
  }
  const track = async (path: string, base: string, name: string) => {
    const bytes = await packageBytes(path, base)
    add(name, bytes)
    tracked.set(name, { path, root: base, digest: sha(bytes) })
    return bytes
  }
  const own = async (directory: string) => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((e) => !/\.test\.|^test_|^__pycache__$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    members.set(
      directory,
      entries.map((e) => e.name),
    )
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await own(path)
      else if (entry.isFile() && /\.(ts|tsx|py|json|html)$/.test(entry.name))
        await track(path, root, relative(root, path))
      else throw new Error('Unapproved private source member.')
    }
  }
  // Separate external namespace, including durable service validators once that lane is present.
  await own(join(root, 'src/image-service/remote-display'))
  for (const name of [
    'package.json',
    'package-lock.json',
    'public/textures/sources.json',
    'scripts/build-textures.py',
    'src/display/cloudContract.ts',
    'src/display/cloudSession.ts',
    'src/display/contract.ts',
    'src/display/session.ts',
    'src/render/display/build.ts',
    'src/render/display/process.ts',
    'src/render/display/supervisor.py',
    'src/render/prototype/capture/artifacts.ts',
    'src/render/prototype/capture/contract.ts',
    'src/image-service/display/cache.ts',
    'src/image-service/display/files.ts',
    'src/image-service/display/errors.ts',
  ])
    await track(join(root, name), root, name)
  // The source compiler package versions participate in identity; these are not remote runtime pins.
  for (const name of ['vite', 'rollup', 'esbuild', 'three', 'typescript'])
    await track(
      join(dependencies, name, 'package.json'),
      dependencies,
      `node_modules/${name}/package.json`,
    )
  const assets: ByteRecord[] = []
  for (const [set, info] of Object.entries(TEXTURE_SETS)) {
    for (const channel of 'detailOnly' in info ? ['normal', 'arm'] : ['albedo', 'normal', 'arm']) {
      const name = `public/textures/${set}/${channel}.webp`
      assets.push(record(name, await track(join(root, name), root, name)))
    }
  }
  const graph = (): Plugin => ({
    name: 'fury-cloud-private-package',
    enforce: 'pre',
    async load(id) {
      if (id.startsWith('\0') || id.startsWith('vite/')) return null
      const path = await realpath(id.split('?')[0])
      const dep = path.startsWith(`${dependencies}/`)
      const name = dep ? `node_modules/${relative(dependencies, path)}` : relative(root, path)
      assertDisplayBrowserModule(name)
      await track(path, dep ? dependencies : root, name)
      return null
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle))
        if (item.type === 'chunk') {
          if (
            Object.entries(item.modules).some(
              ([name, info]) =>
                /\/src\/lib\/(recovery|stillsManifest)\.ts$/.test(name) && info.renderedLength > 0,
            )
          )
            throw new Error('Historical/storage code emitted.')
          if (
            [...item.imports, ...item.dynamicImports].some((name) =>
              /^(https?:|data:|file:|node:|\/\/)/.test(name),
            )
          )
            throw new Error('External private bundle import.')
        }
    },
  })
  const result = await viteBuild({
    configFile: false,
    envFile: false,
    publicDir: false,
    root: join(root, 'src/render/display/browser'),
    base: '/',
    logLevel: 'silent',
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
      rollupOptions: { input: join(root, 'src/render/display/browser/display.html') },
    },
  })
  if ('on' in result) throw new Error('Watch mode denied.')
  const bundle: ByteRecord[] = []
  for (const output of Array.isArray(result) ? result : [result])
    for (const item of output.output) {
      if (
        !/^(display\.html|assets\/[A-Za-z0-9_.-]+\.(js|css))$/.test(item.fileName) ||
        item.fileName.includes('..')
      )
        throw new Error('Unapproved bundle output.')
      const name = `private-browser/${item.fileName}`
      if (files.has(name)) throw new Error('Duplicate bundle output.')
      bundle.push(
        record(name, add(name, Buffer.from(item.type === 'chunk' ? item.code : item.source))),
      )
    }
  if (
    !files.has('private-browser/display.html') ||
    !bundle.some((b) => /siteLight\.worker.*\.js$/.test(b.name))
  )
    throw new Error('Private scene/light worker missing.')
  // Resolve actual runtime source imports, not a repository archive. Type-only imports do not
  // become executable closure members. Only reviewed private namespaces are eligible.
  const serverAllowed = (name: string) =>
    /^src\/image-service\/remote-display\/(worker|service)\//.test(name) ||
    /^src\/image-service\/display\/(cache|files|errors|http)\.ts$/.test(name) ||
    /^src\/image-service\/localRender(Http|Protocol|Errors)\.ts$/.test(name) ||
    /^src\/display\/(cloudContract|cloudSession|contract|session|readiness)\.ts$/.test(name) ||
    /^src\/render\/display\/(build|process|input|revisions|observation)\.ts$/.test(name) ||
    /^src\/render\/prototype\/capture\/(artifacts|contract)\.ts$/.test(name) ||
    /^src\/domain\//.test(name)
  const visited = new Set<string>()
  const closeSource = async (name: string): Promise<void> => {
    if (visited.has(name) || !/\.(ts|tsx)$/.test(name) || name.startsWith('node_modules/')) return
    visited.add(name)
    const bytes = files.get(name)
    if (!bytes) throw new Error('Missing source closure member.')
    const tree = ts.createSourceFile(name, bytes.toString(), ts.ScriptTarget.ES2022, true)
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) continue
      if (ts.isExportDeclaration(node) && node.isTypeOnly) continue
      const specifier = node.moduleSpecifier
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
      const base = resolve(root, dirname(name), specifier.text.replace(/\.js$/, ''))
      let path: string | undefined
      for (const candidate of /\.(ts|tsx|json)$/.test(base)
        ? [base]
        : [base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
        try {
          path = await realpath(candidate)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (!path || !path.startsWith(`${root}/`))
        throw new Error('Source import cannot be resolved privately.')
      const target = relative(root, path)
      if (!files.has(target)) {
        if (!serverAllowed(target)) throw new Error(`Unapproved server source import: ${target}`)
        await track(path, root, target)
      }
      await closeSource(target)
    }
  }
  for (const name of [...files.keys()].filter((name) =>
    name.startsWith('src/image-service/remote-display/'),
  ))
    await closeSource(name)
  const sourceRecords = [...files]
    .filter(([name]) => !name.endsWith('.webp') && !name.startsWith('private-browser/'))
    .map(([name, bytes]) => record(name, bytes))
  add('runtime-policy.json', Buffer.from(stableDisplayJson(CLOUD_RUNTIME_POLICY)))
  const build = displayBuildSchema.parse({
    sourceManifestDigest: manifestHash(sourceRecords),
    assetManifestDigest: manifestHash(assets),
    bundleDigest: manifestHash(bundle),
    lockfileDigest: sha(files.get('package-lock.json')!),
    runtimePolicyDigest: sha(files.get('runtime-policy.json')!),
    threeRevision: (
      JSON.parse(files.get('node_modules/three/package.json')!.toString()) as { version: string }
    ).version.match(/^0\.(\d+)\./)?.[1],
  })
  const records = [...files]
    .map(([name, bytes]) => record(name, bytes))
    .sort((a, b) => a.name.localeCompare(b.name))
  const packageDigest = manifestHash(records)
  const revalidate = async () => {
    for (const entry of tracked.values())
      if (sha(await packageBytes(entry.path, entry.root)) !== entry.digest)
        throw new Error('Cloud package source/asset changed.')
    for (const [directory, names] of members) {
      const next = (await readdir(directory))
        .filter((name) => !/\.test\.|^test_|^__pycache__$/.test(name))
        .sort((a, b) => a.localeCompare(b))
      if (stableDisplayJson(names) !== stableDisplayJson(next))
        throw new Error('Cloud package source membership changed.')
    }
    if (manifestHash([...files].map(([name, bytes]) => record(name, bytes))) !== packageDigest)
      throw new Error('Cloud package memory changed.')
  }
  await revalidate()
  return {
    build: freezeDesignValue(build),
    packageDigest,
    records: freezeDesignValue(records),
    files: () => new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)])),
    revalidate,
  }
}

/** Portable bytes verification is separate from approval and from runtime image verification. */
export function verifyPortableFiles(files: ReadonlyMap<string, Uint8Array>, expected: string) {
  if (files.size < 1 || files.size > RESOURCE_BOUNDS.sources)
    throw new Error('Package member count.')
  let total = 0
  const records: ByteRecord[] = []
  for (const [name, bytes] of files) {
    assertPortableName(name)
    if (
      !bytes.length ||
      bytes.length > RESOURCE_BOUNDS.file ||
      (total += bytes.length) > RESOURCE_BOUNDS.total
    )
      throw new Error('Package byte bound.')
    records.push(record(name, bytes))
  }
  if (manifestHash(records) !== expected) throw new Error('Portable package digest mismatch.')
}
