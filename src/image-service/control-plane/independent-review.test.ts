import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign } from '../../domain/design'
import { createMockArtifact } from '../protocol'
import { createLoopbackControlServer } from './api'
import { createSignedContextAuth } from './auth'
import {
  artifactPath,
  bindRequestSync,
  DEFAULT_POLICY,
  EXPORT_PATH,
  exportRequestFixture,
  IMAGE_PATH,
  imageRequestFixture,
  interestPath,
  signProviderReceipt,
  signWorkerContext,
  workerClaimsForLease,
  worstCaseQuote,
  type AuthContext,
  type FakeProvider,
  type Lease,
  type Policy,
} from './contracts'
import { SqliteLedger } from './ledger'
import { FileObjectStore, type ObjectStoreTestHooks } from './objects'
import { LocalFakeProvider, type FakeExecutionPlan } from './provider'
import { SafeImageService } from './service'
import { IndependentWatchdog } from './watchdog'
import { ControlWorker } from './worker'

// Independent adversarial cases, with unsafe characterizations converted to safe regressions.
import { TEST_ROOT as HANDOFF } from './testPaths'
const alice: AuthContext = {
  principalId: 'review-alice-000001',
  experimentId: 'review-experiment-01',
  scopes: ['images:read', 'images:write', 'exports:write'],
}
const bob: AuthContext = { ...alice, principalId: 'review-bob-00000001' }
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const alternate = () => defaultDesign({ family: 'studio', lengthFt: 40 })
function fixture(
  options: {
    policy?: Partial<Policy>
    plan?: FakeExecutionPlan
    hooks?: ObjectStoreTestHooks
  } = {},
) {
  const dir = mkdtempSync(join(HANDOFF, 'independent-review-store-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let now = 2_000_000
  const clock = () => now
  const receiptSecret = randomBytes(32).toString('hex')
  const objectSecret = randomBytes(32).toString('hex')
  const contextSecret = randomBytes(32).toString('hex')
  const ledgerOptions = {
    path: join(dir, 'ledger.sqlite'),
    receiptSecret,
    objectSecret,
    policy: options.policy,
    now: clock,
  }
  const openLedger = () => {
    const value = new SqliteLedger(ledgerOptions)
    cleanup.push(() => value.close())
    return value
  }
  const ledger = openLedger()
  const provider = new LocalFakeProvider(
    { path: join(dir, 'provider.sqlite'), receiptSecret, contextSecret, now: clock },
    { plan: () => options.plan ?? {} },
  )
  cleanup.push(() => provider.close())
  const objects = new FileObjectStore(
    { root: join(dir, 'objects'), objectSecret, now: clock },
    options.hooks,
  )
  cleanup.push(() => objects.close())
  const service = new SafeImageService({ ledger, objects, now: clock })
  const worker = new ControlWorker({
    ledger,
    provider,
    objects,
    contextSecret,
    workerId: 'review-worker-00001',
    now: clock,
  })
  cleanup.push(() => worker.shutdown())
  const watchdog = new IndependentWatchdog({ ledger, provider, objects, now: clock })
  function admit(design = defaultDesign(), auth = alice, key = 'review-idempotency-01') {
    return ledger.admit({
      auth,
      purpose: 'image',
      request: imageRequestFixture(design, key),
      binding: bindRequestSync(design, 'image', auth),
      quote: worstCaseQuote(ledger.policy),
    })
  }
  function context(lease: Lease) {
    return signWorkerContext(workerClaimsForLease(lease, now), contextSecret)
  }
  async function listen() {
    const auth = createSignedContextAuth({ secret: randomBytes(32).toString('hex'), now: clock })
    const server = createLoopbackControlServer({ service, authenticate: auth.authenticate })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local test listener')
    return (path: string, body?: unknown, grant: AuthContext | null = alice) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(grant ? { Authorization: `Bearer ${auth.issue(grant, 60_000)}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
  }
  return {
    dir,
    ledgerOptions,
    ledger,
    provider,
    objects,
    service,
    worker,
    watchdog,
    admit,
    openLedger,
    context,
    listen,
    receiptSecret,
    clock,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function providerFacade(provider: FakeProvider, stop: FakeProvider['stop']): FakeProvider {
  return {
    provider: 'fake-local',
    paidExecutionAllowed: false,
    execute: (context) => provider.execute(context),
    inspect: () => provider.inspect(),
    receipt: (execution) => provider.receipt(execution),
    stop,
    close: async () => {},
  }
}

describe('independent P04 adversarial fault review', () => {
  it('global budget cannot be bypassed by coalescing, principal rotation, and restart', () => {
    const total = worstCaseQuote(DEFAULT_POLICY).total
    const f = fixture({ policy: { globalBudgetMicro: total } })
    const first = f.admit()
    expect(f.admit(undefined, bob, 'review-coalesce-0001').view.job.id).toBe(first.view.job.id)
    const reopened = f.openLedger()
    const rotated = { ...bob, experimentId: 'review-other-exp-001' }
    expect(() =>
      reopened.admit({
        auth: rotated,
        purpose: 'image',
        request: imageRequestFixture(alternate(), 'review-rotate-000001'),
        binding: bindRequestSync(alternate(), 'image', rotated),
        quote: worstCaseQuote(reopened.policy),
      }),
    ).toThrow(expect.objectContaining({ status: 429, code: 'budget-exceeded' }))
    expect(reopened.snapshot()).toMatchObject({
      jobs: 1,
      interests: 2,
      global: { reservedMicro: total, uniqueMisses: 1 },
    })
  })

  it('principal rotation cannot bypass durable interest or identity-row capacity', () => {
    const f = fixture({ policy: { maxInterests: 2, maxPrincipals: 2 } })
    f.admit()
    f.admit(undefined, bob, 'review-coalesce-0001')
    expect(() =>
      f.admit(undefined, { ...bob, principalId: 'review-third-000001' }, 'review-coalesce-0002'),
    ).toThrow(expect.objectContaining({ status: 429 }))
    expect(f.openLedger().snapshot()).toMatchObject({ jobs: 1, interests: 2 })
    expect(f.ledger.snapshot().principals).toHaveLength(2)
  })

  it('known failed attempts consume the prepaid retry cap without new reservations', async () => {
    const f = fixture({ plan: { mode: 'known-failure' }, policy: { maxAttempts: 2 } })
    const first = f.admit()
    const quote = worstCaseQuote(f.ledger.policy)
    expect(await f.worker.runOnce()).toBe(1)
    const retry = f.ledger.getInterest(alice, first.view.interest.id).job
    expect(retry).toMatchObject({ state: 'queued', attempts: 1, reservedMicro: quote.total })
    f.advance(f.ledger.policy.retryDelayMs)
    expect(await f.worker.runOnce()).toBe(1)
    expect(f.ledger.getInterest(alice, first.view.interest.id).job).toMatchObject({
      state: 'failed',
      attempts: 2,
      reservedMicro: 0,
    })
    expect(await f.worker.runOnce()).toBe(0)
    expect((await f.provider.inspect()).length).toBe(2)
    expect(f.ledger.snapshot().global.uniqueMisses).toBe(1)
  })

  it('kill before execute creates durable tombstone and rejects a delayed signed start', async () => {
    const f = fixture()
    f.admit()
    const lease = f.ledger.claim('review-delayed-worker')!
    expect(f.ledger.beginExecution(lease)).toBe(true)
    const context = f.context(lease)
    const killed = await f.watchdog.kill('review delayed dispatch')
    expect(killed.killed).toBe(true)
    expect(killed.retainedLiabilities).toBe(0)
    expect(await f.provider.execute(context)).toMatchObject({
      outcome: 'failure',
      receipt: { claims: { outcome: 'stopped', startForbidden: true, finalMeter: true } },
    })
    expect((await f.provider.inspect())[0].startedAt).toBeNull()
    expect(f.openLedger().claim('review-delayed-worker')).toBeNull()
  })

  it('delayed stop and meter never release liabilities or simulated streams prematurely', async () => {
    const f = fixture({ plan: { mode: 'unknown', stopDelayMs: 100, meterDelayMs: 100 } })
    const first = f.admit()
    const lease = f.ledger.claim('review-delayed-worker')!
    f.ledger.beginExecution(lease)
    await f.provider.execute(f.context(lease))
    f.ledger.openStream(alice, first.view.interest.id)
    const killed = await f.watchdog.kill('review delayed stop')
    expect(killed).toMatchObject({ killed: true, retainedLiabilities: 1, closedStreams: 1 })
    const initial = f.ledger.snapshot().global
    expect(initial.reservedMicro).toBeGreaterThan(0)
    f.advance(100)
    expect(await f.watchdog.tick()).toMatchObject({ retainedLiabilities: 1 })
    expect(f.openLedger().snapshot().global.reservedMicro).toBeGreaterThan(0)
    f.advance(100)
    expect(await f.watchdog.tick()).toMatchObject({ retainedLiabilities: 0 })
    expect(f.ledger.snapshot().global.reservedMicro).toBe(0)
  })

  it('a provider-only unresolved execution prevents dispatch and watchdog reports its liability', async () => {
    const f = fixture({ plan: { mode: 'unknown', neverSettle: true } })
    const first = f.admit()
    const lease = f.ledger.claim('review-orphan-worker')!
    const context = f.context({
      ...lease,
      execution: {
        ...lease.execution,
        executionId: 'review-orphan-exec-01',
        jobId: 'review-orphan-job-001',
      },
    })
    await f.provider.execute(context)
    expect(f.ledger.getInterest(alice, first.view.interest.id).job.state).toBe('leased')
    await expect(f.worker.runOnce()).rejects.toMatchObject({ status: 503 })
    expect(await f.watchdog.tick()).toMatchObject({ orphanExecutions: 1, retainedLiabilities: 2 })
    expect(f.ledger.snapshot().global.reservedMicro).toBe(worstCaseQuote(f.ledger.policy).total)
  })

  it('SQLite commit failure prevents provider dispatch and rolls back claim/fence/events', async () => {
    const f = fixture()
    const first = f.admit()
    const db = new DatabaseSync(f.ledgerOptions.path)
    cleanup.push(() => db.close())
    db.exec(
      "CREATE TRIGGER review_write_fault BEFORE UPDATE ON p04_checkpoint BEGIN SELECT RAISE(FAIL, 'review injected write failure'); END",
    )
    await expect(f.worker.runOnce()).rejects.toMatchObject({ status: 503 })
    expect(await f.provider.inspect()).toHaveLength(0)
    const row = db.prepare('SELECT payload FROM p04_checkpoint').get()!
    const state = JSON.parse(String(row.payload))
    expect(state.jobs[0].record).toMatchObject({
      id: first.view.job.id,
      state: 'queued',
      attempts: 0,
      fence: 0,
    })
  })

  it('kill between filesystem publication and ledger CAS prevents readiness', async () => {
    let kill = () => {}
    const f = fixture({
      hooks: {
        at: (point) => {
          if (point === 'before-receipt') kill()
        },
      },
    })
    kill = () => {
      f.ledger.kill('review publication race')
    }
    const first = f.admit()
    await f.worker.runOnce()
    const job = f.ledger.getInterest(alice, first.view.interest.id).job
    expect(job.state).not.toBe('ready')
    expect(f.ledger.snapshot().killed).toBe(true)
    await expect(f.service.artifact(alice, first.view.interest.id)).rejects.toMatchObject({
      status: 503,
    })
    const recovered = await f.objects.recover([], [], f.clock())
    expect(recovered.orphanObjects).toHaveLength(1)
  })

  it('publication readback fault cannot produce a ready manifest', async () => {
    const f = fixture({
      hooks: {
        at: (point) => {
          if (point === 'before-receipt') throw new Error('review readback fault')
        },
      },
    })
    const first = f.admit()
    await f.worker.runOnce()
    expect(f.ledger.getInterest(alice, first.view.interest.id).job).toMatchObject({
      state: 'failed',
      artifact: null,
    })
    expect(f.ledger.snapshot().global.spentMicro).toBeGreaterThan(0)
    await expect(f.service.artifact(alice, first.view.interest.id)).rejects.toMatchObject({
      status: 503,
    })
  })

  it('cross-principal coalescing cannot expand the shared delivery byte allowance', async () => {
    const f = fixture({ policy: { maxDeliveriesPerJob: 1 } })
    const a = f.admit()
    const b = f.admit(undefined, bob, 'review-coalesce-0001')
    await f.worker.runOnce()
    const first = await f.service.artifact(alice, a.view.interest.id)
    await expect(f.service.artifact(bob, b.view.interest.id)).rejects.toMatchObject({ status: 429 })
    expect(f.openLedger().snapshot().deliveredBytes).toBe(first.bytes.length)
  })

  it('quarantines a newer authenticated final-meter contradiction durably without rewriting settled balances', async () => {
    const f = fixture()
    const first = f.admit()
    await f.worker.runOnce()
    const final = (await f.provider.inspect())[0].receipt
    const before = f.ledger.snapshot()
    expect(f.ledger.recordReceipt(final)).toBe(true)
    const older = signProviderReceipt(
      { ...final.claims, sequence: final.claims.sequence - 1 },
      f.receiptSecret,
    )
    expect(f.ledger.recordReceipt(older)).toBe(false)
    expect(f.openLedger().snapshot().quarantinedExecutions).toEqual([])
    const contradiction = signProviderReceipt(
      {
        ...final.claims,
        sequence: final.claims.sequence + 1,
        cumulativeCostMicro: worstCaseQuote(f.ledger.policy).total + 1,
        runtimeMs: f.ledger.policy.maxRuntimeMs + 1,
      },
      f.receiptSecret,
    )
    expect(f.ledger.recordReceipt(contradiction)).toBe(false)
    expect(f.openLedger().snapshot()).toMatchObject({
      killed: true,
      global: before.global,
      quarantinedExecutions: [
        {
          execution: final.claims.execution,
          settledReceipt: final,
          contradictoryReceipt: contradiction,
          outstandingLiabilityUnknown: true,
        },
      ],
    })
    expect(
      f.ledger.events(first.view.job.id).some((event) => event.kind === 'provider-quarantined'),
    ).toBe(true)
    expect(f.ledger.getInterest(alice, first.view.interest.id).job).toMatchObject({
      state: 'ready',
      reconciliationRequired: false,
      reservedMicro: 0,
    })
    expect(() => f.admit(alternate(), bob, 'review-after-final-01')).toThrow()
    expect(f.ledger.recordReceipt(final)).toBe(false)
    expect(f.openLedger().snapshot().quarantinedExecutions).toHaveLength(1)
    f.advance(f.ledger.policy.retentionMs + f.ledger.policy.jobTtlMs + 1)
    expect(f.ledger.retentionCandidates()).toHaveLength(0)
  })

  it('kill stops and quarantines contradictory running inventory for a historically settled execution', async () => {
    const f = fixture()
    f.admit()
    await f.worker.runOnce()
    const resource = (await f.provider.inspect())[0]
    const contradiction = signProviderReceipt(
      {
        ...resource.receipt.claims,
        sequence: resource.receipt.claims.sequence + 1,
        outcome: 'running',
        finalMeter: false,
        startForbidden: false,
      },
      f.receiptSecret,
    )
    let stopCalls = 0
    const provider = providerFacade(f.provider, (execution, reason) => {
      stopCalls++
      return f.provider.stop(execution, reason)
    })
    provider.inspect = async () => [{ ...resource, receipt: contradiction }]
    const watchdog = new IndependentWatchdog({ ledger: f.ledger, provider, now: f.clock })
    expect(await watchdog.kill('review-historic-provider-contradiction')).toMatchObject({
      killed: true,
      stopRequested: 1,
      retainedLiabilities: 1,
      orphanExecutions: 0,
      errors: ['provider-finality-quarantined'],
    })
    expect(stopCalls).toBe(1)
    expect(f.openLedger().snapshot().quarantinedExecutions).toHaveLength(1)
  })

  it('a hung stop times out without starving another stop or stream closure, retaining liability', async () => {
    const f = fixture({ plan: { mode: 'unknown' } })
    const first = f.admit()
    f.admit(alternate(), bob, 'review-second-job-01')
    for (let n = 0; n < 2; n++) {
      const lease = f.ledger.claim('review-held-worker-01')!
      f.ledger.beginExecution(lease)
      await f.provider.execute(f.context(lease))
    }
    f.ledger.openStream(alice, first.view.interest.id)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let stops = 0
    const provider = providerFacade(f.provider, async (execution, reason) => {
      stops++
      if (stops === 1) await gate
      return f.provider.stop(execution, reason)
    })
    const watchdog = new IndependentWatchdog({
      ledger: f.ledger,
      provider,
      now: f.clock,
      providerCallTimeoutMs: 10,
    })
    const pass = watchdog.kill('review hung stop')
    try {
      const result = await Promise.race([
        pass.then(() => 'completed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 1_000)),
      ])
      expect(result).toBe('completed')
      expect(stops).toBe(2)
      expect(f.ledger.snapshot()).toMatchObject({
        killed: true,
        streams: [{ state: 'closed' }],
      })
      expect((await pass).retainedLiabilities).toBeGreaterThan(0)
      await watchdog.tick()
      expect(stops).toBe(2) // The timed-out operation retains its slot, not another promise per tick.
    } finally {
      release()
      await pass
    }
    expect(stops).toBe(2)
  })

  it('watchdog cleanup cutoff precedes its snapshot and preserves a newly live stage', async () => {
    const f = fixture()
    f.admit()
    const recover = f.objects.recover.bind(f.objects)
    const recovered = vi
      .spyOn(f.objects, 'recover')
      .mockImplementation(async (references, active, before) => {
        const lease = f.ledger.claim('review-stage-worker01')!
        f.ledger.beginExecution(lease)
        const staged = await f.objects.stage(lease, await createMockArtifact(lease.design))
        f.advance(1)
        expect(before).toBeLessThan(f.clock())
        const report = await recover(references, active, before)
        expect(report.removedStages).toBe(0)
        await expect(f.objects.publish(staged)).resolves.toHaveProperty('claims')
        return report
      })
    expect((await f.watchdog.tick()).errors).toEqual([])
    expect(recovered).toHaveBeenCalledOnce()
    expect(f.ledger.snapshot().activeExecutions).toHaveLength(1)
  })

  it('real HTTP private export IDs do not authorize other principals, experiments, queries or anonymous access', async () => {
    const f = fixture()
    const request = await f.listen()
    const submitted = await request(EXPORT_PATH, exportRequestFixture())
    expect(submitted.status).toBe(202)
    const body = (await submitted.json()) as { interestId: string }
    await f.worker.runOnce()
    const path = artifactPath(body.interestId)
    expect((await request(path, undefined, bob)).status).toBe(404)
    expect(
      (await request(path, undefined, { ...alice, experimentId: 'review-foreign-exp01' })).status,
    ).toBe(404)
    expect((await request(path, undefined, null)).status).toBe(401)
    expect((await request(`${path}?token=not-a-credential`)).status).toBe(400)
    const delivered = await request(path)
    expect(delivered.status).toBe(200)
    expect(delivered.headers.get('cache-control')).toBe('private, no-store')
    expect(delivered.headers.get('content-disposition')).toContain('attachment;')
    const text = await delivered.text()
    expect(text).toContain('MOCK')
    expect(text).not.toContain(alice.principalId)
    expect((await request(interestPath(body.interestId), undefined, bob)).status).toBe(404)
  })

  it.each([
    'assetURLs',
    'meshes',
    'camera',
    'samples',
    'script',
    'callback',
    'workerCommand',
    'priority',
    'auth',
    'outputProfile',
  ])('real HTTP rejects forbidden top-level %s without admission', async (field) => {
    const f = fixture()
    const request = await f.listen()
    expect(
      (await request(IMAGE_PATH, { ...imageRequestFixture(), [field]: 'review-forbidden' })).status,
    ).toBe(422)
    expect(f.ledger.snapshot()).toMatchObject({ jobs: 0, interests: 0 })
  })

  it('real HTTP enforces nested shape and byte cap before durable admission', async () => {
    const f = fixture()
    const request = await f.listen()
    const base = imageRequestFixture()
    expect(
      (
        await request(IMAGE_PATH, {
          ...base,
          design: { ...base.design, presentation: { ...base.design.presentation, samples: 1 } },
        })
      ).status,
    ).toBe(422)
    expect((await request(IMAGE_PATH, { ...base, padding: 'x'.repeat(16 * 1024) })).status).toBe(
      413,
    )
    expect(f.ledger.snapshot().jobs).toBe(0)
  })
})
