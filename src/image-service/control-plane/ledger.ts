import { createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { mockArtifactDimensions } from '../protocol'
import {
  ControlError,
  artifactDescriptorSchema,
  assertTransition,
  authContextSchema,
  bindRequestSync,
  canonicalJson,
  checkedAdd,
  errorSchema,
  eventKindSchema,
  executionIdentitySchema,
  exportRequestSchema,
  imageRequestSchema,
  isSettledReceipt,
  jobStateSchema,
  objectKeySchema,
  opaqueIdSchema,
  policySchema,
  providerReceiptSchema,
  purposeSchema,
  quoteSchema,
  requestBindingSchema,
  safeIntegerSchema,
  sameExecution,
  timestampSchema,
  unavailable,
  verifyObjectReceipt,
  verifyProviderReceipt,
  worstCaseQuote,
  type Admission,
  type AdmissionResult,
  type ArtifactDescriptor,
  type AuthContext,
  type InterestView,
  type JobFailure,
  type JobRecord,
  type JobState,
  type KillResult,
  type Lease,
  type Ledger,
  type LedgerOptions,
  type LedgerSnapshot,
  type LifecycleEvent,
  type Policy,
  type ProviderReceipt,
  type RecoveryReport,
  type Scope,
  type StagedObject,
  type StreamLease,
  type VerifiedObject,
} from './contracts'

// Independent P04 namespace; no migrations or access to the retained mock ledger.
// A bounded checkpoint plus append-only events commits under one BEGIN IMMEDIATE lock.
// This deliberately favors simple cross-process atomicity over high-throughput SQL queries.
const SCHEMA = 'p04-ledger-checkpoint@1'
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024
const NORMAL_EVENT_LIMIT = 65_536
const HARD_EVENT_LIMIT = NORMAL_EVENT_LIMIT + 32_768 // reserved for kill/final reconciliation
const EVENT_READ_LIMIT = 4096
const eventSchema = z
  .object({
    sequence: safeIntegerSchema,
    at: timestampSchema,
    jobId: opaqueIdSchema.nullable(),
    kind: eventKindSchema,
    fromState: jobStateSchema.nullable(),
    toState: jobStateSchema.nullable(),
    fence: safeIntegerSchema.nullable(),
    executionId: opaqueIdSchema.nullable(),
    detail: z
      .string()
      .max(240)
      .regex(/^[A-Za-z0-9=; -]*$/),
  })
  .strict()
const workerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const stageSchema = z
  .object({
    stageId: opaqueIdSchema,
    execution: executionIdentitySchema,
    object: artifactDescriptorSchema,
    stagedAt: timestampSchema,
  })
  .strict()
const leaseSchema = z
  .object({
    execution: executionIdentitySchema,
    workerId: workerIdSchema,
    design: imageRequestSchema.shape.design,
    binding: requestBindingSchema,
    quote: quoteSchema,
    leaseUntil: timestampSchema,
    deadline: timestampSchema,
    policy: policySchema,
  })
  .strict()
const balanceSchema = z
  .object({
    id: z.string().min(1).max(128),
    spentMicro: safeIntegerSchema,
    reservedMicro: safeIntegerSchema,
    uniqueMisses: safeIntegerSchema,
  })
  .strict()
const jobSchema = z
  .object({
    record: z
      .object({
        id: opaqueIdSchema,
        design: imageRequestSchema.shape.design,
        binding: requestBindingSchema,
        state: jobStateSchema,
        sponsorPrincipalId: opaqueIdSchema,
        sponsorExperimentId: opaqueIdSchema,
        quote: quoteSchema,
        fence: safeIntegerSchema,
        attempts: safeIntegerSchema,
        execution: executionIdentitySchema.nullable(),
        leaseUntil: timestampSchema,
        deadline: timestampSchema,
        availableAt: timestampSchema,
        createdAt: timestampSchema,
        finishedAt: timestampSchema.nullable(),
        reconciliationRequired: z.boolean(),
        reservedMicro: safeIntegerSchema,
        spentMicro: safeIntegerSchema,
        artifact: artifactDescriptorSchema.nullable(),
        error: errorSchema.nullable(),
      })
      .strict(),
    workerId: workerIdSchema.nullable(),
    stage: stageSchema.nullable(),
    deliveries: safeIntegerSchema,
    deliveryRemainingBytes: safeIntegerSchema,
    overheadCharged: z.boolean(),
    deletedObjectKey: objectKeySchema.nullable(),
  })
  .strict()
const interestSchema = z
  .object({
    record: z
      .object({
        id: opaqueIdSchema,
        jobId: opaqueIdSchema,
        principalId: opaqueIdSchema,
        experimentId: opaqueIdSchema,
        idempotencyKey: opaqueIdSchema,
        cancelled: z.boolean(),
        createdAt: timestampSchema,
        expiresAt: timestampSchema,
      })
      .strict(),
    expiredLogged: z.boolean(),
  })
  .strict()
const executionSchema = z
  .object({
    execution: executionIdentitySchema,
    createdAt: timestampSchema,
    active: z.boolean(),
    lastReceipt: providerReceiptSchema.nullable(),
    rejectedReceipt: providerReceiptSchema.nullable(),
    breached: z.boolean(),
  })
  .strict()
const streamSchema = z
  .object({
    id: opaqueIdSchema,
    jobId: opaqueIdSchema,
    principalId: opaqueIdSchema,
    openedAt: timestampSchema,
    expiresAt: timestampSchema,
    state: z.enum(['open', 'stop-requested', 'closed']),
  })
  .strict()
const markerSchema = z.object({ schema: z.literal(SCHEMA), storeId: opaqueIdSchema }).strict()
const stateSchema = z
  .object({
    schema: z.literal(SCHEMA),
    storeId: opaqueIdSchema,
    policy: policySchema,
    receiptKeyBinding: z.string().length(64),
    objectKeyBinding: z.string().length(64),
    lastNow: timestampSchema,
    killedAt: timestampSchema.nullable(),
    killReason: z.string().max(120).nullable(),
    global: balanceSchema,
    experiments: z.array(balanceSchema).max(32),
    principals: z.array(balanceSchema).max(512),
    jobs: z.array(jobSchema).max(512),
    interests: z.array(interestSchema).max(2048),
    executions: z.array(executionSchema).max(1536),
    streams: z.array(streamSchema).max(4096),
    storageBytes: safeIntegerSchema,
    deliveredBytes: safeIntegerSchema,
    eventCount: safeIntegerSchema,
    retiredObjectKeys: z.array(objectKeySchema).max(512),
  })
  .strict()
type State = z.infer<typeof stateSchema>
type StoredJob = z.infer<typeof jobSchema>
type StoredExecution = z.infer<typeof executionSchema>
type StoredInterest = z.infer<typeof interestSchema>
const id = () => randomBytes(24).toString('base64url')
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
const terminal = (state: JobState) => ['ready', 'failed', 'cancelled', 'expired'].includes(state)
const keyBinding = (secret: string, purpose: string) =>
  createHmac('sha256', secret).update(`${SCHEMA}/${purpose}`).digest('hex')
const invalid = () =>
  new ControlError(422, 'invalid-request', 'Private ledger input failed strict validation.')
const capacity = () =>
  new ControlError(429, 'capacity-exceeded', 'A durable capacity limit has been reached.')
const ended = () =>
  new ControlError(410, 'expired', 'This interest or immutable revision is no longer available.')

/** Local-only durable ledger. Keys, policy, kill, spent and tombstones cannot be reset on reopen. */
export class SqliteLedger implements Ledger {
  readonly policy: Policy
  private readonly db: DatabaseSync
  private readonly clock: () => number
  private readonly receiptSecret: string
  private readonly objectSecret: string
  private readonly path: string
  private readonly inode: number
  private readonly device: number
  private readonly markerPath: string
  private readonly markerInode: number
  private readonly storeId: string
  private closed = false

  constructor(options: LedgerOptions) {
    let opened: DatabaseSync | undefined
    try {
      if (
        !isAbsolute(options.path) ||
        options.path.includes('\0') ||
        Buffer.byteLength(options.receiptSecret, 'utf8') < 32 ||
        Buffer.byteLength(options.objectSecret, 'utf8') < 32
      )
        throw unavailable()
      this.path = resolve(options.path)
      if (realpathSync(dirname(this.path)) !== dirname(this.path)) throw unavailable()
      this.receiptSecret = options.receiptSecret
      this.objectSecret = options.objectSecret
      this.clock = options.now ?? Date.now
      const suppliedPolicy =
        options.policy === undefined ? null : policySchema.parse(options.policy)
      if (suppliedPolicy) worstCaseQuote(suppliedPolicy)
      this.markerPath = `${this.path}.p04-identity`
      const exists = (path: string) => {
        try {
          lstatSync(path)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      }
      // The durable companion identity distinguishes a lost DB from first creation.
      // Never remove it: deleting only the DB must not silently reset budgets.
      let created = false
      if (!exists(this.markerPath)) {
        if (exists(this.path)) throw unavailable()
        const marker = markerSchema.parse({ schema: SCHEMA, storeId: id() })
        const fd = openSync(this.markerPath, 'wx', 0o600)
        try {
          writeFileSync(fd, JSON.stringify(marker))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        const parent = openSync(dirname(this.path), 'r')
        try {
          fsyncSync(parent)
        } finally {
          closeSync(parent)
        }
        const database = openSync(this.path, 'wx', 0o600)
        closeSync(database)
        created = true
      }
      const markerStat = lstatSync(this.markerPath)
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 512)
        throw unavailable()
      this.markerInode = markerStat.ino
      this.storeId = markerSchema.parse(JSON.parse(readFileSync(this.markerPath, 'utf8'))).storeId
      const stat = lstatSync(this.path)
      if (!stat.isFile() || stat.isSymbolicLink() || (!created && stat.size === 0))
        throw unavailable()
      this.inode = stat.ino
      this.device = stat.dev
      opened = new DatabaseSync(this.path)
      this.db = opened
      opened.exec(
        'PRAGMA busy_timeout=50; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;',
      )
      // No WAL readers holding obsolete checkpoints; DELETE journal commits are FULL-synchronous.
      const journal = opened.prepare('PRAGMA journal_mode=DELETE').get()
      if (journal?.journal_mode !== 'delete') throw unavailable()
      opened.exec('PRAGMA max_page_count=16384; BEGIN IMMEDIATE')
      try {
        if (created) {
          opened.exec(`CREATE TABLE p04_checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= ${MAX_CHECKPOINT_BYTES}));
            CREATE TABLE p04_events (sequence INTEGER PRIMARY KEY, job_id TEXT,
            payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 1024));
            CREATE INDEX p04_events_job ON p04_events(job_id, sequence);`)
          const policy = suppliedPolicy ?? policySchema.parse({})
          worstCaseQuote(policy)
          const state: State = {
            schema: SCHEMA,
            storeId: this.storeId,
            policy,
            receiptKeyBinding: keyBinding(this.receiptSecret, 'receipt'),
            objectKeyBinding: keyBinding(this.objectSecret, 'object'),
            lastNow: timestampSchema.parse(this.clock()),
            killedAt: null,
            killReason: null,
            global: { id: 'global', spentMicro: 0, reservedMicro: 0, uniqueMisses: 0 },
            experiments: [],
            principals: [],
            jobs: [],
            interests: [],
            executions: [],
            streams: [],
            storageBytes: 0,
            deliveredBytes: 0,
            eventCount: 0,
            retiredObjectKeys: [],
          }
          opened.prepare('INSERT INTO p04_checkpoint VALUES (1, ?)').run(JSON.stringify(state))
        }
        const state = this.load()
        if (
          state.storeId !== this.storeId ||
          (suppliedPolicy && !equal(state.policy, suppliedPolicy)) ||
          state.receiptKeyBinding !== keyBinding(this.receiptSecret, 'receipt') ||
          state.objectKeyBinding !== keyBinding(this.objectSecret, 'object')
        )
          throw unavailable()
        this.policy = Object.freeze({ ...state.policy })
        this.assertInvariants(state)
        const count = opened
          .prepare('SELECT count(*) AS n, coalesce(max(sequence),0) AS last FROM p04_events')
          .get()
        if (count?.n !== state.eventCount || count?.last !== state.eventCount) throw unavailable()
        opened.exec('COMMIT')
      } catch (error) {
        opened.exec('ROLLBACK')
        throw error
      }
    } catch {
      try {
        opened?.close()
      } catch {
        /* original unavailable outcome is authoritative */
      }
      throw unavailable()
    }
  }

  private load(): State {
    const row = this.db.prepare('SELECT payload FROM p04_checkpoint WHERE singleton=1').get()
    if (
      !row ||
      typeof row.payload !== 'string' ||
      Buffer.byteLength(row.payload) > MAX_CHECKPOINT_BYTES
    )
      throw unavailable()
    return stateSchema.parse(JSON.parse(row.payload))
  }

  private assertInvariants(s: State): void {
    const p = s.policy
    if (
      s.jobs.length > p.maxJobs ||
      s.interests.length > p.maxInterests ||
      s.principals.length > p.maxPrincipals ||
      s.experiments.length > p.maxExperiments ||
      s.global.uniqueMisses !== s.jobs.length ||
      s.global.uniqueMisses > p.maxUniqueMisses ||
      s.storageBytes > p.maxStorageBytes ||
      checkedAdd(s.deliveredBytes, ...s.jobs.map((j) => j.deliveryRemainingBytes)) >
        p.maxDeliveryBytes ||
      s.executions.filter((e) => e.active).length > p.maxConcurrency ||
      s.eventCount > HARD_EVENT_LIMIT ||
      s.storageBytes !== checkedAdd(...s.jobs.map((j) => j.record.quote.reservedStorageBytes)) ||
      s.streams.filter((stream) => stream.state !== 'closed').length > p.maxStreams
    )
      throw unavailable()
    const unique = (values: readonly string[]) => new Set(values).size === values.length
    if (
      !unique(s.jobs.map((j) => j.record.id)) ||
      !unique(s.interests.map((i) => i.record.id)) ||
      !unique(
        s.interests.map(
          (i) => `${i.record.principalId}/${i.record.experimentId}/${i.record.idempotencyKey}`,
        ),
      ) ||
      !unique(s.executions.map((e) => e.execution.executionId)) ||
      !unique(s.principals.map((a) => a.id)) ||
      !unique(s.experiments.map((a) => a.id)) ||
      !unique(s.retiredObjectKeys) ||
      !unique(s.streams.map((stream) => stream.id))
    )
      throw unavailable()
    for (const [accounts, limit, kind] of [
      [[s.global], p.globalBudgetMicro, 'global'],
      [s.principals, p.principalBudgetMicro, 'principal'],
      [s.experiments, p.experimentBudgetMicro, 'experiment'],
    ] as const) {
      for (const account of accounts) {
        const jobs = s.jobs.filter(
          (j) =>
            kind === 'global' ||
            (kind === 'principal' ? j.record.sponsorPrincipalId : j.record.sponsorExperimentId) ===
              account.id,
        )
        if (
          checkedAdd(account.spentMicro, account.reservedMicro) > limit ||
          account.spentMicro !== checkedAdd(...jobs.map((j) => j.record.spentMicro)) ||
          account.reservedMicro !== checkedAdd(...jobs.map((j) => j.record.reservedMicro)) ||
          account.uniqueMisses !== jobs.length ||
          (kind === 'principal' && account.uniqueMisses > p.maxPrincipalUniqueMisses)
        )
          throw unavailable()
      }
    }
    for (const j of s.jobs) {
      const r = j.record
      const executions = s.executions.filter((e) => e.execution.jobId === r.id)
      const expectedSpent = checkedAdd(
        ...executions.map((e) => e.lastReceipt?.claims.cumulativeCostMicro ?? 0),
        j.overheadCharged ? checkedAdd(r.quote.storage, r.quote.delivery) : 0,
      )
      if (
        r.attempts > p.maxAttempts ||
        checkedAdd(r.spentMicro, r.reservedMicro) > r.quote.total ||
        ['requested', 'reserved'].includes(r.state) ||
        r.spentMicro !== expectedSpent ||
        r.reservedMicro !== (terminal(r.state) ? 0 : r.quote.total - r.spentMicro) ||
        !equal(r.quote, worstCaseQuote(p)) ||
        r.deadline !== checkedAdd(r.createdAt, p.jobTtlMs) ||
        !equal(
          r.binding,
          bindRequestSync(r.design, r.binding.purpose, {
            principalId: r.sponsorPrincipalId,
            experimentId: r.sponsorExperimentId,
            scopes: ['images:read'],
          }),
        ) ||
        !s.principals.some((a) => a.id === r.sponsorPrincipalId) ||
        !s.experiments.some((a) => a.id === r.sponsorExperimentId) ||
        (r.reconciliationRequired && terminal(r.state)) ||
        (r.state === 'ready' && !r.artifact) ||
        (r.artifact && !this.matchesObject(j, r.artifact)) ||
        s.executions.filter((e) => e.execution.jobId === r.id).length !== r.attempts ||
        (r.execution && !s.executions.some((e) => sameExecution(e.execution, r.execution!)))
      )
        throw unavailable()
    }
    for (const execution of s.executions) {
      const j = s.jobs.find((j) => j.record.id === execution.execution.jobId)
      if (
        !j ||
        (execution.active &&
          (!j.record.execution ||
            !sameExecution(execution.execution, j.record.execution) ||
            !['leased', 'rendering', 'publishing'].includes(j.record.state))) ||
        (!execution.active &&
          (!execution.lastReceipt || !isSettledReceipt(execution.lastReceipt.claims)))
      )
        throw unavailable()
      for (const receipt of [execution.lastReceipt, execution.rejectedReceipt])
        if (receipt) {
          try {
            if (
              !sameExecution(
                verifyProviderReceipt(receipt, this.receiptSecret).execution,
                execution.execution,
              )
            )
              throw unavailable()
          } catch {
            throw unavailable()
          }
        }
    }
    for (const interest of s.interests)
      if (
        !s.jobs.some((j) => j.record.id === interest.record.jobId) ||
        !s.principals.some((a) => a.id === interest.record.principalId) ||
        !s.experiments.some((a) => a.id === interest.record.experimentId)
      )
        throw unavailable()
    for (const principal of s.principals)
      if (
        s.interests.filter((i) => i.record.principalId === principal.id).length >
        p.maxPrincipalInterests
      )
        throw unavailable()
  }

  private tx<T>(operation: (s: State, now: number) => T): T {
    let begun = false
    try {
      if (this.closed) throw unavailable()
      const stat = lstatSync(this.path)
      const marker = lstatSync(this.markerPath)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== this.inode ||
        stat.dev !== this.device ||
        !marker.isFile() ||
        marker.isSymbolicLink() ||
        marker.ino !== this.markerInode
      )
        throw unavailable()
      this.db.exec('BEGIN IMMEDIATE')
      begun = true
      let s = this.load()
      if (!equal(s.policy, this.policy) || s.storeId !== this.storeId) throw unavailable()
      const rawNow = timestampSchema.parse(this.clock())
      // Commit safety action independently: a rejected admission must not roll back
      // clock-regression kill. Reacquire/reload after commit to avoid lost updates.
      if (rawNow < s.lastNow) {
        this.enableKill(s, s.lastNow, 'clock-regression')
        this.assertInvariants(s)
        this.db
          .prepare('UPDATE p04_checkpoint SET payload=? WHERE singleton=1')
          .run(JSON.stringify(s))
        this.db.exec('COMMIT')
        begun = false
        this.db.exec('BEGIN IMMEDIATE')
        begun = true
        s = this.load()
      }
      const now = Math.max(rawNow, s.lastNow)
      s.lastNow = now
      const result = operation(s, now)
      this.assertInvariants(s)
      const payload = JSON.stringify(s)
      if (Buffer.byteLength(payload) > MAX_CHECKPOINT_BYTES) throw unavailable()
      this.db.prepare('UPDATE p04_checkpoint SET payload=? WHERE singleton=1').run(payload)
      this.db.exec('COMMIT')
      begun = false
      return structuredClone(result)
    } catch (error) {
      if (begun) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* unavailable remains fail closed */
        }
      }
      if (error instanceof ControlError) throw error
      throw unavailable()
    }
  }

  private validate<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input)
    if (!result.success) throw invalid()
    return result.data
  }
  private auth(input: AuthContext, scope: Scope): AuthContext {
    const auth = this.validate(authContextSchema, input)
    if (!auth.scopes.includes(scope))
      throw new ControlError(403, 'forbidden', 'Required scope is absent.')
    return auth
  }
  private live(s: State): void {
    if (s.killedAt !== null)
      throw new ControlError(503, 'killed', 'The durable kill switch is enabled.')
    if (s.jobs.some((j) => j.record.reconciliationRequired))
      throw new ControlError(
        503,
        'reconciliation-required',
        'Unresolved execution liability blocks new work.',
      )
    if (s.eventCount >= NORMAL_EVENT_LIMIT) throw capacity()
  }
  private event(
    s: State,
    now: number,
    kind: LifecycleEvent['kind'],
    job: StoredJob | null,
    from: JobState | null = job?.record.state ?? null,
    to: JobState | null = job?.record.state ?? null,
    detail = '',
    execution?: ProviderReceipt['claims']['execution'],
  ): void {
    if (s.eventCount >= HARD_EVENT_LIMIT) throw unavailable()
    const event: LifecycleEvent = {
      sequence: ++s.eventCount,
      at: now,
      jobId: job?.record.id ?? null,
      kind,
      fromState: from,
      toState: to,
      fence: execution?.fence ?? job?.record.fence ?? null,
      executionId: execution?.executionId ?? job?.record.execution?.executionId ?? null,
      detail,
    }
    this.db
      .prepare('INSERT INTO p04_events(sequence,job_id,payload) VALUES (?,?,?)')
      .run(event.sequence, event.jobId, JSON.stringify(event))
  }
  private transition(s: State, j: StoredJob, to: JobState, now: number): void {
    const from = j.record.state
    if (from === to) return
    assertTransition(from, to, j.record.reconciliationRequired)
    j.record.state = to
    this.event(s, now, to, j, from, to)
  }
  private accounts(s: State, j: StoredJob) {
    const principal = s.principals.find((a) => a.id === j.record.sponsorPrincipalId)
    const experiment = s.experiments.find((a) => a.id === j.record.sponsorExperimentId)
    if (!principal || !experiment) throw unavailable()
    return [s.global, principal, experiment]
  }
  private spend(s: State, j: StoredJob, amount: number): void {
    if (amount > j.record.reservedMicro) throw unavailable()
    j.record.reservedMicro -= amount
    j.record.spentMicro = checkedAdd(j.record.spentMicro, amount)
    for (const a of this.accounts(s, j)) {
      a.reservedMicro -= amount
      a.spentMicro = checkedAdd(a.spentMicro, amount)
    }
  }
  private finish(
    s: State,
    j: StoredJob,
    state: 'ready' | 'failed' | 'cancelled' | 'expired',
    now: number,
  ): void {
    if (j.record.reconciliationRequired) throw unavailable()
    const e = this.execution(s, j)
    if (e && (!e.lastReceipt || !isSettledReceipt(e.lastReceipt.claims) || e.breached))
      throw unavailable()
    if (j.record.attempts > 0 && !j.overheadCharged) {
      this.spend(s, j, checkedAdd(j.record.quote.storage, j.record.quote.delivery))
      j.overheadCharged = true
    }
    for (const a of this.accounts(s, j)) a.reservedMicro -= j.record.reservedMicro
    j.record.reservedMicro = 0
    if (state !== 'ready') j.deliveryRemainingBytes = 0
    if (e) e.active = false
    j.record.leaseUntil = 0
    j.record.finishedAt = now
    this.transition(s, j, state, now)
  }
  private execution(s: State, j: StoredJob): StoredExecution | undefined {
    return j.record.execution
      ? s.executions.find((e) => e.execution.executionId === j.record.execution!.executionId)
      : undefined
  }
  private owned(
    s: State,
    auth: AuthContext,
    interestId: string,
  ): { i: StoredInterest; j: StoredJob } {
    this.validate(opaqueIdSchema, interestId)
    const i = s.interests.find(
      (value) =>
        value.record.id === interestId &&
        value.record.principalId === auth.principalId &&
        value.record.experimentId === auth.experimentId,
    )
    const j = i && s.jobs.find((value) => value.record.id === i.record.jobId)
    if (!i || !j) throw new ControlError(404, 'not-found', 'Interest was not found.')
    return { i, j }
  }
  private view(i: StoredInterest, j: StoredJob): InterestView {
    return { interest: i.record, job: j.record }
  }
  private available(j: StoredJob, now: number): boolean {
    return (
      j.record.state === 'ready' &&
      j.record.finishedAt !== null &&
      now < checkedAdd(j.record.finishedAt, this.policy.retentionMs)
    )
  }

  admit(input: Admission): AdmissionResult {
    const outer = this.validate(
      z
        .object({
          auth: authContextSchema,
          purpose: purposeSchema,
          request: z.unknown(),
          binding: requestBindingSchema,
          quote: quoteSchema,
        })
        .strict(),
      input,
    )
    const auth = this.auth(outer.auth, outer.purpose === 'image' ? 'images:write' : 'exports:write')
    const request =
      outer.purpose === 'image'
        ? this.validate(imageRequestSchema, outer.request)
        : this.validate(exportRequestSchema, outer.request)
    // Recovery commits even when the subsequent admission is denied; discovering an
    // expired execution cannot be rolled back together with a failed new request.
    this.recover()
    return this.tx((s, now) => {
      this.sweep(s, now)
      this.live(s)
      const binding = bindRequestSync(request.design, outer.purpose, auth)
      const quote = worstCaseQuote(this.policy)
      if (!equal(binding, outer.binding) || !equal(quote, outer.quote)) throw invalid()
      // A permanent retirement tombstone closes the delete-vs-republish crash race.
      // Reusing this deterministic immutable revision needs a future deletion epoch contract.
      if (s.retiredObjectKeys.some((key) => key.split('/')[2] === binding.cacheKey.slice(7)))
        throw ended()
      const prior = s.interests.find(
        (i) =>
          i.record.principalId === auth.principalId &&
          i.record.experimentId === auth.experimentId &&
          i.record.idempotencyKey === request.idempotencyKey,
      )
      if (prior) {
        const job = s.jobs.find((j) => j.record.id === prior.record.jobId)!
        if (!equal(job.record.binding, binding))
          throw new ControlError(
            409,
            'idempotency-conflict',
            'Idempotency key is bound to another immutable request.',
          )
        if (
          prior.record.cancelled ||
          now >= prior.record.expiresAt ||
          (terminal(job.record.state) && !this.available(job, now))
        )
          throw ended()
        return { view: this.view(prior, job), disposition: 'idempotent' }
      }
      if (
        s.interests.length >= this.policy.maxInterests ||
        s.interests.filter((i) => i.record.principalId === auth.principalId).length >=
          this.policy.maxPrincipalInterests
      )
        throw capacity()
      let principal = s.principals.find((a) => a.id === auth.principalId)
      let experiment = s.experiments.find((a) => a.id === auth.experimentId)
      if (
        (!principal && s.principals.length >= this.policy.maxPrincipals) ||
        (!experiment && s.experiments.length >= this.policy.maxExperiments)
      )
        throw capacity()
      if (!principal) {
        principal = { id: auth.principalId, spentMicro: 0, reservedMicro: 0, uniqueMisses: 0 }
        s.principals.push(principal)
      }
      if (!experiment) {
        experiment = { id: auth.experimentId, spentMicro: 0, reservedMicro: 0, uniqueMisses: 0 }
        s.experiments.push(experiment)
      }
      let job = s.jobs.find(
        (j) =>
          equal(j.record.binding, binding) &&
          ((!terminal(j.record.state) && now < j.record.deadline) || this.available(j, now)),
      )
      let disposition: AdmissionResult['disposition'] = job
        ? job.record.state === 'ready'
          ? 'cache-hit'
          : 'coalesced'
        : 'created'
      // An expired but unswept execution must not be replaced by a duplicate miss.
      if (!job && s.jobs.some((j) => equal(j.record.binding, binding) && !terminal(j.record.state)))
        throw new ControlError(
          503,
          'reconciliation-required',
          'Expired work requires a recovery sweep before replacement.',
        )
      if (!job) {
        if (
          s.jobs.length >= this.policy.maxJobs ||
          s.global.uniqueMisses >= this.policy.maxUniqueMisses ||
          principal.uniqueMisses >= this.policy.maxPrincipalUniqueMisses ||
          checkedAdd(s.storageBytes, quote.reservedStorageBytes) > this.policy.maxStorageBytes ||
          checkedAdd(
            s.deliveredBytes,
            ...s.jobs.map((j) => j.deliveryRemainingBytes),
            quote.reservedDeliveryBytes,
          ) > this.policy.maxDeliveryBytes
        )
          throw capacity()
        for (const [a, limit] of [
          [s.global, this.policy.globalBudgetMicro],
          [principal, this.policy.principalBudgetMicro],
          [experiment, this.policy.experimentBudgetMicro],
        ] as const)
          if (checkedAdd(a.spentMicro, a.reservedMicro, quote.total) > limit)
            throw new ControlError(
              429,
              'budget-exceeded',
              'Worst-case lifecycle reservation exceeds a durable budget.',
            )
        job = {
          record: {
            id: id(),
            design: request.design,
            binding,
            state: 'requested',
            sponsorPrincipalId: auth.principalId,
            sponsorExperimentId: auth.experimentId,
            quote,
            fence: 0,
            attempts: 0,
            execution: null,
            leaseUntil: 0,
            deadline: checkedAdd(now, this.policy.jobTtlMs),
            availableAt: now,
            createdAt: now,
            finishedAt: null,
            reconciliationRequired: false,
            reservedMicro: quote.total,
            spentMicro: 0,
            artifact: null,
            error: null,
          },
          workerId: null,
          stage: null,
          deliveries: 0,
          deliveryRemainingBytes: quote.reservedDeliveryBytes,
          overheadCharged: false,
          deletedObjectKey: null,
        }
        s.jobs.push(job)
        for (const a of [s.global, principal, experiment]) {
          a.reservedMicro = checkedAdd(a.reservedMicro, quote.total)
          a.uniqueMisses++
        }
        s.storageBytes = checkedAdd(s.storageBytes, quote.reservedStorageBytes)
        this.event(s, now, 'requested', job, null, 'requested')
        this.transition(s, job, 'reserved', now)
        this.transition(s, job, 'queued', now)
        disposition = 'created'
      }
      const interest: StoredInterest = {
        record: {
          id: id(),
          jobId: job.record.id,
          principalId: auth.principalId,
          experimentId: auth.experimentId,
          idempotencyKey: request.idempotencyKey,
          cancelled: false,
          createdAt: now,
          expiresAt: checkedAdd(now, this.policy.interestTtlMs),
        },
        expiredLogged: false,
      }
      s.interests.push(interest)
      this.event(s, now, 'interest-attached', job)
      return { view: this.view(interest, job), disposition }
    })
  }

  getInterest(input: AuthContext, interestId: string): InterestView {
    const auth = this.auth(input, 'images:read')
    return this.tx((s, now) => {
      this.sweep(s, now)
      const { i, j } = this.owned(s, auth, interestId)
      return this.view(i, j)
    })
  }
  cancelInterest(input: AuthContext, interestId: string): InterestView {
    const auth = this.auth(input, 'images:read')
    return this.tx((s, now) => {
      this.sweep(s, now)
      const { i, j } = this.owned(s, auth, interestId)
      if (!i.record.cancelled && now < i.record.expiresAt) {
        i.record.cancelled = true
        this.event(s, now, 'interest-cancelled', j)
      }
      // Cancellation only detaches an interest; even the final detach is not stop proof.
      return this.view(i, j)
    })
  }

  private lease(j: StoredJob): Lease {
    if (!j.record.execution || !j.workerId) throw unavailable()
    return {
      execution: j.record.execution,
      workerId: j.workerId,
      design: j.record.design,
      binding: j.record.binding,
      quote: j.record.quote,
      leaseUntil: j.record.leaseUntil,
      deadline: j.record.deadline,
      policy: this.policy,
    }
  }
  private match(s: State, lease: Lease, now: number, requireLive = true): StoredJob | undefined {
    const parsed = this.validate(leaseSchema, lease)
    const j = s.jobs.find((j) => j.record.id === parsed.execution.jobId)
    if (
      !j ||
      !j.record.execution ||
      !sameExecution(j.record.execution, parsed.execution) ||
      j.record.fence !== parsed.execution.fence ||
      j.workerId !== parsed.workerId ||
      !equal(j.record.design, parsed.design) ||
      !equal(j.record.binding, parsed.binding) ||
      !equal(j.record.quote, parsed.quote) ||
      !equal(this.policy, parsed.policy) ||
      j.record.deadline !== parsed.deadline ||
      (!terminal(j.record.state) && parsed.leaseUntil > j.record.leaseUntil) ||
      j.record.reconciliationRequired
    )
      return undefined
    if (
      requireLive &&
      (s.killedAt !== null ||
        now >= j.record.leaseUntil ||
        now >= j.record.deadline ||
        terminal(j.record.state))
    )
      return undefined
    return j
  }
  claim(workerId: string): Lease | null {
    this.validate(workerIdSchema, workerId)
    return this.tx((s, now) => {
      this.sweep(s, now)
      if (
        s.killedAt !== null ||
        s.jobs.some((j) => j.record.reconciliationRequired) ||
        s.eventCount >= NORMAL_EVENT_LIMIT ||
        s.executions.filter((e) => e.active).length >= this.policy.maxConcurrency
      )
        return null
      const job = s.jobs.find(
        (j) =>
          j.record.state === 'queued' &&
          now >= j.record.availableAt &&
          now < j.record.deadline &&
          j.record.attempts < this.policy.maxAttempts &&
          s.interests.some(
            (i) =>
              i.record.jobId === j.record.id && !i.record.cancelled && now < i.record.expiresAt,
          ),
      )
      if (!job) return null
      job.record.attempts++
      job.record.fence = checkedAdd(job.record.fence, 1)
      job.record.execution = {
        provider: 'fake-local',
        executionId: id(),
        jobId: job.record.id,
        fence: job.record.fence,
        attempt: job.record.attempts,
      }
      job.record.leaseUntil = Math.min(checkedAdd(now, this.policy.leaseMs), job.record.deadline)
      job.workerId = workerId
      job.stage = null
      s.executions.push({
        execution: job.record.execution,
        createdAt: now,
        active: true,
        lastReceipt: null,
        rejectedReceipt: null,
        breached: false,
      })
      this.transition(s, job, 'leased', now)
      return this.lease(job)
    })
  }
  heartbeat(lease: Lease): Lease | null {
    return this.tx((s, now) => {
      const j = this.match(s, lease, now)
      if (!j || s.eventCount >= NORMAL_EVENT_LIMIT) return null
      const until = Math.min(checkedAdd(now, this.policy.leaseMs), j.record.deadline)
      if (until > j.record.leaseUntil) {
        j.record.leaseUntil = until
        this.event(s, now, 'heartbeat', j)
      }
      return this.lease(j)
    })
  }
  beginExecution(lease: Lease): boolean {
    return this.tx((s, now) => {
      const j = this.match(s, lease, now)
      if (
        !j ||
        !['leased', 'rendering'].includes(j.record.state) ||
        s.eventCount >= NORMAL_EVENT_LIMIT
      )
        return false
      this.transition(s, j, 'rendering', now)
      return true
    })
  }
  private matchesObject(j: StoredJob, object: ArtifactDescriptor): boolean {
    const dimensions = mockArtifactDimensions(j.record.design)
    return (
      equal(object.binding, j.record.binding) &&
      object.outputProfile === j.record.design.outputProfile &&
      object.width === dimensions.width &&
      object.height === dimensions.height &&
      object.byteLength <= this.policy.maxOutputBytes
    )
  }
  beginPublishing(lease: Lease, input: StagedObject): boolean {
    const staged = this.validate(stageSchema, input)
    return this.tx((s, now) => {
      const j = this.match(s, lease, now)
      if (
        !j ||
        !sameExecution(lease.execution, staged.execution) ||
        !this.matchesObject(j, staged.object) ||
        staged.stagedAt < this.execution(s, j)!.createdAt ||
        staged.stagedAt > now ||
        s.eventCount >= NORMAL_EVENT_LIMIT
      )
        return false
      if (j.record.state === 'publishing') return equal(j.stage, staged)
      if (j.record.state !== 'rendering') return false
      const e = this.execution(s, j)!
      if (
        !e.lastReceipt ||
        !isSettledReceipt(e.lastReceipt.claims) ||
        e.lastReceipt.claims.outcome !== 'completed' ||
        e.breached
      )
        return false
      j.stage = staged
      this.transition(s, j, 'publishing', now)
      return true
    })
  }
  publish(lease: Lease, object: VerifiedObject): boolean {
    const claims = verifyObjectReceipt(object, this.objectSecret)
    return this.tx((s, now) => {
      const j = this.match(s, lease, now, false)
      if (
        !j ||
        !j.stage ||
        !sameExecution(claims.execution, lease.execution) ||
        claims.stageId !== j.stage.stageId ||
        !equal(claims.object, j.stage.object) ||
        !this.matchesObject(j, claims.object) ||
        claims.verifiedAt < j.stage.stagedAt ||
        claims.verifiedAt > now ||
        s.killedAt !== null ||
        s.retiredObjectKeys.includes(claims.object.objectKey)
      )
        return false
      if (j.record.state === 'ready') return equal(j.record.artifact, claims.object)
      if (j.record.state !== 'publishing' || now >= j.record.leaseUntil || now >= j.record.deadline)
        return false
      const e = this.execution(s, j)!
      if (
        !e.lastReceipt ||
        !isSettledReceipt(e.lastReceipt.claims) ||
        e.lastReceipt.claims.outcome !== 'completed' ||
        e.breached
      )
        return false
      j.record.artifact = claims.object
      j.record.error = null
      this.finish(s, j, 'ready', now)
      return true
    })
  }

  private uncertain(s: State, j: StoredJob, now: number): void {
    if (j.record.reconciliationRequired) return
    j.record.fence = checkedAdd(j.record.fence, 1)
    j.record.reconciliationRequired = true
    j.record.error = {
      code: 'reconciliation-required',
      message: 'Execution outcome requires signed reconciliation.',
      retryable: false,
    }
    this.event(s, now, 'reconciliation-required', j)
  }
  private acceptReceipt(s: State, receipt: ProviderReceipt, now: number): boolean {
    const claims = verifyProviderReceipt(receipt, this.receiptSecret)
    const e = s.executions.find((e) => e.execution.executionId === claims.execution.executionId)
    if (!e || !sameExecution(e.execution, claims.execution)) return false
    const j = s.jobs.find((j) => j.record.id === e.execution.jobId)!
    if (e.breached) return false
    if (e.lastReceipt && equal(e.lastReceipt, receipt)) return true
    if (s.eventCount >= NORMAL_EVENT_LIMIT && !isSettledReceipt(claims)) {
      this.enableKill(s, now, 'telemetry-capacity')
      return false
    }
    const prior = e.lastReceipt?.claims
    // Final receipts remain immutable. New authenticated contradictions are liabilities,
    // not a replay, a refund, or permission to rewrite the settled cost accounts.
    if (!e.active || (prior && isSettledReceipt(prior))) {
      if (prior && claims.sequence >= prior.sequence) {
        e.breached = true
        e.rejectedReceipt = receipt
        this.event(
          s,
          now,
          'provider-quarantined',
          j,
          j.record.state,
          j.record.state,
          '',
          claims.execution,
        )
        this.enableKill(s, now, 'provider-finality-contradiction')
      }
      return false
    }
    if (
      claims.observedAt < e.createdAt ||
      claims.observedAt > now ||
      (prior &&
        (claims.sequence <= prior.sequence ||
          claims.observedAt < prior.observedAt ||
          claims.cumulativeCostMicro < prior.cumulativeCostMicro ||
          claims.runtimeMs < prior.runtimeMs ||
          (prior.startForbidden && !claims.startForbidden)))
    )
      return false
    const cap = checkedAdd(
      j.record.quote.startup,
      j.record.quote.runtime,
      j.record.quote.idle,
      j.record.quote.shutdown,
      j.record.quote.delayedMeter,
    )
    if (
      claims.cumulativeCostMicro > cap ||
      claims.runtimeMs > this.policy.maxRuntimeMs ||
      claims.cumulativeCostMicro - (prior?.cumulativeCostMicro ?? 0) > j.record.reservedMicro
    ) {
      e.breached = true
      e.rejectedReceipt = receipt
      this.event(
        s,
        now,
        'provider-quarantined',
        j,
        j.record.state,
        j.record.state,
        '',
        claims.execution,
      )
      this.enableKill(s, now, 'provider-bound-breach')
      return false
    }
    this.spend(s, j, claims.cumulativeCostMicro - (prior?.cumulativeCostMicro ?? 0))
    e.lastReceipt = receipt
    this.event(
      s,
      now,
      'receipt-recorded',
      j,
      j.record.state,
      j.record.state,
      `sequence=${claims.sequence};cost=${claims.cumulativeCostMicro};runtime=${claims.runtimeMs};final=${claims.finalMeter}`,
    )
    if (
      !isSettledReceipt(claims) &&
      ['unknown', 'stop-requested', 'stopped', 'completed'].includes(claims.outcome)
    )
      this.uncertain(s, j, now)
    return true
  }
  recordReceipt(receipt: ProviderReceipt): boolean {
    // Verify even on an empty ledger; unknown executions are not created from provider evidence.
    verifyProviderReceipt(receipt, this.receiptSecret)
    return this.tx((s, now) => this.acceptReceipt(s, receipt, now))
  }
  private settledFailure(s: State, j: StoredJob, now: number, retryable: boolean): void {
    const e = this.execution(s, j)
    if (!e || !e.lastReceipt || !isSettledReceipt(e.lastReceipt.claims) || e.breached)
      throw unavailable()
    e.active = false
    j.record.leaseUntil = 0
    const activeInterest = s.interests.some(
      (i) => i.record.jobId === j.record.id && !i.record.cancelled && now < i.record.expiresAt,
    )
    const availableAt = checkedAdd(now, this.policy.retryDelayMs)
    if (
      retryable &&
      activeInterest &&
      s.killedAt === null &&
      s.eventCount < NORMAL_EVENT_LIMIT &&
      j.record.attempts < this.policy.maxAttempts &&
      availableAt < j.record.deadline
    ) {
      j.record.availableAt = availableAt
      j.workerId = null
      this.transition(s, j, 'queued', now)
    } else this.finish(s, j, now >= j.record.deadline ? 'expired' : 'failed', now)
  }
  fail(lease: Lease, input: JobFailure, receipt?: ProviderReceipt): boolean {
    const failure = this.validate(errorSchema, input)
    if (receipt) verifyProviderReceipt(receipt, this.receiptSecret)
    return this.tx((s, now) => {
      const j = this.match(s, lease, now)
      if (!j) return false
      if (
        receipt &&
        (!sameExecution(receipt.claims.execution, lease.execution) ||
          !this.acceptReceipt(s, receipt, now))
      )
        return false
      // Do not persist arbitrary exception text or operator-provided raw configuration.
      j.record.error = {
        code: failure.code,
        message: 'Execution could not safely complete.',
        retryable: failure.retryable,
      }
      const e = this.execution(s, j)!
      if (!e.lastReceipt || !isSettledReceipt(e.lastReceipt.claims) || e.breached)
        this.uncertain(s, j, now)
      else {
        if (j.record.reconciliationRequired) {
          j.record.reconciliationRequired = false
          this.event(s, now, 'reconciled', j)
        }
        this.settledFailure(s, j, now, failure.retryable)
      }
      return true
    })
  }
  reconcile(receipt: ProviderReceipt): boolean {
    const claims = verifyProviderReceipt(receipt, this.receiptSecret)
    return this.tx((s, now) => {
      if (!this.acceptReceipt(s, receipt, now)) return false
      const e = s.executions.find((e) => sameExecution(e.execution, claims.execution))!
      if (!isSettledReceipt(claims) || e.breached) return false
      if (!e.active) return true // accepted exact replay only; no current-attempt mutation
      const j = s.jobs.find((j) => j.record.id === claims.execution.jobId)!
      if (!j.record.execution || !sameExecution(j.record.execution, claims.execution)) return false
      if (!j.record.reconciliationRequired) return true // live owner may still publish a verified completed artifact
      j.record.reconciliationRequired = false
      this.event(s, now, 'reconciled', j)
      this.settledFailure(s, j, now, true)
      return true
    })
  }

  private enableKill(s: State, now: number, reason: string): void {
    if (s.killedAt === null) {
      s.killedAt = now
      s.killReason = reason
      this.event(s, now, 'kill-enabled', null)
    }
    for (const j of s.jobs) {
      if (terminal(j.record.state)) continue
      if (j.record.state === 'queued') this.finish(s, j, 'cancelled', now)
      else this.uncertain(s, j, now)
    }
    for (const stream of s.streams) if (stream.state === 'open') stream.state = 'stop-requested'
  }
  kill(reason: string): KillResult {
    this.validate(
      z
        .string()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z0-9 _.,:()-]+$/),
      reason,
    )
    return this.tx((s, now) => {
      this.enableKill(s, now, reason)
      return {
        killedAt: s.killedAt!,
        executions: s.executions.filter((e) => e.active).map((e) => e.execution),
        streams: s.streams.filter((stream) => stream.state !== 'closed'),
      }
    })
  }
  private sweep(s: State, now: number): RecoveryReport {
    let fenced = 0
    let expired = 0
    for (const i of s.interests)
      if (!i.expiredLogged && !i.record.cancelled && now >= i.record.expiresAt) {
        i.expiredLogged = true
        const j = s.jobs.find((j) => j.record.id === i.record.jobId)!
        this.event(s, now, 'expired', j, j.record.state, j.record.state, 'interest-expired')
      }
    for (const j of s.jobs) {
      if (j.record.state === 'queued' && now >= j.record.deadline) {
        this.finish(s, j, 'expired', now)
        expired++
      } else if (
        ['leased', 'rendering', 'publishing'].includes(j.record.state) &&
        (s.killedAt !== null || now >= j.record.leaseUntil || now >= j.record.deadline) &&
        !j.record.reconciliationRequired
      ) {
        this.uncertain(s, j, now)
        fenced++
      } else if (j.record.state === 'ready' && !this.available(j, now)) {
        j.deliveryRemainingBytes = 0
        this.transition(s, j, 'expired', now)
        expired++
      }
    }
    for (const stream of s.streams)
      if (stream.state === 'open' && (s.killedAt !== null || now >= stream.expiresAt))
        stream.state = 'stop-requested'
    return {
      fenced,
      expired,
      reconciliationRequired: s.jobs.filter((j) => j.record.reconciliationRequired).length,
    }
  }
  recover(): RecoveryReport {
    return this.tx((s, now) => this.sweep(s, now))
  }
  snapshot(): LedgerSnapshot {
    return this.tx((s) => ({
      killed: s.killedAt !== null,
      killedAt: s.killedAt,
      killReason: s.killReason,
      policy: this.policy,
      global: s.global,
      experiments: s.experiments,
      principals: s.principals,
      jobs: s.jobs.length,
      interests: s.interests.length,
      activeExecutions: s.executions
        .filter((e) => e.active)
        .map((e) => {
          const j = s.jobs.find((j) => j.record.id === e.execution.jobId)!
          return {
            execution: e.execution,
            leaseUntil: j.record.leaseUntil,
            deadline: j.record.deadline,
            reconciliationRequired: j.record.reconciliationRequired,
            lastReceipt: e.lastReceipt,
          }
        }),
      quarantinedExecutions: s.executions.flatMap((e) =>
        e.breached && e.rejectedReceipt
          ? [
              {
                execution: e.execution,
                settledReceipt: e.lastReceipt,
                contradictoryReceipt: e.rejectedReceipt,
                outstandingLiabilityUnknown: true as const,
              },
            ]
          : [],
      ),
      streams: s.streams,
      objects: s.jobs.flatMap((j) => (j.record.artifact ? [j.record.artifact] : [])),
      storageBytes: s.storageBytes,
      deliveredBytes: s.deliveredBytes,
      reservedDeliveryBytes: checkedAdd(...s.jobs.map((j) => j.deliveryRemainingBytes)),
    }))
  }
  events(jobId?: string): readonly LifecycleEvent[] {
    if (jobId !== undefined) this.validate(opaqueIdSchema, jobId)
    return this.tx(() => {
      const rows =
        jobId === undefined
          ? this.db
              .prepare('SELECT payload FROM p04_events ORDER BY sequence DESC LIMIT ?')
              .all(EVENT_READ_LIMIT)
          : this.db
              .prepare(
                'SELECT payload FROM p04_events WHERE job_id=? ORDER BY sequence DESC LIMIT ?',
              )
              .all(jobId, EVENT_READ_LIMIT)
      return rows.reverse().map((row) => eventSchema.parse(JSON.parse(String(row.payload))))
    })
  }
  openStream(input: AuthContext, interestId: string): StreamLease {
    const auth = this.auth(input, 'images:read')
    return this.tx((s, now) => {
      this.live(s)
      const { i, j } = this.owned(s, auth, interestId)
      if (
        i.record.cancelled ||
        now >= i.record.expiresAt ||
        now >= j.record.deadline ||
        terminal(j.record.state)
      )
        throw ended()
      if (
        s.streams.filter((stream) => stream.state !== 'closed').length >= this.policy.maxStreams ||
        s.streams.length >= 4096
      )
        throw capacity()
      const stream: StreamLease = {
        id: id(),
        jobId: j.record.id,
        principalId: auth.principalId,
        openedAt: now,
        expiresAt: Math.min(
          checkedAdd(now, this.policy.streamTtlMs),
          i.record.expiresAt,
          j.record.deadline,
        ),
        state: 'open',
      }
      s.streams.push(stream)
      this.event(s, now, 'stream-opened', j)
      return stream
    })
  }
  closeStream(streamId: string): boolean {
    this.validate(opaqueIdSchema, streamId)
    return this.tx((s, now) => {
      const stream = s.streams.find((stream) => stream.id === streamId)
      if (!stream) return false
      if (stream.state !== 'closed') {
        stream.state = 'closed'
        this.event(
          s,
          now,
          'stream-closed',
          s.jobs.find((j) => j.record.id === stream.jobId)!,
        )
      }
      return true
    })
  }
  recordDelivery(input: AuthContext, interestId: string, byteLength: number): ArtifactDescriptor {
    const auth = this.auth(input, 'images:read')
    this.validate(safeIntegerSchema, byteLength)
    return this.tx((s, now) => {
      this.live(s)
      const { i, j } = this.owned(s, auth, interestId)
      if (
        i.record.cancelled ||
        now >= i.record.expiresAt ||
        !this.available(j, now) ||
        !j.record.artifact
      )
        throw ended()
      if (byteLength !== j.record.artifact.byteLength) throw invalid()
      if (
        j.deliveries >= this.policy.maxDeliveriesPerJob ||
        byteLength > j.deliveryRemainingBytes ||
        checkedAdd(s.deliveredBytes, byteLength) > this.policy.maxDeliveryBytes
      )
        throw capacity()
      j.deliveries++
      j.deliveryRemainingBytes -= byteLength
      s.deliveredBytes = checkedAdd(s.deliveredBytes, byteLength)
      this.event(
        s,
        now,
        'delivery-recorded',
        j,
        j.record.state,
        j.record.state,
        `bytes=${byteLength};delivery=${j.deliveries}`,
      )
      return j.record.artifact
    })
  }
  retentionCandidates(): readonly JobRecord[] {
    return this.tx((s, now) => {
      this.sweep(s, now)
      const candidates = s.jobs.filter(
        (j) =>
          terminal(j.record.state) &&
          !j.record.reconciliationRequired &&
          !s.executions.some((e) => e.execution.jobId === j.record.id && e.breached) &&
          j.record.finishedAt !== null &&
          now >= checkedAdd(j.record.finishedAt, this.policy.retentionMs) &&
          (!j.record.artifact ||
            !s.jobs.some(
              (other) =>
                other !== j &&
                equal(other.record.binding, j.record.binding) &&
                (!terminal(other.record.state) || other.record.state === 'ready'),
            )),
      )
      for (const j of candidates)
        if (j.record.artifact && !s.retiredObjectKeys.includes(j.record.artifact.objectKey))
          s.retiredObjectKeys.push(j.record.artifact.objectKey)
      return candidates.map((j) => j.record)
    })
  }
  confirmObjectDeleted(jobId: string, objectKey: string): boolean {
    this.validate(opaqueIdSchema, jobId)
    this.validate(objectKeySchema, objectKey)
    return this.tx((s, now) => {
      const j = s.jobs.find((j) => j.record.id === jobId)
      if (!j) return false
      if (j.deletedObjectKey === objectKey && !j.record.artifact) return true
      if (
        !terminal(j.record.state) ||
        j.record.state === 'ready' ||
        j.record.reconciliationRequired ||
        s.executions.some((e) => e.execution.jobId === jobId && e.breached) ||
        j.record.finishedAt === null ||
        now < checkedAdd(j.record.finishedAt, this.policy.retentionMs) ||
        j.record.artifact?.objectKey !== objectKey ||
        !s.retiredObjectKeys.includes(objectKey)
      )
        return false
      j.deletedObjectKey = objectKey
      j.record.artifact = null
      // Storage allocation is deliberately lifetime bounded, not replenished by deletion.
      this.event(s, now, 'object-deleted', j)
      return true
    })
  }
  close(): void {
    if (this.closed) return
    try {
      this.db.close()
      this.closed = true
    } catch {
      throw unavailable()
    }
  }
}
