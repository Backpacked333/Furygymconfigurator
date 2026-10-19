import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultDesign, parseDesign, type DesignEnvelope } from '../../domain/design'
import { createMockArtifact } from '../protocol'
import {
  bindRequestSync,
  diagnosticBytes,
  sha256Bytes,
  verifyObjectReceipt,
  worstCaseQuote,
  policySchema,
  type AuthContext,
  type Lease,
  type MockArtifact,
  type Purpose,
} from './contracts'
import { FileObjectStore, localObjectResponseHeaders, type ObjectStoreTestHooks } from './objects'

// All disposable filesystem state stays in the assigned P04 handoff lane.
import { TEST_ROOT as HANDOFF } from './testPaths'
const auth: AuthContext = {
  principalId: 'objects-test-principal',
  experimentId: 'objects-test-experiment',
  scopes: ['images:read', 'images:write', 'exports:write'],
}
let sandbox: string
let root: string
let secret: string
let now: number
let sequence: number
let stores: FileObjectStore[]

beforeEach(() => {
  sandbox = mkdtempSync(join(HANDOFF, 'objects-test-'))
  root = join(sandbox, 'store')
  secret = randomBytes(48).toString('base64url')
  now = 10_000
  sequence = 0
  stores = []
})
afterEach(() => {
  for (const store of stores) store.close()
  rmSync(sandbox, { recursive: true, force: true })
})
function open(hooks: ObjectStoreTestHooks = {}, path = root, key = secret): FileObjectStore {
  const store = new FileObjectStore({ root: path, objectSecret: key, now: () => now }, hooks)
  stores.push(store)
  return store
}
function lease(
  purpose: Purpose = 'image',
  design: DesignEnvelope = defaultDesign(),
  owner = auth,
): Lease {
  const id = String(++sequence).padStart(20, '0')
  const policy = policySchema.parse({})
  return {
    execution: {
      provider: 'fake-local',
      executionId: `execution_${id}`,
      jobId: `job_${id}`,
      fence: 1,
      attempt: 1,
    },
    workerId: 'objects-test-worker',
    design,
    binding: bindRequestSync(design, purpose, owner),
    quote: worstCaseQuote(policy),
    policy,
    leaseUntil: 20_000,
    deadline: 30_000,
  }
}
async function prepared(store = open(), execution = lease()) {
  const artifact = await createMockArtifact(execution.design)
  const stage = await store.stage(execution, artifact)
  return { store, execution, artifact, stage }
}
async function published(store = open(), execution = lease()) {
  const result = await prepared(store, execution)
  const receipt = await store.publish(result.stage)
  return {
    ...result,
    receipt,
    object: receipt.claims.object,
    file: join(root, receipt.claims.object.objectKey),
  }
}
function rewrite(path: string, data: string | Uint8Array): void {
  chmodSync(path, 0o600)
  writeFileSync(path, data)
  chmodSync(path, 0o400)
}
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) => {
    const full = join(path, item.name)
    return item.isDirectory() ? files(full) : [full]
  })
}
const unavailable = { status: 503, code: 'store-unavailable' }

describe('immutable local diagnostic object boundary', () => {
  it('verifies and durably publishes bounded labelled bytes, signs execution proof, and reopens', async () => {
    const { store, execution, artifact, stage, receipt, object, file } = await published()
    expect(verifyObjectReceipt(receipt, secret)).toEqual(receipt.claims)
    expect(receipt.claims.execution).toEqual(execution.execution)
    expect(receipt.claims.stageId).toBe(stage.stageId)
    expect(object).toMatchObject({
      kind: 'mock-diagnostic',
      approvedCurrentImage: false,
      strictExport: false,
      productionAllowed: false,
    })
    expect(Buffer.from(await store.read(object))).toEqual(Buffer.from(diagnosticBytes(artifact)))
    expect(await store.verify(object, execution.design)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o400)
    expect(statSync(file).nlink).toBe(1)
    expect(existsSync(join(root, 'stages', stage.stageId, 'bytes.svg'))).toBe(false)
    expect(existsSync(join(root, 'stages', stage.stageId, 'record.json'))).toBe(true)
    store.close()
    const reopened = open()
    expect(await reopened.verify(object, execution.design)).toBe(true)
    expect(await reopened.publish(stage)).toEqual(receipt)
  })

  it('coalesces duplicate stage calls and same-key concurrent publications without overwrite', async () => {
    const first = open()
    const second = open()
    const execution = lease()
    const artifact = await createMockArtifact(execution.design)
    const [a, b] = await Promise.all([
      first.stage(execution, artifact),
      second.stage(execution, artifact),
    ])
    expect(a).toEqual(b)
    const initial = await first.publish(a)
    const inode = statSync(join(root, initial.claims.object.objectKey)).ino
    const otherExecution = lease()
    const other = await second.stage(otherExecution, artifact)
    const receipts = await Promise.all([first.publish(a), second.publish(other), first.publish(a)])
    expect(new Set(receipts.map((receipt) => receipt.claims.object.objectKey)).size).toBe(1)
    expect(statSync(join(root, initial.claims.object.objectKey)).ino).toBe(inode)
    expect(await first.stage(execution, artifact)).toEqual(a)
  })

  it('isolates exports by principal and experiment, never using a public shared key', async () => {
    const store = open()
    const a = await published(store, lease('image'))
    const b = await published(store, lease('export'))
    const c = await published(
      store,
      lease('export', defaultDesign(), { ...auth, principalId: 'other-test-principal' }),
    )
    const d = await published(
      store,
      lease('export', defaultDesign(), { ...auth, experimentId: 'other-test-experiment' }),
    )
    expect(new Set([a, b, c, d].map(({ object }) => object.objectKey)).size).toBe(4)
    expect(new Set([a, b, c, d].map(({ object }) => object.checksum)).size).toBe(1)
    expect(a.object.objectKey).toMatch(/^p04\/public\//)
    for (const item of [b, c, d]) expect(item.object.objectKey).toMatch(/^p04\/private\//)
  })

  it('binds profile, presentation, generator and revision to deterministic delivery identity', async () => {
    const store = open()
    const hero = await published(store)
    const design = parseDesign({ ...defaultDesign(), outputProfile: 'web-thumbnail' })
    const thumb = await published(store, lease('image', design))
    expect(thumb.object.objectKey).not.toBe(hero.object.objectKey)
    expect(thumb.object.width).not.toBe(hero.object.width)
    expect(thumb.object.binding.revision).not.toBe(hero.object.binding.revision)
    expect(await store.verify(hero.object, design)).toBe(false)
    expect(await store.verify(thumb.object, design)).toBe(true)
  })

  it('supplies checksum/ETag metadata but no public caching, URLs, credentials or export promises', async () => {
    const { object } = await published()
    const headers = localObjectResponseHeaders(object)
    expect(headers.ETag).toBe(`"${object.checksum}"`)
    expect(headers['Content-Digest']).toContain(
      Buffer.from(object.checksum.slice(7), 'hex').toString('base64'),
    )
    expect(headers['Cache-Control']).toBe('private, no-store')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Content-Security-Policy']).toContain('sandbox')
    const exported = await published(open(), lease('export'))
    expect(localObjectResponseHeaders(exported.object)['Content-Disposition']).toContain(
      'mock-diagnostic.svg',
    )
    const persisted = files(root)
      .map((file) => readFileSync(file).toString('utf8'))
      .join('\n')
    expect(persisted).not.toContain(secret)
    expect(JSON.stringify(headers)).not.toContain(secret)
    expect(JSON.stringify(headers)).not.toMatch(/https?:|signedUrl|photoreal|\.pdf/)
  })
})

describe('verification and immutable collision failures', () => {
  it.each([
    'width',
    'height',
    'byteLength',
    'mediaType',
    'checksum',
    'src',
    'provenance',
    'unknown',
  ])('rejects malformed or altered artifact %s before any stage write', async (field) => {
    const store = open()
    const execution = lease()
    const original = await createMockArtifact(execution.design)
    const changes: Record<string, unknown> = {
      width: original.width - 1,
      height: original.height - 1,
      byteLength: original.byteLength - 1,
      mediaType: 'image/png',
      checksum: `sha256:${'f'.repeat(64)}`,
      src: original.src.replace('svg', 'html'),
      provenance: { ...original.provenance, productionAllowed: true },
      unknown: 'rejected',
    }
    await expect(
      store.stage(execution, { ...original, [field]: changes[field] } as MockArtifact),
    ).rejects.toMatchObject(unavailable)
    expect(files(root)).toEqual([join(root, '.store.json')])
  })

  it('rejects self-consistent hashes of arbitrary scripts instead of trusting MIME/checksum', async () => {
    const store = open()
    const execution = lease()
    const original = await createMockArtifact(execution.design)
    const payload = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    const checksum = sha256Bytes(payload)
    const forged = {
      ...original,
      checksum,
      artifactId: checksum,
      byteLength: payload.length,
      src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload.toString())}`,
    }
    await expect(store.stage(execution, forged)).rejects.toMatchObject(unavailable)
  })

  it('enforces lease byte caps, expiry, attempts, strict fields and canonical public binding', async () => {
    const store = open()
    const execution = lease()
    const artifact = await createMockArtifact(execution.design)
    const badLeases: unknown[] = [
      { ...execution, policy: { ...execution.policy, maxOutputBytes: 1 } },
      { ...execution, leaseUntil: now },
      { ...execution, deadline: now },
      {
        ...execution,
        policy: { ...execution.policy, maxAttempts: 1 },
        execution: { ...execution.execution, attempt: 2 },
      },
      { ...execution, command: 'forbidden' },
      { ...execution, binding: { ...execution.binding, cacheKey: `sha256:${'0'.repeat(64)}` } },
      {
        ...execution,
        binding: {
          ...execution.binding,
          identity: { ...execution.binding.identity, designDigest: `sha256:${'0'.repeat(64)}` },
        },
      },
    ]
    for (const bad of badLeases)
      await expect(store.stage(bad as Lease, artifact)).rejects.toMatchObject(unavailable)
  })

  it('will not rebind one execution stage to a different artifact or forged stage metadata', async () => {
    const { store, stage, execution } = await prepared()
    await expect(store.publish({ ...stage, stagedAt: stage.stagedAt + 1 })).rejects.toMatchObject(
      unavailable,
    )
    await expect(
      store.publish({ ...stage, execution: { ...stage.execution, fence: 2 } }),
    ).rejects.toMatchObject(unavailable)
    const design = parseDesign({ ...execution.design, outputProfile: 'web-thumbnail' })
    await expect(
      store.stage(
        { ...execution, design, binding: bindRequestSync(design, 'image', auth) },
        await createMockArtifact(design),
      ),
    ).rejects.toMatchObject(unavailable)
  })

  it('rejects tampered on-disk stage bytes and metadata without an object receipt', async () => {
    const a = await prepared()
    rewrite(join(root, 'stages', a.stage.stageId, 'bytes.svg'), 'corrupt')
    await expect(a.store.publish(a.stage)).rejects.toMatchObject(unavailable)
    const b = await prepared(a.store)
    const path = join(root, 'stages', b.stage.stageId, 'record.json')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    record.payload.stage.stagedAt++
    rewrite(path, JSON.stringify(record))
    await expect(b.store.publish(b.stage)).rejects.toMatchObject(unavailable)
    expect(existsSync(join(root, a.stage.object.objectKey))).toBe(false)
  })

  it.each(['truncated', 'same-length', 'oversized', 'writable', 'descriptor', 'manifest'])(
    'rejects %s object tampering for reads, verifies and publication replay',
    async (kind) => {
      const { store, object, execution, file, stage } = await published()
      let descriptor = object
      if (kind === 'truncated') rewrite(file, 'bad')
      if (kind === 'same-length') rewrite(file, Buffer.alloc(object.byteLength, 65))
      if (kind === 'oversized') rewrite(file, Buffer.alloc(12 * 1024 + 1))
      if (kind === 'writable') chmodSync(file, 0o600)
      if (kind === 'descriptor') descriptor = { ...object, width: object.width - 1 }
      if (kind === 'manifest') rewrite(`${file}.json`, '{}')
      await expect(store.read(descriptor)).rejects.toMatchObject(unavailable)
      expect(await store.verify(descriptor, execution.design)).toBe(false)
      if (kind !== 'descriptor')
        await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    },
  )

  it('never overwrites an immutable collision, even to repair corrupt bytes', async () => {
    const { store, object, file } = await published()
    rewrite(file, 'immutable collision')
    const before = statSync(file).ino
    const second = await prepared(store)
    await expect(store.publish(second.stage)).rejects.toMatchObject(unavailable)
    expect(readFileSync(file, 'utf8')).toBe('immutable collision')
    expect(statSync(file).ino).toBe(before)
    expect(existsSync(join(root, 'stages', second.stage.stageId, 'bytes.svg'))).toBe(true)
    await expect(store.delete(object)).rejects.toMatchObject(unavailable)
  })
})

describe('path confinement and pinned-directory race handling', () => {
  it('rejects relative/traversal roots, symlink roots/ancestors, weak keys and changed restart keys', () => {
    const target = join(sandbox, 'target')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, root, 'dir')
    expect(() => open()).toThrow(/safely/)
    expect(() => open({}, join(root, 'nested'))).toThrow(/safely/)
    unlinkSync(root)
    for (const path of ['relative', `${sandbox}/../store`, '/'])
      expect(() => open({}, path)).toThrow(/safely/)
    expect(() => open({}, root, 'short')).toThrow(/safely/)
    open().close()
    expect(() => open({}, root, randomBytes(40).toString('hex'))).toThrow(/safely/)
  })

  it('refuses adoption of nonempty, unmarked or group-writable roots', () => {
    mkdirSync(root, { mode: 0o700 })
    writeFileSync(join(root, 'unowned'), 'do not touch')
    expect(() => open()).toThrow(/safely/)
    expect(readFileSync(join(root, 'unowned'), 'utf8')).toBe('do not touch')
    rmSync(join(root, 'unowned'))
    chmodSync(root, 0o770)
    expect(() => open()).toThrow(/safely/)
  })

  it.each([
    '../../outside',
    '/etc/passwd',
    'https://example.invalid/a.svg',
    'p04/public/%2e%2e/a.svg',
    'p04/public/../a.svg',
  ])('rejects caller-selected path/URL %s', async (objectKey) => {
    const { store, object } = await published()
    await expect(store.read({ ...object, objectKey })).rejects.toMatchObject(unavailable)
    await expect(store.delete({ ...object, objectKey })).rejects.toMatchObject(unavailable)
    await expect(store.removeStage(objectKey)).rejects.toMatchObject(unavailable)
  })

  it('refuses symlink files, nonregular files and symlink namespace directories', async () => {
    const { store, object, file } = await published()
    const outside = join(sandbox, 'outside')
    writeFileSync(outside, 'untouched')
    unlinkSync(file)
    symlinkSync(outside, file)
    await expect(store.read(object)).rejects.toMatchObject(unavailable)
    await expect(store.delete(object)).rejects.toMatchObject(unavailable)
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
    unlinkSync(file)
    mkdirSync(file)
    await expect(store.read(object)).rejects.toMatchObject(unavailable)
    rmSync(file, { recursive: true })
    const namespace = join(root, 'p04', 'public')
    renameSync(namespace, `${namespace}-held`)
    symlinkSync(sandbox, namespace, 'dir')
    await expect(store.read(object)).rejects.toMatchObject(unavailable)
    await expect(store.delete(object)).rejects.toMatchObject(unavailable)
  })

  it('rejects extra hardlinks without altering the aliased outside file', async () => {
    const { store, object, file } = await published()
    const outside = join(sandbox, 'aliased')
    linkSync(file, outside)
    const original = readFileSync(outside)
    await expect(store.read(object)).rejects.toMatchObject(unavailable)
    await expect(store.delete(object)).rejects.toMatchObject(unavailable)
    expect(readFileSync(outside)).toEqual(original)
    expect(statSync(outside).nlink).toBe(2)
  })

  it('refuses a symlink stage directory without following or cleaning its target', async () => {
    const { store, stage } = await prepared()
    const directory = join(root, 'stages', stage.stageId)
    renameSync(directory, `${directory}-held`)
    symlinkSync(sandbox, directory, 'dir')
    await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    await expect(store.removeStage(stage.stageId)).rejects.toMatchObject(unavailable)
    expect(lstatSync(directory).isSymbolicLink()).toBe(true)
  })

  it('rejects root replacement while open and after pure verification awaits', async () => {
    const { store, stage, artifact, execution } = await prepared()
    renameSync(root, `${root}-held`)
    mkdirSync(root, { mode: 0o700 })
    await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    await expect(store.stage(execution, artifact)).rejects.toMatchObject(unavailable)
    await expect(store.recover([], [], now)).rejects.toMatchObject(unavailable)
    expect(readdirSync(root)).toEqual([])
  })

  it('pins directory inodes and refuses a directory-to-symlink swap before final link', async () => {
    const outside = join(sandbox, 'outside')
    mkdirSync(outside, { mode: 0o700 })
    const store = open({
      at: (point) => {
        if (point !== 'before-publish-link') return
        const directory = join(root, 'p04', 'public', stage.object.binding.cacheKey.slice(7))
        renameSync(directory, `${directory}-held`)
        symlinkSync(outside, directory, 'dir')
      },
    })
    const { stage } = await prepared(store)
    await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(root, 'stages', stage.stageId, 'bytes.svg'))).toBe(true)
  })

  it('rejects tampering at final readback/receipt and at deletion boundary', async () => {
    let armed = false
    const store = open({
      at: (point) => {
        if (armed && (point === 'before-receipt' || point === 'before-delete'))
          rewrite(join(root, object.objectKey), 'changed')
      },
    })
    const { stage } = await prepared(store)
    const object = stage.object
    armed = true
    await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    await expect(store.delete(object)).rejects.toMatchObject(unavailable)
    expect(readFileSync(join(root, object.objectKey), 'utf8')).toBe('changed')
  })
})

describe('failure, recovery and conservative retention', () => {
  it('fails closed on denied filesystem reads and writes without leaking OS details', async () => {
    const { store, object, file, execution } = await published()
    chmodSync(file, 0o000)
    await expect(store.read(object)).rejects.toMatchObject(unavailable)
    expect(await store.verify(object, execution.design)).toBe(false)
    chmodSync(file, 0o400)
    chmodSync(join(root, 'stages'), 0o500)
    const next = lease()
    await expect(store.stage(next, await createMockArtifact(next.design))).rejects.toMatchObject(
      unavailable,
    )
    chmodSync(join(root, 'stages'), 0o700)
    expect(await store.verify(object, execution.design)).toBe(true)
  })

  it('fails closed after closure without deleting or resetting durable state', async () => {
    const { store, object, stage, artifact, execution } = await published()
    store.close()
    store.close()
    await expect(store.read(object)).rejects.toMatchObject(unavailable)
    expect(await store.verify(object, execution.design)).toBe(false)
    await expect(store.stage(execution, artifact)).rejects.toMatchObject(unavailable)
    await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    await expect(store.delete(object)).rejects.toMatchObject(unavailable)
    await expect(store.removeStage(stage.stageId)).rejects.toMatchObject(unavailable)
    await expect(store.recover([], [], now)).rejects.toMatchObject(unavailable)
    expect(await open().verify(object, execution.design)).toBe(true)
  })

  it('handles partial writes until complete, but zero-write and disk failures never publish', async () => {
    const store = open({
      write: (fd, bytes, offset, length) =>
        writeSync(fd, bytes, offset, Math.min(length, 7), offset),
    })
    const complete = await published(store)
    expect(await store.verify(complete.object, complete.execution.design)).toBe(true)
    let fail = false
    const failed = open({
      write: (fd, bytes, offset, length) => {
        if (fail && offset > 0)
          throw Object.assign(new Error(`synthetic ENOSPC ${secret}`), { code: 'ENOSPC' })
        return writeSync(fd, bytes, offset, Math.min(length, 9), offset)
      },
    })
    fail = true
    const execution = lease()
    const artifact = await createMockArtifact(execution.design)
    await expect(failed.stage(execution, artifact)).rejects.toMatchObject(unavailable)
    try {
      await failed.stage(execution, artifact)
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
    now++
    expect(
      (
        await store.recover(
          [complete.object.objectKey],
          [complete.execution.execution.executionId],
          now,
        )
      ).removedStages,
    ).toBe(0)
    expect(files(root).some((path) => path.endsWith('bytes.svg'))).toBe(true) // unknown partial preserved
    let zero = false
    const zeroStore = open({
      write: (fd, bytes, offset, length) =>
        zero ? 0 : writeSync(fd, bytes, offset, length, offset),
    })
    zero = true
    await expect(zeroStore.stage(lease(), artifact)).rejects.toMatchObject(unavailable)
  })

  it('recovers an interrupted same-inode link publication without copying or overwriting payload', async () => {
    const store = open({
      at: (point) => {
        if (point === 'after-create-link') throw new Error('simulated interrupted unlink')
      },
    })
    const { stage } = await prepared(store)
    await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    const stagedFile = join(root, 'stages', stage.stageId, 'bytes.svg')
    const finalFile = join(root, stage.object.objectKey)
    const inode = statSync(stagedFile).ino
    expect(statSync(finalFile).ino).toBe(inode)
    expect(statSync(finalFile).nlink).toBe(2)
    await expect(store.read(stage.object)).rejects.toMatchObject(unavailable)
    store.close()
    const reopened = open()
    const receipt = await reopened.publish(stage)
    expect(verifyObjectReceipt(receipt, secret).object).toEqual(stage.object)
    expect(statSync(finalFile).ino).toBe(inode)
    expect(statSync(finalFile).nlink).toBe(1)
    expect(existsSync(stagedFile)).toBe(false)
  })

  it('retains an orphan after final-object write failure and never infers DB readiness', async () => {
    let fail = true
    const store = open({
      at: (point) => {
        if (point === 'after-publish-link' && fail)
          throw new Error('simulated crash before DB publication')
      },
    })
    const { stage } = await prepared(store)
    await expect(store.publish(stage)).rejects.toMatchObject(unavailable)
    expect(existsSync(join(root, stage.object.objectKey))).toBe(true)
    const report = await store.recover([], [stage.execution.executionId], now + 0)
    expect(report).toEqual({ removedStages: 0, orphanObjects: [stage.object.objectKey] })
    expect(existsSync(join(root, stage.object.objectKey))).toBe(true)
    fail = false
    const receipt = await store.publish(stage)
    expect(verifyObjectReceipt(receipt, secret).object).toEqual(stage.object)
    // Object receipts alone have no ability to mutate a job state.
    expect(Object.keys(receipt)).toEqual(['claims', 'signature'])
  })

  it('retains referenced objects, active/unknown stages and recent stages; reports only final orphans', async () => {
    const store = open()
    const pinned = await published(store)
    const orphan = await published(store, lease('export'))
    const active = await prepared(store, lease('export'))
    const old = await prepared(store, lease('export'))
    now += 10
    const recent = await prepared(store, lease('export'))
    const report = await store.recover(
      [pinned.object.objectKey],
      [active.execution.execution.executionId],
      now,
    )
    expect(report.removedStages).toBe(2) // orphan tombstone and safely old unstarted stage
    expect(report.orphanObjects).toEqual([orphan.object.objectKey])
    expect(existsSync(join(root, 'stages', pinned.stage.stageId))).toBe(true)
    expect(existsSync(join(root, 'stages', active.stage.stageId))).toBe(true)
    expect(existsSync(join(root, 'stages', old.stage.stageId))).toBe(false)
    expect(existsSync(join(root, 'stages', recent.stage.stageId))).toBe(true)
    expect(existsSync(orphan.file)).toBe(true)
  })

  it('retains all stages sharing a referenced immutable key even across executions', async () => {
    const store = open()
    const ready = await published(store)
    const duplicate = await prepared(store)
    now++
    const report = await store.recover([ready.object.objectKey], [], now)
    expect(report).toEqual({ removedStages: 0, orphanObjects: [] })
    expect(existsSync(join(root, 'stages', duplicate.stage.stageId, 'bytes.svg'))).toBe(true)
  })

  it('rejects unavailable/malformed/oversized reference snapshots and future cutoffs before sweeping', async () => {
    const { store, stage } = await prepared()
    now++
    const invalid: [readonly string[], readonly string[], number][] = [
      [null as unknown as string[], [], now],
      [['../outside'], [], now],
      [[], ['bad'], now],
      [[], [], now + 1],
      [[], [], -1],
      [Array(1537).fill(stage.object.objectKey), [], now],
    ]
    for (const args of invalid)
      await expect(store.recover(...args)).rejects.toMatchObject(unavailable)
    expect(existsSync(join(root, 'stages', stage.stageId))).toBe(true)
  })

  it('explicit trusted deletion and stage removal are idempotent, never recursive or a refund', async () => {
    const { store, object, stage, file } = await published()
    // A healthy ledger is required to expire availability and rule out live references first.
    expect(await store.delete(object)).toBe(true)
    expect(await store.delete(object)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.json`)).toBe(false)
    expect(await store.removeStage(stage.stageId)).toBe(true)
    expect(await store.removeStage(stage.stageId)).toBe(true)
    expect(existsSync(join(root, '.store.json'))).toBe(true)
    const other = await prepared(store)
    writeFileSync(join(root, 'stages', other.stage.stageId, 'foreign'), 'preserve')
    await expect(store.removeStage(other.stage.stageId)).rejects.toMatchObject(unavailable)
    expect(existsSync(join(root, 'stages', other.stage.stageId, 'foreign'))).toBe(true)
  })
})
