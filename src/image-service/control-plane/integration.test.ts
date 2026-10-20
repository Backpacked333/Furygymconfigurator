import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDesign } from '../../domain/design'
import { createLoopbackControlServer } from './api'
import { createSignedContextAuth } from './auth'
import {
  artifactPath,
  CONTROL_PROTOCOL,
  DEFAULT_POLICY,
  EXPORT_PATH,
  exportRequestFixture,
  IMAGE_PATH,
  imageRequestFixture,
  interestPath,
  sha256Bytes,
  signWorkerContext,
  statusReplySchema,
  workerClaimsForLease,
  worstCaseQuote,
  type AuthContext,
  type Policy,
} from './contracts'
import { SqliteLedger } from './ledger'
import { FileObjectStore, type ObjectStoreTestHooks } from './objects'
import { LocalFakeProvider, type FakeExecutionPlan } from './provider'
import { SafeImageService } from './service'
import { IndependentWatchdog } from './watchdog'
import { ControlWorker } from './worker'

import { TEST_ROOT as ROOT } from './testPaths'
const alice: AuthContext = {
  principalId: 'integration-alice-001',
  experimentId: 'integration-experiment-01',
  scopes: ['images:read', 'images:write', 'exports:write'],
}
const bob: AuthContext = { ...alice, principalId: 'integration-bob-00001' }
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const changed = () => {
  const design = defaultDesign()
  return {
    ...design,
    presentation: { ...design.presentation, lookRef: 'desert-day-draft@1' as const },
  }
}

async function fixture(
  options: {
    policy?: Partial<Policy>
    plan?: FakeExecutionPlan
    objectHooks?: ObjectStoreTestHooks
  } = {},
) {
  const dir = mkdtempSync(join(ROOT, 'integration-test-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1_000_000
  const clock = () => now
  const keys = {
    receiptSecret: randomBytes(32).toString('hex'),
    objectSecret: randomBytes(32).toString('hex'),
    contextSecret: randomBytes(32).toString('hex'),
  }
  const ledgerOptions = {
    path: join(dir, 'ledger.sqlite'),
    receiptSecret: keys.receiptSecret,
    objectSecret: keys.objectSecret,
    policy: options.policy,
    now: clock,
  }
  const providerOptions = {
    path: join(dir, 'provider.sqlite'),
    contextSecret: keys.contextSecret,
    receiptSecret: keys.receiptSecret,
    now: clock,
  }
  const objectOptions = { root: join(dir, 'objects'), objectSecret: keys.objectSecret, now: clock }
  const openLedger = () => {
    const value = new SqliteLedger(ledgerOptions)
    cleanup.push(() => value.close())
    return value
  }
  const openProvider = () => {
    const value = new LocalFakeProvider(providerOptions, { plan: () => options.plan ?? {} })
    cleanup.push(() => value.close())
    return value
  }
  const openObjects = () => {
    const value = new FileObjectStore(objectOptions, options.objectHooks)
    cleanup.push(() => value.close())
    return value
  }
  const ledger = openLedger(),
    provider = openProvider(),
    objects = openObjects()
  const worker = new ControlWorker({
    ledger,
    provider,
    objects,
    contextSecret: keys.contextSecret,
    workerId: 'integration-worker-01',
    now: clock,
  })
  cleanup.push(() => worker.shutdown())
  const watchdog = new IndependentWatchdog({ ledger, provider, objects, now: clock })
  const service = new SafeImageService({ ledger, objects, now: clock })
  const auth = createSignedContextAuth({ secret: randomBytes(32).toString('hex'), now: clock })
  async function listen(nextService = service) {
    const server: Server = createLoopbackControlServer({
      service: nextService,
      authenticate: auth.authenticate,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable')
    return `http://127.0.0.1:${address.port}`
  }
  const url = await listen()
  const request = (path: string, body?: unknown, grant: AuthContext | null = alice, base = url) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(grant ? { Authorization: `Bearer ${auth.issue(grant, 60_000)}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  async function submit(body = imageRequestFixture(), grant = alice) {
    const response = await request(IMAGE_PATH, body, grant)
    expect(response.status).toBe(202)
    return statusReplySchema.parse(await response.json())
  }
  return {
    ledger,
    provider,
    objects,
    worker,
    watchdog,
    service,
    request,
    submit,
    listen,
    openLedger,
    openProvider,
    openObjects,
    advance: (ms: number) => {
      now += ms
    },
    clock,
    keys,
  }
}

// Every request below crosses a real loopback socket, HMAC auth, service, and real SQLite.
// Only provider outcomes are synthetic; no browser, renderer, remote API or paid execution exists.
describe('durable loopback control plane integration', () => {
  it('returns miss 202, coalesces/idempotently attaches, publishes real checked bytes, then exact hit 200', async () => {
    const f = await fixture()
    const first = await f.submit()
    expect(first).toMatchObject({
      state: 'queued',
      artifact: null,
      productionAllowed: false,
      paidExecutionAllowed: false,
    })
    const quote = worstCaseQuote(f.ledger.policy)
    expect(f.ledger.snapshot().global).toMatchObject({
      reservedMicro: quote.total,
      uniqueMisses: 1,
    })
    const repeated = await f.submit()
    expect(repeated.interestId).toBe(first.interestId)
    const coalesced = await f.submit(imageRequestFixture(undefined, 'integration-coalesced1'), bob)
    expect(coalesced.jobId).toBe(first.jobId)
    expect(coalesced.interestId).not.toBe(first.interestId)
    expect(f.ledger.snapshot().global.uniqueMisses).toBe(1)
    expect(await f.worker.runOnce()).toBe(1)
    const ready = await f.request(interestPath(first.interestId))
    expect(ready.status).toBe(200)
    const status = statusReplySchema.parse(await ready.json())
    expect(status).toMatchObject({
      state: 'ready',
      reconciliationRequired: false,
      artifact: { kind: 'mock-diagnostic', strictExport: false, approvedCurrentImage: false },
    })
    const delivered = await f.request(artifactPath(first.interestId))
    expect(delivered.status).toBe(200)
    expect(delivered.headers.get('cache-control')).toBe('private, no-store')
    const bytes = new Uint8Array(await delivered.arrayBuffer())
    expect(sha256Bytes(bytes)).toBe(status.artifact!.checksum)
    expect(delivered.headers.get('etag')).toBe(`"${status.artifact!.checksum}"`)
    expect(Buffer.from(bytes).toString()).toContain('MOCK')
    const hit = await f.request(
      IMAGE_PATH,
      imageRequestFixture(undefined, 'integration-exact-hit1'),
    )
    expect(hit.status).toBe(200)
    expect(statusReplySchema.parse(await hit.json()).artifact).toEqual(status.artifact)
    expect((await f.provider.inspect()).length).toBe(1)
    expect(f.ledger.events(first.jobId).map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'requested',
        'reserved',
        'queued',
        'leased',
        'rendering',
        'publishing',
        'ready',
        'delivery-recorded',
      ]),
    )
  })

  it('distinct presentation/profile revisions never reuse an earlier immutable object', async () => {
    const f = await fixture()
    const first = await f.submit()
    await f.worker.runOnce()
    const next = await f.submit(imageRequestFixture(changed(), 'integration-next-rev1'))
    await f.worker.runOnce()
    const thumbnail = { ...defaultDesign(), outputProfile: 'web-thumbnail' as const }
    const third = await f.submit(imageRequestFixture(thumbnail, 'integration-thumbnail1'))
    await f.worker.runOnce()
    const objects = [first, next, third].map(
      (item) => f.ledger.getInterest(alice, item.interestId).job.artifact!,
    )
    expect(new Set(objects.map((object) => object.objectKey)).size).toBe(3)
    expect(new Set(objects.map((object) => object.binding.cacheKey)).size).toBe(3)
    for (const object of objects)
      expect(sha256Bytes(await f.objects.read(object))).toBe(object.checksum)
    expect((await f.request(IMAGE_PATH, imageRequestFixture(changed()))).status).toBe(409)
  })

  it('explicit diagnostic exports require a grant and remain principal/experiment private', async () => {
    const f = await fixture()
    const request = exportRequestFixture()
    expect(
      (await f.request(EXPORT_PATH, request, { ...alice, scopes: ['images:read', 'images:write'] }))
        .status,
    ).toBe(403)
    expect((await f.request(EXPORT_PATH, { ...request, format: 'pdf' })).status).toBe(422)
    const admitted = await f.request(EXPORT_PATH, request)
    expect(admitted.status).toBe(202)
    const first = statusReplySchema.parse(await admitted.json())
    await f.worker.runOnce()
    const response = await f.request(artifactPath(first.interestId))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="mock-diagnostic-/,
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    for (const other of [bob, { ...alice, experimentId: 'integration-experiment-02' }]) {
      expect((await f.request(artifactPath(first.interestId), undefined, other)).status).toBe(404)
      expect((await f.request(interestPath(first.interestId), undefined, other)).status).toBe(404)
    }
    expect((await f.request(artifactPath(first.interestId), undefined, null)).status).toBe(401)
    expect((await f.request(`${artifactPath(first.interestId)}?token=not-supported`)).status).toBe(
      400,
    )
    const second = statusReplySchema.parse(
      await (await f.request(EXPORT_PATH, request, bob)).json(),
    )
    expect(second.jobId).not.toBe(first.jobId)
    await f.worker.runOnce()
    const a = f.ledger.getInterest(alice, first.interestId).job.artifact!,
      b = f.ledger.getInterest(bob, second.interestId).job.artifact!
    expect(a.binding.visibility).toBe('private')
    expect(a.objectKey).not.toBe(b.objectKey)
    expect(a.binding.revision).toBe(b.binding.revision)
  })

  it.each([
    'assetURLs',
    'meshes',
    'camera',
    'samples',
    'scripts',
    'callback',
    'workerCommand',
    'priority',
    'auth',
    'paidExecutionAllowed',
  ])('rejects client %s without reservations or provider calls', async (key) => {
    const f = await fixture()
    expect(
      (await f.request(IMAGE_PATH, { ...imageRequestFixture(), [key]: 'not-permitted' })).status,
    ).toBe(422)
    expect(f.ledger.snapshot().jobs).toBe(0)
    expect(await f.provider.inspect()).toEqual([])
  })

  it('rejects v3, unknown nested fields and unallowlisted output/camera/look before admission', async () => {
    const f = await fixture(),
      request = imageRequestFixture()
    for (const design of [
      { ...request.design, version: 3 },
      { ...request.design, assetURLs: [] },
      { ...request.design, outputProfile: 'strict-4k' },
      {
        ...request.design,
        presentation: { ...request.design.presentation, cameraRef: 'arbitrary' },
      },
      { ...request.design, presentation: { ...request.design.presentation, lookRef: 'arbitrary' } },
      { ...request.design, presentation: { ...request.design.presentation, samples: 1024 } },
    ])
      expect((await f.request(IMAGE_PATH, { ...request, design })).status).toBe(422)
    expect((await f.request(IMAGE_PATH, request, null)).status).toBe(401)
    expect(f.ledger.snapshot().global.reservedMicro).toBe(0)
  })

  it.each([
    ['global budget', { globalBudgetMicro: 0 }, 'budget-exceeded'],
    ['experiment budget', { experimentBudgetMicro: 0 }, 'budget-exceeded'],
    ['principal budget', { principalBudgetMicro: 0 }, 'budget-exceeded'],
    ['storage bytes', { maxStorageBytes: 1 }, 'capacity-exceeded'],
    ['delivery bytes', { maxDeliveryBytes: 1 }, 'capacity-exceeded'],
  ] as const)(
    'returns truthful 429 for %s with no partial reservation',
    async (_name, policy, code) => {
      const f = await fixture({ policy })
      const response = await f.request(IMAGE_PATH, imageRequestFixture())
      expect(response.status).toBe(429)
      expect(await response.json()).toMatchObject({ error: { code } })
      expect(f.ledger.snapshot()).toMatchObject({
        jobs: 0,
        interests: 0,
        global: { reservedMicro: 0, spentMicro: 0 },
      })
    },
  )

  it('unique miss, concurrency, delivery and runtime caps remain enforced across the HTTP/worker boundary', async () => {
    const f = await fixture({
      policy: { maxUniqueMisses: 1, maxConcurrency: 1, maxDeliveriesPerJob: 1 },
    })
    const first = await f.submit()
    expect(
      (await f.request(IMAGE_PATH, imageRequestFixture(changed(), 'integration-over-cap1'))).status,
    ).toBe(429)
    await f.worker.runOnce()
    expect((await f.request(artifactPath(first.interestId))).status).toBe(200)
    expect((await f.request(artifactPath(first.interestId))).status).toBe(429)
    const second = await fixture({
      policy: { maxConcurrency: 1, maxRuntimeMs: 100, leaseMs: 100 },
      plan: { mode: 'hold', loseResponse: true },
    })
    await second.submit()
    await second.submit(imageRequestFixture(changed(), 'integration-concur-01'))
    const lease = second.ledger.claim('integration-claim-01')!
    expect(second.ledger.beginExecution(lease)).toBe(true)
    await second.provider.execute(
      signWorkerContext(workerClaimsForLease(lease, second.clock()), second.keys.contextSecret),
    )
    expect(second.ledger.claim('integration-claim-02')).toBeNull()
    second.advance(101)
    expect(await second.watchdog.tick()).toMatchObject({ reconciled: 1, retainedLiabilities: 0 })
    expect((await second.provider.receipt(lease.execution)).claims).toMatchObject({
      outcome: 'stopped',
      runtimeMs: 100,
      finalMeter: true,
    })
  })

  it('partial filesystem publication never returns ready or an exact cache hit', async () => {
    const f = await fixture({
      objectHooks: {
        at: (point) => {
          if (point === 'after-publish-link') throw new Error('injected-publication-failure')
        },
      },
    })
    const first = await f.submit()
    await f.worker.runOnce()
    const response = await f.request(interestPath(first.interestId))
    expect(statusReplySchema.parse(await response.json())).toMatchObject({
      state: 'failed',
      artifact: null,
    })
    expect((await f.request(artifactPath(first.interestId))).status).toBe(503)
    expect((await f.request(IMAGE_PATH, imageRequestFixture())).status).toBe(410)
    expect(f.ledger.events().some((event) => event.kind === 'ready')).toBe(false)
    expect(f.ledger.snapshot().global.spentMicro).toBeGreaterThan(0)
  })

  it('reopens all durable stores and serves the identical object without repeat execution or budget reset', async () => {
    const f = await fixture()
    const first = await f.submit()
    await f.worker.runOnce()
    const before = f.ledger.snapshot(),
      descriptor = f.ledger.getInterest(alice, first.interestId).job.artifact
    await f.worker.shutdown()
    f.ledger.close()
    f.objects.close()
    await f.provider.close()
    const ledger = f.openLedger(),
      objects = f.openObjects(),
      provider = f.openProvider()
    const base = await f.listen(new SafeImageService({ ledger, objects, now: f.clock }))
    const hit = await f.request(IMAGE_PATH, imageRequestFixture(), alice, base)
    expect(hit.status).toBe(200)
    expect(statusReplySchema.parse(await hit.json()).artifact).toEqual(descriptor)
    expect(ledger.snapshot().global).toEqual(before.global)
    expect(await provider.inspect()).toHaveLength(1)
    expect(sha256Bytes(await objects.read(descriptor!))).toBe(descriptor!.checksum)
  })

  it('kill blocks queued work, closes simulated stream leases, survives reopen and denies delivery/admission', async () => {
    const f = await fixture()
    const ready = await f.submit()
    await f.worker.runOnce()
    const queued = await f.submit(imageRequestFixture(changed(), 'integration-queued-01'))
    f.ledger.openStream(alice, queued.interestId)
    expect(await f.watchdog.kill('integration-kill-queued')).toMatchObject({
      killed: true,
      closedStreams: 1,
      retainedLiabilities: 0,
    })
    expect(f.ledger.getInterest(alice, queued.interestId).job.state).toBe('cancelled')
    expect((await f.request(IMAGE_PATH, imageRequestFixture())).status).toBe(503)
    expect((await f.request(artifactPath(ready.interestId))).status).toBe(503)
    expect(f.openLedger().snapshot().killed).toBe(true)
    expect(await f.worker.runOnce()).toBe(0)
  })

  it('independent handles retain active/late-stop liabilities, fence stale publication, and reconcile only final billing', async () => {
    const f = await fixture({
      plan: { mode: 'hold', loseResponse: true, stopDelayMs: 100, meterDelayMs: 200 },
    })
    const first = await f.submit()
    const lease = f.ledger.claim('integration-manual-01')!
    f.ledger.beginExecution(lease)
    const context = signWorkerContext(workerClaimsForLease(lease, f.clock()), f.keys.contextSecret)
    await f.provider.execute(context)
    const independent = new IndependentWatchdog({
      ledger: f.openLedger(),
      provider: f.openProvider(),
      objects: f.openObjects(),
      now: f.clock,
    })
    expect(await independent.kill('integration-active-kill')).toMatchObject({
      killed: true,
      retainedLiabilities: 1,
      reconciled: 0,
    })
    expect(f.ledger.snapshot().global.reservedMicro).toBeGreaterThan(0)
    expect(f.ledger.heartbeat(lease)).toBeNull()
    const status = statusReplySchema.parse(
      await (await f.request(interestPath(first.interestId))).json(),
    )
    expect(status.reconciliationRequired).toBe(true)
    expect(['cancelled', 'expired', 'ready']).not.toContain(status.state)
    f.advance(100)
    expect(await independent.tick()).toMatchObject({ retainedLiabilities: 1 })
    expect((await f.provider.receipt(lease.execution)).claims).toMatchObject({
      outcome: 'stopped',
      finalMeter: false,
    })
    f.advance(200)
    expect(await independent.tick()).toMatchObject({ retainedLiabilities: 0, reconciled: 1 })
    expect(await f.provider.execute(context)).toMatchObject({ outcome: 'failure' })
    expect(f.ledger.beginExecution(lease)).toBe(false)
    expect(f.ledger.events().some((event) => event.kind === 'ready')).toBe(false)
  })

  it('unknown provider outcome is not cancellation/refund, including interest cancellation and expired leases', async () => {
    const f = await fixture({
      plan: { mode: 'unknown', neverSettle: true },
      policy: { leaseMs: 100, jobTtlMs: 200 },
    })
    const first = await f.submit()
    const reserved = f.ledger.snapshot().global.reservedMicro
    await f.worker.runOnce()
    const cancel = await f.request(`${interestPath(first.interestId)}/cancel`, {
      protocol: CONTROL_PROTOCOL,
    })
    expect(statusReplySchema.parse(await cancel.json())).toMatchObject({
      interestState: 'cancelled',
      sharedWorkCancelled: false,
      reconciliationRequired: true,
    })
    f.advance(500)
    expect(await f.watchdog.kill('integration-unknown-kill')).toMatchObject({
      retainedLiabilities: 1,
      reconciled: 0,
    })
    expect(f.ledger.snapshot().global.reservedMicro).toBe(reserved)
    const job = f.ledger.getInterest(alice, first.interestId).job
    expect(['ready', 'cancelled', 'expired']).not.toContain(job.state)
  })

  it('kills retry queues without extra attempts and denies service on store outage', async () => {
    const f = await fixture({ plan: { mode: 'known-failure' }, policy: { retryDelayMs: 0 } })
    const first = await f.submit()
    await f.worker.runOnce()
    expect(f.ledger.getInterest(alice, first.interestId).job).toMatchObject({
      state: 'queued',
      attempts: 1,
    })
    await f.watchdog.kill('integration-retry-kill')
    expect(await f.worker.runOnce()).toBe(0)
    expect(await f.provider.inspect()).toHaveLength(1)
    f.ledger.close()
    expect((await f.request(IMAGE_PATH, imageRequestFixture())).status).toBe(503)
    expect((await f.request(interestPath(first.interestId))).status).toBe(503)
  })

  it('expiry retires immutable objects without clearing tombstones or resetting allocated bytes', async () => {
    const f = await fixture({ policy: { retentionMs: 100, interestTtlMs: 100 } })
    const first = await f.submit()
    await f.worker.runOnce()
    const before = f.ledger.snapshot().storageBytes
    f.advance(101)
    expect(await f.watchdog.tick()).toMatchObject({ errors: [] })
    expect(f.ledger.events(first.jobId).some((event) => event.kind === 'object-deleted')).toBe(true)
    expect(f.ledger.snapshot().objects).toHaveLength(0)
    expect((await f.request(artifactPath(first.interestId))).status).toBe(410)
    expect(
      (await f.request(IMAGE_PATH, imageRequestFixture(undefined, 'integration-retired-01')))
        .status,
    ).toBe(410)
    expect(f.ledger.snapshot().storageBytes).toBe(before)
  })

  it('retention deletion failure retains the immutable descriptor and allocation until verified retry', async () => {
    let failDelete = true
    const f = await fixture({
      policy: { retentionMs: 100 },
      objectHooks: {
        at: (point) => {
          if (point === 'before-delete' && failDelete) throw new Error('test-deletion-failed')
        },
      },
    })
    const first = await f.submit()
    await f.worker.runOnce()
    const object = f.ledger.getInterest(alice, first.interestId).job.artifact!
    const allocated = f.ledger.snapshot().storageBytes
    f.advance(101)
    expect((await f.watchdog.tick()).errors).toContain('object-deletion-unconfirmed')
    expect(f.ledger.getInterest(alice, first.interestId).job.artifact).toEqual(object)
    expect(sha256Bytes(await f.objects.read(object))).toBe(object.checksum)
    expect(
      (await f.request(IMAGE_PATH, imageRequestFixture(undefined, 'integration-retired-02')))
        .status,
    ).toBe(410)
    failDelete = false
    expect((await f.watchdog.tick()).errors).toEqual([])
    expect(f.ledger.getInterest(alice, first.interestId).job.artifact).toBeNull()
    await expect(f.objects.read(object)).rejects.toThrow()
    expect(f.ledger.snapshot().storageBytes).toBe(allocated)
  })

  it('the default worst-case quote includes every named liability component and prepaid retries', () => {
    const quote = worstCaseQuote(DEFAULT_POLICY)
    for (const key of [
      'startup',
      'runtime',
      'idle',
      'retries',
      'delivery',
      'storage',
      'shutdown',
      'delayedMeter',
    ] as const)
      expect(quote[key]).toBeGreaterThan(0)
    expect(quote.reservedStorageBytes).toBe(
      DEFAULT_POLICY.maxOutputBytes * DEFAULT_POLICY.maxAttempts,
    )
    expect(quote.reservedDeliveryBytes).toBe(
      DEFAULT_POLICY.maxOutputBytes * DEFAULT_POLICY.maxDeliveriesPerJob,
    )
  })
})
