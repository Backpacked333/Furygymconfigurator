import LZString from 'lz-string'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  configSchema,
  decodeConfig,
  encodeConfig,
  initialConfig,
  inspectConfig,
  type Config,
} from './config'
import { boundedDecompress, DOCUMENT_LIMITS } from './documentCodec'
import { DraftPersistence, initializeRepository } from './draftSession'
import { readLegacyLibrary, readSavedState, writeSavedCompat } from './legacyLibrary'
import { DocumentRepository, openIndexedDB, buildFromConfig } from './repository'
import { TestBackend, TestStorage } from './persistenceTestFixtures'
import {
  DRAFT_KEY,
  LEGACY_LIBRARY_KEY,
  RECOVERY_KEY,
  preserveRaw,
  readRecovery,
  recoveryRecord,
  RECOVERY_LIMITS,
} from './recovery'

const encoded = (value: unknown) => LZString.compressToEncodedURIComponent(JSON.stringify(value))
const chalk: Config = { ...DEFAULT_CONFIG, finish: 'chalk' }
const olive: Config = { ...DEFAULT_CONFIG, finish: 'olive' }
const build = (id: string, config = DEFAULT_CONFIG) => ({ ...buildFromConfig(config, id), id })

describe('PRES-01..03 raw input preservation', () => {
  it.each([
    '#c=not-valid',
    `#c=${encoded({ ...DEFAULT_CONFIG, v: 500 })}`,
    `#c=${'x'.repeat(DOCUMENT_LIMITS.encodedChars + 1)}`,
  ])('keeps the nondefault draft when %s is rejected', (hash) => {
    const storage = new TestStorage(),
      raw = encodeConfig(chalk)
    storage.setItem(DRAFT_KEY, raw)
    const result = initialConfig({ storage, hash })
    expect(result.config).toEqual(chalk)
    expect(result.source).toBe('draft')
    expect(result.recovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'durable',
          record: expect.objectContaining({ raw: hash, source: 'share' }),
        }),
      ]),
    )
    expect(storage.getItem(DRAFT_KEY)).toBe(raw)
  })
  it('archives the exact hash and exact displaced draft before exposing a valid share', () => {
    const storage = new TestStorage(),
      raw = encodeConfig(chalk),
      hash = `#extra=%20&c=${encodeConfig(olive)}`
    storage.setItem(DRAFT_KEY, raw)
    const result = initialConfig({ storage, hash })
    expect(result).toMatchObject({
      config: olive,
      source: 'share',
      writeSafe: true,
      originalPreserved: 'durable',
    })
    expect(result.recovery.map((entry) => entry.record.raw)).toEqual([hash, raw])
    expect(storage.getItem(DRAFT_KEY)).toBe(raw)
  })
  it('keeps a valid incoming design volatile and suspends writes when preservation is denied', () => {
    const storage = new TestStorage(),
      raw = encodeConfig(chalk)
    storage.setItem(DRAFT_KEY, raw)
    storage.denyWrite = true
    const result = initialConfig({ storage, hash: `#c=${encodeConfig(olive)}` })
    expect(result).toMatchObject({
      config: olive,
      writeSafe: false,
      originalPreserved: 'volatile',
      storageFailure: 'quota',
    })
    expect(result.recovery.map((entry) => entry.record.raw)).toContain(raw)
    expect(storage.getItem(DRAFT_KEY)).toBe(raw)
  })
  it('never reports an unreadable draft or corrupt recovery ledger as safely empty', () => {
    const storage = new TestStorage()
    storage.denyRead = true
    expect(initialConfig({ storage, hash: '' })).toMatchObject({
      writeSafe: false,
      storageFailure: 'read-failed',
    })
    storage.denyRead = false
    storage.setItem(RECOVERY_KEY, '{')
    expect(initialConfig({ storage, hash: '#c=bad' })).toMatchObject({
      writeSafe: false,
      originalPreserved: 'volatile',
    })
    expect(storage.getItem(RECOVERY_KEY)).toBe('{')
  })
  it('bounds recovery storage without deleting previous inputs', () => {
    const storage = new TestStorage()
    for (let i = 0; i < RECOVERY_LIMITS.records; i++)
      expect(preserveRaw(recoveryRecord(String(i), 'share', 'hash'), storage).status).toBe(
        'durable',
      )
    expect(preserveRaw(recoveryRecord('overflow', 'share', 'hash'), storage)).toMatchObject({
      status: 'volatile',
      reason: 'capacity',
    })
    expect(readRecovery(storage)).toMatchObject({ ok: true, value: expect.any(Array) })
    expect(storage.length).toBe(RECOVERY_LIMITS.records)
    expect(
      preserveRaw(
        recoveryRecord('x'.repeat(RECOVERY_LIMITS.rawBytes + 1), 'share', 'hash'),
        new TestStorage(),
      ),
    ).toMatchObject({ status: 'volatile', reason: 'too-large' })
  })
})

describe('bounded v1/v2/v3 codec and repair migration', () => {
  it.each([1, 2, 3])('migrates version %s, retaining design meaning and original bytes', (v) => {
    const storage = new TestStorage(),
      raw = encoded({ ...chalk, v })
    storage.setItem(DRAFT_KEY, raw)
    const result = initialConfig({ storage, hash: '' })
    expect(result.config).toEqual(chalk)
    expect(result.config.v).toBe(3)
    expect(decodeConfig(encodeConfig(result.config))).toEqual(chalk)
    expect(storage.getItem(DRAFT_KEY)).toBe(raw)
    if (v < 3) expect(result.recovery[0]).toMatchObject({ status: 'durable', record: { raw } })
  })
  it('retains a structurally valid out-of-room layout for explicit repair', () => {
    const storage = new TestStorage()
    const invalid = { ...chalk, v: 2, items: [{ ...chalk.items[0], x: 19 }] }
    const raw = encoded(invalid)
    storage.setItem(DRAFT_KEY, raw)
    expect(configSchema.safeParse(invalid).success).toBe(true)
    expect(inspectConfig(raw)).toMatchObject({
      status: 'repair',
      config: { items: invalid.items },
      migratedFrom: 2,
    })
    expect(decodeConfig(raw)).toBeNull()
    expect(initialConfig({ storage, hash: '' })).toMatchObject({
      acceptance: 'repair',
      writeSafe: false,
      originalPreserved: 'durable',
      config: { items: invalid.items },
    })
  })
  it('bounds decompression before materializing a bomb and matches LZ-string for ordinary text', () => {
    for (const value of [
      '',
      'hello',
      'abcd'.repeat(200),
      'مرحبا 🏋️'.repeat(100),
      JSON.stringify(DEFAULT_CONFIG),
    ]) {
      const packed = LZString.compressToEncodedURIComponent(value)
      expect(boundedDecompress(packed)).toBe(value)
    }
    const bomb = LZString.compressToEncodedURIComponent('x'.repeat(500_000))
    expect(bomb.length).toBeLessThan(DOCUMENT_LIMITS.encodedChars)
    expect(boundedDecompress(bomb)).toBeNull()
    expect(boundedDecompress('!')).toBeNull()
    expect(boundedDecompress('x'.repeat(DOCUMENT_LIMITS.encodedChars + 1))).toBeNull()
  })
})

describe('PRES-04..08 transactional repository', () => {
  it('salvages valid and repair records independently and preserves all legacy bytes', async () => {
    const storage = new TestStorage(),
      backend = new TestBackend(),
      repo = new DocumentRepository(backend, false)
    const repair = build('repair', { ...chalk, items: [{ ...chalk.items[0], x: 19 }] })
    const raw = JSON.stringify([
      build('good'),
      { ...build('future'), config: { ...chalk, v: 99 } },
      { junk: true },
      repair,
    ])
    storage.setItem(LEGACY_LIBRARY_KEY, raw)
    await initializeRepository(repo, storage, '')
    const result = await repo.list()
    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: [
          expect.objectContaining({
            build: { ...build('unused'), id: 'good', name: 'good', date: expect.any(String) },
            status: 'accepted',
          }),
          expect.objectContaining({ status: 'repair' }),
        ],
        rejected: expect.any(Array),
      },
    })
    if (!result.ok) throw new Error('Repository unavailable')
    expect(result.value.entries.map((entry) => entry.build.id)).toEqual(['good', 'repair'])
    expect(result.value.rejected).toHaveLength(2)
    expect(storage.getItem(LEGACY_LIBRARY_KEY)).toBe(raw)
    expect(
      [...backend.rows.values()].some(
        (row) => row.key.startsWith('legacy:library:') && row.raw === raw,
      ),
    ).toBe(true)
  })
  it('keeps malformed library data visible instead of returning a silently empty library', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false)
    expect(await repo.migrateLegacy({ draft: null, library: '{' })).toMatchObject({ ok: true })
    expect(await repo.list()).toMatchObject({
      ok: true,
      value: {
        entries: [],
        rejected: [expect.objectContaining({ raw: '{', reason: 'malformed' })],
      },
    })
  })
  it('serializes distinct saves and rejects racing edits/deletion resurrection', async () => {
    const backend = new TestBackend(),
      a = new DocumentRepository(backend, false),
      b = new DocumentRepository(backend, false)
    const first = build('a'),
      second = build('b')
    expect(await Promise.all([a.put(first, null), b.put(second, null)])).toEqual([
      { ok: true, value: { status: 'saved', revision: 1 } },
      { ok: true, value: { status: 'saved', revision: 1 } },
    ])
    const race = await Promise.all([
      a.put({ ...first, name: 'left' }, 1),
      b.put({ ...first, name: 'right' }, 1),
    ])
    expect(race[0]).toMatchObject({ ok: true, value: { status: 'saved', revision: 2 } })
    expect(race[1]).toMatchObject({ ok: true, value: { status: 'conflict', currentRevision: 2 } })
    if (race[1].ok && race[1].value.status === 'conflict') {
      expect(race[1].value.candidateRaw).toContain('right')
      expect(backend.rows.get(race[1].value.recoveryKey!)?.raw).toContain('right')
    }
    expect(await b.delete('a', 1)).toMatchObject({ ok: true, value: { status: 'conflict' } })
    expect(await a.delete('a', 2)).toMatchObject({
      ok: true,
      value: { status: 'saved', revision: 3 },
    })
    expect(await b.put(first, 3)).toMatchObject({
      ok: true,
      value: { status: 'conflict', deleted: true },
    })
    await b.migrateLegacy({ draft: null, library: JSON.stringify([first]) })
    expect(await b.list()).toMatchObject({
      ok: true,
      value: {
        entries: [expect.objectContaining({ build: second })],
        tombstones: [{ id: 'a', revision: 3 }],
      },
    })
    expect(backend.rows.get('build:a')?.raw).toContain('left')
  })
  it('retains the legacy source on aborted migration, then retries idempotently', async () => {
    const storage = new TestStorage(),
      backend = new TestBackend(),
      repo = new DocumentRepository(backend, false)
    const raw = JSON.stringify([build('good')])
    storage.setItem(LEGACY_LIBRARY_KEY, raw)
    backend.fail = 'quota'
    expect((await initializeRepository(repo, storage, '')).initial.writeSafe).toBe(false)
    expect(backend.rows.size).toBe(0)
    expect(storage.getItem(LEGACY_LIBRARY_KEY)).toBe(raw)
    backend.fail = undefined
    await initializeRepository(repo, storage, '')
    const size = backend.rows.size
    await initializeRepository(repo, storage, '')
    expect(backend.rows.size).toBe(size)
  })
  it('atomically preserves a displaced draft and refuses stale draft writers', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false)
    const raw = encodeConfig(chalk)
    await repo.saveDraft(raw, null)
    const original = recoveryRecord(raw, 'displaced-draft', 'encoded-config')
    backend.fail = 'quota'
    expect(await repo.saveDraft(encodeConfig(olive), 1, [original])).toEqual({
      ok: false,
      reason: 'quota',
    })
    expect(backend.rows.size).toBe(1)
    expect(backend.rows.get('draft')?.raw).toBe(raw)
    backend.fail = undefined
    expect(await repo.saveDraft(encodeConfig(olive), 1, [original])).toMatchObject({
      ok: true,
      value: { status: 'saved', revision: 2 },
    })
    expect(backend.rows.get(`recovery:${original.id}`)?.raw).toContain(original.id)
    expect(await repo.saveDraft(encodeConfig(DEFAULT_CONFIG), 1)).toMatchObject({
      ok: true,
      value: { status: 'conflict', currentRevision: 2 },
    })
  })
  it('does not replace unsupported repository document records', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false)
    backend.rows.set('draft', { key: 'draft', version: 99, revision: 6, raw: encodeConfig(chalk) })
    const result = await initializeRepository(repo, new TestStorage(), '')
    expect(result.initial).toMatchObject({ writeSafe: false, acceptance: 'rejected' })
    expect(await repo.saveDraft(encodeConfig(olive), 6)).toMatchObject({
      ok: true,
      value: { status: 'conflict' },
    })
    expect(backend.rows.get('draft')?.version).toBe(99)
  })
  it('reports unavailable IndexedDB rather than claiming fallback writes are safe', async () => {
    expect(await openIndexedDB(undefined)).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('salvages valid records beside corrupt revision metadata and refuses writes to corrupt records', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false)
    await repo.put(build('good'), null)
    const corrupt = {
      key: 'build:bad',
      revision: NaN,
      version: 1,
      raw: JSON.stringify(build('bad')),
    }
    backend.rows.set(corrupt.key, corrupt)
    expect(await repo.list()).toMatchObject({
      ok: true,
      value: {
        entries: [expect.objectContaining({ build: expect.objectContaining({ id: 'good' }) })],
        rejected: [expect.objectContaining({ key: corrupt.key })],
      },
    })
    expect(await repo.put(build('bad'), 0)).toMatchObject({
      ok: true,
      value: { status: 'conflict' },
    })
    expect(backend.rows.get(corrupt.key)).toBe(corrupt)
  })
  it('never overwrites an immutable recovery record on an ID collision', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false),
      record = recoveryRecord('first', 'share', 'hash')
    await repo.preserve([record])
    expect(await repo.preserve([{ ...record, raw: 'second' }])).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(JSON.parse(backend.rows.get(`recovery:${record.id}`)!.raw).raw).toBe('first')
  })
  it('keeps previously rejected input available after URL removal and reload', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false),
      storage = new TestStorage()
    const first = await initializeRepository(repo, storage, '#c=bad')
    expect(first.initial.recovery.some((entry) => entry.record.raw === '#c=bad')).toBe(true)
    const next = await initializeRepository(repo, storage, '')
    expect(
      next.initial.recovery.some(
        (entry) => entry.record.raw === '#c=bad' && entry.status === 'durable',
      ),
    ).toBe(true)
  })
  it('surfaces later legacy journal edits without overwriting repository changes or inventing conflicts on unchanged reloads', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false),
      storage = new TestStorage(),
      first = build('first')
    storage.setItem(LEGACY_LIBRARY_KEY, JSON.stringify([first]))
    await initializeRepository(repo, storage, '')
    await repo.put({ ...first, name: 'Repository edit' }, 1)
    await initializeRepository(repo, storage, '')
    expect(await repo.list()).toMatchObject({ ok: true, value: { rejected: [] } })
    readSavedState(storage)
    writeSavedCompat([{ ...first, name: 'Legacy edit' }], storage)
    await initializeRepository(repo, storage, '')
    const result = await repo.list()
    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: [
          expect.objectContaining({ build: expect.objectContaining({ name: 'Repository edit' }) }),
        ],
        rejected: [expect.objectContaining({ raw: expect.stringContaining('Legacy edit') })],
      },
    })
    await initializeRepository(repo, storage, '')
    expect(await repo.list()).toEqual(result)
  })
  it('preserves draft extensions before canonical normalization drops unknown fields', () => {
    const storage = new TestStorage(),
      raw = encoded({ ...DEFAULT_CONFIG, futureMetadata: { source: 'older-tool' } })
    storage.setItem(DRAFT_KEY, raw)
    expect(initialConfig({ storage, hash: '' }).recovery).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ raw }), status: 'durable' }),
    ])
  })
})

describe('honest legacy compatibility journal', () => {
  it('keeps rejected records and old raw array while appending record-level edits', () => {
    const storage = new TestStorage(),
      good = build('good'),
      raw = JSON.stringify([good, { unsupported: true }])
    storage.setItem(LEGACY_LIBRARY_KEY, raw)
    const first = readSavedState(storage)
    expect(first.entries.map((entry) => entry.build)).toEqual([good])
    expect(first.rejected).toHaveLength(1)
    writeSavedCompat([{ ...good, name: 'Edited' }], storage)
    expect(storage.getItem(LEGACY_LIBRARY_KEY)).toBe(raw)
    expect(readSavedState(storage).entries[0].build.name).toBe('Edited')
    writeSavedCompat([], storage)
    const result = readSavedState(storage)
    expect(result.entries).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.tombstones).toHaveLength(1)
  })
  it('retains both branches of a truly concurrent write instead of last-writer-wins', () => {
    const storage = new TestStorage(),
      first = build('same')
    for (const token of ['one', 'two'])
      storage.setItem(
        `fury-build-op-v1:${token}`,
        JSON.stringify({
          version: 1,
          id: first.id,
          token,
          parent: null,
          deleted: false,
          raw: JSON.stringify({ ...first, name: token }),
        }),
      )
    const result = readLegacyLibrary(storage)
    expect(result.conflicts).toContain(first.id)
    expect(result.rejected).toHaveLength(2)
    expect(result.entries).toEqual([])
    expect(storage.length).toBe(2)
  })
  it('does not delete a concurrently created distinct record missing from a stale array', () => {
    const storage = new TestStorage(),
      first = build('first'),
      second = build('second')
    writeSavedCompat([first], storage)
    const token = 'another-tab'
    storage.setItem(
      `fury-build-op-v1:${token}`,
      JSON.stringify({
        version: 1,
        id: second.id,
        token,
        parent: null,
        deleted: false,
        raw: JSON.stringify(second),
      }),
    )
    writeSavedCompat([{ ...first, name: 'Edited' }], storage)
    expect(
      readSavedState(storage)
        .entries.map((entry) => entry.build.id)
        .sort(),
    ).toEqual(['first', 'second'])
  })
  it('surfaces disconnected cycles instead of allowing hidden tombstones to erase a valid head', () => {
    const storage = new TestStorage(),
      first = build('same')
    for (const [token, parent, deleted] of [
      ['one', 'two', true],
      ['two', 'one', false],
      ['root', null, false],
    ] as const)
      storage.setItem(
        `fury-build-op-v1:${token}`,
        JSON.stringify({
          version: 1,
          id: first.id,
          token,
          parent,
          deleted,
          raw: JSON.stringify(first),
        }),
      )
    expect(readLegacyLibrary(storage)).toMatchObject({
      entries: [],
      conflicts: ['same'],
      rejected: expect.any(Array),
      tombstones: [],
    })
  })
})

describe('draft controller', () => {
  it('bounds autosave per committed revision and preserves stale-tab candidates', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false),
      storage = new TestStorage()
    const init = initialConfig({ storage, hash: '' }),
      a = new DraftPersistence(repo, init, null),
      b = new DraftPersistence(repo, init, null)
    await a.enqueue(chalk, 1)
    const writes = backend.writes
    await a.enqueue(chalk, 1)
    expect(backend.writes).toBe(writes)
    await b.enqueue(olive, 1)
    expect(b.snapshot).toMatchObject({
      status: 'conflict',
      writeSafe: false,
      recovery: [{ status: 'durable', record: { raw: JSON.stringify(olive) } }],
    })
    expect(backend.rows.get('draft')?.raw).toBe(encodeConfig(chalk))
    await b.enqueue(DEFAULT_CONFIG, 2)
    expect(backend.rows.get('draft')?.raw).toBe(encodeConfig(chalk))
    expect(await b.accept(olive, 2, () => true)).toMatchObject({
      ok: true,
      value: { status: 'saved' },
    })
    expect(b.snapshot.writeSafe).toBe(true)
  })
  it('rechecks the live edit guard inside the atomic replacement', async () => {
    const backend = new TestBackend(),
      repo = new DocumentRepository(backend, false),
      controller = new DraftPersistence(
        repo,
        initialConfig({ storage: new TestStorage(), hash: '' }),
        null,
      )
    let calls = 0
    const result = await controller.accept(chalk, 1, () => ++calls === 1)
    expect(result).toMatchObject({ ok: true, value: { status: 'conflict' } })
    expect(backend.rows.has('draft')).toBe(false)
  })
  it('never writes automatically after failed preservation', async () => {
    const storage = new TestStorage(),
      backend = new TestBackend(),
      repo = new DocumentRepository(backend, false)
    storage.denyWrite = true
    const init = initialConfig({ storage, hash: `#c=${encodeConfig(chalk)}` })
    const controller = new DraftPersistence(repo, init, null)
    expect(await controller.enqueue(chalk, 0)).toMatchObject({ ok: false, reason: 'quota' })
    expect(backend.rows.size).toBe(0)
  })
})
