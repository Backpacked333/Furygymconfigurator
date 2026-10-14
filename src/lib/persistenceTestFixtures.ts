import type { Mutation, StoredRecord, TransactionBackend } from './repository'
import type { Outcome, StorageAccess, StorageFailure } from './recovery'

export class TestStorage implements StorageAccess {
  readonly data = new Map<string, string>()
  denyRead = false
  denyWrite = false
  get length() {
    return this.data.size
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }
  getItem(key: string) {
    if (this.denyRead) throw new Error('Denied')
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.denyWrite) throw new DOMException('Full', 'QuotaExceededError')
    this.data.set(key, value)
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
}

// Deterministic transaction-contract fake; this is not an IndexedDB/browser implementation test.
export class TestBackend implements TransactionBackend {
  readonly rows = new Map<string, StoredRecord>()
  writes = 0
  fail?: StorageFailure
  beforeTransaction?: () => void
  private queue: Promise<unknown> = Promise.resolve()
  close() {}
  atomic<T>(operation: (rows: readonly StoredRecord[]) => Mutation<T>): Promise<Outcome<T>> {
    const task = this.queue.then((): Outcome<T> => {
      this.beforeTransaction?.()
      if (this.fail) return { ok: false, reason: this.fail }
      const snapshot = structuredClone([...this.rows.values()])
      const mutation = operation(snapshot)
      if ('failure' in mutation) return { ok: false, reason: mutation.failure }
      for (const row of mutation.writes ?? []) {
        this.rows.set(row.key, structuredClone(row))
        this.writes++
      }
      return { ok: true, value: mutation.value }
    })
    this.queue = task
    return task
  }
}
