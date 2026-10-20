// Node-only persistent cache. The index is NOT an attempt ledger and cannot authorize rendering.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  CAPTURE_LIMITS,
  assertCanStartAttempt,
  captureAttemptSchema,
  captureBuildSchema,
  captureCompleteSchema,
  captureJobSchema,
  validateCaptureJob,
  validateCaptureReceipt,
  validateDecodedArtifact,
  type CaptureAttempt,
  type CaptureJob,
} from '../render/prototype/capture/contract'
import {
  decodeCapturePng,
  digest,
  jsonBytes,
  matchesObservedBrowserRuntime,
} from '../render/prototype/capture/artifacts'
import { localRenderRuntimeSchema } from './localRenderProtocol'
import {
  localCapacity,
  localIdentityMismatch,
  localInvalidArtifact,
  localUnavailable,
} from './localRenderErrors'
import {
  LOCAL_RENDER_CACHE_DIRECTORY,
  LOCAL_RENDER_HANDOFF,
  LOCAL_RENDER_HISTORY_DIRECTORY,
  type LocalRenderPrepared,
} from './localRenderPrivate'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const fingerprintSchema = z
  .object({
    dev: z.number(),
    ino: z.number(),
    size: z.number(),
    mtimeMs: z.number(),
    ctimeMs: z.number(),
  })
  .strict()
type Fingerprint = z.infer<typeof fingerprintSchema>
const fingerprint = (stat: Awaited<ReturnType<typeof lstat>>): Fingerprint => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  size: Number(stat.size),
  mtimeMs: Number(stat.mtimeMs),
  ctimeMs: Number(stat.ctimeMs),
})

/** Fixed-size no-follow snapshots, with inode/path/readback fences. Same-UID hostile writers are
 * not sandboxed; replacements and symlinks fail closed rather than becoming trusted cache files. */
export class LocalRenderSnapshot {
  private files = new Map<string, Fingerprint>()
  private directory: Fingerprint | undefined
  constructor(readonly root: string) {}
  async checkRoot() {
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw localInvalidArtifact()
    if ((await realpath(this.root)) !== this.root) throw localInvalidArtifact()
    const value = fingerprint(stat)
    if (this.directory && (this.directory.dev !== value.dev || this.directory.ino !== value.ino))
      throw localInvalidArtifact()
    this.directory = value
  }
  async read(name: string, max: number): Promise<Buffer> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name)) throw localInvalidArtifact()
    await this.checkRoot()
    const path = join(this.root, name)
    const pathStat = await lstat(path)
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw localInvalidArtifact()
    if ((await realpath(path)) !== path) throw localInvalidArtifact()
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat(),
        before = fingerprint(stat)
      if (
        !stat.isFile() ||
        stat.size < 1 ||
        stat.size > max ||
        !same(before, fingerprint(pathStat))
      )
        throw localInvalidArtifact()
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesRead) throw localInvalidArtifact()
        offset += result.bytesRead
      }
      if (
        !same(before, fingerprint(await handle.stat())) ||
        !same(before, fingerprint(await lstat(path)))
      )
        throw localInvalidArtifact()
      const previous = this.files.get(name)
      if (previous && !same(previous, before)) throw localInvalidArtifact()
      this.files.set(name, before)
      await this.checkRoot()
      return bytes
    } finally {
      await handle.close()
    }
  }
  async json(name: string) {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await this.read(name, CAPTURE_LIMITS.metadataBytes),
      ),
    ) as unknown
  }
  async revalidate() {
    await this.checkRoot()
    for (const [name, before] of this.files) {
      const path = join(this.root, name)
      if ((await realpath(path)) !== path || !same(before, fingerprint(await lstat(path))))
        throw localInvalidArtifact()
    }
  }
  identities() {
    return Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b)))
  }
}
const startedSchema = z
  .object({
    attempt: captureAttemptSchema,
    startedAt: z.number().int().positive(),
    outputDirectory: z.string().min(1).max(4096),
  })
  .strict()
const finishedSchema = z
  .object({
    attempt: captureAttemptSchema,
    elapsedMs: z
      .number()
      .finite()
      .nonnegative()
      .max(CAPTURE_LIMITS.runMs + CAPTURE_LIMITS.cleanupMs),
    code: z.string().max(40).nullable(),
  })
  .strict()
export type LocalRenderHistory = {
  attempts: CaptureAttempt[]
  outputs: Map<string, string>
  consumedMs: number
  locked: boolean
}
const indexSchema = z
  .object({
    version: z.literal(1),
    outputDirectory: z.string().max(4096),
    job: captureJobSchema,
    marker: captureCompleteSchema,
    files: z.record(z.string(), fingerprintSchema),
  })
  .strict()
export type VerifiedLocalCapture = Awaited<ReturnType<LocalRenderCache['verify']>>

export class LocalRenderCache {
  /** Test-only dependency seam. Production plugin always uses the three fixed constants. */
  constructor(
    readonly paths = {
      index: LOCAL_RENDER_CACHE_DIRECTORY,
      outputs: LOCAL_RENDER_HANDOFF,
      history: LOCAL_RENDER_HISTORY_DIRECTORY,
    },
  ) {}
  private assertOutput(path: string) {
    if (
      dirname(path) !== this.paths.outputs ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(path.slice(this.paths.outputs.length + 1)) ||
      path === this.paths.index
    )
      throw localInvalidArtifact()
  }
  newOutputPath() {
    return join(this.paths.outputs, `local-render-capture-${randomUUID()}`)
  }
  async history(): Promise<LocalRenderHistory> {
    const result: LocalRenderHistory = {
      attempts: [],
      outputs: new Map(),
      consumedMs: 0,
      locked: false,
    }
    const snapshot = new LocalRenderSnapshot(this.paths.history)
    try {
      await snapshot.checkRoot()
    } catch (error) {
      if (missing(error)) return result
      throw error
    }
    const names = await readdir(this.paths.history)
    if (
      names.length > 17 ||
      names.some(
        (name) =>
          name !== 'runner.lock' && !/^attempt-0[1-8]\.(?:started|finished)\.json$/.test(name),
      )
    )
      throw localUnavailable()
    result.locked = names.includes('runner.lock')
    for (let i = 1; i <= CAPTURE_LIMITS.attempts; i++) {
      const prefix = `attempt-${String(i).padStart(2, '0')}`
      if (!names.includes(`${prefix}.started.json`)) {
        if (names.some((name) => /^attempt-/.test(name) && Number(name.slice(8, 10)) >= i))
          throw localUnavailable()
        break
      }
      const start = startedSchema.parse(await snapshot.json(`${prefix}.started.json`))
      if (start.attempt.state !== 'running') throw localUnavailable()
      assertCanStartAttempt(result.attempts, start.attempt.sampleId, start.attempt.kind)
      let attempt = start.attempt
      if (names.includes(`${prefix}.finished.json`)) {
        const finish = finishedSchema.parse(await snapshot.json(`${prefix}.finished.json`))
        if (
          finish.attempt.state === 'running' ||
          !same({ ...finish.attempt, state: 'running' }, attempt) ||
          (finish.attempt.state === 'succeeded' && finish.code !== null)
        )
          throw localUnavailable()
        attempt = finish.attempt
        result.consumedMs += finish.elapsedMs
      }
      result.attempts.push(attempt)
      result.outputs.set(attempt.jobId, start.outputDirectory)
    }
    await snapshot.revalidate()
    return result
  }
  assertAdmission(history: LocalRenderHistory, sampleId: CaptureJob['sampleId']) {
    if (history.locked || history.consumedMs >= CAPTURE_LIMITS.runMs - CAPTURE_LIMITS.jobMs)
      throw localCapacity()
    try {
      assertCanStartAttempt(history.attempts, sampleId, 'sample')
    } catch {
      throw localCapacity()
    }
  }
  async lookup(expected: CaptureJob, prepared: LocalRenderPrepared) {
    const history = await this.history()
    const completed = history.attempts.find(
      (entry) => entry.sampleId === expected.sampleId && entry.state === 'succeeded',
    )
    if (!completed) {
      // A lost/replaced history must not turn a retained success index into a fresh render budget.
      try {
        const snapshot = new LocalRenderSnapshot(this.paths.index)
        await snapshot.checkRoot()
        const names = await readdir(this.paths.index)
        if (
          names.length > 16 ||
          names.some((name) => !/^(?:[a-f0-9]{64}\.json|\.pending-[a-f0-9-]{36})$/.test(name))
        )
          throw localUnavailable()
        for (const name of names.filter((name) => name.endsWith('.json'))) {
          const entry = indexSchema.parse(await snapshot.json(name))
          if (entry.job.sampleId === expected.sampleId) throw localUnavailable()
        }
        await snapshot.revalidate()
      } catch (error) {
        if (!missing(error)) throw error
      }
      return { history, verified: null }
    }
    const output = history.outputs.get(completed.jobId)!
    const verified = await this.verify(output, expected, prepared, completed.jobId)
    await this.publishIndex(output, verified)
    await prepared.revalidate()
    return { history, verified }
  }
  async verify(
    output: string,
    expected: CaptureJob,
    prepared: LocalRenderPrepared,
    completedJobId: string,
  ) {
    this.assertOutput(output)
    const files = new LocalRenderSnapshot(output)
    const job = await validateCaptureJob(await files.json('job.json'))
    if (
      job.jobId !== completedJobId ||
      job.sampleId !== expected.sampleId ||
      !same(job.identity, expected.identity) ||
      !same(job.build, prepared.build) ||
      !same(job.profile, expected.profile)
    )
      throw localIdentityMismatch()
    const build = captureBuildSchema.parse(await files.json('build.json'))
    if (!same(build, job.build)) throw localIdentityMismatch()
    const marker = captureCompleteSchema.parse(await files.json('COMPLETE.json'))
    if (marker.jobId !== job.jobId || marker.captureDigest !== job.identity.captureDigest)
      throw localIdentityMismatch()
    const receiptBytes = await files.read('receipt.json', CAPTURE_LIMITS.metadataBytes)
    if (
      digest(receiptBytes) !== marker.receipt.digest ||
      receiptBytes.length !== marker.receipt.bytes
    )
      throw localInvalidArtifact()
    const receipt = await validateCaptureReceipt(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)),
      job,
    )
    const runtime = localRenderRuntimeSchema.parse(receipt.runtime)
    const browser = z
      .object({ product: z.string().max(512), userAgent: z.string().max(512) })
      .passthrough()
      .parse(await files.json('browser.json'))
    if (!matchesObservedBrowserRuntime(runtime, browser)) throw localInvalidArtifact()
    for (const [kind, records] of Object.entries(prepared.manifests)) {
      const expectedRecords = [...records].sort((a, b) => a.name.localeCompare(b.name))
      const actual: unknown[] = []
      for (let i = 0; i < expectedRecords.length; i += 80) {
        const chunk = await files.json(`${kind}-${String(i / 80).padStart(3, '0')}.json`)
        if (!Array.isArray(chunk) || chunk.length > 80) throw localInvalidArtifact()
        actual.push(...chunk)
      }
      if (!same(actual, expectedRecords)) throw localIdentityMismatch()
    }
    const bytes = await files.read('image.png', CAPTURE_LIMITS.pngBytes)
    const artifact = await validateDecodedArtifact(
      job.profile,
      bytes,
      decodeCapturePng(bytes, job.profile),
    )
    if (!same(artifact, receipt.artifact) || !same(artifact, marker.image))
      throw localInvalidArtifact()
    await prepared.revalidate()
    await files.revalidate()
    return { job, marker, receipt, runtime, bytes, files: files.identities() }
  }
  private async publishIndex(outputDirectory: string, verified: VerifiedLocalCapture) {
    const entry = indexSchema.parse({
      version: 1,
      outputDirectory,
      job: verified.job,
      marker: verified.marker,
      files: verified.files,
    })
    if ((await realpath(dirname(this.paths.index))) !== dirname(this.paths.index))
      throw localInvalidArtifact()
    try {
      await mkdir(this.paths.index, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const snapshot = new LocalRenderSnapshot(this.paths.index)
    await snapshot.checkRoot()
    const name = `${verified.job.identity.captureDigest.slice(7)}.json`
    try {
      if (!same(indexSchema.parse(await snapshot.json(name)), entry)) throw localInvalidArtifact()
      return
    } catch (error) {
      if (!missing(error)) throw error
    }
    const pending = `.pending-${randomUUID()}`
    const handle = await open(
      join(this.paths.index, pending),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(jsonBytes(entry))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await snapshot.checkRoot()
    try {
      await link(join(this.paths.index, pending), join(this.paths.index, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await unlink(join(this.paths.index, pending))
    }
    if (!same(indexSchema.parse(await snapshot.json(name)), entry)) throw localInvalidArtifact()
    const directory = await open(
      this.paths.index,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}
