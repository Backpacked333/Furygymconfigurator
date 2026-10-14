import { encodeConfig, initialConfig, inspectDocument, type Config } from './config'
import { readLegacyLibrary } from './legacyLibrary'
import {
  DRAFT_KEY,
  LEGACY_LIBRARY_KEY,
  readStorage,
  readRecovery,
  isRecoveryRecord,
  recoveryRecord,
  type Initialization,
  type Outcome,
  type Preservation,
  type StorageAccess,
  type StorageFailure,
} from './recovery'
import { DocumentRepository, type RecordWrite, type StoredRecord } from './repository'

export type PersistenceState = {
  status: 'initializing' | 'ready' | 'saving' | 'saved' | 'volatile' | 'conflict'
  writeSafe: boolean
  draftRevision: number | null
  savedRevision: number | null
  reason?: StorageFailure
  recovery: Preservation[]
}
export async function initializeRepository(
  repository: DocumentRepository,
  storage: StorageAccess | undefined,
  hash: string,
) {
  const legacyDraft = readStorage(storage, DRAFT_KEY),
    legacyLibrary = readStorage(storage, LEGACY_LIBRARY_KEY)
  const library = readLegacyLibrary(storage)
  let failure: StorageFailure | undefined = !legacyDraft.ok
    ? legacyDraft.reason
    : !legacyLibrary.ok
      ? legacyLibrary.reason
      : library.failure
  if (!failure && legacyDraft.ok && legacyLibrary.ok) {
    const records: StoredRecord[] = [
      ...library.entries.map((entry) => ({
        key: `build:${entry.build.id}`,
        version: 1,
        revision: entry.revision,
        raw: JSON.stringify(entry.build),
      })),
      ...library.tombstones.map((entry) => ({
        key: `build:${entry.id}`,
        version: 1,
        revision: entry.revision,
        raw: entry.raw,
        deleted: true,
      })),
      ...library.rejected.map((entry, index) => ({
        key: `rejected:compat:${index}`,
        version: 1,
        revision: 1,
        raw: entry.raw,
      })),
    ]
    const migrated = await repository.migrateLegacy(
      { draft: legacyDraft.value, library: legacyLibrary.value },
      records,
      library.rawSources.filter((source) => source.key !== LEGACY_LIBRARY_KEY),
    )
    if (!migrated.ok) failure = migrated.reason
  }
  const draft = await repository.readDraft()
  const initial = initialConfig({
    storage,
    hash,
    draft: draft.ok
      ? { ok: true, value: draft.value?.raw ?? (legacyDraft.ok ? legacyDraft.value : null) }
      : { ok: false, reason: draft.reason },
  })
  if (draft.ok && draft.value && draft.value.version !== 1) {
    initial.acceptance = 'rejected'
    initial.issues.push('Unsupported draft record version.')
    failure = 'corrupt-store'
  }
  const localRecovery = readRecovery(storage)
  if (!localRecovery.ok) failure ??= localRecovery.reason
  else
    initial.recovery.push(
      ...localRecovery.value.map((record): Preservation => ({ status: 'durable', record })),
    )
  const prior = await repository.listRecovery()
  if (!prior.ok) failure ??= prior.reason
  else
    for (const row of prior.value.filter((row) => row.key.startsWith('recovery:'))) {
      try {
        const record: unknown = JSON.parse(row.raw)
        if (!isRecoveryRecord(record) || row.version !== 1) {
          failure = 'corrupt-store'
          continue
        }
        initial.recovery.push({ status: 'durable', record })
      } catch {
        failure = 'corrupt-store'
      }
    }
  initial.recovery = [
    ...new Map(
      initial.recovery.map((entry) => [
        JSON.stringify([entry.record.source, entry.record.format, entry.record.raw]),
        entry,
      ]),
    ).values(),
  ]
  const preserved = await repository.preserve(initial.recovery.map((entry) => entry.record))
  if (!preserved.ok) failure = preserved.reason
  else
    initial.recovery = initial.recovery.map((entry, index) => ({
      status: 'durable',
      record: { ...entry.record, id: preserved.value[index].replace(/^recovery:/, '') },
    }))
  if (initial.recovery.length) initial.originalPreserved = preserved.ok ? 'durable' : 'volatile'
  if (failure) {
    initial.writeSafe = false
    initial.storageFailure = failure
  }
  return { initial, draftRevision: draft.ok ? (draft.value?.revision ?? null) : null }
}

export class DraftPersistence {
  private queue: Promise<unknown> = Promise.resolve()
  private lastQueuedRevision = -1
  private state: PersistenceState
  private listeners = new Set<(state: PersistenceState) => void>()
  constructor(
    private readonly repository: DocumentRepository,
    initial: Initialization<Config>,
    draftRevision: number | null,
  ) {
    this.state = {
      status: initial.writeSafe ? 'ready' : 'volatile',
      writeSafe: initial.writeSafe,
      draftRevision,
      savedRevision: null,
      reason: initial.storageFailure,
      recovery: initial.recovery,
    }
  }
  get snapshot() {
    return this.state
  }
  subscribe(listener: (state: PersistenceState) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<PersistenceState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener(this.state))
  }
  remember(preservation: Preservation) {
    const recovery = this.state.recovery.filter(
      (entry) =>
        entry.record.raw !== preservation.record.raw ||
        entry.record.source !== preservation.record.source ||
        entry.record.format !== preservation.record.format,
    )
    this.update({ recovery: [...recovery, preservation] })
    if (preservation.status === 'volatile') this.suspend(preservation.reason)
  }
  async preserveCandidate(
    config: Config,
    source: 'transaction' | 'displaced-draft' = 'transaction',
  ) {
    const record = recoveryRecord(JSON.stringify(config), source, 'json')
    const result = await this.repository.preserve([record])
    const preservation: Preservation = {
      status: result.ok ? 'durable' : 'volatile',
      record: result.ok ? { ...record, id: result.value[0].replace(/^recovery:/, '') } : record,
      ...(!result.ok ? { reason: result.reason } : {}),
    }
    this.remember(preservation)
    return preservation
  }
  suspend(reason: StorageFailure = 'conflict') {
    this.update({
      status: reason === 'conflict' ? 'conflict' : 'volatile',
      writeSafe: false,
      reason,
    })
  }
  enqueue(config: Config, revision: number): Promise<Outcome<RecordWrite> | undefined> {
    if (revision <= this.lastQueuedRevision)
      return this.queue as Promise<Outcome<RecordWrite> | undefined>
    if (!this.state.writeSafe)
      return Promise.resolve({ ok: false, reason: this.state.reason ?? 'conflict' })
    const inspected = inspectDocument(config)
    if (inspected.status !== 'accepted') {
      this.suspend('corrupt-store')
      return Promise.resolve({ ok: false, reason: 'corrupt-store' })
    }
    this.lastQueuedRevision = revision
    const raw = encodeConfig(inspected.config)
    this.update({ status: 'saving' })
    const operation = this.queue.then(async (): Promise<Outcome<RecordWrite>> => {
      if (!this.state.writeSafe) return { ok: false, reason: this.state.reason ?? 'conflict' }
      const result = await this.repository.saveDraft(raw, this.state.draftRevision)
      if (!result.ok || result.value.status === 'conflict') {
        this.suspend(result.ok ? 'conflict' : result.reason)
        await this.preserveCandidate(inspected.config)
      } else {
        this.update({
          draftRevision: result.value.revision,
          savedRevision: revision,
          status: revision === this.lastQueuedRevision ? 'saved' : 'saving',
        })
      }
      return result
    })
    this.queue = operation
    return operation
  }
  flush() {
    return this.queue
  }
  async detectStale(config: Config) {
    await this.queue
    const read = await this.repository.readDraft()
    if (!read.ok) {
      this.suspend(read.reason)
      return
    }
    if ((read.value?.revision ?? null) !== this.state.draftRevision) {
      this.suspend('conflict')
      await this.preserveCandidate(config)
    }
  }
  async accept(
    config: Config,
    revision: number,
    isCurrent: () => boolean,
  ): Promise<Outcome<RecordWrite>> {
    const inspected = inspectDocument(config)
    if (inspected.status !== 'accepted') return { ok: false, reason: 'corrupt-store' }
    this.update({ status: 'saving', writeSafe: false })
    await this.queue
    const draft = await this.repository.readDraft()
    if (!draft.ok) {
      this.suspend(draft.reason)
      return draft
    }
    const originals = this.state.recovery.map((entry) => entry.record)
    if (draft.value)
      originals.push(recoveryRecord(draft.value.raw, 'displaced-draft', 'encoded-config'))
    if (!isCurrent()) {
      this.suspend('conflict')
      return { ok: false, reason: 'conflict' }
    }
    // saveDraft archives originals and replaces the active record in the same transaction.
    const result = await this.repository.saveDraft(
      encodeConfig(inspected.config),
      draft.value?.revision ?? null,
      originals,
      false,
      isCurrent,
    )
    if (!result.ok || result.value.status === 'conflict') {
      this.suspend(result.ok ? 'conflict' : result.reason)
      return result
    }
    this.lastQueuedRevision = revision
    this.update({
      writeSafe: true,
      status: 'saved',
      reason: undefined,
      savedRevision: revision,
      draftRevision: result.value.revision,
      recovery: this.state.recovery.map((entry) => ({
        ...entry,
        status: 'durable',
        reason: undefined,
      })),
    })
    return result
  }
}
