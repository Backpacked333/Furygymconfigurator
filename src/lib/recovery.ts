export const DRAFT_KEY = 'fury-draft-v1'
export const LEGACY_LIBRARY_KEY = 'fury-builds-v1'
export const RECOVERY_KEY = 'fury-recovery-v1'
const RECORD_PREFIX = 'fury-recovery-record-v1:'
export const RECOVERY_LIMITS = { records: 64, rawBytes: 256_000, totalBytes: 2_000_000 } as const
export interface StorageAccess {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
  key?(index: number): string | null
  readonly length?: number
}
export type StorageFailure =
  | 'unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'quota'
  | 'too-large'
  | 'capacity'
  | 'corrupt-store'
  | 'conflict'
  | 'transaction-required'
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: StorageFailure }
export function failureReason(error: unknown, reading = false): StorageFailure {
  return error instanceof Error && error.name === 'QuotaExceededError'
    ? 'quota'
    : reading
      ? 'read-failed'
      : 'write-failed'
}
export function browserStorage(): StorageAccess | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
export function readStorage(
  storage: StorageAccess | undefined,
  key: string,
): Outcome<string | null> {
  if (!storage) return { ok: false, reason: 'unavailable' }
  try {
    return { ok: true, value: storage.getItem(key) }
  } catch (error) {
    return { ok: false, reason: failureReason(error, true) }
  }
}
export function rawBytes(raw: string) {
  return new TextEncoder().encode(raw).byteLength
}
export type RecoverySource = 'share' | 'draft' | 'library' | 'transaction' | 'displaced-draft'
export type RecoveryRecord = {
  id: string
  raw: string
  source: RecoverySource
  format: 'hash' | 'encoded-config' | 'json'
  createdAt: string
  resolved: boolean
}
export type Preservation = {
  status: 'durable' | 'volatile'
  record: RecoveryRecord
  reason?: StorageFailure
}
export function recoveryRecord(
  raw: string,
  source: RecoverySource,
  format: RecoveryRecord['format'],
): RecoveryRecord {
  return {
    id: crypto.randomUUID(),
    raw,
    source,
    format,
    createdAt: new Date().toISOString(),
    resolved: false,
  }
}
export function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as RecoveryRecord
  return (
    typeof record.id === 'string' &&
    typeof record.raw === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.resolved === 'boolean' &&
    ['share', 'draft', 'library', 'transaction', 'displaced-draft'].includes(record.source) &&
    ['hash', 'encoded-config', 'json'].includes(record.format)
  )
}
export function readRecovery(storage = browserStorage()): Outcome<RecoveryRecord[]> {
  const read = readStorage(storage, RECOVERY_KEY)
  if (!read.ok) return read
  if (read.value !== null && rawBytes(read.value) > RECOVERY_LIMITS.totalBytes)
    return { ok: false, reason: 'too-large' }
  try {
    const records: unknown = read.value === null ? [] : JSON.parse(read.value)
    if (!Array.isArray(records) || !records.every(isRecoveryRecord))
      return { ok: false, reason: 'corrupt-store' }
    if (storage?.key && typeof storage.length === 'number') {
      if (storage.length > 10_000) return { ok: false, reason: 'capacity' }
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (!key?.startsWith(RECORD_PREFIX)) continue
        const raw = storage.getItem(key)
        if (raw === null) continue
        if (rawBytes(raw) > RECOVERY_LIMITS.totalBytes) return { ok: false, reason: 'too-large' }
        const record: unknown = JSON.parse(raw)
        if (!isRecoveryRecord(record)) return { ok: false, reason: 'corrupt-store' }
        records.push(record)
      }
    }
    if (
      records.length > RECOVERY_LIMITS.records ||
      rawBytes(JSON.stringify(records)) > RECOVERY_LIMITS.totalBytes
    )
      return { ok: false, reason: 'capacity' }
    return { ok: true, value: records }
  } catch {
    return { ok: false, reason: 'corrupt-store' }
  }
}
export function preserveRaw(record: RecoveryRecord, storage = browserStorage()): Preservation {
  const read = readRecovery(storage)
  if (!read.ok) return { status: 'volatile', record, reason: read.reason }
  const duplicate = read.value.find(
    (entry) =>
      entry.raw === record.raw && entry.source === record.source && entry.format === record.format,
  )
  if (duplicate) return { status: 'durable', record: duplicate }
  if (rawBytes(record.raw) > RECOVERY_LIMITS.rawBytes)
    return { status: 'volatile', record, reason: 'too-large' }
  const records = [...read.value, record]
  const serialized = JSON.stringify(records)
  if (records.length > RECOVERY_LIMITS.records || rawBytes(serialized) > RECOVERY_LIMITS.totalBytes)
    return { status: 'volatile', record, reason: 'capacity' }
  try {
    if (!storage?.key || typeof storage.length !== 'number')
      return { status: 'volatile', record, reason: 'transaction-required' }
    const key = `${RECORD_PREFIX}${record.id}`,
      value = JSON.stringify(record)
    storage.setItem(key, value)
    if (storage.getItem(key) !== value)
      return { status: 'volatile', record, reason: 'write-failed' }
    return { status: 'durable', record }
  } catch (error) {
    return { status: 'volatile', record, reason: failureReason(error) }
  }
}
export type DocumentInspection<T> =
  | {
      status: 'accepted' | 'repair'
      config: T
      issues: string[]
      migratedFrom?: number
      normalized?: boolean
    }
  | {
      status: 'rejected'
      issues: string[]
      reason: 'malformed' | 'unsupported' | 'too-large' | 'schema'
    }
export type Initialization<T> = {
  config: T
  notice: string
  source: 'default' | 'draft' | 'share'
  acceptance: 'accepted' | 'repair' | 'rejected'
  issues: string[]
  writeSafe: boolean
  recovery: Preservation[]
  originalPreserved: 'not-needed' | 'durable' | 'volatile'
  draftRaw: string | null
  storageFailure?: StorageFailure
}
export function initializeRecovery<T>(options: {
  fallback: T
  inspect(raw: string): DocumentInspection<T>
  hash: string
  storage?: StorageAccess
  draft?: Outcome<string | null>
}): Initialization<T> {
  const draft = options.draft ?? readStorage(options.storage, DRAFT_KEY)
  const state: Initialization<T> = {
    config: options.fallback,
    notice: '',
    source: 'default',
    acceptance: 'accepted',
    issues: [],
    writeSafe: draft.ok,
    recovery: [],
    originalPreserved: 'not-needed',
    draftRaw: draft.ok ? draft.value : null,
  }
  if (!draft.ok) state.storageFailure = draft.reason
  const preserve = (raw: string, source: RecoverySource, format: RecoveryRecord['format']) => {
    const preservation = preserveRaw(recoveryRecord(raw, source, format), options.storage)
    state.recovery.push(preservation)
    if (preservation.status === 'volatile') {
      state.writeSafe = false
      state.storageFailure = preservation.reason
    }
    state.originalPreserved = state.recovery.some((record) => record.status === 'volatile')
      ? 'volatile'
      : 'durable'
  }
  if (draft.ok && draft.value !== null) {
    const inspection = options.inspect(draft.value)
    if (inspection.status !== 'rejected') {
      state.config = inspection.config
      state.source = 'draft'
      state.acceptance = inspection.status
      state.issues = inspection.issues
    } else {
      state.acceptance = 'rejected'
      state.issues = inspection.issues
      state.writeSafe = false
    }
    if (
      inspection.status !== 'accepted' ||
      inspection.migratedFrom !== undefined ||
      inspection.normalized
    )
      preserve(draft.value, 'draft', 'encoded-config')
    if (inspection.status === 'repair') state.writeSafe = false
  }
  const params = new URLSearchParams(options.hash.replace(/^#/, ''))
  if (!params.has('c')) return state
  preserve(options.hash, 'share', 'hash')
  const inspection = options.inspect(params.get('c') ?? '')
  if (inspection.status === 'rejected') {
    state.notice =
      'This share link is invalid or unsupported. The prior draft has not been replaced.'
    state.issues = [...state.issues, ...inspection.issues]
    if (state.source === 'default') {
      state.acceptance = 'rejected'
      state.writeSafe = false
    }
    return state
  }
  if (draft.ok && draft.value !== null && draft.value !== params.get('c'))
    preserve(draft.value, 'displaced-draft', 'encoded-config')
  state.config = inspection.config
  state.source = 'share'
  state.acceptance = inspection.status
  state.issues = inspection.issues
  state.notice =
    inspection.status === 'repair'
      ? 'Shared design needs repair; its original input is preserved.'
      : 'Shared design loaded. Make it your own.'
  if (inspection.status === 'repair') state.writeSafe = false
  return state
}
