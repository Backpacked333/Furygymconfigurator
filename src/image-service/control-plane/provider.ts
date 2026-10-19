import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, normalize, parse } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { createMockArtifact } from '../protocol'
import {
  bindRequestSync,
  canonicalJson,
  checkedAdd,
  executionIdentitySchema,
  isSettledReceipt,
  providerReceiptSchema,
  sameExecution,
  signProviderReceipt,
  timestampSchema,
  unavailable,
  verifyDiagnosticArtifact,
  verifyProviderReceipt,
  verifyWorkerContext,
  workerClaimsSchema,
  type ExecutionIdentity,
  type FakeProvider,
  type FakeProviderOptions,
  type JobFailure,
  type ProviderExecution,
  type ProviderReceipt,
  type ProviderResult,
  type ReceiptClaims,
  type SignedWorkerContext,
  type StopReason,
  type WorkerClaims,
} from './contracts'

const APPLICATION_ID = 0x50303450
const MAX_EXECUTIONS = 4096 // Lifetime bound; tombstones are never pruned/reset.
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
const planSchema = z
  .object({
    mode: z.enum(['complete', 'hold', 'known-failure', 'unknown']).default('complete'),
    completeAfterMs: z.number().int().min(0).max(30_000).default(0),
    stopDelayMs: z.number().int().min(0).max(60_000).default(0),
    meterDelayMs: z.number().int().min(0).max(60_000).default(0),
    loseResponse: z.boolean().default(false),
    neverSettle: z.boolean().default(false),
  })
  .strict()
export type FakeExecutionPlan = Partial<z.infer<typeof planSchema>>
/** Private constructor-only fault injection. Persisted on first start, never accepted in a request. */
export type FakeProviderTestHooks = Readonly<{ plan?: (claims: WorkerClaims) => FakeExecutionPlan }>
const rowSchema = z
  .object({
    execution: executionIdentitySchema,
    claims: workerClaimsSchema.nullable(),
    resourceId: z
      .string()
      .regex(/^p04-fake-(image|export)-[a-f0-9]{64}$/)
      .nullable(),
    startedAt: timestampSchema.nullable(),
    plan: planSchema,
    stopAt: timestampSchema.nullable(),
    stopRequestedAt: timestampSchema.nullable(),
    stopReason: z.enum(['kill', 'deadline', 'lease-expired', 'orphan', 'shutdown']).nullable(),
    receipt: providerReceiptSchema,
  })
  .strict()
type Row = z.infer<typeof rowSchema>
const stopReasonSchema = z.enum(['kill', 'deadline', 'lease-expired', 'orphan', 'shutdown'])
const deniedFailure = (retryable = false): JobFailure => ({
  code: 'unavailable',
  message: 'Local diagnostic execution did not complete under its private bounds.',
  retryable,
})
const unknownFailure: JobFailure = {
  code: 'reconciliation-required',
  message: 'Local provider outcome is unconfirmed; retain execution liability.',
  retryable: false,
}

/** Separate SQLite authority for simulated resources, deliberately independent of dispatcher handles.
 * No real renderer, commands, hosts, streams, paid provider, or external network is invoked.
 * Simulated stop/proof times advance on inspection even when the dispatcher has exited.
 */
export class LocalFakeProvider implements FakeProvider {
  readonly provider = 'fake-local' as const
  readonly paidExecutionAllowed = false as const
  readonly #db: DatabaseSync
  readonly #path: string
  readonly #inode: Stats
  readonly #marker: string
  readonly #now: () => number
  readonly #contextSecret: string
  readonly #receiptSecret: string
  readonly #hooks: FakeProviderTestHooks
  #closed = false

  constructor(options: FakeProviderOptions, testHooks: FakeProviderTestHooks = {}) {
    let db: DatabaseSync | undefined
    try {
      this.#path = options.path
      this.#now = options.now ?? Date.now
      this.#contextSecret = options.contextSecret
      this.#receiptSecret = options.receiptSecret
      this.#hooks = testHooks
      if (
        !isAbsolute(options.path) ||
        normalize(options.path) !== options.path ||
        options.path === '/' ||
        Buffer.byteLength(options.contextSecret) < 32 ||
        Buffer.byteLength(options.receiptSecret) < 32 ||
        options.contextSecret === options.receiptSecret
      )
        throw unavailable()
      this.#checkParents()
      this.#marker = `${options.path}.p04-provider-identity`
      let fresh = false
      try {
        lstatSync(options.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        fresh = true
      }
      if (fresh) {
        const markerFd = openSync(this.#marker, 'wx', 0o600)
        try {
          writeFileSync(markerFd, `p04-provider@1\n${randomBytes(24).toString('hex')}\n`)
          fsyncSync(markerFd)
        } finally {
          closeSync(markerFd)
        }
        const directory = openSync(
          dirname(this.#path),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        try {
          fsyncSync(directory)
        } finally {
          closeSync(directory)
        }
        const fd = openSync(this.#path, 'wx', 0o600)
        closeSync(fd)
      }
      this.#inode = lstatSync(this.#path)
      this.#checkFile(this.#inode)
      const markerStat = lstatSync(this.#marker)
      this.#checkFile(markerStat)
      if (markerStat.size > 128) throw unavailable()
      const marker = readFileSync(this.#marker, 'utf8')
      if (!/^p04-provider@1\n[a-f0-9]{48}\n$/.test(marker)) throw unavailable()
      this.#checkSidecars()
      const native = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
      db = new native.DatabaseSync(this.#path)
      this.#db = db
      db.exec('PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF;')
      if (
        !fresh &&
        (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
          db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
          db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      )
        throw unavailable()
      db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=64; BEGIN IMMEDIATE;',
      )
      try {
        const keyBinding = createHash('sha256')
          .update(
            canonicalJson({
              domain: 'p04-provider-keys@1',
              marker,
              context: options.contextSecret,
              receipt: options.receiptSecret,
            }),
          )
          .digest('hex')
        if (fresh) {
          db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
            CREATE TABLE provider_meta (id INTEGER PRIMARY KEY CHECK(id=1), key_binding TEXT NOT NULL, last_now INTEGER NOT NULL) STRICT;
            CREATE TABLE provider_executions (id TEXT PRIMARY KEY, data TEXT NOT NULL, signature TEXT NOT NULL) STRICT;`)
          db.prepare('INSERT INTO provider_meta VALUES(1,?,?)').run(
            keyBinding,
            timestampSchema.parse(this.#now()),
          )
        } else if (
          db.prepare('SELECT key_binding FROM provider_meta WHERE id=1').get()?.key_binding !==
          keyBinding
        )
          throw unavailable()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch {
      try {
        db?.close()
      } catch {
        /* No reset or repair. */
      }
      throw unavailable('Durable local fake-provider state is unavailable; execution is denied.')
    }
  }

  #checkParents(): void {
    for (let current = dirname(this.#path); ; current = dirname(current)) {
      if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
        throw unavailable()
      if (current === parse(current).root) break
    }
  }
  #checkFile(stat: Stats): void {
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw unavailable()
  }
  #checkSidecars(): void {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        this.#checkFile(lstatSync(`${this.#path}${suffix}`))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  #transaction<T>(fn: (now: number) => T): T {
    if (this.#closed) throw unavailable()
    let begun = false
    try {
      this.#checkParents()
      const stat = lstatSync(this.#path)
      this.#checkFile(stat)
      this.#checkFile(lstatSync(this.#marker))
      if (stat.ino !== this.#inode.ino || stat.dev !== this.#inode.dev) throw unavailable()
      this.#checkSidecars()
      this.#db.exec('BEGIN IMMEDIATE')
      begun = true
      const now = timestampSchema.parse(this.#now())
      const last = this.#db.prepare('SELECT last_now FROM provider_meta WHERE id=1').get()?.last_now
      if (typeof last !== 'number' || now < last) throw unavailable()
      this.#db.prepare('UPDATE provider_meta SET last_now=? WHERE id=1').run(now)
      const result = fn(now)
      this.#db.exec('COMMIT')
      begun = false
      return result
    } catch {
      if (begun)
        try {
          this.#db.exec('ROLLBACK')
        } catch {
          /* Preserve durable evidence. */
        }
      throw unavailable('Durable local fake-provider state or signed execution validation failed.')
    }
  }
  #mac(data: string): string {
    return createHmac('sha256', this.#receiptSecret)
      .update(`p04-provider-row@1\n${data}`)
      .digest('hex')
  }
  #load(execution: ExecutionIdentity): Row | null {
    const value = this.#db
      .prepare('SELECT data, signature FROM provider_executions WHERE id=?')
      .get(execution.executionId)
    if (!value) return null
    if (
      typeof value.data !== 'string' ||
      value.data.length > 32_768 ||
      typeof value.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.signature) ||
      !timingSafeEqual(
        Buffer.from(value.signature, 'hex'),
        Buffer.from(this.#mac(value.data), 'hex'),
      )
    )
      throw unavailable()
    const row = rowSchema.parse(JSON.parse(value.data))
    if (
      !sameExecution(row.execution, execution) ||
      !sameExecution(row.receipt.claims.execution, execution)
    )
      throw unavailable()
    verifyProviderReceipt(row.receipt, this.#receiptSecret)
    return row
  }
  #save(row: Row): void {
    const data = canonicalJson(rowSchema.parse(row))
    this.#db
      .prepare(
        'INSERT INTO provider_executions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, signature=excluded.signature',
      )
      .run(row.execution.executionId, data, this.#mac(data))
  }
  #capacity(): void {
    const count = this.#db.prepare('SELECT count(*) AS n FROM provider_executions').get()?.n
    if (typeof count !== 'number' || count >= MAX_EXECUTIONS) throw unavailable()
  }
  #initial(execution: ExecutionIdentity, now: number, claims: WorkerClaims | null): Row {
    this.#capacity()
    const resourceId = claims
      ? `p04-fake-${claims.binding.purpose}-${createHash('sha256')
          .update(canonicalJson({ execution, type: claims.binding.purpose }))
          .digest('hex')}`
      : null
    return rowSchema.parse({
      execution,
      claims,
      resourceId,
      startedAt: claims ? now : null,
      plan: planSchema.parse(claims ? (this.#hooks.plan?.(claims) ?? {}) : {}),
      stopAt: null,
      stopRequestedAt: null,
      stopReason: null,
      receipt: signProviderReceipt(
        {
          execution,
          sequence: 1,
          observedAt: now,
          outcome: claims ? 'running' : 'unknown',
          cumulativeCostMicro: 0,
          runtimeMs: 0,
          finalMeter: false,
          startForbidden: false,
        },
        this.#receiptSecret,
      ),
    })
  }
  #receipt(row: Row, now: number, patch: Partial<ReceiptClaims>): void {
    const previous = row.receipt.claims
    const candidate = { ...previous, ...patch }
    // Stable reads are exactly idempotent, rather than inventing new meter events on each poll.
    if (equal(candidate, previous)) return
    row.receipt = signProviderReceipt(
      { ...candidate, sequence: checkedAdd(previous.sequence, 1), observedAt: now },
      this.#receiptSecret,
    )
  }
  #advance(row: Row, now: number): Row {
    if (isSettledReceipt(row.receipt.claims) || row.startedAt === null || row.claims === null)
      return row
    const claims = row.claims
    const capAt = checkedAdd(row.startedAt, claims.maxRuntimeMs)
    const completeAt = checkedAdd(row.startedAt, row.plan.completeAfterMs)
    const completed =
      row.receipt.claims.outcome === 'completed' ||
      (row.stopRequestedAt === null &&
        row.plan.mode === 'complete' &&
        completeAt < capAt &&
        now >= completeAt)
    if (row.stopRequestedAt === null && !completed && now >= capAt) {
      row.stopRequestedAt = capAt
      row.stopAt = capAt
      row.stopReason = 'deadline'
    }
    const stopAt = row.stopAt === null ? capAt : Math.min(row.stopAt, capAt)
    const endedAt = completed ? completeAt : stopAt
    const runtimeMs = Math.max(0, Math.min(now, endedAt) - row.startedAt)
    // Synthetic only: ceil(bound * runtime / runtime-cap), using exact integers; no real invoice claim.
    const cumulativeCostMicro = Number(
      (BigInt(claims.maxCostMicro) * BigInt(runtimeMs) + BigInt(claims.maxRuntimeMs) - 1n) /
        BigInt(claims.maxRuntimeMs),
    )
    let outcome: ReceiptClaims['outcome'] = row.plan.mode === 'unknown' ? 'unknown' : 'running'
    let finalMeter = false
    let startForbidden = row.stopRequestedAt !== null
    if (completed) {
      outcome = 'completed'
      startForbidden = true
      finalMeter = now >= checkedAdd(completeAt, row.plan.meterDelayMs)
    } else if (row.stopRequestedAt !== null) {
      outcome = now >= stopAt ? 'stopped' : 'stop-requested'
      finalMeter = now >= checkedAdd(stopAt, row.plan.meterDelayMs)
    }
    if (row.plan.neverSettle) {
      outcome = 'unknown'
      finalMeter = false
    }
    this.#receipt(row, now, { outcome, finalMeter, startForbidden, runtimeMs, cumulativeCostMicro })
    this.#save(row)
    return row
  }

  async execute(context: SignedWorkerContext): Promise<ProviderResult> {
    const claims = verifyWorkerContext(
      context,
      this.#contextSecret,
      timestampSchema.parse(this.#now()),
    )
    // Export sponsor is deliberately absent from worker claims. Its private cache key is signer-bound;
    // design/presentation/request digests are independently recomputed for both purposes.
    const expected = bindRequestSync(claims.design, 'image', {
      principalId: 'provider-private-0001',
      experimentId: 'provider-private-0001',
      scopes: ['images:read'],
    })
    if (
      !equal(expected.identity, claims.binding.identity) ||
      (claims.binding.purpose === 'image' && !equal(expected, claims.binding))
    )
      throw unavailable('Signed diagnostic request identity does not match its strict design.')
    let row = this.#transaction((now) => {
      if (now < claims.issuedAt || now >= claims.expiresAt) throw unavailable()
      const previous = this.#load(claims.execution)
      if (previous) {
        if (previous.claims && !equal(previous.claims, claims)) throw unavailable()
        return this.#advance(previous, now)
      }
      const fresh = this.#initial(claims.execution, now, claims)
      this.#save(fresh)
      if (fresh.plan.mode === 'known-failure') {
        fresh.stopRequestedAt = now
        fresh.stopAt = checkedAdd(now, fresh.plan.stopDelayMs)
        fresh.stopReason = 'shutdown'
        this.#save(fresh)
      }
      return this.#advance(fresh, now)
    })
    while (true) {
      const receipt = row.receipt
      if (row.claims === null || receipt.claims.outcome === 'stopped')
        return {
          outcome: 'failure',
          failure: deniedFailure(row.plan.mode === 'known-failure'),
          receipt,
        }
      if (row.plan.loseResponse)
        return { outcome: 'failure', failure: unknownFailure, receipt: null }
      if (row.plan.mode === 'unknown' || row.plan.neverSettle)
        return { outcome: 'failure', failure: unknownFailure, receipt }
      if (receipt.claims.outcome === 'completed' && receipt.claims.finalMeter) {
        const artifact = await createMockArtifact(claims.design)
        await verifyDiagnosticArtifact(artifact, claims.design, claims.maxOutputBytes)
        // Recheck durable tombstone/outcome after async deterministic hashing, never use a stale result.
        const current = await this.receipt(claims.execution)
        if (current.claims.outcome !== 'completed' || !current.claims.finalMeter)
          return { outcome: 'failure', failure: deniedFailure(), receipt: current }
        return { outcome: 'success', artifact, receipt: current }
      }
      // A held fake operation represents resource state only; never a graphics or provider call.
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      row = this.#transaction((now) => {
        const current = this.#load(claims.execution)
        if (!current) throw unavailable()
        return this.#advance(current, now)
      })
    }
  }

  async stop(executionInput: ExecutionIdentity, reasonInput: StopReason): Promise<ProviderReceipt> {
    const execution = executionIdentitySchema.parse(executionInput)
    const reason = stopReasonSchema.parse(reasonInput)
    return this.#transaction((now) => {
      const row = this.#advance(this.#load(execution) ?? this.#initial(execution, now, null), now)
      if (isSettledReceipt(row.receipt.claims)) return row.receipt
      if (row.startedAt === null) {
        row.stopRequestedAt = now
        row.stopAt = now
        row.stopReason = reason
        this.#receipt(row, now, { outcome: 'stopped', startForbidden: true, finalMeter: true })
      } else if (row.stopRequestedAt === null && row.receipt.claims.outcome !== 'completed') {
        row.stopRequestedAt = now
        row.stopAt = checkedAdd(now, row.plan.stopDelayMs)
        row.stopReason = reason
        this.#receipt(row, now, {
          outcome: 'stop-requested',
          startForbidden: true,
          finalMeter: false,
        })
      }
      this.#save(row) // Commit tombstone BEFORE returning any acknowledgement.
      return this.#advance(row, now).receipt
    })
  }

  async receipt(executionInput: ExecutionIdentity): Promise<ProviderReceipt> {
    const execution = executionIdentitySchema.parse(executionInput)
    return this.#transaction((now) => {
      const row = this.#load(execution)
      // Lookup alone never establishes termination or permission to refund/retry.
      return row
        ? this.#advance(row, now).receipt
        : signProviderReceipt(
            {
              execution,
              sequence: 1,
              observedAt: now,
              outcome: 'unknown',
              cumulativeCostMicro: 0,
              runtimeMs: 0,
              finalMeter: false,
              startForbidden: false,
            },
            this.#receiptSecret,
          )
    })
  }

  async inspect(): Promise<readonly ProviderExecution[]> {
    return this.#transaction((now) => {
      const ids = this.#db
        .prepare('SELECT id FROM provider_executions ORDER BY id LIMIT ?')
        .all(MAX_EXECUTIONS + 1)
      if (ids.length > MAX_EXECUTIONS) throw unavailable()
      return ids.map(({ id }) => {
        const raw = this.#db
          .prepare('SELECT data FROM provider_executions WHERE id=?')
          .get(String(id))
        if (typeof raw?.data !== 'string' || raw.data.length > 32_768) throw unavailable()
        const execution = executionIdentitySchema.parse((JSON.parse(raw.data) as Row).execution)
        const row = this.#load(execution)
        if (!row) throw unavailable()
        this.#advance(row, now)
        return { execution: row.execution, startedAt: row.startedAt, receipt: row.receipt }
      })
    })
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#db.close()
    }
    // A closed dispatcher handle is explicitly NOT stopped/final billing evidence.
  }
}
