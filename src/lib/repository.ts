import {
  configSchema,
  inspectDocument,
  inspectConfig,
  type Config,
  type SavedBuild,
} from './config'
import {
  failureReason,
  rawBytes,
  RECOVERY_LIMITS,
  recoveryRecord,
  type Outcome,
  type RecoveryRecord,
  type StorageFailure,
} from './recovery'

export const REPOSITORY_NAME = 'fury-documents-v1'
const STORE = 'records'
const MAX_RECORD_BYTES = 32_000
export type StoredRecord = {
  key: string
  version: number
  revision: number
  raw: string
  deleted?: boolean
  writer?: string
}
export type Mutation<T> = { value: T; writes?: StoredRecord[] } | { failure: StorageFailure }
export interface TransactionBackend {
  atomic<T>(operation: (records: readonly StoredRecord[]) => Mutation<T>): Promise<Outcome<T>>
  close(): void
}
function readableRecords(records: readonly StoredRecord[]): StoredRecord[] {
  return records.map((row, index) => {
    if (
      row &&
      typeof row.key === 'string' &&
      Number.isSafeInteger(row.version) &&
      row.version > 0 &&
      Number.isSafeInteger(row.revision) &&
      row.revision > 0 &&
      typeof row.raw === 'string' &&
      (row.deleted === undefined || typeof row.deleted === 'boolean')
    )
      return row
    return {
      key: row && typeof row.key === 'string' ? row.key : `rejected:metadata:${index}`,
      version: 0,
      revision: 0,
      raw: JSON.stringify(row),
    }
  })
}
export function openIndexedDB(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<Outcome<TransactionBackend>> {
  if (!factory) return Promise.resolve({ ok: false, reason: 'unavailable' })
  return new Promise((resolve) => {
    let completed = false
    const finish = (result: Outcome<TransactionBackend>) => {
      if (!completed) {
        completed = true
        clearTimeout(timeout)
        resolve(result)
      }
    }
    const timeout = setTimeout(() => finish({ ok: false, reason: 'unavailable' }), 4000)
    try {
      const request = factory.open(REPOSITORY_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: 'key' })
      }
      request.onerror = () => finish({ ok: false, reason: failureReason(request.error) })
      request.onblocked = () => finish({ ok: false, reason: 'unavailable' })
      request.onsuccess = () => {
        const db = request.result
        if (completed) {
          db.close()
          return
        }
        db.onversionchange = () => db.close()
        const backend: TransactionBackend = {
          close: () => db.close(),
          atomic: <T>(operation: (records: readonly StoredRecord[]) => Mutation<T>) =>
            new Promise<Outcome<T>>((settle) => {
              let value: T,
                reason: StorageFailure = 'write-failed'
              try {
                const transaction = db.transaction(STORE, 'readwrite')
                const store = transaction.objectStore(STORE)
                const read = store.getAll()
                transaction.oncomplete = () => settle({ ok: true, value })
                transaction.onabort = () =>
                  settle({
                    ok: false,
                    reason: transaction.error ? failureReason(transaction.error) : reason,
                  })
                transaction.onerror = () => {
                  reason = failureReason(transaction.error)
                }
                read.onsuccess = () => {
                  try {
                    const result = operation(read.result as StoredRecord[])
                    if ('failure' in result) {
                      reason = result.failure
                      transaction.abort()
                      return
                    }
                    value = result.value
                    for (const row of result.writes ?? []) store.put(row)
                  } catch (error) {
                    reason = failureReason(error)
                    transaction.abort()
                  }
                }
              } catch (error) {
                settle({ ok: false, reason: failureReason(error) })
              }
            }),
        }
        finish({ ok: true, value: backend })
      }
    } catch (error) {
      finish({ ok: false, reason: failureReason(error) })
    }
  })
}
export type LibraryEntry = {
  build: SavedBuild
  originalRaw?: string
  revision: number
  status: 'accepted' | 'repair'
  issues: string[]
}
export type RejectedRecord = {
  key: string
  raw: string
  revision: number
  reason: 'malformed' | 'unsupported' | 'schema'
}
export type LibrarySnapshot = {
  entries: LibraryEntry[]
  rejected: RejectedRecord[]
  tombstones: { id: string; revision: number }[]
}
export function inspectBuild(
  raw: string,
):
  | { build: SavedBuild; status: 'accepted' | 'repair'; issues: string[] }
  | { reason: RejectedRecord['reason'] } {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return { reason: 'schema' }
    const build = value as SavedBuild
    if (
      typeof build.id !== 'string' ||
      !build.id ||
      build.id.length > 64 ||
      typeof build.name !== 'string' ||
      !build.name.trim() ||
      build.name.length > 60 ||
      typeof build.date !== 'string' ||
      build.date.length > 128
    )
      return { reason: 'schema' }
    const document = inspectDocument(build.config)
    if (document.status === 'rejected')
      return { reason: document.reason === 'unsupported' ? 'unsupported' : 'schema' }
    return {
      build: { id: build.id, name: build.name, date: build.date, config: document.config },
      status: document.status,
      issues: document.issues,
    }
  } catch {
    return { reason: 'malformed' }
  }
}
export function salvageLibrary(raw: string): {
  records: { key: string; raw: string }[]
  malformed: boolean
} {
  try {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values) || values.length > 256) return { records: [], malformed: true }
    const seen = new Set<string>()
    return {
      malformed: false,
      records: values.map((value, index) => {
        const serialized = JSON.stringify(value)
        const inspected = inspectBuild(serialized)
        const id = 'build' in inspected ? inspected.build.id : null
        const key = id && !seen.has(id) ? `build:${id}` : `rejected:legacy:${index}`
        if (id) seen.add(id)
        return { key, raw: serialized }
      }),
    }
  } catch {
    return { records: [], malformed: true }
  }
}
function librarySnapshot(records: readonly StoredRecord[]): LibrarySnapshot {
  const result: LibrarySnapshot = { entries: [], rejected: [], tombstones: [] }
  for (const row of records) {
    if (row.key.startsWith('legacy:library:') && salvageLibrary(row.raw).malformed) {
      result.rejected.push({ ...row, reason: 'malformed' })
      continue
    }
    if (!row.key.startsWith('build:') && !row.key.startsWith('rejected:')) continue
    if (row.version !== 1) {
      result.rejected.push({ ...row, reason: 'unsupported' })
      continue
    }
    if (row.deleted) {
      result.tombstones.push({ id: row.key.slice(6), revision: row.revision })
      continue
    }
    const inspected = inspectBuild(row.raw)
    if ('reason' in inspected || row.key !== `build:${inspected.build.id}`)
      result.rejected.push({ ...row, reason: 'reason' in inspected ? inspected.reason : 'schema' })
    else result.entries.push({ ...inspected, originalRaw: row.raw, revision: row.revision })
  }
  return result
}
export type RecordConflict = {
  status: 'conflict'
  currentRevision: number | null
  deleted: boolean
  raw?: string
  candidateRaw?: string
  recoveryKey?: string
}
export type RecordWrite = { status: 'saved'; revision: number } | RecordConflict
function conflict(row: StoredRecord | undefined): RecordConflict {
  return {
    status: 'conflict',
    currentRevision: row?.revision ?? null,
    deleted: !!row?.deleted,
    ...(row ? { raw: row.raw } : {}),
  }
}
function recoveryWrites(
  records: readonly StoredRecord[],
  inputs: readonly RecoveryRecord[],
): Outcome<{ writes: StoredRecord[]; references: string[] }> {
  const rows = records.filter((row) => row.key.startsWith('recovery:'))
  const writes: StoredRecord[] = [],
    references: string[] = []
  let bytes = rows.reduce((total, row) => total + rawBytes(row.raw), 0)
  for (const record of inputs) {
    const raw = JSON.stringify(record)
    if (rawBytes(record.raw) > RECOVERY_LIMITS.rawBytes) return { ok: false, reason: 'too-large' }
    const duplicate = [...rows, ...writes].find((row) => {
      try {
        const previous = JSON.parse(row.raw) as RecoveryRecord
        return (
          previous.raw === record.raw &&
          previous.source === record.source &&
          previous.format === record.format
        )
      } catch {
        return false
      }
    })
    if (duplicate) {
      references.push(duplicate.key)
      continue
    }
    bytes += rawBytes(raw)
    if (
      rows.length + writes.length >= RECOVERY_LIMITS.records ||
      bytes > RECOVERY_LIMITS.totalBytes
    )
      return { ok: false, reason: 'capacity' }
    const key = `recovery:${record.id}`
    if ([...rows, ...writes].some((row) => row.key === key))
      return { ok: false, reason: 'conflict' }
    writes.push({ key, version: 1, revision: 1, raw })
    references.push(key)
  }
  return { ok: true, value: { writes, references } }
}
export class DocumentRepository {
  readonly writer = crypto.randomUUID()
  private channel?: BroadcastChannel
  private listeners = new Set<() => void>()
  constructor(
    private readonly backend: TransactionBackend,
    notifications = true,
  ) {
    if (notifications && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(REPOSITORY_NAME)
      this.channel.onmessage = () => this.listeners.forEach((listener) => listener())
    }
  }
  private atomic<T>(
    operation: (records: readonly StoredRecord[]) => Mutation<T>,
  ): Promise<Outcome<T>> {
    return this.backend.atomic((records) => operation(readableRecords(records)))
  }
  private notify() {
    this.channel?.postMessage({ writer: this.writer })
    this.listeners.forEach((listener) => listener())
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  close() {
    this.channel?.close()
    this.listeners.clear()
    this.backend.close()
  }
  readDraft() {
    return this.atomic((records) => ({ value: records.find((row) => row.key === 'draft') ?? null }))
  }
  list() {
    return this.atomic((records) => ({ value: librarySnapshot(records) }))
  }
  listRecovery() {
    return this.atomic((records) => ({
      value: records.filter(
        (row) => row.key.startsWith('recovery:') || row.key.startsWith('legacy:'),
      ),
    }))
  }
  async preserve(records: readonly RecoveryRecord[]) {
    const result = await this.atomic<string[]>((rows) => {
      const preserved = recoveryWrites(rows, records)
      return preserved.ok
        ? { value: preserved.value.references, writes: preserved.value.writes }
        : { failure: preserved.reason }
    })
    return result
  }
  async saveDraft(
    raw: string,
    expectedRevision: number | null,
    originals: readonly RecoveryRecord[] = [],
    allowRepair = false,
    isCurrent: () => boolean = () => true,
  ): Promise<Outcome<RecordWrite>> {
    const inspected = inspectConfig(raw)
    if (inspected.status === 'rejected' || (!allowRepair && inspected.status === 'repair'))
      return { ok: false, reason: 'corrupt-store' }
    const result = await this.atomic<RecordWrite>((records) => {
      const current = records.find((row) => row.key === 'draft')
      if (
        !isCurrent() ||
        (current?.revision ?? null) !== expectedRevision ||
        (current && current.version !== 1)
      )
        return { value: conflict(current) }
      const preservation = recoveryWrites(records, originals)
      if (!preservation.ok) return { failure: preservation.reason }
      if (current?.raw === raw)
        return {
          value: { status: 'saved', revision: current.revision },
          writes: preservation.value.writes,
        }
      const revision = (current?.revision ?? 0) + 1
      return {
        value: { status: 'saved', revision },
        writes: [
          ...preservation.value.writes,
          { key: 'draft', version: 1, revision, raw, writer: this.writer },
        ],
      }
    })
    if (result.ok && result.value.status === 'saved') this.notify()
    return result
  }
  async put(build: SavedBuild, expectedRevision: number | null): Promise<Outcome<RecordWrite>> {
    const parsed = configSchema.safeParse(build.config)
    if (!parsed.success) return { ok: false, reason: 'corrupt-store' }
    const raw = JSON.stringify({ ...build, config: parsed.data })
    const inspected = inspectBuild(raw)
    if ('reason' in inspected || inspected.status !== 'accepted')
      return { ok: false, reason: 'corrupt-store' }
    if (rawBytes(raw) > MAX_RECORD_BYTES) return { ok: false, reason: 'too-large' }
    const result = await this.atomic<RecordWrite>((records) => {
      const key = `build:${build.id}`,
        current = records.find((row) => row.key === key)
      if (!current && records.filter((row) => row.key.startsWith('build:')).length >= 256)
        return { failure: 'capacity' }
      if (
        current?.deleted ||
        (current?.revision ?? null) !== expectedRevision ||
        (current && current.version !== 1)
      ) {
        const preserved = recoveryWrites(records, [recoveryRecord(raw, 'library', 'json')])
        if (!preserved.ok) return { failure: preserved.reason }
        return {
          value: {
            ...conflict(current),
            candidateRaw: raw,
            recoveryKey: preserved.value.references[0],
          },
          writes: preserved.value.writes,
        }
      }
      const revision = (current?.revision ?? 0) + 1
      if (current?.raw === raw) return { value: { status: 'saved', revision: current.revision } }
      return {
        value: { status: 'saved', revision },
        writes: [{ key, version: 1, revision, raw, writer: this.writer }],
      }
    })
    if (result.ok && result.value.status === 'saved') this.notify()
    return result
  }
  async delete(id: string, expectedRevision: number): Promise<Outcome<RecordWrite>> {
    const result = await this.atomic<RecordWrite>((records) => {
      const row = records.find((record) => record.key === `build:${id}`)
      if (!row || row.deleted || row.version !== 1 || row.revision !== expectedRevision)
        return { value: conflict(row) }
      const revision = row.revision + 1
      return {
        value: { status: 'saved', revision },
        writes: [{ ...row, revision, deleted: true, writer: this.writer }],
      }
    })
    if (result.ok && result.value.status === 'saved') this.notify()
    return result
  }
  async migrateLegacy(
    sources: { draft: string | null; library: string | null },
    libraryRecords?: StoredRecord[],
    additionalSources: { key: string; raw: string }[] = [],
  ): Promise<Outcome<{ status: 'durable'; skipped: boolean }>> {
    return this.atomic<{ status: 'durable'; skipped: boolean }>((records) => {
      const writes: StoredRecord[] = [],
        originals: RecoveryRecord[] = []
      let newLibrarySource = false
      for (const [name, raw] of [
        ...Object.entries(sources),
        ...additionalSources.map((source) => [source.key, source.raw]),
      ]) {
        if (
          raw === null ||
          records.some((row) => row.key.startsWith(`legacy:${name}:`) && row.raw === raw)
        )
          continue
        if (rawBytes(raw) > RECOVERY_LIMITS.rawBytes) return { failure: 'too-large' }
        writes.push({ key: `legacy:${name}:${crypto.randomUUID()}`, version: 1, revision: 1, raw })
        if (name !== 'draft') newLibrarySource = true
        if (name === 'draft') {
          originals.push(recoveryRecord(raw, 'draft', 'encoded-config'))
          if (!records.some((row) => row.key === 'draft'))
            writes.push({ key: 'draft', version: 1, revision: 1, raw })
        } else if (name === 'library' && !libraryRecords) {
          const salvaged = salvageLibrary(raw)
          for (const record of salvaged.records) {
            if (!records.some((row) => row.key === record.key))
              writes.push({ ...record, version: 1, revision: 1 })
            else if (!records.some((row) => row.key === record.key && row.raw === record.raw))
              originals.push(recoveryRecord(record.raw, 'library', 'json'))
          }
        }
      }
      for (const record of newLibrarySource ? (libraryRecords ?? []) : []) {
        if (!records.some((row) => row.key === record.key)) writes.push(record)
        else if (
          !records.some(
            (row) =>
              row.key === record.key &&
              row.raw === record.raw &&
              !!row.deleted === !!record.deleted,
          ) &&
          !records.some(
            (row) =>
              row.key.startsWith('rejected:compat-conflict:') && row.raw === JSON.stringify(record),
          )
        )
          writes.push({
            key: `rejected:compat-conflict:${crypto.randomUUID()}`,
            version: 1,
            revision: 1,
            raw: JSON.stringify(record),
          })
      }
      const archives = [...records, ...writes].filter((row) => row.key.startsWith('legacy:'))
      if (
        archives.length > 512 ||
        archives.reduce((total, row) => total + rawBytes(row.raw), 0) > RECOVERY_LIMITS.totalBytes
      )
        return { failure: 'capacity' }
      const preservation = recoveryWrites(records, originals)
      if (!preservation.ok) return { failure: preservation.reason }
      return {
        value: { status: 'durable' as const, skipped: !writes.length },
        writes: [...writes, ...preservation.value.writes],
      }
    })
  }
  resolveRecovery(keys: readonly string[]) {
    return this.atomic((records) => {
      const writes: StoredRecord[] = []
      for (const key of keys) {
        const row = records.find(
          (record) => record.key === key && key.startsWith('recovery:') && record.version === 1,
        )
        if (!row) continue
        try {
          const record = JSON.parse(row.raw) as RecoveryRecord
          if (!record.resolved)
            writes.push({
              ...row,
              revision: row.revision + 1,
              raw: JSON.stringify({ ...record, resolved: true }),
            })
        } catch {
          return { failure: 'corrupt-store' as const }
        }
      }
      return { value: writes.length, writes }
    })
  }
}
export async function openDocumentRepository(): Promise<Outcome<DocumentRepository>> {
  const opened = await openIndexedDB()
  return opened.ok ? { ok: true, value: new DocumentRepository(opened.value) } : opened
}
export function buildFromConfig(config: Config, name: string): SavedBuild {
  return { id: crypto.randomUUID(), name, date: new Date().toISOString(), config }
}
