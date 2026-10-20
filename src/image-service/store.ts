import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { parseDesign, type DesignEnvelope } from '../domain/design'
import {
  requestIdentitySchema,
  type ImageRequest,
  type ImageError,
  type MockArtifact,
} from './protocol'
import type { DesignIdentity } from '../domain/designIdentity'
import { capacity, ImageServiceError, unavailable } from './errors'

/** Synthetic CPU units only. This is NOT a dollar/provider budget. Persisted policy cannot be raised on reopen. */
export const mockPolicySchema = z
  .object({
    maxWorkUnits: z.number().int().min(1).max(10000).default(200),
    maxPrincipalWorkUnits: z.number().int().min(1).max(10000).default(40),
    maxAttempts: z.number().int().min(1).max(3).default(2),
    maxConcurrency: z.number().int().min(1).max(4).default(2),
    maxJobs: z.number().int().min(1).max(512).default(128),
    maxInterests: z.number().int().min(1).max(2048).default(512),
    maxPrincipalInterests: z.number().int().min(1).max(128).default(32),
    maxPrincipals: z.number().int().min(1).max(512).default(128),
    leaseMs: z.number().int().min(100).max(60000).default(10000),
    jobTtlMs: z.number().int().min(100).max(600000).default(60000),
    interestTtlMs: z.number().int().min(100).max(3600000).default(300000),
    retentionMs: z.number().int().min(100).max(86400000).default(86400000),
    retryDelayMs: z.number().int().min(0).max(30000).default(250),
  })
  .strict()
export type MockPolicy = z.infer<typeof mockPolicySchema>
export type MockStoreOptions = { path: string; policy?: Partial<MockPolicy>; now?: () => number }
const opaqueId = () => randomBytes(24).toString('base64url')
const principalSchema = z.string().regex(/^[A-Za-z0-9_-]{24,128}$/)
const jobSchema = z.object({
  id: z.string(),
  digest: z.string(),
  design: z.string(),
  identity: z.string(),
  sponsor: z.string(),
  state: z.enum(['queued', 'rendering', 'uncertain', 'ready', 'failed', 'expired']),
  attempts: z.number(),
  fence: z.number(),
  lease_until: z.number(),
  deadline: z.number(),
  available_at: z.number(),
  created_at: z.number(),
  finished_at: z.number().nullable(),
  artifact: z.string().nullable(),
  error: z.string().nullable(),
})
export type StoredJob = z.infer<typeof jobSchema>
export type MockLease = {
  jobId: string
  fence: number
  attempt: number
  deadline: number
  design: DesignEnvelope
  identity: DesignIdentity
}
export type StoredInterest = { id: string; cancelled: boolean; expiresAt: number; job: StoredJob }
export type MockLedger = {
  spent: number
  reserved: number
  killed: boolean
  jobs: number
  interests: number
  uncertain: number
}
const totalsSchema = z.object({ spent: z.number(), reserved: z.number(), killed: z.number() })
const balanceSchema = z.object({ spent: z.number(), reserved: z.number() })
const interestSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  digest: z.string(),
  cancelled: z.number(),
  expires_at: z.number(),
})
const countSchema = z.object({ n: z.number() })
const uncertainError: ImageError = {
  code: 'unavailable',
  message: 'Mock attempt outcome is unknown; reservation retained for local reconciliation.',
  retryable: false,
}

/** All state-changing operations are synchronous IMMEDIATE transactions; never await while locked. */
export class MockJobStore {
  readonly policy: Readonly<MockPolicy>
  private readonly db: DatabaseSync
  private readonly now: () => number
  private closed = false

  constructor(options: MockStoreOptions) {
    this.policy = Object.freeze(mockPolicySchema.parse(options.policy ?? {}))
    this.now = options.now ?? Date.now
    // Lazy native load also survives Vite's config bundling without requiring SQLite on the v3 path.
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite')
    this.db = new DatabaseSync(options.path)
    try {
      this.db.exec(
        'PRAGMA busy_timeout=500; PRAGMA foreign_keys=ON; PRAGMA max_page_count=8192; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=64;',
      )
      this.tx(() => {
        const version = z
          .object({ user_version: z.number() })
          .parse(this.db.prepare('PRAGMA user_version').get()).user_version
        if (version === 0) {
          if (this.count("SELECT count(*) AS n FROM sqlite_master WHERE type='table'") !== 0)
            throw unavailable()
          this.db.exec(`
            CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL, cookie_secret TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0), killed INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE principals (id TEXT PRIMARY KEY, spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0));
            CREATE TABLE jobs (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, design TEXT NOT NULL, identity TEXT NOT NULL, sponsor TEXT NOT NULL REFERENCES principals(id), state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, artifact TEXT, error TEXT);
            CREATE TABLE reservations (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, principal TEXT NOT NULL REFERENCES principals(id), units INTEGER NOT NULL CHECK(units>=0));
            CREATE TABLE interests (id TEXT PRIMARY KEY, principal TEXT NOT NULL REFERENCES principals(id), job_id TEXT NOT NULL REFERENCES jobs(id), digest TEXT NOT NULL, idempotency_key TEXT, cancelled INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, UNIQUE(principal,idempotency_key));
            CREATE INDEX interest_jobs ON interests(job_id);
            CREATE INDEX job_queue ON jobs(state,available_at,created_at);
            PRAGMA user_version=1;
          `)
          this.db
            .prepare('INSERT INTO control(id,policy,cookie_secret) VALUES(1,?,?)')
            .run(JSON.stringify(this.policy), randomBytes(32).toString('base64url'))
        } else if (version !== 1) throw unavailable()
        const saved = z
          .object({ policy: z.string() })
          .parse(this.db.prepare('SELECT policy FROM control WHERE id=1').get())
        if (saved.policy !== JSON.stringify(this.policy)) throw unavailable()
      })
    } catch (error) {
      this.db.close()
      throw error instanceof ImageServiceError ? error : unavailable()
    }
  }

  private tx<T>(fn: () => T): T {
    if (this.closed) throw unavailable()
    let began = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      if (began) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* Fail closed even when rollback is unavailable. */
        }
      }
      throw error instanceof ImageServiceError ? error : unavailable()
    }
  }

  private count(sql: string, ...params: (string | number)[]): number {
    return countSchema.parse(this.db.prepare(sql).get(...params)).n
  }
  private job(id: string): StoredJob {
    return jobSchema.parse(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id))
  }
  private checkAdmission(): void {
    if (
      totalsSchema.parse(
        this.db.prepare('SELECT spent,reserved,killed FROM control WHERE id=1').get(),
      ).killed
    )
      throw unavailable()
  }
  private release(jobId: string, spent: number, terminal: boolean): void {
    const held = z
      .object({ principal: z.string(), units: z.number() })
      .parse(this.db.prepare('SELECT principal,units FROM reservations WHERE job_id=?').get(jobId))
    if (spent > held.units) throw unavailable()
    const decrease = terminal ? held.units : spent
    this.db
      .prepare('UPDATE control SET spent=spent+?,reserved=reserved-? WHERE id=1')
      .run(spent, decrease)
    this.db
      .prepare('UPDATE principals SET spent=spent+?,reserved=reserved-? WHERE id=?')
      .run(spent, decrease, held.principal)
    this.db.prepare('UPDATE reservations SET units=units-? WHERE job_id=?').run(decrease, jobId)
  }
  private terminal(
    job: StoredJob,
    state: 'failed' | 'expired',
    error: ImageError | null,
    spent = 0,
  ): void {
    this.release(job.id, spent, true)
    this.db
      .prepare(
        'UPDATE jobs SET state=?,error=?,finished_at=?,fence=fence+1,lease_until=0 WHERE id=?',
      )
      .run(state, error ? JSON.stringify(error) : null, this.now(), job.id)
  }

  private sweep(): void {
    const now = this.now()
    for (const raw of this.db
      .prepare("SELECT * FROM jobs WHERE state='queued' AND deadline<=?")
      .all(now))
      this.terminal(jobSchema.parse(raw), 'expired', null)
    // Expiry is NOT proof that an in-flight execution stopped. Fence it and hold all liabilities.
    this.db
      .prepare(
        "UPDATE jobs SET state='uncertain',fence=fence+1,error=? WHERE state='rendering' AND (lease_until<=? OR deadline<=?)",
      )
      .run(JSON.stringify(uncertainError), now, now)
    this.db.prepare('DELETE FROM interests WHERE expires_at+?<=?').run(this.policy.retentionMs, now)
    this.db
      .prepare(
        "DELETE FROM jobs WHERE state IN ('ready','failed','expired') AND finished_at+?<=? AND NOT EXISTS (SELECT 1 FROM interests WHERE job_id=jobs.id)",
      )
      .run(this.policy.retentionMs, now)
    // Principal spent balances deliberately never reset or disappear during retention cleanup.
  }

  submit(principal: string, request: ImageRequest, identity: DesignIdentity): string {
    principalSchema.parse(principal)
    return this.tx(() => {
      this.sweep()
      this.checkAdmission()
      if (request.idempotencyKey) {
        const raw = this.db
          .prepare(
            'SELECT id,job_id,digest,cancelled,expires_at FROM interests WHERE principal=? AND idempotency_key=?',
          )
          .get(principal, request.idempotencyKey)
        if (raw) {
          const previous = interestSchema.parse(raw)
          if (previous.digest !== identity.requestDigest)
            throw new ImageServiceError(
              409,
              'idempotency-conflict',
              'Idempotency key is already bound to a different request.',
            )
          if (previous.cancelled || previous.expires_at <= this.now())
            throw new ImageServiceError(
              410,
              'expired',
              'This idempotent interest has ended; use a new key for a new interest.',
            )
          return previous.id
        }
      }
      if (
        this.count('SELECT count(*) AS n FROM interests') >= this.policy.maxInterests ||
        this.count('SELECT count(*) AS n FROM interests WHERE principal=?', principal) >=
          this.policy.maxPrincipalInterests
      )
        throw capacity()
      if (!this.db.prepare('SELECT id FROM principals WHERE id=?').get(principal)) {
        if (this.count('SELECT count(*) AS n FROM principals') >= this.policy.maxPrincipals)
          throw capacity()
        this.db.prepare('INSERT INTO principals(id) VALUES(?)').run(principal)
      }
      const existing = this.db
        .prepare('SELECT * FROM jobs WHERE digest=?')
        .get(identity.requestDigest)
      let jobId: string
      if (existing) {
        const job = jobSchema.parse(existing)
        if (job.state === 'failed' || job.state === 'expired' || job.state === 'uncertain')
          throw new ImageServiceError(
            503,
            'unavailable',
            'This mock job is terminal or awaiting local reconciliation; no replacement work admitted.',
            false,
          )
        jobId = job.id
      } else {
        if (this.count('SELECT count(*) AS n FROM jobs') >= this.policy.maxJobs) throw capacity()
        const global = totalsSchema.parse(
          this.db.prepare('SELECT spent,reserved,killed FROM control WHERE id=1').get(),
        )
        const account = balanceSchema.parse(
          this.db.prepare('SELECT spent,reserved FROM principals WHERE id=?').get(principal),
        )
        const units = this.policy.maxAttempts
        if (
          global.spent + global.reserved + units > this.policy.maxWorkUnits ||
          account.spent + account.reserved + units > this.policy.maxPrincipalWorkUnits
        )
          throw capacity()
        jobId = opaqueId()
        this.db.prepare('UPDATE control SET reserved=reserved+? WHERE id=1').run(units)
        this.db
          .prepare('UPDATE principals SET reserved=reserved+? WHERE id=?')
          .run(units, principal)
        this.db
          .prepare(
            "INSERT INTO jobs(id,digest,design,identity,sponsor,state,deadline,available_at,created_at) VALUES(?,?,?,?,?,'queued',?,?,?)",
          )
          .run(
            jobId,
            identity.requestDigest,
            JSON.stringify(request.design),
            JSON.stringify(identity),
            principal,
            this.now() + this.policy.jobTtlMs,
            this.now(),
            this.now(),
          )
        this.db
          .prepare('INSERT INTO reservations(job_id,principal,units) VALUES(?,?,?)')
          .run(jobId, principal, units)
      }
      const interestId = opaqueId()
      this.db
        .prepare(
          'INSERT INTO interests(id,principal,job_id,digest,idempotency_key,expires_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          interestId,
          principal,
          jobId,
          identity.requestDigest,
          request.idempotencyKey ?? null,
          this.now() + this.policy.interestTtlMs,
        )
      return interestId
    })
  }

  readInterest(principal: string, interestId: string): StoredInterest {
    return this.tx(() => {
      this.sweep()
      const row = this.db
        .prepare(
          'SELECT id,job_id,digest,cancelled,expires_at FROM interests WHERE principal=? AND id=?',
        )
        .get(principal, interestId)
      if (!row)
        throw new ImageServiceError(
          404,
          'not-found',
          'No image interest is available for this local principal.',
        )
      const interest = interestSchema.parse(row)
      return {
        id: interest.id,
        cancelled: !!interest.cancelled,
        expiresAt: interest.expires_at,
        job: this.job(interest.job_id),
      }
    })
  }

  detach(principal: string, interestId: string): void {
    this.tx(() => {
      const result = this.db
        .prepare('UPDATE interests SET cancelled=1 WHERE principal=? AND id=?')
        .run(principal, interestId)
      if (!result.changes)
        throw new ImageServiceError(
          404,
          'not-found',
          'No image interest is available for this local principal.',
        )
    })
  }

  claim(): MockLease | null {
    return this.tx(() => {
      this.sweep()
      this.checkAdmission()
      if (
        this.count("SELECT count(*) AS n FROM jobs WHERE state IN ('rendering','uncertain')") >=
        this.policy.maxConcurrency
      )
        return null
      const raw = this.db
        .prepare(
          "SELECT * FROM jobs WHERE state='queued' AND available_at<=? ORDER BY created_at,id LIMIT 1",
        )
        .get(this.now())
      if (!raw) return null
      const job = jobSchema.parse(raw)
      if (job.attempts >= this.policy.maxAttempts) throw unavailable()
      const fence = job.fence + 1
      const deadline = Math.min(this.now() + this.policy.leaseMs, job.deadline)
      this.db
        .prepare(
          "UPDATE jobs SET state='rendering',attempts=attempts+1,fence=?,lease_until=?,error=NULL WHERE id=?",
        )
        .run(fence, deadline, job.id)
      return {
        jobId: job.id,
        fence,
        attempt: job.attempts + 1,
        deadline,
        design: parseDesign(JSON.parse(job.design)),
        identity: requestIdentitySchema.parse(JSON.parse(job.identity)),
      }
    })
  }

  /** Optional local heartbeat, bounded by the original job deadline and the current fencing token. */
  renew(lease: MockLease): number | null {
    return this.tx(() => {
      this.sweep()
      this.checkAdmission()
      const job = this.job(lease.jobId)
      if (job.state !== 'rendering' || job.fence !== lease.fence) return null
      const deadline = Math.min(this.now() + this.policy.leaseMs, job.deadline)
      this.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(deadline, job.id)
      return deadline
    })
  }

  /** Called only after service-level deterministic byte/provenance verification. */
  publishVerified(lease: MockLease, artifact: MockArtifact): boolean {
    return this.tx(() => {
      this.sweep()
      this.checkAdmission()
      const job = this.job(lease.jobId)
      if (
        job.state !== 'rendering' ||
        job.fence !== lease.fence ||
        job.digest !== lease.identity.requestDigest
      )
        return false
      this.release(job.id, 1, true)
      this.db
        .prepare("UPDATE jobs SET state='ready',artifact=?,finished_at=?,lease_until=0 WHERE id=?")
        .run(JSON.stringify(artifact), this.now(), job.id)
      return true
    })
  }

  fail(lease: MockLease, error: ImageError, outcome: 'known' | 'unknown'): boolean {
    return this.tx(() => {
      this.sweep()
      const job = this.job(lease.jobId)
      if (job.state !== 'rendering' || job.fence !== lease.fence) return false
      if (outcome === 'unknown') {
        this.db
          .prepare("UPDATE jobs SET state='uncertain',fence=fence+1,error=? WHERE id=?")
          .run(JSON.stringify(uncertainError), job.id)
      } else if (
        error.retryable &&
        job.attempts < this.policy.maxAttempts &&
        this.now() + this.policy.retryDelayMs < job.deadline
      ) {
        this.release(job.id, 1, false)
        this.db
          .prepare(
            "UPDATE jobs SET state='queued',fence=fence+1,error=?,lease_until=0,available_at=? WHERE id=?",
          )
          .run(JSON.stringify(error), this.now() + this.policy.retryDelayMs, job.id)
      } else this.terminal(job, 'failed', error, 1)
      return true
    })
  }

  /** Local operator API ONLY. Assertion must follow proof the old mock execution stopped. No HTTP route. */
  reconcileStoppedMock(
    jobId: string,
    fence: number,
    evidence: { confirmedStopped: true },
  ): boolean {
    if (evidence.confirmedStopped !== true) throw unavailable()
    return this.tx(() => {
      this.sweep()
      const job = this.job(jobId)
      if (job.state !== 'uncertain' || job.fence !== fence) return false
      const killed = totalsSchema.parse(
        this.db.prepare('SELECT spent,reserved,killed FROM control WHERE id=1').get(),
      ).killed
      if (!killed && job.attempts < this.policy.maxAttempts && this.now() < job.deadline) {
        this.release(job.id, 1, false) // Conservative charge for an uncertain attempt, never a refund.
        this.db
          .prepare(
            "UPDATE jobs SET state='queued',fence=fence+1,lease_until=0,available_at=? WHERE id=?",
          )
          .run(this.now() + this.policy.retryDelayMs, job.id)
      } else
        this.terminal(job, this.now() >= job.deadline ? 'expired' : 'failed', uncertainError, 1)
      return true
    })
  }

  /** Irreversible in this API: persists across restart; cannot reset budgets or revive admission. */
  kill(): void {
    this.tx(() => {
      this.db.prepare('UPDATE control SET killed=1 WHERE id=1').run()
      for (const raw of this.db.prepare("SELECT * FROM jobs WHERE state='queued'").all())
        this.terminal(jobSchema.parse(raw), 'failed', {
          code: 'unavailable',
          message: 'Local operator disabled mock execution.',
          retryable: false,
        })
      this.db
        .prepare("UPDATE jobs SET state='uncertain',fence=fence+1,error=? WHERE state='rendering'")
        .run(JSON.stringify(uncertainError))
    })
  }

  inspect(): MockLedger {
    return this.tx(() => {
      this.sweep()
      const total = totalsSchema.parse(
        this.db.prepare('SELECT spent,reserved,killed FROM control WHERE id=1').get(),
      )
      return {
        ...total,
        killed: !!total.killed,
        jobs: this.count('SELECT count(*) AS n FROM jobs'),
        interests: this.count('SELECT count(*) AS n FROM interests'),
        uncertain: this.count("SELECT count(*) AS n FROM jobs WHERE state='uncertain'"),
      }
    })
  }
  uncertainAttempts(): { jobId: string; fence: number }[] {
    return this.tx(() => {
      this.sweep()
      return this.db
        .prepare("SELECT id,fence FROM jobs WHERE state='uncertain'")
        .all()
        .map((row) => {
          const value = z.object({ id: z.string(), fence: z.number() }).parse(row)
          return { jobId: value.id, fence: value.fence }
        })
    })
  }
  /** Server-only signing material; never include in diagnostics or wire replies. */
  principalSecret(): string {
    return this.tx(
      () =>
        z
          .object({ cookie_secret: z.string().min(40) })
          .parse(this.db.prepare('SELECT cookie_secret FROM control WHERE id=1').get())
          .cookie_secret,
    )
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
