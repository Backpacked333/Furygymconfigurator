import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindRequestSync,
  exportRequestFixture,
  imageRequestFixture,
  signWorkerContext,
  workerClaimsForLease,
  worstCaseQuote,
  type AuthContext,
  type ObjectStore,
  type Policy,
  type ProviderResult,
} from './contracts'
import { SqliteLedger } from './ledger'
import { FileObjectStore, type ObjectStoreTestHooks } from './objects'
import { LocalFakeProvider, type FakeProviderTestHooks } from './provider'
import { ControlWorker } from './worker'

import { TEST_ROOT as ROOT } from './testPaths'
const auth: AuthContext = {
  principalId: 'worker-principal-0001',
  experimentId: 'worker-experiment-0001',
  scopes: ['images:read', 'images:write', 'exports:write'],
}
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture(
  providerHooks: FakeProviderTestHooks = {},
  objectHooks: ObjectStoreTestHooks = {},
  policy: Partial<Policy> = {},
) {
  const dir = mkdtempSync(join(ROOT, 'worker-test-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1_000_000
  const keys = {
    contextSecret: randomBytes(32).toString('hex'),
    receiptSecret: randomBytes(32).toString('hex'),
    objectSecret: randomBytes(32).toString('hex'),
  }
  const ledgerOptions = {
    path: join(dir, 'ledger.sqlite'),
    policy,
    receiptSecret: keys.receiptSecret,
    objectSecret: keys.objectSecret,
    now: () => now,
  }
  const openLedger = () => {
    const value = new SqliteLedger(ledgerOptions)
    cleanup.push(() => value.close())
    return value
  }
  const ledger = openLedger()
  const provider = new LocalFakeProvider(
    { path: join(dir, 'provider.sqlite'), ...keys, now: () => now },
    providerHooks,
  )
  cleanup.push(() => provider.close())
  const objects = new FileObjectStore(
    { root: join(dir, 'objects'), objectSecret: keys.objectSecret, now: () => now },
    objectHooks,
  )
  cleanup.push(() => objects.close())
  const workerOptions = {
    ledger,
    provider,
    objects,
    workerId: 'control-worker-000001',
    contextSecret: keys.contextSecret,
    now: () => now,
  }
  const worker = new ControlWorker(workerOptions)
  cleanup.push(() => worker.shutdown())
  const admit = (purpose: 'image' | 'export' = 'image', key = 'worker-request-000001') => {
    const request =
      purpose === 'image'
        ? imageRequestFixture(undefined, key)
        : exportRequestFixture(undefined, key)
    return ledger.admit({
      auth,
      purpose,
      request,
      binding: bindRequestSync(request.design, purpose, auth),
      quote: worstCaseQuote(ledger.policy),
    })
  }
  return {
    dir,
    ledger,
    provider,
    objects,
    worker,
    workerOptions,
    openLedger,
    admit,
    advance: (ms: number) => {
      now += ms
    },
  }
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Test-only wait bound exceeded.')
}

describe('ControlWorker fenced diagnostic publication', () => {
  it.each(['image', 'export'] as const)(
    'publishes only verified labelled %s bytes through final receipt and object CAS',
    async (purpose) => {
      const f = fixture()
      const admitted = f.admit(purpose)
      expect(await f.worker.runOnce()).toBe(1)
      const job = f.ledger.getInterest(auth, admitted.view.interest.id).job
      expect(job).toMatchObject({
        state: 'ready',
        reconciliationRequired: false,
        artifact: {
          kind: 'mock-diagnostic',
          approvedCurrentImage: false,
          strictExport: false,
          productionAllowed: false,
          binding: { purpose, visibility: purpose === 'export' ? 'private' : 'public' },
        },
      })
      expect(await f.objects.verify(job.artifact!, job.design)).toBe(true)
      expect(f.ledger.events(job.id).map((event) => event.kind)).toEqual(
        expect.arrayContaining(['rendering', 'receipt-recorded', 'publishing', 'ready']),
      )
      expect(await f.worker.runOnce()).toBe(0)
    },
  )

  it('does not publish tampered provider diagnostic metadata/bytes even with a valid completed receipt', async () => {
    const f = fixture()
    const admitted = f.admit()
    const execute = f.provider.execute.bind(f.provider)
    vi.spyOn(f.provider, 'execute').mockImplementation(async (context) => {
      const result = await execute(context)
      return result.outcome === 'success'
        ? { ...result, artifact: { ...result.artifact, width: 1 } }
        : result
    })
    const stage = vi.spyOn(f.objects, 'stage')
    expect(await f.worker.runOnce()).toBe(1)
    expect(stage).not.toHaveBeenCalled()
    expect(f.ledger.getInterest(auth, admitted.view.interest.id).job.state).toBe('failed')
  })

  it('rejects an untrusted receipt signature without any ready result', async () => {
    const f = fixture()
    const admitted = f.admit()
    const execute = f.provider.execute.bind(f.provider)
    vi.spyOn(f.provider, 'execute').mockImplementation(async (context) => {
      const result = await execute(context)
      return result.receipt
        ? { ...result, receipt: { ...result.receipt, signature: '0'.repeat(64) } }
        : result
    })
    await f.worker.runOnce()
    expect(f.ledger.getInterest(auth, admitted.view.interest.id).job.state).not.toBe('ready')
    expect(f.ledger.events().filter((event) => event.kind === 'ready')).toHaveLength(0)
  })

  it('publication failure after provider settlement is a known failure, not fabricated readiness or object refund', async () => {
    const f = fixture(
      {},
      {
        at: (point) => {
          if (point === 'after-publish-link') throw new Error('injected-not-logged')
        },
      },
    )
    const admitted = f.admit()
    const storage = f.ledger.snapshot().storageBytes
    await f.worker.runOnce()
    const job = f.ledger.getInterest(auth, admitted.view.interest.id).job
    expect(job.state).toBe('failed')
    expect(job.artifact).toBeNull()
    expect(f.ledger.snapshot().storageBytes).toBe(storage)
    expect(job.spentMicro).toBeGreaterThan(0)
  })

  it('lost response followed by unknown stop retains liabilities and prevents a replacement attempt', async () => {
    const f = fixture({ plan: () => ({ mode: 'unknown', loseResponse: true, neverSettle: true }) })
    const admitted = f.admit()
    const reserved = admitted.view.job.reservedMicro
    await f.worker.runOnce()
    expect(f.ledger.getInterest(auth, admitted.view.interest.id).job).toMatchObject({
      reconciliationRequired: true,
      attempts: 1,
      reservedMicro: reserved,
    })
    await expect(f.worker.runOnce()).rejects.toThrow(expect.objectContaining({ status: 503 }))
    expect(f.ledger.snapshot().activeExecutions).toHaveLength(1)
  })

  it('known settled failure retries with a distinct execution/fence and cannot exceed attempts', async () => {
    const f = fixture({ plan: () => ({ mode: 'known-failure' }) }, {}, { retryDelayMs: 0 })
    const admitted = f.admit()
    expect(await f.worker.runOnce()).toBe(1)
    expect(f.ledger.getInterest(auth, admitted.view.interest.id).job).toMatchObject({
      state: 'queued',
      attempts: 1,
    })
    expect(await f.worker.runOnce()).toBe(1)
    expect(f.ledger.getInterest(auth, admitted.view.interest.id).job).toMatchObject({
      state: 'failed',
      attempts: 2,
    })
    const inventory = await f.provider.inspect()
    expect(new Set(inventory.map((entry) => entry.execution.executionId)).size).toBe(2)
    expect(inventory[1].execution.fence).not.toBe(inventory[0].execution.fence)
    expect(await f.worker.runOnce()).toBe(0)
  })

  it('fail-closes before any claim on provider outage or ledger outage', async () => {
    const f = fixture()
    f.admit()
    const execute = vi.spyOn(f.provider, 'execute')
    const inspect = vi
      .spyOn(f.provider, 'inspect')
      .mockRejectedValue(new Error('test-provider-outage'))
    await expect(f.worker.runOnce()).rejects.toThrow(expect.objectContaining({ status: 503 }))
    expect(f.ledger.snapshot().activeExecutions).toHaveLength(0)
    inspect.mockRestore()
    f.ledger.close()
    await expect(f.worker.runOnce()).rejects.toThrow(expect.objectContaining({ status: 503 }))
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses new claims while an unbudgeted provider-only orphan is still outstanding', async () => {
    const f = fixture({ plan: () => ({ mode: 'hold', loseResponse: true }) })
    f.admit()
    const lease = f.ledger.claim('orphan-seed-worker-001')!
    const queued = f.admit('export', 'worker-export-orphan1')
    const orphan = {
      ...lease,
      execution: {
        ...lease.execution,
        executionId: 'worker-orphan-exec-01',
        jobId: 'worker-orphan-job-001',
      },
    }
    await f.provider.execute(
      signWorkerContext(workerClaimsForLease(orphan, 1_000_000), f.workerOptions.contextSecret),
    )
    await expect(f.worker.runOnce()).rejects.toThrow(expect.objectContaining({ status: 503 }))
    expect(f.ledger.getInterest(auth, queued.view.interest.id).job).toMatchObject({
      state: 'queued',
      attempts: 0,
    })
    expect(await f.provider.inspect()).toHaveLength(1)
  })

  it('shutdown tombstones active work, stops heartbeats/admission and does not close shared stores', async () => {
    const f = fixture({ plan: () => ({ mode: 'hold' }) })
    const admitted = f.admit()
    const running = f.worker.runOnce()
    await waitFor(async () => (await f.provider.inspect()).length === 1)
    expect(await f.worker.runOnce()).toBe(0)
    await f.worker.shutdown()
    expect(await running).toBe(1)
    expect(await f.worker.runOnce()).toBe(0)
    expect((await f.provider.inspect())[0].receipt.claims).toMatchObject({
      outcome: 'stopped',
      finalMeter: true,
      startForbidden: true,
    })
    expect(f.ledger.getInterest(auth, admitted.view.interest.id).job.state).not.toBe('ready')
    expect(f.ledger.snapshot().activeExecutions).toHaveLength(0)
    expect(f.ledger.snapshot().killed).toBe(false)
  })

  it('fences late completion after another dispatcher connection recovers an expired lease', async () => {
    const f = fixture()
    const admitted = f.admit()
    const actual = f.provider.execute.bind(f.provider)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let completed = false
    vi.spyOn(f.provider, 'execute').mockImplementation(async (context) => {
      const result = await actual(context)
      completed = true
      await gate
      return result
    })
    const running = f.worker.runOnce()
    await waitFor(() => completed)
    f.advance(20_000)
    const restarted = f.openLedger()
    expect(restarted.recover().fenced).toBe(1)
    release()
    await running
    expect(restarted.getInterest(auth, admitted.view.interest.id).job.state).not.toBe('ready')
    expect(restarted.events().some((event) => event.kind === 'ready')).toBe(false)
  })

  it('a heartbeat rejection interrupts a never-resolving provider response without late publication', async () => {
    const f = fixture()
    f.admit()
    let release!: (value: ProviderResult) => void
    vi.spyOn(f.provider, 'execute').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const heartbeat = vi.spyOn(f.ledger, 'heartbeat')
    const running = f.worker.runOnce()
    await waitFor(() => Boolean(release))
    f.ledger.kill('heartbeat-test-kill')
    expect(await running).toBe(1)
    expect(heartbeat).toHaveBeenCalled()
    expect(f.ledger.events().some((event) => event.kind === 'ready')).toBe(false)
    release({
      outcome: 'failure',
      failure: { code: 'unavailable', message: 'late test completion', retryable: true },
      receipt: null,
    })
  })

  it('kill during immutable publication cannot make a job ready and retains orphan object evidence', async () => {
    const f = fixture()
    const admitted = f.admit()
    const actual = f.objects.publish.bind(f.objects)
    const objects: ObjectStore = f.objects
    vi.spyOn(objects, 'publish').mockImplementation(async (staged) => {
      const result = await actual(staged)
      f.ledger.kill('publication-race-kill')
      return result
    })
    await f.worker.runOnce()
    expect(f.ledger.getInterest(auth, admitted.view.interest.id).job.state).not.toBe('ready')
    const recovered = await f.objects.recover([], [], 1_000_000)
    expect(recovered.orphanObjects.length).toBeGreaterThan(0)
  })
})
