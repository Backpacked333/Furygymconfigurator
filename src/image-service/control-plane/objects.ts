import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import { designEnvelopeSchema, type DesignEnvelope } from '../../domain/design'
import { createMockArtifact } from '../protocol'
import {
  artifactDescriptorSchema,
  bindRequestSync,
  canonicalJson,
  describeArtifact,
  diagnosticBytes,
  executionIdentitySchema,
  objectKeySchema,
  opaqueIdSchema,
  policySchema,
  quoteSchema,
  requestBindingSchema,
  sha256Bytes,
  signVerifiedObject,
  timestampSchema,
  unavailable,
  verifyDiagnosticArtifact,
  type ArtifactDescriptor,
  type Lease,
  type MockArtifact,
  type ObjectRecoveryReport,
  type ObjectStore,
  type ObjectStoreOptions,
  type StagedObject,
  type VerifiedObject,
} from './contracts'

const MAX_BYTES = 12 * 1024
const MAX_RECORD_BYTES = 32 * 1024
// Policy permits at most 512 jobs with three attempts each. Refuse an unbounded inventory.
const MAX_ENTRIES = 4096
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const stageSchema = z
  .object({
    stageId: opaqueIdSchema,
    execution: executionIdentitySchema,
    object: artifactDescriptorSchema,
    stagedAt: timestampSchema,
  })
  .strict()
const stageRecordSchema = z.object({ stage: stageSchema, design: designEnvelopeSchema }).strict()
const objectRecordSchema = z
  .object({ object: artifactDescriptorSchema, design: designEnvelopeSchema })
  .strict()
const signedRecordSchema = z
  .object({ payload: z.unknown(), signature: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
const leaseSchema = z
  .object({
    execution: executionIdentitySchema,
    workerId: opaqueIdSchema,
    design: designEnvelopeSchema,
    binding: requestBindingSchema,
    quote: quoteSchema,
    leaseUntil: timestampSchema,
    deadline: timestampSchema,
    policy: policySchema,
  })
  .strict()
type StageRecord = z.infer<typeof stageRecordSchema>
type ObjectRecord = z.infer<typeof objectRecordSchema>
type Directory = { fd: number; stat: Stats; parent?: Directory; name?: string }

/** Fault injection only; never exposed by the HTTP/request/worker contracts. */
export type ObjectStoreTestHooks = Readonly<{
  at?: (
    point:
      | 'before-stage-write'
      | 'before-publish-link'
      | 'after-create-link'
      | 'after-publish-link'
      | 'before-receipt'
      | 'before-read'
      | 'before-delete',
  ) => void
  write?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number
}>

function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}
function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}
function existsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST'
}
function denied(): never {
  throw unavailable('Immutable local object storage is unavailable or failed verification.')
}
function safeName(name: string): void {
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(name) || name === '.' || name === '..') denied()
}
function anchored(directory: Directory, name: string): string {
  safeName(name)
  return `/proc/self/fd/${directory.fd}/${name}`
}
function closeDirectory(directory: Directory): void {
  closeSync(directory.fd)
}

/**
 * Linux-only local object boundary. Every untrusted component is opened NOFOLLOW,
 * relative to pinned directory descriptors; /proc/self/fd is the trusted kernel anchor.
 * Never mounted as a public directory. No renderer, CDN, network, or provider exists here.
 * A hostile same-UID process can cause denial of service; this is not an OS sandbox.
 */
export class FileObjectStore implements ObjectStore {
  readonly #rootPath: string
  readonly #secret: string
  readonly #now: () => number
  readonly #hooks: ObjectStoreTestHooks
  readonly #root: Directory
  #closed = false

  constructor(options: ObjectStoreOptions, testHooks: ObjectStoreTestHooks = {}) {
    this.#secret = options.objectSecret
    this.#now = options.now ?? Date.now
    this.#hooks = testHooks
    this.#rootPath = options.root
    let root: Directory | undefined
    try {
      if (
        process.platform !== 'linux' ||
        typeof this.#secret !== 'string' ||
        Buffer.byteLength(this.#secret) < 32 ||
        !isAbsolute(this.#rootPath) ||
        normalize(this.#rootPath) !== this.#rootPath ||
        this.#rootPath === '/' ||
        this.#rootPath
          .split('/')
          .slice(1)
          .some((part) => !part || part === '.' || part === '..')
      )
        denied()
      root = this.#openRoot(true)
      this.#root = root
      this.#checkOwned(root.stat)
      const marker = { format: 'fury-p04-local-objects@1' }
      let markerBytes: Uint8Array
      try {
        markerBytes = this.#readFile(root, '.store.json', MAX_RECORD_BYTES)
      } catch (error) {
        if (!isMissing(error)) throw error
        if (this.#names(root).length !== 0) denied()
        this.#exclusive(root, '.store.json', this.#signed(marker), 0o400)
        markerBytes = this.#readFile(root, '.store.json', MAX_RECORD_BYTES)
      }
      if (!equal(this.#unsigned(markerBytes), marker)) denied()
      this.#assertLive(root)
    } catch {
      if (root) closeDirectory(root)
      throw unavailable('Immutable local object store could not be opened safely.')
    }
  }

  // No deletion/refund/stop is implied by closing this local descriptor.
  close(): void {
    if (!this.#closed) {
      this.#closed = true
      closeDirectory(this.#root)
    }
  }

  #checkOwned(stat: Stats): void {
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      denied()
  }

  #openRoot(create: boolean): Directory {
    let current: Directory = { fd: openSync('/', DIRECTORY_FLAGS), stat: lstatSync('/') }
    try {
      const parts = this.#rootPath.split('/').slice(1)
      for (let index = 0; index < parts.length; index++) {
        const name = parts[index]
        let fd: number
        try {
          fd = openSync(anchored(current, name), DIRECTORY_FLAGS)
        } catch (error) {
          if (!create || index !== parts.length - 1 || !isMissing(error)) throw error
          try {
            mkdirSync(anchored(current, name), { mode: 0o700 })
            fsyncSync(current.fd)
          } catch (mkdirError) {
            if (!existsError(mkdirError)) throw mkdirError
          }
          fd = openSync(anchored(current, name), DIRECTORY_FLAGS)
        }
        const next = { fd, stat: fstatSync(fd) }
        closeDirectory(current)
        current = next
      }
      return current
    } catch (error) {
      closeDirectory(current)
      throw error
    }
  }

  #assertLive(directory: Directory = this.#root): void {
    if (this.#closed) denied()
    const reopened = this.#openRoot(false)
    try {
      if (!sameInode(reopened.stat, this.#root.stat)) denied()
    } finally {
      closeDirectory(reopened)
    }
    let current = directory
    while (current.parent && current.name) {
      const linked = lstatSync(anchored(current.parent, current.name))
      if (!linked.isDirectory() || !sameInode(linked, current.stat)) denied()
      this.#checkOwned(linked)
      current = current.parent
    }
    this.#checkOwned(fstatSync(this.#root.fd))
  }

  #directory(parent: Directory, name: string, create = false): Directory {
    this.#assertLive(parent)
    if (create) {
      try {
        mkdirSync(anchored(parent, name), { mode: 0o700 })
        fsyncSync(parent.fd)
      } catch (error) {
        if (!existsError(error)) throw error
      }
    }
    const fd = openSync(anchored(parent, name), DIRECTORY_FLAGS)
    try {
      const result = { fd, stat: fstatSync(fd), parent, name }
      this.#checkOwned(result.stat)
      this.#assertLive(result)
      return result
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }

  #withDirectory<T>(
    names: readonly string[],
    create: boolean,
    operation: (directory: Directory) => T,
  ): T {
    const opened: Directory[] = []
    try {
      let directory = this.#root
      for (const name of names) {
        directory = this.#directory(directory, name, create)
        opened.push(directory)
      }
      this.#assertLive(directory)
      return operation(directory)
    } finally {
      for (const directory of opened.reverse()) closeDirectory(directory)
    }
  }

  #signed(payload: unknown): Uint8Array {
    const signature = createHmac('sha256', this.#secret)
      .update(`p04-local-manifest\n${canonicalJson(payload)}`)
      .digest('hex')
    const bytes = Buffer.from(canonicalJson({ payload, signature }))
    if (bytes.byteLength > MAX_RECORD_BYTES) denied()
    return bytes
  }

  #unsigned(bytes: Uint8Array): unknown {
    const record = signedRecordSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    const expected = createHmac('sha256', this.#secret)
      .update(`p04-local-manifest\n${canonicalJson(record.payload)}`)
      .digest()
    if (!timingSafeEqual(expected, Buffer.from(record.signature, 'hex'))) denied()
    return record.payload
  }

  #regular(stat: Stats, maximum: number, expectedLinks = 1): void {
    // Two links are allowed only for a proven same-inode interrupted stage/publication pair.
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== expectedLinks ||
      (stat.mode & 0o222) !== 0 ||
      stat.size < 1 ||
      stat.size > maximum
    )
      denied()
  }

  #readFile(directory: Directory, name: string, maximum: number, expectedLinks = 1): Uint8Array {
    this.#assertLive(directory)
    const fd = openSync(anchored(directory, name), FILE_FLAGS)
    try {
      const before = fstatSync(fd)
      this.#regular(before, maximum, expectedLinks)
      const bytes = Buffer.alloc(before.size)
      let offset = 0
      while (offset < bytes.byteLength) {
        const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset)
        if (count <= 0) denied()
        offset += count
      }
      const after = fstatSync(fd)
      const linked = lstatSync(anchored(directory, name))
      this.#regular(after, maximum, expectedLinks)
      if (
        !linked.isFile() ||
        !sameInode(before, after) ||
        !sameInode(after, linked) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        denied()
      this.#assertLive(directory)
      return bytes
    } finally {
      closeSync(fd)
    }
  }

  #exclusive(directory: Directory, name: string, bytes: Uint8Array, mode = 0o400): void {
    this.#assertLive(directory)
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_RECORD_BYTES) denied()
    const fd = openSync(
      anchored(directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      let offset = 0
      while (offset < bytes.byteLength) {
        const count = this.#hooks.write
          ? this.#hooks.write(fd, bytes, offset, bytes.byteLength - offset)
          : writeSync(fd, bytes, offset, bytes.byteLength - offset, offset)
        if (!Number.isInteger(count) || count <= 0 || count > bytes.byteLength - offset) denied()
        offset += count
      }
      fchmodSync(fd, mode)
      fsyncSync(fd)
      const stat = fstatSync(fd)
      if (stat.size !== bytes.byteLength || !sameInode(stat, lstatSync(anchored(directory, name))))
        denied()
      this.#assertLive(directory)
    } finally {
      closeSync(fd)
    }
    fsyncSync(directory.fd)
    // Interrupted writes deliberately remain quarantined, never overwritten or treated as complete.
  }

  #names(directory: Directory): string[] {
    this.#assertLive(directory)
    const handle = opendirSync(`/proc/self/fd/${directory.fd}`)
    const names: string[] = []
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (names.length >= MAX_ENTRIES) denied()
        safeName(entry.name)
        names.push(entry.name)
      }
    } finally {
      handle.closeSync()
    }
    this.#assertLive(directory)
    return names.sort()
  }

  #validateBinding(design: DesignEnvelope, object: ArtifactDescriptor): void {
    // A Lease does not carry export sponsor IDs: the ledger authenticates that private cache key.
    const canonical = bindRequestSync(design, 'image', {
      principalId: 'object-check-principal',
      experimentId: 'object-check-experiment',
      scopes: ['images:read'],
    })
    if (
      !equal(canonical.identity, object.binding.identity) ||
      object.binding.revision !== canonical.revision ||
      (object.binding.purpose === 'image' && object.binding.cacheKey !== canonical.cacheKey) ||
      object.outputProfile !== design.outputProfile
    )
      denied()
  }

  #stageRecord(directory: Directory): StageRecord {
    const record = stageRecordSchema.parse(
      this.#unsigned(this.#readFile(directory, 'record.json', MAX_RECORD_BYTES)),
    )
    this.#validateBinding(record.design, record.stage.object)
    if (
      directory.name !== record.stage.stageId ||
      this.#stageId(record.stage.execution) !== record.stage.stageId
    )
      denied()
    return record
  }

  #stageId(execution: Lease['execution']): string {
    return sha256Bytes(Buffer.from(canonicalJson(executionIdentitySchema.parse(execution)))).slice(
      7,
    )
  }

  #checkBytes(object: ArtifactDescriptor, bytes: Uint8Array): void {
    if (bytes.byteLength !== object.byteLength || sha256Bytes(bytes) !== object.checksum) denied()
  }

  #objectRead(
    directory: Directory,
    filename: string,
    object: ArtifactDescriptor,
  ): { bytes: Uint8Array; record: ObjectRecord } {
    const record = objectRecordSchema.parse(
      this.#unsigned(this.#readFile(directory, `${filename}.json`, MAX_RECORD_BYTES)),
    )
    if (!equal(record.object, object)) denied()
    this.#validateBinding(record.design, object)
    const bytes = this.#readFile(directory, filename, MAX_BYTES)
    this.#checkBytes(object, bytes)
    return { bytes, record }
  }

  #stagePayload(
    directory: Directory,
    object: ArtifactDescriptor,
  ): { bytes: Uint8Array; linked: boolean } | null {
    let stat: Stats
    try {
      stat = lstatSync(anchored(directory, 'bytes.svg'))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    if (stat.nlink === 1)
      return { bytes: this.#readFile(directory, 'bytes.svg', MAX_BYTES), linked: false }
    this.#regular(stat, MAX_BYTES, 2)
    const parts = object.objectKey.split('/')
    const filename = parts.pop()!
    return this.#withDirectory(parts, false, (published) => {
      const final = lstatSync(anchored(published, filename))
      this.#regular(final, MAX_BYTES, 2)
      if (!sameInode(stat, final)) denied()
      const bytes = this.#readFile(directory, 'bytes.svg', MAX_BYTES, 2)
      this.#checkBytes(object, bytes)
      if (
        !Buffer.from(bytes).equals(Buffer.from(this.#readFile(published, filename, MAX_BYTES, 2)))
      )
        denied()
      return { bytes, linked: true }
    })
  }

  async stage(leaseInput: Lease, artifactInput: MockArtifact): Promise<StagedObject> {
    try {
      this.#assertLive()
      const lease = leaseSchema.parse(leaseInput)
      const now = timestampSchema.parse(this.#now())
      if (
        now >= lease.deadline ||
        now >= lease.leaseUntil ||
        lease.execution.attempt > lease.policy.maxAttempts
      )
        denied()
      const artifact = await verifyDiagnosticArtifact(
        artifactInput,
        lease.design,
        lease.policy.maxOutputBytes,
      )
      const object = describeArtifact(artifact, lease.design, lease.binding)
      this.#validateBinding(lease.design, object)
      const bytes = diagnosticBytes(artifact)
      const stage: StagedObject = {
        stageId: this.#stageId(lease.execution),
        execution: lease.execution,
        object,
        stagedAt: now,
      }
      return this.#withDirectory(['stages', stage.stageId], true, (directory) => {
        const names = this.#names(directory)
        if (names.length !== 0) {
          const existing = this.#stageRecord(directory)
          if (
            !equal({ ...existing.stage, stagedAt: now }, stage) ||
            !equal(existing.design, lease.design)
          )
            denied()
          try {
            this.#checkBytes(object, this.#readFile(directory, 'bytes.svg', MAX_BYTES))
          } catch (error) {
            if (!isMissing(error)) throw error
            const parts = object.objectKey.split('/')
            const filename = parts.pop()!
            this.#withDirectory(parts, false, (published) =>
              this.#objectRead(published, filename, object),
            )
          }
          return existing.stage
        }
        this.#hooks.at?.('before-stage-write')
        this.#exclusive(directory, 'bytes.svg', bytes)
        this.#exclusive(directory, 'record.json', this.#signed({ stage, design: lease.design }))
        this.#checkBytes(object, this.#readFile(directory, 'bytes.svg', MAX_BYTES))
        this.#assertLive(directory)
        return stage
      })
    } catch {
      return denied()
    }
  }

  async publish(stagedInput: StagedObject): Promise<VerifiedObject> {
    try {
      const staged = stageSchema.parse(stagedInput)
      // Copy the authenticated stage before the only await, then reread it afterwards.
      const initial = this.#withDirectory(['stages', staged.stageId], false, (directory) =>
        this.#stageRecord(directory),
      )
      if (!equal(initial.stage, staged)) denied()
      const expected = await createMockArtifact(initial.design)
      if (!equal(describeArtifact(expected, initial.design, staged.object.binding), staged.object))
        denied()
      return this.#withDirectory(['stages', staged.stageId], false, (stageDirectory) => {
        if (!equal(this.#stageRecord(stageDirectory), initial)) denied()
        const parts = staged.object.objectKey.split('/')
        const filename = parts.pop()!
        const payload = this.#stagePayload(stageDirectory, staged.object)
        const bytes =
          payload?.bytes ??
          this.#withDirectory(
            parts,
            false,
            (published) => this.#objectRead(published, filename, staged.object).bytes,
          )
        this.#checkBytes(staged.object, bytes)
        if (!Buffer.from(bytes).equals(Buffer.from(diagnosticBytes(expected)))) denied()
        return this.#withDirectory(parts, true, (directory) => {
          const recordBytes = this.#signed({ object: staged.object, design: initial.design })
          try {
            this.#exclusive(directory, `${filename}.json`, recordBytes)
          } catch (error) {
            if (!existsError(error)) throw error
            if (
              !Buffer.from(this.#readFile(directory, `${filename}.json`, MAX_RECORD_BYTES)).equals(
                Buffer.from(recordBytes),
              )
            )
              denied()
          }
          // link(2) is create-if-absent, never rename-overwrite. The payload has only one
          // inode throughout publication: no second maxOutputBytes allocation is needed.
          if (payload) {
            this.#hooks.at?.('before-publish-link')
            this.#assertLive(directory)
            const current = this.#stagePayload(stageDirectory, staged.object)
            if (!current || current.linked !== payload.linked) denied()
            this.#checkBytes(staged.object, current.bytes)
            if (!current.linked) {
              try {
                linkSync(anchored(stageDirectory, 'bytes.svg'), anchored(directory, filename))
              } catch (error) {
                if (!existsError(error)) throw error
                this.#objectRead(directory, filename, staged.object) // Collision must not consume the stage.
              }
            }
            this.#hooks.at?.('after-create-link')
            this.#assertLive(stageDirectory)
            this.#assertLive(directory)
            fsyncSync(directory.fd) // Persist the destination name before dropping the source name.
            unlinkSync(anchored(stageDirectory, 'bytes.svg'))
            fsyncSync(stageDirectory.fd)
          }
          fsyncSync(directory.fd)
          this.#hooks.at?.('after-publish-link')
          const result = this.#objectRead(directory, filename, staged.object)
          if (!Buffer.from(result.bytes).equals(Buffer.from(bytes))) denied()
          this.#hooks.at?.('before-receipt')
          this.#objectRead(directory, filename, staged.object)
          this.#assertLive(stageDirectory)
          this.#assertLive(directory)
          const receipt = signVerifiedObject(
            {
              stageId: staged.stageId,
              execution: staged.execution,
              object: staged.object,
              verifiedAt: timestampSchema.parse(this.#now()),
            },
            this.#secret,
          )
          // Keep only the small signed stage record as a durable idempotency tombstone.
          // Payload is removed from staging; retention can remove the tombstone explicitly.
          return receipt
        })
      })
    } catch {
      return denied()
    }
  }

  async verify(input: ArtifactDescriptor, designInput: DesignEnvelope): Promise<boolean> {
    try {
      const object = artifactDescriptorSchema.parse(input)
      const design = designEnvelopeSchema.parse(designInput)
      this.#validateBinding(design, object)
      const expected = await createMockArtifact(design)
      if (!equal(describeArtifact(expected, design, object.binding), object)) return false
      const bytes = await this.read(object)
      return Buffer.from(bytes).equals(Buffer.from(diagnosticBytes(expected)))
    } catch {
      return false
    }
  }

  async read(input: ArtifactDescriptor): Promise<Uint8Array> {
    try {
      const object = artifactDescriptorSchema.parse(input)
      const parts = object.objectKey.split('/')
      const filename = parts.pop()!
      return this.#withDirectory(parts, false, (directory) => {
        this.#hooks.at?.('before-read')
        return this.#objectRead(directory, filename, object).bytes
      })
    } catch {
      return denied()
    }
  }

  /** Trusted ledger caller MUST expire availability and exclude all live references first. */
  async delete(input: ArtifactDescriptor): Promise<boolean> {
    try {
      const object = artifactDescriptorSchema.parse(input)
      const parts = object.objectKey.split('/')
      const filename = parts.pop()!
      return this.#withDirectory(parts, false, (directory) => {
        // Even absence is accepted only after the namespace/descriptor has been validated.
        try {
          this.#objectRead(directory, filename, object)
        } catch (error) {
          if (!isMissing(error)) throw error
          const names = this.#names(directory)
          if (names.includes(filename)) denied()
        }
        this.#hooks.at?.('before-delete')
        this.#assertLive(directory)
        if (this.#names(directory).includes(filename)) this.#objectRead(directory, filename, object)
        for (const name of [filename, `${filename}.json`]) {
          try {
            const stat = lstatSync(anchored(directory, name))
            this.#regular(stat, name === filename ? MAX_BYTES : MAX_RECORD_BYTES)
            unlinkSync(anchored(directory, name))
          } catch (error) {
            if (!isMissing(error)) throw error
          }
        }
        fsyncSync(directory.fd)
        this.#assertLive(directory)
        return true
      })
    } catch (error) {
      if (isMissing(error)) {
        try {
          this.#assertLive()
          return true
        } catch {
          return denied()
        }
      }
      return denied()
    }
  }

  async removeStage(stageIdInput: string): Promise<boolean> {
    try {
      const stageId = opaqueIdSchema.parse(stageIdInput)
      return this.#removeStage(stageId)
    } catch (error) {
      if (isMissing(error)) {
        try {
          this.#assertLive()
          return true
        } catch {
          return denied()
        }
      }
      return denied()
    }
  }

  #removeStage(stageId: string): boolean {
    return this.#withDirectory(['stages'], false, (parent) => {
      const directory = this.#directory(parent, stageId)
      try {
        this.#stageRecord(directory) // Unknown/incomplete metadata is pinned, not guessed safe.
        const names = this.#names(directory)
        if (names.some((name) => !['record.json', 'bytes.svg'].includes(name))) denied()
        for (const name of ['bytes.svg', 'record.json']) {
          try {
            this.#regular(
              lstatSync(anchored(directory, name)),
              name === 'bytes.svg' ? MAX_BYTES : MAX_RECORD_BYTES,
            )
            unlinkSync(anchored(directory, name))
          } catch (error) {
            if (!isMissing(error)) throw error
          }
        }
        fsyncSync(directory.fd)
        this.#assertLive(directory)
        rmdirSync(anchored(parent, stageId))
        fsyncSync(parent.fd)
        this.#assertLive(parent)
        return true
      } finally {
        closeDirectory(directory)
      }
    })
  }

  async recover(
    referencedInput: readonly string[],
    activeInput: readonly string[],
    beforeInput: number,
  ): Promise<ObjectRecoveryReport> {
    try {
      this.#assertLive()
      const references = new Set(z.array(objectKeySchema).max(1536).parse(referencedInput))
      const active = new Set(z.array(opaqueIdSchema).max(1536).parse(activeInput))
      const before = timestampSchema.parse(beforeInput)
      if (before > timestampSchema.parse(this.#now())) denied()
      let removedStages = 0
      const orphanObjects: string[] = []
      let visited = 0
      const inventory = (directory: Directory): string[] => {
        const names = this.#names(directory)
        visited += names.length
        if (visited > 8192) denied()
        return names
      }
      const rootNames = inventory(this.#root)
      if (rootNames.some((name) => !['.store.json', 'stages', 'p04'].includes(name))) denied()
      if (rootNames.includes('stages'))
        this.#withDirectory(['stages'], false, (directory) => {
          for (const stageId of inventory(directory)) {
            opaqueIdSchema.parse(stageId)
            const record = this.#withDirectory(['stages', stageId], false, (stageDirectory) => {
              // A partially written/unverifiable stage has unknown ownership: preserve it.
              try {
                return this.#stageRecord(stageDirectory)
              } catch {
                return null
              }
            })
            if (
              record &&
              record.stage.stagedAt < before &&
              !active.has(record.stage.execution.executionId) &&
              !references.has(record.stage.object.objectKey)
            ) {
              if (this.#removeStage(stageId)) removedStages++
            }
          }
        })
      if (rootNames.includes('p04'))
        this.#withDirectory(['p04'], false, (p04) => {
          for (const visibility of inventory(p04)) {
            if (!['public', 'private'].includes(visibility)) denied()
            this.#withDirectory(['p04', visibility], false, (scope) => {
              for (const cacheKey of inventory(scope)) {
                if (!/^[a-f0-9]{64}$/.test(cacheKey)) denied()
                this.#withDirectory(['p04', visibility, cacheKey], false, (objects) => {
                  for (const filename of inventory(objects)) {
                    if (!/^[a-f0-9]{64}(\.svg(\.json)?|\.pending)$/.test(filename)) denied()
                    if (!filename.endsWith('.svg')) continue // Incomplete publication remains pinned.
                    const key = objectKeySchema.parse(`p04/${visibility}/${cacheKey}/${filename}`)
                    const record = objectRecordSchema.parse(
                      this.#unsigned(this.#readFile(objects, `${filename}.json`, MAX_RECORD_BYTES)),
                    )
                    if (record.object.objectKey !== key) denied()
                    this.#objectRead(objects, filename, record.object)
                    if (!references.has(key)) {
                      if (orphanObjects.length >= 1536) denied()
                      orphanObjects.push(key)
                    }
                  }
                })
              }
            })
          }
        })
      return { removedStages, orphanObjects: orphanObjects.sort() }
    } catch {
      return denied()
    }
  }
}

/** Authenticated local delivery only; public identity is not public caching authorization. */
export function localObjectResponseHeaders(
  input: ArtifactDescriptor,
): Readonly<Record<string, string>> {
  const object = artifactDescriptorSchema.parse(input)
  return Object.freeze({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': String(object.byteLength),
    ETag: `"${object.checksum}"`,
    'Content-Digest': `sha-256=:${Buffer.from(object.checksum.slice(7), 'hex').toString('base64')}:`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition':
      object.binding.purpose === 'export' ? 'attachment; filename="mock-diagnostic.svg"' : 'inline',
    Vary: 'Authorization, Cookie',
  })
}
