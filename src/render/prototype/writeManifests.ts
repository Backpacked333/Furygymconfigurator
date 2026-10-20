import { mkdir, open, readFile, readdir, realpath, lstat, link, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { createG1ReviewBundle } from './fixtures'
import { canonical, bytesDigest } from './identity'
import { PREPARATION_ASSET_INVENTORY, sourceProvenance } from './provenance'
import { prepareCaptureBuild } from './capture/host'

async function preparePackage() {
  if (process.env.NODE_ENV !== 'production')
    throw new Error(
      'Private preparation requires NODE_ENV=production for reproducible bundle identity.',
    )
  const bundle = createG1ReviewBundle()
  const deadline = performance.now() + 180_000
  const prepared = await prepareCaptureBuild(() => {
    if (performance.now() > deadline)
      throw new Error('Private preparation build deadline exceeded.')
  })
  const pins = new Map(PREPARATION_ASSET_INVENTORY.files.map((file) => [file.path, file]))
  if (prepared.manifests.assets.length !== pins.size - 1)
    throw new Error('Private asset closure does not match inventory.')
  for (const asset of prepared.manifests.assets) {
    const pin = pins.get(asset.name)
    if (!pin || pin.digest !== asset.digest || pin.bytes !== asset.bytes)
      throw new Error('Private asset closure contains an unpinned resource.')
  }
  const entries: { name: string; value: unknown }[] = []
  for (const { fixture, scene } of bundle.fixtures) {
    entries.push(
      { name: `${fixture.id}.fixture.json`, value: fixture },
      { name: `${fixture.id}.scene.json`, value: scene },
    )
  }
  for (const { id, scene } of bundle.caseScenes)
    entries.push({ name: `${id}.scene.json`, value: scene })
  entries.push(
    { name: 'g1-review-manifest.json', value: bundle.g1 },
    { name: 'strict-reference-manifest.json', value: bundle.reference },
    { name: 'asset-inventory.json', value: PREPARATION_ASSET_INVENTORY },
    {
      name: 'private-build-manifest.json',
      value: {
        build: prepared.build,
        manifests: Object.fromEntries(
          Object.entries(prepared.manifests).map(([kind, records]) => [
            kind,
            [...records].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          ]),
        ),
        mode: 'build-only-no-browser-no-render',
        nodeEnv: 'production',
      },
    },
  )
  const revalidate = async () => {
    await prepared.revalidate()
    if (sourceProvenance().digest !== bundle.fixtures[0].scene.sources.digest)
      throw new Error('Preparation sources changed before publication.')
  }
  return { bundle, entries, revalidate }
}

/** Exclusive new directory only: never replace, migrate, delete or merge old review data. */
export async function writePrototypeReviewManifests(outputDirectory: string) {
  const output = z
    .string()
    .min(1)
    .max(4096)
    .refine(isAbsolute, 'Use an absolute output directory.')
    .parse(outputDirectory)
  const parent = await realpath(dirname(output))
  if (parent !== dirname(resolve(output)))
    throw new Error('Symlink/relative output parents are not accepted.')
  // Only explicit local preparation outputs; never replace another lane's retained evidence.
  if (/^\/home\/ubuntu\/Documents\/fury-(?:real|next|ui|capture)(?:-handoff)?(?:\/|$)/.test(output))
    throw new Error('Protected source/capture evidence path.')
  // Fail before expensive preparation if an output already exists.
  try {
    await lstat(output)
    throw new Error('EEXIST: preparation output already exists.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const { bundle, entries, revalidate } = await preparePackage()
  // Atomic ownership of this new path. A concurrent writer or existing directory wins; we fail.
  await mkdir(output, { recursive: false, mode: 0o700 })
  const owned = await lstat(output)
  const assertOwned = async () => {
    const current = await lstat(output)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino
    )
      throw new Error('Output directory changed during preparation. No further files written.')
  }
  const files: { name: string; bytes: number; digest: string }[] = []
  const writeExclusive = async (name: string, value: unknown) => {
    await assertOwned()
    const bytes = `${canonical(value)}\n`
    const path = join(output, name)
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(bytes, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (bytesDigest(await readFile(path)) !== bytesDigest(bytes))
      throw new Error('Output verification failed; directory is incomplete.')
    files.push({ name, bytes: Buffer.byteLength(bytes), digest: bytesDigest(bytes) })
  }
  for (const { name, value } of entries) await writeExclusive(name, value)
  await revalidate()
  const completion = {
    contract: 'fury.prototype-review-directory',
    version: 2,
    status: 'DRAFT-local-review-only',
    approval: false,
    productionAllowed: false,
    paidExecutionAllowed: false,
    manifestDigest: bundle.g1.manifestDigest,
    files: [...files],
  }
  // Last marker means all preceding files were written, fsynced and checksummed. Never implies image readiness.
  await writeExclusive('.COMPLETE.pending.json', completion)
  await assertOwned()
  // Link publishes a fully verified file atomically and refuses an existing final name.
  await link(join(output, '.COMPLETE.pending.json'), join(output, 'COMPLETE.json'))
  await unlink(join(output, '.COMPLETE.pending.json'))
  files[files.length - 1].name = 'COMPLETE.json'
  return {
    outputDirectory: output,
    manifestDigest: bundle.g1.manifestDigest,
    files,
    counts: bundle.g1.counts,
  }
}

/** Replay against current trusted code/assets, not against claims in an imported manifest. */
export async function validatePrototypeReviewDirectory(outputDirectory: string) {
  const directory = resolve(outputDirectory)
  if ((await realpath(directory)) !== directory)
    throw new Error('Symlink review directory rejected.')
  const owner = await lstat(directory)
  if (!owner.isDirectory()) throw new Error('Review directory required.')
  const { bundle, entries, revalidate } = await preparePackage()
  const expectedFiles = entries.map(({ name, value }) => {
    const bytes = `${canonical(value)}\n`
    return { name, bytes: Buffer.byteLength(bytes), digest: bytesDigest(bytes) }
  })
  const expectedCompletion = {
    contract: 'fury.prototype-review-directory',
    version: 2,
    status: 'DRAFT-local-review-only',
    approval: false,
    productionAllowed: false,
    paidExecutionAllowed: false,
    manifestDigest: bundle.g1.manifestDigest,
    files: expectedFiles,
  }
  const expected = [...entries, { name: 'COMPLETE.json', value: expectedCompletion }]
  if (
    canonical((await readdir(directory)).sort()) !== canonical(expected.map((e) => e.name).sort())
  )
    throw new Error('Incomplete or unknown review files.')
  for (const { name, value } of expected) {
    const path = join(directory, name),
      bytes = `${canonical(value)}\n`
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== Buffer.byteLength(bytes))
        throw new Error(`Review file type/size mismatch: ${name}`)
      const actual = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < actual.length) {
        const read = await handle.read(actual, offset, actual.length - offset, offset)
        if (!read.bytesRead) throw new Error(`Truncated review file: ${name}`)
        offset += read.bytesRead
      }
      const after = await handle.stat()
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        actual.toString('utf8') !== bytes
      )
        throw new Error(`Review identity mismatch: ${name}`)
    } finally {
      await handle.close()
    }
  }
  await revalidate()
  const after = await lstat(directory)
  if (
    (await realpath(directory)) !== directory ||
    after.ino !== owner.ino ||
    after.dev !== owner.dev
  )
    throw new Error('Review directory changed during verification.')
  return {
    valid: true,
    files: expected.length,
    manifestDigest: bundle.g1.manifestDigest,
    counts: bundle.g1.counts,
  }
}
