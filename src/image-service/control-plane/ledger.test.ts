import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultDesign } from '../../domain/design'
import { createDesignFixtures } from '../../domain/designFixtures'
import { createMockArtifact } from '../protocol'
import {
  ControlError,
  authContextSchema,
  bindRequestSync,
  canTransition,
  describeArtifact,
  exportRequestFixture,
  imageRequestFixture,
  signProviderReceipt,
  signVerifiedObject,
  worstCaseQuote,
  type Admission,
  type AuthContext,
  type DesignEnvelope,
  type JobFailure,
  type Lease,
  type LedgerOptions,
  type Policy,
  type Purpose,
  type ReceiptClaims,
  type StagedObject,
} from './contracts'
import { SqliteLedger } from './ledger'

import { TEST_ROOT as evidenceRoot } from './testPaths'
const node = process.execPath
const auth: AuthContext = authContextSchema.parse({
  principalId: 'ledger-principal-00001',
  experimentId: 'ledger-experiment-00001',
  scopes: ['images:read', 'images:write', 'exports:write'],
})
const other: AuthContext = { ...auth, principalId: 'ledger-principal-00002' }
const designs = createDesignFixtures()
const failure: JobFailure = {
  code: 'unavailable',
  message: 'Synthetic test failure.',
  retryable: true,
}
const key = () => randomBytes(24).toString('base64url')
let directory: string
let time: number
let receiptSecret: string
let objectSecret: string
let handles: SqliteLedger[]
beforeEach(() => {
  directory = mkdtempSync(join(evidenceRoot, 'ledger-test-'))
  time = 10_000
  receiptSecret = key()
  objectSecret = key()
  handles = []
})
afterEach(() => {
  for (const handle of handles) handle.close()
  rmSync(directory, { recursive: true, force: true }) // exclusively this test's disposable namespace
})
function options(policy?: Partial<Policy>): LedgerOptions {
  return {
    path: join(directory, 'ledger.sqlite'),
    now: () => time,
    receiptSecret,
    objectSecret,
    ...(policy ? { policy } : {}),
  }
}
function open(policy?: Partial<Policy>, overrides: Partial<LedgerOptions> = {}): SqliteLedger {
  const ledger = new SqliteLedger({ ...options(policy), ...overrides })
  handles.push(ledger)
  return ledger
}
function admission(
  ledger: SqliteLedger,
  input: {
    auth?: AuthContext
    purpose?: Purpose
    design?: DesignEnvelope
    idempotencyKey?: string
  } = {},
): Admission {
  const principal = input.auth ?? auth
  const purpose = input.purpose ?? 'image'
  const design = input.design ?? defaultDesign()
  const request =
    purpose === 'image'
      ? imageRequestFixture(design, input.idempotencyKey ?? key())
      : exportRequestFixture(design, input.idempotencyKey ?? key())
  return {
    auth: principal,
    purpose,
    request,
    binding: bindRequestSync(design, purpose, principal),
    quote: worstCaseQuote(ledger.policy),
  }
}
function admit(ledger: SqliteLedger, input: Parameters<typeof admission>[1] = {}) {
  return ledger.admit(admission(ledger, input))
}
function lease(ledger: SqliteLedger): Lease {
  const claimed = ledger.claim('ledger-test-worker')
  expect(claimed).not.toBeNull()
  return claimed!
}
function receipt(l: Lease, overrides: Partial<ReceiptClaims> = {}) {
  return signProviderReceipt(
    {
      execution: l.execution,
      sequence: 1,
      observedAt: time,
      outcome: 'completed',
      cumulativeCostMicro: 10,
      runtimeMs: 10,
      finalMeter: true,
      startForbidden: true,
      ...overrides,
    },
    receiptSecret,
  )
}
async function staged(l: Lease): Promise<StagedObject> {
  return {
    stageId: key(),
    execution: l.execution,
    object: describeArtifact(await createMockArtifact(l.design), l.design, l.binding),
    stagedAt: time,
  }
}
async function ready(ledger: SqliteLedger) {
  const admitted = admit(ledger)
  const l = lease(ledger)
  expect(ledger.beginExecution(l)).toBe(true)
  expect(ledger.recordReceipt(receipt(l))).toBe(true)
  const stage = await staged(l)
  expect(ledger.beginPublishing(l, stage)).toBe(true)
  const proof = signVerifiedObject(
    { stageId: stage.stageId, execution: l.execution, object: stage.object, verifiedAt: time },
    objectSecret,
  )
  expect(ledger.publish(l, proof)).toBe(true)
  return { admitted, l, stage, proof }
}
function expectError(operation: () => unknown, status: number, code?: string) {
  try {
    operation()
    expect.fail('Expected a fail-closed control error')
  } catch (error) {
    expect(error).toBeInstanceOf(ControlError)
    expect((error as ControlError).status).toBe(status)
    if (code) expect((error as ControlError).code).toBe(code)
  }
}

describe('transactional admission, identity, ownership and persisted ceilings', () => {
  it('records requested/reserved/queued atomically and reserves the entire retry lifecycle in three accounts', () => {
    const ledger = open()
    const result = admit(ledger)
    const snapshot = ledger.snapshot()
    expect(result.disposition).toBe('created')
    expect(result.view.job.state).toBe('queued')
    expect(snapshot.global.reservedMicro).toBe(worstCaseQuote(ledger.policy).total)
    expect(snapshot.principals[0].reservedMicro).toBe(snapshot.global.reservedMicro)
    expect(snapshot.experiments[0].reservedMicro).toBe(snapshot.global.reservedMicro)
    expect(snapshot.global.uniqueMisses).toBe(1)
    expect(snapshot.storageBytes).toBe(result.view.job.quote.reservedStorageBytes)
    expect(snapshot.reservedDeliveryBytes).toBe(result.view.job.quote.reservedDeliveryBytes)
    expect(ledger.events().map((event) => event.kind)).toEqual([
      'requested',
      'reserved',
      'queued',
      'interest-attached',
    ])
    expect(ledger.events()[0].fromState).toBeNull()
  })
  it('coalesces public requests across principals and connections without extra budget or miss', () => {
    const one = open()
    const two = open()
    const first = admit(one)
    const second = admit(two, { auth: other })
    expect(second.disposition).toBe('coalesced')
    expect(second.view.job.id).toBe(first.view.job.id)
    expect(second.view.interest.id).not.toBe(first.view.interest.id)
    expect(second.view.job.sponsorPrincipalId).toBe(auth.principalId)
    expect(one.snapshot().global).toMatchObject({
      uniqueMisses: 1,
      reservedMicro: first.view.job.quote.total,
    })
    expect(one.snapshot().principals.find((a) => a.id === other.principalId)?.reservedMicro).toBe(0)
  })
  it('idempotency does not duplicate interests, events or reservations and survives restart', () => {
    const one = open()
    const request = admission(one)
    const first = one.admit(request)
    const before = one.events()
    expect(one.admit(request)).toEqual({ ...first, disposition: 'idempotent' })
    expect(one.events()).toEqual(before)
    one.close()
    expect(open().admit(request).view).toEqual(first.view)
  })
  it('binds a principal/experiment key across image and export routes and refuses rebinding', () => {
    const ledger = open()
    const idempotencyKey = key()
    admit(ledger, { idempotencyKey })
    expectError(
      () => admit(ledger, { idempotencyKey, purpose: 'export' }),
      409,
      'idempotency-conflict',
    )
    expectError(
      () => admit(ledger, { idempotencyKey, design: designs[3] }),
      409,
      'idempotency-conflict',
    )
    expect(ledger.snapshot().jobs).toBe(1)
  })
  it('isolates export identity by principal AND experiment and never coalesces public/private', () => {
    const ledger = open()
    const ids = [
      admit(ledger),
      admit(ledger, { purpose: 'export' }),
      admit(ledger, { purpose: 'export', auth: other }),
      admit(ledger, {
        purpose: 'export',
        auth: { ...auth, experimentId: 'ledger-experiment-00002' },
      }),
    ].map((v) => v.view.job.id)
    expect(new Set(ids).size).toBe(4)
    expect(ledger.snapshot().jobs).toBe(4)
  })
  it('recomputes binding and exact quote and rejects principal/config/unknown fields', () => {
    const ledger = open()
    const base = admission(ledger)
    expectError(
      () =>
        ledger.admit({
          ...base,
          binding: { ...base.binding, cacheKey: `sha256:${'0'.repeat(64)}` },
        }),
      422,
    )
    expectError(
      () =>
        ledger.admit({
          ...base,
          quote: { ...base.quote, delivery: base.quote.delivery - 1, total: base.quote.total - 1 },
        }),
      422,
    )
    expectError(
      () =>
        ledger.admit({
          ...base,
          request: { ...base.request, principalId: other.principalId },
        } as unknown as Admission),
      422,
    )
    expectError(
      () =>
        ledger.admit({
          ...base,
          request: { ...base.request, callback: 'https://example.invalid' },
        } as unknown as Admission),
      422,
    )
    expectError(() => ledger.admit({ ...base, workerCommand: 'forbidden' } as Admission), 422)
    expect(ledger.snapshot().jobs).toBe(0)
  })
  it('enforces auth ownership with principal plus experiment and does not mint scopes', () => {
    const ledger = open()
    const result = admit(ledger)
    const id = result.view.interest.id
    expectError(() => ledger.getInterest(other, id), 404)
    expectError(
      () => ledger.getInterest({ ...auth, experimentId: 'ledger-experiment-00002' }, id),
      404,
    )
    expectError(() => admit(ledger, { auth: { ...auth, scopes: ['images:read'] } }), 403)
    expectError(() => ledger.getInterest({ ...auth, scopes: ['images:write'] }, id), 403)
    expectError(() => ledger.cancelInterest(other, id), 404)
  })
  it.each(['globalBudgetMicro', 'experimentBudgetMicro', 'principalBudgetMicro'] as const)(
    'enforces %s atomically at exact quote boundary',
    (field) => {
      const quote = worstCaseQuote()
      const ledger = open({ [field]: quote.total })
      admit(ledger)
      const before = ledger.snapshot()
      expectError(() => admit(ledger, { design: designs[3] }), 429, 'budget-exceeded')
      expect(ledger.snapshot()).toEqual(before)
    },
  )
  it('principal rotation and experiment rotation cannot evade global exhaustion', () => {
    const ledger = open({ globalBudgetMicro: worstCaseQuote().total })
    admit(ledger)
    expectError(
      () =>
        admit(ledger, {
          design: designs[3],
          auth: { ...other, experimentId: 'ledger-experiment-00002' },
        }),
      429,
      'budget-exceeded',
    )
    expect(ledger.snapshot().principals).toHaveLength(1)
    expect(ledger.snapshot().experiments).toHaveLength(1)
  })
  it.each([
    ['maxJobs', 1],
    ['maxUniqueMisses', 1],
    ['maxPrincipalUniqueMisses', 1],
    ['maxStorageBytes', worstCaseQuote().reservedStorageBytes],
    ['maxDeliveryBytes', worstCaseQuote().reservedDeliveryBytes],
  ] as const)('enforces %s independently and preserves existing reservations', (field, value) => {
    const ledger = open({ [field]: value })
    admit(ledger)
    const before = ledger.snapshot()
    expectError(() => admit(ledger, { design: designs[3] }), 429, 'capacity-exceeded')
    expect(ledger.snapshot()).toEqual(before)
  })
  it.each(['maxInterests', 'maxPrincipalInterests'] as const)(
    'bounds retained %s even on cache/coalescing',
    (field) => {
      const ledger = open({ [field]: 1 })
      admit(ledger)
      expectError(() => admit(ledger), 429, 'capacity-exceeded')
    },
  )
  it('bounds principal and experiment rows, including zero-cost coalesced accounts', () => {
    const ledger = open({ maxPrincipals: 1, maxExperiments: 1 })
    admit(ledger)
    expectError(() => admit(ledger, { auth: other }), 429)
    expectError(
      () => admit(ledger, { auth: { ...auth, experimentId: 'ledger-experiment-00002' } }),
      429,
    )
  })
  it('retains cancelled idempotency tombstones and does not refund merely detached shared work', () => {
    const ledger = open()
    const request = admission(ledger)
    const first = ledger.admit(request)
    const second = admit(ledger, { auth: other })
    const before = ledger.snapshot().global
    const cancelled = ledger.cancelInterest(auth, first.view.interest.id)
    expect(cancelled.interest.cancelled).toBe(true)
    expect(cancelled.job.state).toBe('queued')
    expect(ledger.cancelInterest(auth, first.view.interest.id)).toEqual(cancelled)
    expect(ledger.snapshot().global).toEqual(before)
    expectError(() => ledger.admit(request), 410)
    expect(ledger.getInterest(other, second.view.interest.id).interest.cancelled).toBe(false)
    expect(lease(ledger).execution.jobId).toBe(first.view.job.id)
  })
  it('keeps no-interest jobs unclaimed, expires only demonstrably unstarted work and retains misses', () => {
    const ledger = open({ jobTtlMs: 100, interestTtlMs: 100 })
    const first = admit(ledger)
    ledger.cancelInterest(auth, first.view.interest.id)
    expect(ledger.claim('worker')).toBeNull()
    time += 100
    expect(ledger.recover()).toEqual({ fenced: 0, expired: 1, reconciliationRequired: 0 })
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('expired')
    expect(ledger.snapshot().global).toMatchObject({
      spentMicro: 0,
      reservedMicro: 0,
      uniqueMisses: 1,
    })
    expect(ledger.snapshot().reservedDeliveryBytes).toBe(0)
    expect(ledger.snapshot().storageBytes).toBe(first.view.job.quote.reservedStorageBytes)
  })
  it('exposes independent snapshots, not mutable references into persisted identity or policy', () => {
    const ledger = open()
    const first = admit(ledger)
    const snapshot = ledger.snapshot()
    ;(snapshot.global as { reservedMicro: number }).reservedMicro = 0
    ;(first.view.job as { sponsorPrincipalId: string }).sponsorPrincipalId = other.principalId
    const view = ledger.getInterest(auth, first.view.interest.id)
    expect(view.job.sponsorPrincipalId).toBe(auth.principalId)
    expect(ledger.snapshot().global.reservedMicro).toBe(view.job.quote.total)
    expect(Object.isFrozen(ledger.policy)).toBe(true)
  })
})

describe('leases, final receipts, accounting and uncertain execution', () => {
  it('persists execution before contact; enforces concurrency across independent connections', () => {
    const ledger = open({ maxConcurrency: 1 })
    const second = open()
    admit(ledger)
    admit(ledger, { design: designs[3] })
    const first = lease(ledger)
    expect(second.claim('second-worker')).toBeNull()
    expect(second.snapshot().activeExecutions[0].execution).toEqual(first.execution)
    expect(ledger.beginExecution(first)).toBe(true)
    const events = ledger.events()
    expect(ledger.beginExecution(first)).toBe(true)
    expect(ledger.events()).toEqual(events)
  })
  it('heartbeats extend only matching owner and never original deadline or expired lease', () => {
    const ledger = open({ leaseMs: 100, jobTtlMs: 250 })
    admit(ledger)
    const l = lease(ledger)
    time += 80
    expect(ledger.heartbeat({ ...l, workerId: 'wrong-worker' })).toBeNull()
    const next = ledger.heartbeat(l)!
    expect(next.leaseUntil).toBe(time + 100)
    time += 80
    const final = ledger.heartbeat(next)!
    expect(final.leaseUntil).toBe(l.deadline)
    time = l.deadline
    expect(ledger.heartbeat(final)).toBeNull()
    expect(ledger.beginExecution(final)).toBe(false)
  })
  it('admission recovers an expired execution before coalescing and persists uncertainty on denial', () => {
    const ledger = open({ leaseMs: 100 })
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    time += 100
    expectError(() => admit(ledger, { auth: other }), 503, 'reconciliation-required')
    expect(ledger.snapshot().activeExecutions[0].reconciliationRequired).toBe(true)
    expect(ledger.snapshot().global.reservedMicro).toBe(first.view.job.quote.total)
    expect(ledger.snapshot().interests).toBe(1)
  })
  it('refuses caller-altered lease identity, policy, quote and design', () => {
    const ledger = open()
    admit(ledger)
    const l = lease(ledger)
    expect(
      ledger.beginExecution({ ...l, execution: { ...l.execution, fence: l.execution.fence + 1 } }),
    ).toBe(false)
    expect(
      ledger.beginExecution({
        ...l,
        policy: { ...l.policy, maxRuntimeMs: l.policy.maxRuntimeMs + 1 },
      }),
    ).toBe(false)
    expect(ledger.beginExecution({ ...l, design: designs[3] })).toBe(false)
    expectError(() => ledger.beginExecution({ ...l, paidExecutionAllowed: true } as Lease), 422)
    expect(ledger.beginExecution(l)).toBe(true)
  })
  it('moves monotone cumulative deltas reserved→spent once across all accounts, not an early refund', () => {
    const ledger = open()
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    const running = receipt(l, {
      outcome: 'running',
      finalMeter: false,
      startForbidden: false,
      cumulativeCostMicro: 7,
      runtimeMs: 7,
    })
    expect(ledger.recordReceipt(running)).toBe(true)
    expect(ledger.recordReceipt(running)).toBe(true)
    const final = receipt(l, { sequence: 2 })
    expect(ledger.recordReceipt(final)).toBe(true)
    expect(ledger.snapshot().global).toMatchObject({
      spentMicro: 10,
      reservedMicro: first.view.job.quote.total - 10,
    })
    expect(ledger.snapshot().experiments[0].spentMicro).toBe(10)
    expect(ledger.snapshot().principals[0].spentMicro).toBe(10)
    expect(ledger.events().filter((e) => e.kind === 'receipt-recorded')).toHaveLength(2)
  })
  it('rejects unauthenticated/unknown/mismatched executions, future and regressive receipts without refund', () => {
    const ledger = open()
    admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    const running = receipt(l, { outcome: 'running', finalMeter: false, startForbidden: false })
    ledger.recordReceipt(running)
    const before = ledger.snapshot()
    expectError(() => ledger.recordReceipt({ ...running, signature: '0'.repeat(64) }), 403)
    const variants: Partial<ReceiptClaims>[] = [
      { execution: { ...l.execution, executionId: key() } },
      { execution: { ...l.execution, attempt: 2 } },
      { sequence: 2, cumulativeCostMicro: 9 },
      { sequence: 2, runtimeMs: 9 },
      { sequence: 2, observedAt: time + 1 },
      { sequence: 2, observedAt: time - 1 },
      { sequence: 1 },
    ]
    for (const value of variants) expect(ledger.recordReceipt(receipt(l, value))).toBe(false)
    expect(ledger.snapshot()).toEqual(before)
  })
  it('missing receipt fences failure and retains all liability/concurrency; no duplicate work', () => {
    const ledger = open({ maxConcurrency: 1 })
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    expect(ledger.fail(l, failure)).toBe(true)
    const current = ledger.getInterest(auth, first.view.interest.id).job
    expect(current.state).toBe('rendering')
    expect(current.reconciliationRequired).toBe(true)
    expect(current.fence).toBeGreaterThan(l.execution.fence)
    expect(ledger.snapshot().global.reservedMicro).toBe(first.view.job.quote.total)
    expect(ledger.snapshot().activeExecutions).toHaveLength(1)
    expect(ledger.claim('replacement')).toBeNull()
    expectError(() => admit(ledger, { design: designs[3] }), 503, 'reconciliation-required')
    expect(ledger.beginExecution(l)).toBe(false)
  })
  it.each(['unknown', 'stop-requested', 'stopped', 'completed'] as const)(
    'outcome %s without final meter never refunds or releases concurrency',
    (outcome) => {
      const ledger = open()
      admit(ledger)
      const l = lease(ledger)
      ledger.beginExecution(l)
      const result = receipt(l, {
        outcome,
        finalMeter: false,
        startForbidden: outcome !== 'unknown',
      })
      expect(ledger.reconcile(result)).toBe(false)
      expect(ledger.snapshot().activeExecutions).toHaveLength(1)
      expect(ledger.snapshot().activeExecutions[0].reconciliationRequired).toBe(true)
      expect(ledger.snapshot().global.reservedMicro).toBe(worstCaseQuote(ledger.policy).total - 10)
      expect(ledger.claim('replacement')).toBeNull()
    },
  )
  it('reconciles by old execution after fencing, then retries within prepaid bounds without duplicate stale settlement', () => {
    const ledger = open({ retryDelayMs: 0 })
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.fail(l, failure)
    const final = receipt(l, { outcome: 'stopped' })
    expect(ledger.reconcile(final)).toBe(true)
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('queued')
    const next = lease(ledger)
    expect(next.execution.attempt).toBe(2)
    expect(next.execution.fence).toBeGreaterThan(l.execution.fence)
    expect(next.execution.executionId).not.toBe(l.execution.executionId)
    const before = ledger.snapshot()
    expect(ledger.reconcile(final)).toBe(true)
    expect(ledger.recordReceipt(final)).toBe(true)
    expect(ledger.snapshot()).toEqual(before)
    expect(ledger.fail(l, failure)).toBe(false)
    expect(ledger.beginExecution(l)).toBe(false)
    ledger.beginExecution(next)
    expect(ledger.fail(next, failure, receipt(next))).toBe(true)
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('failed')
    expect(ledger.snapshot().global.reservedMicro).toBe(0)
    expect(ledger.snapshot().global.spentMicro).toBe(
      20 + first.view.job.quote.delivery + first.view.job.quote.storage,
    )
    expect(ledger.claim('third-attempt')).toBeNull()
  })
  it('retry delay and attempt count do not extend original TTL; terminal signed outcomes expire truthfully', () => {
    const ledger = open({ retryDelayMs: 100, jobTtlMs: 200 })
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.fail(l, failure, receipt(l))
    expect(ledger.claim('too-early')).toBeNull()
    time += 100
    const next = lease(ledger)
    expect(next.deadline).toBe(l.deadline)
    time = l.deadline
    ledger.recover()
    expect(
      ledger.reconcile(receipt(next, { outcome: 'stopped', cumulativeCostMicro: 0, runtimeMs: 0 })),
    ).toBe(true)
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('expired')
  })
  it.each(['runtime', 'cost'] as const)(
    'signed %s overrun persists kill and evidence, never clamps, refunds or retries',
    (field) => {
      const ledger = open()
      const first = admit(ledger)
      const l = lease(ledger)
      ledger.beginExecution(l)
      const claims =
        field === 'runtime'
          ? { runtimeMs: ledger.policy.maxRuntimeMs + 1 }
          : {
              cumulativeCostMicro:
                first.view.job.quote.startup +
                first.view.job.quote.runtime +
                first.view.job.quote.idle +
                first.view.job.quote.shutdown +
                first.view.job.quote.delayedMeter +
                1,
            }
      expect(ledger.recordReceipt(receipt(l, claims))).toBe(false)
      const before = ledger.snapshot()
      expect(before.killed).toBe(true)
      expect(before.killReason).toBe('provider-bound-breach')
      expect(before.global.reservedMicro).toBe(first.view.job.quote.total)
      expect(before.global.spentMicro).toBe(0)
      expect(before.activeExecutions[0].reconciliationRequired).toBe(true)
      expect(ledger.reconcile(receipt(l, { sequence: 2 }))).toBe(false)
      ledger.close()
      expect(open().snapshot()).toEqual(before)
    },
  )
  it('does not erase known final meter when publication fails; charges storage/delivery conservatively', () => {
    const ledger = open({ maxAttempts: 1 })
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.recordReceipt(receipt(l))
    expect(ledger.fail(l, { ...failure, code: 'publication-failed', retryable: false })).toBe(true)
    const job = ledger.getInterest(auth, first.view.interest.id).job
    expect(job.state).toBe('failed')
    expect(job.artifact).toBeNull()
    expect(job.reservedMicro).toBe(0)
    expect(job.spentMicro).toBe(10 + first.view.job.quote.storage + first.view.job.quote.delivery)
    expect(ledger.snapshot().storageBytes).toBe(first.view.job.quote.reservedStorageBytes)
  })
})

describe('publication compare-and-swap, retention and bounded delivery', () => {
  it('cannot ready without a final completed receipt and authenticated matching object readback', async () => {
    const ledger = open()
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    const stage = await staged(l)
    expect(ledger.beginPublishing(l, stage)).toBe(false)
    ledger.recordReceipt(receipt(l))
    expect(ledger.beginPublishing(l, stage)).toBe(true)
    const proof = signVerifiedObject(
      { stageId: stage.stageId, execution: l.execution, object: stage.object, verifiedAt: time },
      objectSecret,
    )
    expectError(() => ledger.publish(l, { ...proof, signature: '0'.repeat(64) }), 403)
    expect(
      ledger.publish(l, signVerifiedObject({ ...proof.claims, stageId: key() }, objectSecret)),
    ).toBe(false)
    expect(
      ledger.publish(
        l,
        signVerifiedObject(
          { ...proof.claims, execution: { ...l.execution, fence: 9 } },
          objectSecret,
        ),
      ),
    ).toBe(false)
    expect(
      ledger.publish(
        l,
        signVerifiedObject({ ...proof.claims, verifiedAt: time + 1 }, objectSecret),
      ),
    ).toBe(false)
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('publishing')
    expect(ledger.publish(l, proof)).toBe(true)
    expect(ledger.getInterest(auth, first.view.interest.id).job.artifact).toEqual(stage.object)
    const before = ledger.events()
    expect(ledger.publish(l, proof)).toBe(true)
    expect(ledger.events()).toEqual(before)
    expect(ledger.snapshot().activeExecutions).toHaveLength(0)
    expect(ledger.snapshot().global.reservedMicro).toBe(0)
  })
  it('validates stage identity, binding, profile, dimensions, output bound, time and unknown fields', async () => {
    const ledger = open()
    admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.recordReceipt(receipt(l))
    const stage = await staged(l)
    expect(
      ledger.beginPublishing(l, { ...stage, execution: { ...l.execution, executionId: key() } }),
    ).toBe(false)
    expect(
      ledger.beginPublishing(l, {
        ...stage,
        object: { ...stage.object, width: stage.object.width - 1 },
      }),
    ).toBe(false)
    expect(ledger.beginPublishing(l, { ...stage, stagedAt: time + 1 })).toBe(false)
    expectError(() => ledger.beginPublishing(l, { ...stage, verified: true } as StagedObject), 422)
    expect(ledger.beginPublishing(l, stage)).toBe(true)
    expect(ledger.beginPublishing(l, { ...stage, stageId: key() })).toBe(false)
  })
  it('a final stopped receipt is settlement evidence but not successful-render evidence', async () => {
    const ledger = open()
    admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.recordReceipt(receipt(l, { outcome: 'stopped' }))
    expect(ledger.beginPublishing(l, await staged(l))).toBe(false)
  })
  it('will not publish from a signed stopped receipt or exceed smaller configured output bounds', async () => {
    const ledger = open({ maxOutputBytes: 1 })
    admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.recordReceipt(receipt(l, { outcome: 'stopped' }))
    expect(ledger.beginPublishing(l, await staged(l))).toBe(false)
  })
  it.each(['lease-expired', 'kill'] as const)(
    'stale %s worker cannot publish even a valid proof; filename alone never readies',
    async (how) => {
      const ledger = open({ leaseMs: 100 })
      const first = admit(ledger)
      const l = lease(ledger)
      ledger.beginExecution(l)
      ledger.recordReceipt(receipt(l))
      const stage = await staged(l)
      ledger.beginPublishing(l, stage)
      const proof = signVerifiedObject(
        { stageId: stage.stageId, execution: l.execution, object: stage.object, verifiedAt: time },
        objectSecret,
      )
      if (how === 'kill') ledger.kill('test stop')
      else {
        time += 100
        ledger.recover()
      }
      expect(ledger.publish(l, proof)).toBe(false)
      const view = ledger.getInterest(auth, first.view.interest.id)
      expect(view.job.state).toBe('publishing')
      expect(view.job.reconciliationRequired).toBe(true)
      expect(view.job.artifact).toBeNull()
      expect(ledger.snapshot().objects).toHaveLength(0)
    },
  )
  it('ready immutable identity is cached without new miss; later delivery counters are shared and persistent', async () => {
    const ledger = open({ maxDeliveriesPerJob: 2 })
    const { admitted, stage } = await ready(ledger)
    const second = admit(ledger, { auth: other })
    expect(second.disposition).toBe('cache-hit')
    expect(second.view.job.id).toBe(admitted.view.job.id)
    expectError(
      () => ledger.recordDelivery(auth, admitted.view.interest.id, stage.object.byteLength - 1),
      422,
    )
    expect(ledger.recordDelivery(auth, admitted.view.interest.id, stage.object.byteLength)).toEqual(
      stage.object,
    )
    expect(ledger.recordDelivery(other, second.view.interest.id, stage.object.byteLength)).toEqual(
      stage.object,
    )
    expectError(
      () => ledger.recordDelivery(auth, admitted.view.interest.id, stage.object.byteLength),
      429,
    )
    expect(ledger.snapshot().deliveredBytes).toBe(stage.object.byteLength * 2)
    const before = ledger.snapshot()
    ledger.close()
    expect(open().snapshot()).toEqual(before)
  })
  it('marks availability expired before object deletion; misses/spent/byte allocations/tombstones survive retention', async () => {
    const ledger = open({ retentionMs: 100 })
    const { admitted, stage } = await ready(ledger)
    expect(ledger.confirmObjectDeleted(admitted.view.job.id, stage.object.objectKey)).toBe(false)
    const before = ledger.snapshot()
    time += 100
    expectError(
      () => ledger.recordDelivery(auth, admitted.view.interest.id, stage.object.byteLength),
      410,
    )
    const candidates = ledger.retentionCandidates()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].state).toBe('expired')
    expect(candidates[0].artifact).toEqual(stage.object)
    expect(ledger.snapshot().objects).toEqual([stage.object])
    expect(ledger.confirmObjectDeleted(admitted.view.job.id, stage.object.objectKey)).toBe(true)
    expect(ledger.confirmObjectDeleted(admitted.view.job.id, stage.object.objectKey)).toBe(true)
    expect(ledger.snapshot().objects).toEqual([])
    expect(ledger.snapshot().global).toEqual(before.global)
    expect(ledger.snapshot().storageBytes).toBe(before.storageBytes)
    expect(ledger.snapshot().interests).toBe(before.interests)
    expect(ledger.snapshot().reservedDeliveryBytes).toBe(0)
  })
  it('retirement permanently fences immutable keys against delete-vs-republish races', async () => {
    const ledger = open({ retentionMs: 100 })
    const { admitted, stage } = await ready(ledger)
    time += 100
    expect(ledger.retentionCandidates()).toHaveLength(1)
    expectError(() => admit(ledger), 410)
    expect(ledger.confirmObjectDeleted(admitted.view.job.id, stage.object.objectKey)).toBe(true)
    expectError(() => admit(ledger), 410)
    ledger.close()
    expectError(() => admit(open()), 410)
  })
  it('retention never deletes a reused immutable key while a newer matching job is queued or ready', async () => {
    const ledger = open({ retentionMs: 100 })
    const first = await ready(ledger)
    time += 100
    ledger.recover()
    const second = admit(ledger)
    expect(second.disposition).toBe('created')
    expect(ledger.retentionCandidates()).toHaveLength(0)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.recordReceipt(receipt(l))
    const stage = await staged(l)
    expect(stage.object.objectKey).toBe(first.stage.object.objectKey)
    ledger.beginPublishing(l, stage)
    ledger.publish(
      l,
      signVerifiedObject(
        { stageId: stage.stageId, execution: l.execution, object: stage.object, verifiedAt: time },
        objectSecret,
      ),
    )
    expect(ledger.retentionCandidates()).toHaveLength(0)
    expect(ledger.confirmObjectDeleted(first.admitted.view.job.id, stage.object.objectKey)).toBe(
      false,
    )
    expect(ledger.recordDelivery(auth, second.view.interest.id, stage.object.byteLength)).toEqual(
      stage.object,
    )
  })
  it('expired or cancelled interest cannot deliver a still-ready shared artifact', async () => {
    const ledger = open({ interestTtlMs: 100 })
    const { admitted, stage } = await ready(ledger)
    const second = admit(ledger, { auth: other })
    ledger.cancelInterest(auth, admitted.view.interest.id)
    expectError(
      () => ledger.recordDelivery(auth, admitted.view.interest.id, stage.object.byteLength),
      410,
    )
    time += 100
    expectError(
      () => ledger.recordDelivery(other, second.view.interest.id, stage.object.byteLength),
      410,
    )
    expect(ledger.getInterest(other, second.view.interest.id).job.state).toBe('ready')
  })
})

describe('kill, streams, restart, clock and durable-store failure', () => {
  it('kill cancels only queued unstarted work and fences claimed-before-start IDs for provider tombstoning', () => {
    const ledger = open({ maxConcurrency: 1 })
    const first = admit(ledger)
    const queued = admit(ledger, { design: designs[3] })
    const l = lease(ledger)
    const stream = ledger.openStream(auth, first.view.interest.id)
    const result = ledger.kill('test kill')
    expect(result.executions).toEqual([l.execution])
    expect(result.streams).toEqual([{ ...stream, state: 'stop-requested' }])
    expect(ledger.getInterest(auth, queued.view.interest.id).job.state).toBe('cancelled')
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('leased')
    expect(ledger.snapshot().global.reservedMicro).toBe(first.view.job.quote.total)
    expect(ledger.beginExecution(l)).toBe(false)
    expect(ledger.heartbeat(l)).toBeNull()
    expect(ledger.claim('worker')).toBeNull()
    const events = ledger.events()
    time++
    expect(ledger.kill('different reason')).toEqual(result)
    expect(ledger.events()).toEqual(events)
    ledger.close()
    const reopened = open()
    expect(reopened.snapshot().killReason).toBe('test kill')
    expectError(() => admit(reopened), 503, 'killed')
    expect(reopened.snapshot().activeExecutions).toHaveLength(1)
  })
  it('stop requested and delayed final meter retain liabilities through kill, restart and repeated watchdog reconciliation', () => {
    const ledger = open()
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.kill('delayed termination')
    const delayed = receipt(l, { outcome: 'stop-requested', finalMeter: false })
    expect(ledger.reconcile(delayed)).toBe(false)
    ledger.close()
    const reopened = open()
    expect(reopened.snapshot().global.reservedMicro).toBe(first.view.job.quote.total - 10)
    expect(reopened.reconcile(delayed)).toBe(false)
    expect(
      reopened.reconcile(
        receipt(l, { sequence: 2, outcome: 'stopped', finalMeter: false, cumulativeCostMicro: 15 }),
      ),
    ).toBe(false)
    expect(reopened.snapshot().activeExecutions).toHaveLength(1)
    const final = receipt(l, { sequence: 3, outcome: 'stopped', cumulativeCostMicro: 18 })
    expect(reopened.reconcile(final)).toBe(true)
    expect(reopened.reconcile(final)).toBe(true)
    expect(reopened.snapshot().activeExecutions).toHaveLength(0)
    expect(reopened.snapshot().global.reservedMicro).toBe(0)
    expect(reopened.snapshot().global.spentMicro).toBe(
      18 + first.view.job.quote.delivery + first.view.job.quote.storage,
    )
    expect(reopened.snapshot().killed).toBe(true)
    expect(reopened.claim('retry')).toBeNull()
  })
  it('kill cancels queued retries only after their previous execution has a terminal final receipt', () => {
    const ledger = open()
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.fail(l, failure, receipt(l, { outcome: 'stopped' }))
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('queued')
    expect(ledger.kill('stop retries').executions).toEqual([])
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('cancelled')
    expect(ledger.snapshot().global.reservedMicro).toBe(0)
  })
  it('restart and expired lease are not stopped proof and cannot free concurrency or publish', () => {
    const ledger = open({ leaseMs: 100 })
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.close()
    time += 100
    const reopened = open()
    expect(reopened.recover()).toEqual({ fenced: 1, expired: 0, reconciliationRequired: 1 })
    expect(reopened.recover()).toEqual({ fenced: 0, expired: 0, reconciliationRequired: 1 })
    expect(reopened.snapshot().activeExecutions).toHaveLength(1)
    expect(reopened.snapshot().global.reservedMicro).toBe(first.view.job.quote.total)
    expect(reopened.heartbeat(l)).toBeNull()
    expect(reopened.claim('replacement')).toBeNull()
    expect(reopened.retentionCandidates()).toHaveLength(0)
  })
  it('stream expiry requests local resource stop, keeps capacity until close, and cannot settle execution', () => {
    const ledger = open({ maxStreams: 1, streamTtlMs: 100 })
    const first = admit(ledger)
    const l = lease(ledger)
    const stream = ledger.openStream(auth, first.view.interest.id)
    expectError(() => ledger.openStream(auth, first.view.interest.id), 429)
    time += 100
    ledger.recover()
    expect(ledger.snapshot().streams[0].state).toBe('stop-requested')
    expectError(() => ledger.openStream(auth, first.view.interest.id), 429)
    expect(ledger.closeStream(stream.id)).toBe(true)
    expect(ledger.closeStream(stream.id)).toBe(true)
    expect(ledger.snapshot().activeExecutions[0].execution).toEqual(l.execution)
    expect(ledger.snapshot().global.reservedMicro).toBe(first.view.job.quote.total)
    expect(ledger.openStream(auth, first.view.interest.id).state).toBe('open')
    ledger.kill('stream stop')
    expectError(() => ledger.openStream(auth, first.view.interest.id), 503, 'killed')
  })
  it('backward clock persists irreversible kill even when the triggering admission fails', () => {
    const ledger = open()
    const first = admit(ledger)
    const l = lease(ledger)
    time--
    expectError(() => admit(ledger, { design: designs[3] }), 503, 'killed')
    time += 100
    const snapshot = ledger.snapshot()
    expect(snapshot.killed).toBe(true)
    expect(snapshot.killReason).toBe('clock-regression')
    expect(snapshot.global.reservedMicro).toBe(first.view.job.quote.total)
    expect(ledger.beginExecution(l)).toBe(false)
  })
  it('forward clock expires queued jobs; rollback never revives ended interests', () => {
    const ledger = open({ jobTtlMs: 100, interestTtlMs: 100 })
    const request = admission(ledger)
    const first = ledger.admit(request)
    time += 101
    ledger.recover()
    time -= 101
    expectError(() => ledger.admit(request), 503, 'killed')
    expect(ledger.getInterest(auth, first.view.interest.id).job.state).toBe('expired')
    expect(ledger.snapshot().global.reservedMicro).toBe(0)
  })
  it('rejects invalid clocks, altered keys, policy replacement and pre-existing empty/foreign/corrupt stores', () => {
    const ledger = open()
    admit(ledger)
    ledger.close()
    expectError(() => open({ globalBudgetMicro: 9_999_999 }), 503)
    expectError(() => open(undefined, { receiptSecret: key() }), 503)
    expectError(() => open(undefined, { objectSecret: key() }), 503)
    expectError(
      () => open(undefined, { path: join(directory, 'bad-time.sqlite'), now: () => Number.NaN }),
      503,
    )
    const bad = join(directory, 'bad.sqlite')
    writeFileSync(bad, '')
    expectError(() => open(undefined, { path: bad }), 503)
    writeFileSync(bad, 'not SQLite')
    expectError(() => open(undefined, { path: bad }), 503)
    const foreignPath = join(directory, 'foreign.sqlite')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('CREATE TABLE retained_mock_data (id TEXT)')
    foreign.close()
    expectError(() => open(undefined, { path: foreignPath }), 503)
    expect(open().snapshot().jobs).toBe(1)
  })
  it('rejects symlink or replaced durable files, missing parents and closed handles without empty fallback', () => {
    const ledger = open()
    admit(ledger)
    const path = options().path
    const symlink = join(directory, 'alias.sqlite')
    symlinkSync(path, symlink)
    expectError(() => open(undefined, { path: symlink }), 503)
    expectError(() => open(undefined, { path: join(directory, 'missing', 'state.sqlite') }), 503)
    renameSync(path, join(directory, 'preserved.sqlite'))
    writeFileSync(path, '')
    expectError(() => ledger.snapshot(), 503)
    ledger.close()
    expectError(() => ledger.snapshot(), 503)
  })
  it('loss of the primary DB cannot silently create a fresh budget under its durable namespace marker', () => {
    const ledger = open()
    admit(ledger)
    ledger.kill('persisted kill')
    ledger.close()
    rmSync(options().path)
    expectError(() => open(), 503, 'store-unavailable')
    expect(readFileSync(`${options().path}.p04-identity`, 'utf8')).toContain(
      'p04-ledger-checkpoint@1',
    )
  })
  it('missing identity marker or schema-corrupt checkpoint fails closed rather than rebuilding rows', () => {
    const ledger = open()
    admit(ledger)
    ledger.close()
    const db = new DatabaseSync(options().path)
    db.prepare('UPDATE p04_checkpoint SET payload=? WHERE singleton=1').run('{"schema":"unknown"}')
    db.close()
    expectError(() => open(), 503)
    rmSync(`${options().path}.p04-identity`)
    expectError(() => open(), 503)
  })
  it('waits for a brief independent write lock without losing or duplicating the reservation', async () => {
    const ledger = open()
    const child = spawn(
      node,
      [
        '--input-type=module',
        '--eval',
        `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(options().path)});
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('LOCKED\\n');
      process.stdin.once('data', () => setTimeout(() => {
        db.exec('ROLLBACK'); db.close(); process.exit(0);
      }, 150));
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve())
        child.stderr.resume()
        child.once('error', reject)
        child.once('exit', (code) => reject(new Error(`Lock holder exited early: ${code}`)))
      })
      await new Promise<void>((resolve, reject) =>
        child.stdin.write('release\n', (error) => (error ? reject(error) : resolve())),
      )
      expect(admit(ledger).disposition).toBe('created')
      expect(ledger.snapshot().global.uniqueMisses).toBe(1)
      expect(ledger.snapshot().global.reservedMicro).toBe(worstCaseQuote(ledger.policy).total)
      expect(ledger.events().filter((event) => event.kind === 'reserved')).toHaveLength(1)
    } finally {
      if (child.exitCode === null) child.kill()
      await exited
    }
  })
  it('a real independent SQLite write lock returns bounded 503 and cannot partially reserve or duplicate events', () => {
    const ledger = open()
    const blocker = new DatabaseSync(options().path)
    blocker.exec('BEGIN IMMEDIATE')
    const start = performance.now()
    try {
      expectError(() => admit(ledger), 503, 'store-unavailable')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
    expect(performance.now() - start).toBeLessThan(1000)
    expect(ledger.snapshot().global.uniqueMisses).toBe(0)
    expect(ledger.events()).toEqual([])
    expect(admit(ledger).disposition).toBe('created')
  })
  it('SQLite commit-write failure rolls back event and all account mutations; reopened state remains unchanged', () => {
    const ledger = open()
    admit(ledger)
    const before = ledger.snapshot()
    const events = ledger.events()
    const db = new DatabaseSync(options().path)
    db.exec(
      "CREATE TRIGGER p04_test_full BEFORE UPDATE ON p04_checkpoint BEGIN SELECT RAISE(FAIL, 'synthetic disk full'); END;",
    )
    expectError(() => admit(ledger, { design: designs[3] }), 503, 'store-unavailable')
    db.exec('DROP TRIGGER p04_test_full')
    db.close()
    expect(ledger.snapshot()).toEqual(before)
    expect(ledger.events()).toEqual(events)
    ledger.close()
    expect(open().snapshot()).toEqual(before)
  })
  it('SQLite enforces hard retained checkpoint/event byte caps without overwriting existing state', () => {
    const ledger = open()
    admit(ledger)
    const before = ledger.snapshot()
    const events = ledger.events()
    const db = new DatabaseSync(options().path)
    try {
      expect(() =>
        db.exec('UPDATE p04_checkpoint SET payload=zeroblob(33554433) WHERE singleton=1'),
      ).toThrow(/CHECK constraint failed/)
      expect(() =>
        db
          .prepare('INSERT INTO p04_events(sequence,job_id,payload) VALUES(999,NULL,?)')
          .run('x'.repeat(1025)),
      ).toThrow(/CHECK constraint failed/)
    } finally {
      db.close()
    }
    expect(ledger.snapshot()).toEqual(before)
    expect(ledger.events()).toEqual(events)
  })
  it('caps retained telemetry while reserving capacity for kill and final reconciliation; event reads are bounded', () => {
    const ledger = open()
    const first = admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    const db = new DatabaseSync(options().path)
    // Populate only this disposable database's audit history to the real fixed ceiling.
    // No financial counter, policy, event or tombstone is reset or deleted.
    const running = receipt(l, { outcome: 'running', finalMeter: false, startForbidden: false })
    ledger.recordReceipt(running)
    const existing = ledger.events().length
    const event = {
      at: time,
      jobId: l.execution.jobId,
      kind: 'heartbeat',
      fromState: 'rendering',
      toState: 'rendering',
      fence: l.execution.fence,
      executionId: l.execution.executionId,
      detail: '',
    }
    try {
      db.prepare(
        `WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x+1 FROM n WHERE x<65536)
        INSERT INTO p04_events(sequence,job_id,payload) SELECT x,?,json_set(?, '$.sequence',x) FROM n`,
      ).run(existing + 1, l.execution.jobId, JSON.stringify(event))
      db.exec(
        "UPDATE p04_checkpoint SET payload=json_set(payload,'$.eventCount',65536) WHERE singleton=1",
      )
    } finally {
      db.close()
    }
    expect(ledger.events()).toHaveLength(4096)
    expectError(() => admit(ledger, { design: designs[3] }), 429, 'capacity-exceeded')
    expect(ledger.recordReceipt(running)).toBe(true) // exact replay stays idempotent even at capacity
    expect(ledger.snapshot().killed).toBe(false)
    expect(
      ledger.reconcile(
        receipt(l, { sequence: 2, outcome: 'running', finalMeter: false, startForbidden: false }),
      ),
    ).toBe(false)
    expect(ledger.snapshot().killReason).toBe('telemetry-capacity')
    expect(ledger.snapshot().global.reservedMicro).toBe(first.view.job.quote.total - 10)
    expect(ledger.reconcile(receipt(l, { sequence: 3, outcome: 'stopped' }))).toBe(true)
    expect(ledger.snapshot().global.reservedMicro).toBe(0)
    expect(ledger.snapshot().activeExecutions).toHaveLength(0)
    expect(ledger.events()).toHaveLength(4096)
    ledger.close()
    expect(open().snapshot().killed).toBe(true)
  })
  it('unknown provider inventory cannot manufacture a ledger refund or a new execution', () => {
    const ledger = open()
    admit(ledger)
    const l = lease(ledger)
    const orphan = receipt({
      ...l,
      execution: { ...l.execution, executionId: key(), jobId: key() },
    })
    const before = ledger.snapshot()
    expect(ledger.recordReceipt(orphan)).toBe(false)
    expect(ledger.reconcile(orphan)).toBe(false)
    expect(ledger.snapshot()).toEqual(before)
  })
  it('audit events are legal, bounded metadata and never raw design, failure text or signing keys', () => {
    const ledger = open()
    admit(ledger)
    const l = lease(ledger)
    ledger.beginExecution(l)
    ledger.fail(l, { ...failure, message: 'DO-NOT-LOG secret raw provider config' })
    ledger.kill('audit stop')
    const events = ledger.events()
    for (const event of events) {
      if (event.fromState && event.toState)
        expect(canTransition(event.fromState, event.toState)).toBe(true)
      expect(event.detail.length).toBeLessThanOrEqual(240)
      expect(Number.isSafeInteger(event.at)).toBe(true)
    }
    const output = JSON.stringify({ events, snapshot: ledger.snapshot() })
    expect(output).not.toContain('DO-NOT-LOG')
    expect(output).not.toContain(receiptSecret)
    expect(output).not.toContain(objectSecret)
    expect(output).not.toContain('cameraRef')
    expect(output).not.toContain('workerCommand')
    const bytes = readFileSync(options().path).toString('utf8')
    expect(bytes).not.toContain(receiptSecret)
    expect(bytes).not.toContain(objectSecret)
  })
})

// Two actual independent Node processes race BEGIN IMMEDIATE on one disposable SQLite.
// TypeScript is transpiled in-memory with the already installed compiler, never installed or emitted.
async function raceAdmissions(ledger: SqliteLedger, requests: Admission[]) {
  const source = fileURLToPath(new URL('./ledger.ts', import.meta.url))
  const compiler = fileURLToPath(
    new URL('../../../node_modules/typescript/lib/typescript.js', import.meta.url),
  )
  const bootstrap = `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    import { pathToFileURL, fileURLToPath } from 'node:url';
    import ts from ${JSON.stringify(compiler)};
    registerHooks({
      resolve(specifier, context, next) { try { return next(specifier, context) } catch (error) {
        if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) return next(specifier.replace(/\\.js$/, '') + '.ts', context);
        throw error;
      } },
      load(url, context, next) { if (url.endsWith('.ts')) return { format:'module', shortCircuit:true,
        source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText };
        return next(url, context); }
    });
    const { SqliteLedger } = await import(pathToFileURL(${JSON.stringify(source)}).href);
    let buffer=''; let ledger; let input;
    process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => {
      buffer += chunk; let index;
      while ((index=buffer.indexOf('\\n')) >= 0) {
        const message=JSON.parse(buffer.slice(0,index)); buffer=buffer.slice(index+1);
        if (message.kind==='init') {
          input=message.input; ledger=new SqliteLedger({...message.options,now:()=>message.now});
          // Test serialization, not the production 250ms availability deadline (covered separately).
          // Allow a contending process to be descheduled on a loaded CI runner without losing the race assertion.
          ledger.db.exec('PRAGMA busy_timeout=5000');
          process.stdout.write('READY\\n');
        }
        else { try { const result=ledger.admit(input); process.stdout.write(JSON.stringify({status:'ok',jobId:result.view.job.id,disposition:result.disposition})+'\\n'); }
          catch(error) {process.stdout.write(JSON.stringify({status:error.status,code:error.code})+'\\n');}
          finally {ledger.close();process.exit(0);} }
      }
    });
  `
  const children = requests.map(() =>
    spawn(node, ['--input-type=module', '--eval', bootstrap], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        NODE_NO_WARNINGS: '1',
      },
    }),
  )
  const results: Promise<{
    status: string | number
    code?: string
    jobId?: string
    disposition?: string
  }>[] = []
  try {
    await Promise.all(
      children.map(
        (child, index) =>
          new Promise<void>((resolve, reject) => {
            let buffer = ''
            let initialized = false
            let resultResolve: (value: {
              status: string | number
              code?: string
              jobId?: string
              disposition?: string
            }) => void
            let resultReject: (error: Error) => void
            results.push(
              new Promise((res, rej) => {
                resultResolve = res
                resultReject = rej
              }),
            )
            child.stdout.setEncoding('utf8')
            child.stderr.resume()
            child.on('error', reject)
            child.on('exit', (code) => {
              if (code !== 0) {
                const error = new Error('Isolated admission subprocess failed')
                reject(error)
                resultReject(error)
              }
            })
            child.stdout.on('data', (chunk) => {
              buffer += chunk
              let lineEnd: number
              while ((lineEnd = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, lineEnd)
                buffer = buffer.slice(lineEnd + 1)
                if (line === 'READY') {
                  initialized = true
                  resolve()
                } else if (initialized) resultResolve(JSON.parse(line))
              }
            })
            child.stdin.write(
              JSON.stringify({
                kind: 'init',
                input: requests[index],
                options: {
                  path: options().path,
                  policy: ledger.policy,
                  receiptSecret,
                  objectSecret,
                },
                now: time,
              }) + '\n',
            )
          }),
      ),
    )
    for (const child of children) child.stdin.write('{"kind":"go"}\n')
    return await Promise.all(results)
  } finally {
    for (const child of children) {
      child.stdin.end()
      if (child.exitCode === null) child.kill()
    }
  }
}

describe('cross-process atomic races', () => {
  it('coalesces concurrent identical misses into exactly one sponsored reservation', async () => {
    const ledger = open()
    const results = await raceAdmissions(ledger, [
      admission(ledger),
      admission(ledger, { auth: other }),
    ])
    expect(
      results.map((r) => r.status),
      JSON.stringify(results),
    ).toEqual(['ok', 'ok'])
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1)
    expect(results.map((r) => r.disposition).sort()).toEqual(['coalesced', 'created'])
    expect(ledger.snapshot().jobs).toBe(1)
    expect(ledger.snapshot().interests).toBe(2)
    expect(ledger.snapshot().global.reservedMicro).toBe(worstCaseQuote(ledger.policy).total)
  }, 20_000)
  it('allows exactly one of two concurrent unique misses at the global budget ceiling', async () => {
    const ledger = open({ globalBudgetMicro: worstCaseQuote().total })
    const results = await raceAdmissions(ledger, [
      admission(ledger),
      admission(ledger, { auth: other, design: designs[3] }),
    ])
    expect(
      results.filter((r) => r.status === 'ok'),
      JSON.stringify(results),
    ).toHaveLength(1)
    expect(results.filter((r) => r.status === 429 && r.code === 'budget-exceeded')).toHaveLength(1)
    expect(ledger.snapshot().jobs).toBe(1)
    expect(ledger.snapshot().interests).toBe(1)
    expect(ledger.snapshot().global.uniqueMisses).toBe(1)
    expect(ledger.events().filter((e) => e.kind === 'reserved')).toHaveLength(1)
  }, 20_000)
})
