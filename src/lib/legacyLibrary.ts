import type { SavedBuild } from './config'
import { inspectBuild, salvageLibrary, type LibraryEntry, type RejectedRecord } from './repository'
import {
  browserStorage,
  failureReason,
  LEGACY_LIBRARY_KEY,
  rawBytes,
  readStorage,
  type StorageAccess,
  type StorageFailure,
} from './recovery'

const PREFIX = 'fury-build-op-v1:'
const MAX_JOURNAL_RECORDS = 256
type Operation = {
  version: 1
  id: string
  token: string
  parent: string | null
  deleted: boolean
  raw: string
}
export type LegacyLibrarySnapshot = {
  entries: LibraryEntry[]
  rejected: RejectedRecord[]
  conflicts: string[]
  heads: Map<string, string>
  tombstones: { id: string; raw: string; revision: number }[]
  rawSources: { key: string; raw: string }[]
  failure?: StorageFailure
}
const observed = new WeakMap<StorageAccess, Map<string, string>>()
export class LibraryPersistenceError extends Error {
  constructor(readonly reason: StorageFailure) {
    super(`Library persistence failed: ${reason}`)
    this.name = 'LibraryPersistenceError'
  }
}
export function readLegacyLibrary(storage = browserStorage()): LegacyLibrarySnapshot {
  const state: LegacyLibrarySnapshot = {
    entries: [],
    rejected: [],
    conflicts: [],
    heads: new Map(),
    tombstones: [],
    rawSources: [],
  }
  const read = readStorage(storage, LEGACY_LIBRARY_KEY)
  if (!read.ok) {
    state.failure = read.reason
    return state
  }
  const operations: Operation[] = []
  if (read.value !== null) {
    state.rawSources.push({ key: LEGACY_LIBRARY_KEY, raw: read.value })
    if (rawBytes(read.value) > 256_000) {
      state.failure = 'too-large'
      return state
    }
    const salvage = salvageLibrary(read.value)
    if (salvage.malformed)
      state.rejected.push({
        key: LEGACY_LIBRARY_KEY,
        raw: read.value,
        revision: 0,
        reason: 'malformed',
      })
    for (const record of salvage.records) {
      const inspected = inspectBuild(record.raw)
      if ('reason' in inspected || record.key.startsWith('rejected:'))
        state.rejected.push({
          ...record,
          revision: 0,
          reason: 'reason' in inspected ? inspected.reason : 'schema',
        })
      else
        operations.push({
          version: 1,
          id: inspected.build.id,
          token: `legacy:${record.raw}`,
          parent: null,
          deleted: false,
          raw: record.raw,
        })
    }
  }
  try {
    if (storage!.key && typeof storage!.length === 'number') {
      if (storage!.length > 10_000) {
        state.failure = 'capacity'
        return state
      }
      const keys: string[] = []
      for (let i = 0; i < storage!.length; i++) {
        const key = storage!.key(i)
        if (key?.startsWith(PREFIX)) keys.push(key)
      }
      if (keys.length > MAX_JOURNAL_RECORDS) {
        state.failure = 'capacity'
        return state
      }
      for (const key of keys) {
        const raw = storage!.getItem(key)
        if (raw === null) continue
        state.rawSources.push({ key, raw })
        if (rawBytes(raw) > 64_000) {
          state.rejected.push({ key, raw, revision: 0, reason: 'schema' })
          continue
        }
        try {
          const op = JSON.parse(raw) as Operation
          if (
            op.version !== 1 ||
            typeof op.id !== 'string' ||
            !op.id ||
            typeof op.token !== 'string' ||
            key !== `${PREFIX}${op.token}` ||
            (op.parent !== null && typeof op.parent !== 'string') ||
            typeof op.deleted !== 'boolean' ||
            typeof op.raw !== 'string'
          )
            state.rejected.push({ key, raw, revision: 0, reason: 'unsupported' })
          else operations.push(op)
        } catch {
          state.rejected.push({ key, raw, revision: 0, reason: 'malformed' })
        }
      }
    }
  } catch (error) {
    state.failure = failureReason(error, true)
    return state
  }
  for (const id of new Set(operations.map((op) => op.id))) {
    const rows = operations.filter((op) => op.id === id)
    const heads = rows.filter((row) => !rows.some((other) => other.parent === row.token))
    const ancestors = new Set<string>()
    let ancestor: Operation | undefined = heads.length === 1 ? heads[0] : undefined
    while (ancestor && !ancestors.has(ancestor.token)) {
      ancestors.add(ancestor.token)
      ancestor = rows.find((row) => row.token === ancestor!.parent)
    }
    if (
      heads.length !== 1 ||
      ancestors.size !== rows.length ||
      rows.some((row) => row.parent !== null && !rows.some((parent) => parent.token === row.parent))
    ) {
      state.conflicts.push(id)
      for (const row of rows)
        state.rejected.push({
          key: `${PREFIX}${row.token}`,
          raw: row.raw,
          revision: rows.length,
          reason: 'schema',
        })
      continue
    }
    const head = heads[0]
    state.heads.set(id, head.token)
    if (rows.some((row) => row.deleted)) {
      state.tombstones.push({ id, raw: head.raw, revision: rows.length })
      continue
    }
    const inspected = inspectBuild(head.raw)
    if ('reason' in inspected || inspected.build.id !== id)
      state.rejected.push({
        key: `${PREFIX}${head.token}`,
        raw: head.raw,
        revision: rows.length,
        reason: 'reason' in inspected ? inspected.reason : 'schema',
      })
    else state.entries.push({ ...inspected, revision: rows.length })
  }
  return state
}
export function readSavedState(storage = browserStorage()): LegacyLibrarySnapshot {
  const result = readLegacyLibrary(storage)
  if (storage && !result.failure) observed.set(storage, new Map(result.heads))
  return result
}
export function readSavedCompat(): SavedBuild[] {
  const result = readSavedState()
  if (result.failure || result.conflicts.length || result.rejected.length)
    throw new LibraryPersistenceError(
      result.failure ?? (result.conflicts.length ? 'conflict' : 'corrupt-store'),
    )
  return result.entries.map((entry) => entry.build)
}
export function writeSavedCompat(builds: SavedBuild[], storage = browserStorage()): void {
  if (!storage) throw new LibraryPersistenceError('unavailable')
  const snapshot = readLegacyLibrary(storage)
  if (snapshot.failure) throw new LibraryPersistenceError(snapshot.failure)
  if (!storage.key || typeof storage.length !== 'number')
    throw new LibraryPersistenceError('transaction-required')
  if (builds.length > 12 || new Set(builds.map((build) => build.id)).size !== builds.length)
    throw new LibraryPersistenceError('capacity')
  const base = observed.get(storage) ?? new Map<string, string>()
  const operations: Operation[] = []
  for (const build of builds) {
    const raw = JSON.stringify(build),
      inspected = inspectBuild(raw)
    if ('reason' in inspected || inspected.status !== 'accepted')
      throw new LibraryPersistenceError('corrupt-store')
    const current = snapshot.entries.find((entry) => entry.build.id === build.id)
    if (current && JSON.stringify(current.build) === raw) continue
    if (
      snapshot.conflicts.includes(build.id) ||
      (snapshot.heads.get(build.id) ?? null) !== (base.get(build.id) ?? null) ||
      (!current && snapshot.heads.has(build.id))
    )
      throw new LibraryPersistenceError('conflict')
    operations.push({
      version: 1,
      id: build.id,
      parent: base.get(build.id) ?? null,
      token: crypto.randomUUID(),
      deleted: false,
      raw,
    })
  }
  for (const [id, token] of base) {
    if (
      builds.some((build) => build.id === id) ||
      !snapshot.entries.some((entry) => entry.build.id === id)
    )
      continue
    if (snapshot.heads.get(id) !== token) throw new LibraryPersistenceError('conflict')
    operations.push({
      version: 1,
      id,
      parent: token,
      token: crypto.randomUUID(),
      deleted: true,
      raw: JSON.stringify(snapshot.entries.find((entry) => entry.build.id === id)!.build),
    })
  }
  if (
    snapshot.rawSources.filter((source) => source.key.startsWith(PREFIX)).length +
      operations.length >
    MAX_JOURNAL_RECORDS
  )
    throw new LibraryPersistenceError('capacity')
  try {
    for (const op of operations) {
      const raw = JSON.stringify(op)
      if (rawBytes(raw) > 64_000) throw new LibraryPersistenceError('too-large')
      // Unique immutable keys retain racing writes. Conflicting branches are exposed on read, never resolved by last-writer-wins.
      storage.setItem(`${PREFIX}${op.token}`, raw)
      if (storage.getItem(`${PREFIX}${op.token}`) !== raw)
        throw new LibraryPersistenceError('write-failed')
    }
  } catch (error) {
    if (error instanceof LibraryPersistenceError) throw error
    throw new LibraryPersistenceError(failureReason(error))
  }
  const after = readLegacyLibrary(storage)
  if (after.failure || after.conflicts.length)
    throw new LibraryPersistenceError(after.failure ?? 'conflict')
  observed.set(storage, after.heads)
}
