import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDesign } from '../../domain/design'
import {
  bindRequestSync,
  canonicalJson,
  isSettledReceipt,
  policySchema,
  signWorkerContext,
  verifyProviderReceipt,
  workerClaimsForLease,
  worstCaseQuote,
  type Lease,
  type WorkerClaims,
} from './contracts'
import { LocalFakeProvider, type FakeExecutionPlan } from './provider'

import { TEST_ROOT as ROOT } from './testPaths'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture(plan: FakeExecutionPlan = {}, purpose: 'image' | 'export' = 'image') {
  const dir = mkdtempSync(join(ROOT, 'provider-test-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1_000_000
  const options = {
    path: join(dir, 'provider.sqlite'),
    contextSecret: randomBytes(32).toString('hex'),
    receiptSecret: randomBytes(32).toString('hex'),
    now: () => now,
  }
  const open = () => {
    const provider = new LocalFakeProvider(options, { plan: () => plan })
    cleanup.push(() => provider.close())
    return provider
  }
  const provider = open()
  const design = defaultDesign()
  const policy = policySchema.parse({})
  const lease: Lease = {
    execution: {
      provider: 'fake-local',
      executionId: 'provider-execution-0001',
      jobId: 'provider-job-00000001',
      fence: 1,
      attempt: 1,
    },
    workerId: 'provider-worker-00001',
    design,
    binding: bindRequestSync(design, purpose, {
      principalId: 'provider-principal-001',
      experimentId: 'provider-experiment-001',
      scopes: ['images:read'],
    }),
    quote: worstCaseQuote(policy),
    policy,
    leaseUntil: now + 10_000,
    deadline: now + 60_000,
  }
  const claims = workerClaimsForLease(lease, now)
  const context = signWorkerContext(claims, options.contextSecret)
  return {
    dir,
    provider,
    options,
    lease,
    claims,
    context,
    open,
    advance: (ms: number) => {
      now += ms
    },
    set: (value: number) => {
      now = value
    },
  }
}

describe('LocalFakeProvider private deterministic CPU-only resource journal', () => {
  it.each(['image', 'export'] as const)(
    'returns labelled deterministic %s bytes and an immutable final receipt',
    async (purpose) => {
      const f = fixture({}, purpose)
      const result = await f.provider.execute(f.context)
      expect(result.outcome).toBe('success')
      if (result.outcome !== 'success') return
      expect(result.artifact).toMatchObject({
        provenance: { kind: 'mock-diagnostic', productionAllowed: false },
      })
      expect(decodeURIComponent(result.artifact.src)).toContain('MOCK DIAGNOSTIC')
      expect(verifyProviderReceipt(result.receipt, f.options.receiptSecret)).toMatchObject({
        outcome: 'completed',
        finalMeter: true,
        startForbidden: true,
      })
      expect(await f.provider.execute(f.context)).toEqual(result)
      expect(await f.open().execute(f.context)).toEqual(result)
      expect(await f.provider.inspect()).toHaveLength(1)
    },
  )

  it('commits unknown-start tombstones before acknowledging and refuses delayed starts after reopen', async () => {
    const f = fixture()
    expect((await f.provider.receipt(f.lease.execution)).claims).toMatchObject({
      outcome: 'unknown',
      finalMeter: false,
      startForbidden: false,
    })
    const stopped = await f.provider.stop(f.lease.execution, 'kill')
    expect(isSettledReceipt(stopped.claims)).toBe(true)
    await f.provider.close()
    const provider = f.open()
    expect(await provider.execute(f.context)).toMatchObject({
      outcome: 'failure',
      receipt: stopped,
    })
    expect((await provider.inspect())[0].startedAt).toBeNull()
    expect(await provider.stop(f.lease.execution, 'orphan')).toEqual(stopped)
  })

  it('persists delayed termination and delayed billing separately, with monotonic exact repeated receipts', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true, stopDelayMs: 100, meterDelayMs: 200 })
    expect(await f.provider.execute(f.context)).toMatchObject({ outcome: 'failure', receipt: null })
    f.advance(50)
    const requested = await f.provider.stop(f.lease.execution, 'kill')
    expect(requested.claims).toMatchObject({
      outcome: 'stop-requested',
      finalMeter: false,
      startForbidden: true,
      runtimeMs: 50,
    })
    expect(await f.provider.stop(f.lease.execution, 'kill')).toEqual(requested)
    await f.provider.close()
    const provider = f.open()
    f.advance(100)
    const stopped = await provider.receipt(f.lease.execution)
    expect(stopped.claims).toMatchObject({ outcome: 'stopped', finalMeter: false, runtimeMs: 150 })
    expect(isSettledReceipt(stopped.claims)).toBe(false)
    f.advance(200)
    const settled = await provider.receipt(f.lease.execution)
    expect(isSettledReceipt(settled.claims)).toBe(true)
    expect(settled.claims.cumulativeCostMicro).toBe(stopped.claims.cumulativeCostMicro)
    expect(settled.claims.sequence).toBeGreaterThan(stopped.claims.sequence)
    f.advance(200)
    expect(await provider.receipt(f.lease.execution)).toEqual(settled)
  })

  it('enforces runtime cap independently on inventory after dispatcher close without a fake over-bound meter', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true, stopDelayMs: 60_000 })
    await f.provider.execute(f.context)
    await f.provider.close()
    f.advance(10_000)
    const resources = await f.open().inspect()
    expect(resources[0].receipt.claims).toMatchObject({
      outcome: 'stopped',
      finalMeter: true,
      runtimeMs: f.claims.maxRuntimeMs,
      cumulativeCostMicro: f.claims.maxCostMicro,
    })
  })

  it('keeps never-confirmed simulated outcome outstanding even after kill, cap and restart', async () => {
    const f = fixture({ mode: 'unknown', neverSettle: true })
    await f.provider.execute(f.context)
    expect((await f.provider.stop(f.lease.execution, 'kill')).claims).toMatchObject({
      outcome: 'unknown',
      finalMeter: false,
      startForbidden: true,
    })
    f.advance(60_000)
    expect(isSettledReceipt((await f.open().receipt(f.lease.execution)).claims)).toBe(false)
  })

  it('produces known failure with terminal proof, not a confirmedStopped escape hatch', async () => {
    const f = fixture({ mode: 'known-failure' })
    const result = await f.provider.execute(f.context)
    expect(result).toMatchObject({
      outcome: 'failure',
      failure: { retryable: true },
      receipt: { claims: { outcome: 'stopped', finalMeter: true } },
    })
    expect(JSON.stringify(result)).not.toContain('confirmedStopped')
  })

  it('returns no result after a lost completed response, but independent receipt inspection recovers final proof', async () => {
    const f = fixture({ loseResponse: true })
    expect(await f.provider.execute(f.context)).toMatchObject({ outcome: 'failure', receipt: null })
    expect((await f.open().receipt(f.lease.execution)).claims).toMatchObject({
      outcome: 'completed',
      finalMeter: true,
    })
  })

  it('rejects forged, expired, extended, unknown-field and paid contexts before resource allocation', async () => {
    const f = fixture()
    const malicious = [
      { ...f.context, signature: '0'.repeat(64) },
      { ...f.context, confirmedStopped: true },
      { ...f.context, claims: { ...f.claims, paidExecutionAllowed: true } },
      { ...f.context, claims: { ...f.claims, expiresAt: f.claims.issuedAt + 60_001 } },
      { ...f.context, claims: { ...f.claims, workerCommand: 'not-executed' } },
    ]
    for (const context of malicious)
      await expect(f.provider.execute(context as typeof f.context)).rejects.toThrow()
    f.advance(10_000)
    await expect(f.provider.execute(f.context)).rejects.toThrow()
    expect(await f.provider.inspect()).toEqual([])
  })

  it('independently rejects signed design and public cache identity mismatch', async () => {
    const f = fixture()
    const badClaims: WorkerClaims = {
      ...f.claims,
      binding: { ...f.claims.binding, cacheKey: `sha256:${'0'.repeat(64)}` },
    }
    await expect(
      f.provider.execute(signWorkerContext(badClaims, f.options.contextSecret)),
    ).rejects.toThrow()
    const designClaims: WorkerClaims = {
      ...f.claims,
      design: { ...f.claims.design, outputProfile: 'web-thumbnail' },
    }
    await expect(
      f.provider.execute(signWorkerContext(designClaims, f.options.contextSecret)),
    ).rejects.toThrow()
    expect(await f.provider.inspect()).toHaveLength(0)
  })

  it('binds resource IDs to exact job, fence, attempt and type and rejects same execution ID rebinding', async () => {
    const f = fixture()
    await f.provider.execute(f.context)
    for (const execution of [
      { ...f.claims.execution, fence: 2 },
      { ...f.claims.execution, attempt: 2 },
      { ...f.claims.execution, jobId: 'provider-other-job-01' },
    ]) {
      await expect(
        f.provider.execute(signWorkerContext({ ...f.claims, execution }, f.options.contextSecret)),
      ).rejects.toThrow()
      await expect(f.provider.stop(execution, 'kill')).rejects.toThrow()
    }
    const native = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const db = new native.DatabaseSync(f.options.path)
    try {
      const row = JSON.parse(
        String(db.prepare('SELECT data FROM provider_executions').get()?.data),
      ) as { resourceId: string }
      expect(row.resourceId).toMatch(/^p04-fake-image-[a-f0-9]{64}$/)
    } finally {
      db.close()
    }
  })

  it('rejects output byte overrun, without claiming unverified success', async () => {
    const f = fixture()
    await expect(
      f.provider.execute(
        signWorkerContext({ ...f.claims, maxOutputBytes: 1 }, f.options.contextSecret),
      ),
    ).rejects.toThrow()
    expect((await f.provider.receipt(f.lease.execution)).claims.outcome).toBe('completed')
  })

  it('fails closed on key replacement, clock rollback, closed or removed store; never resets tombstones', async () => {
    const f = fixture()
    await f.provider.stop(f.lease.execution, 'kill')
    expect(
      () => new LocalFakeProvider({ ...f.options, contextSecret: randomBytes(32).toString('hex') }),
    ).toThrow()
    f.set(1)
    await expect(f.provider.inspect()).rejects.toThrow()
    f.set(1_000_000)
    await f.provider.close()
    await expect(f.provider.execute(f.context)).rejects.toThrow()
    renameSync(f.options.path, `${f.options.path}.preserved`)
    expect(() => f.open()).toThrow()
    expect(readFileSync(`${f.options.path}.p04-provider-identity`, 'utf8')).toMatch(
      /^p04-provider@1/,
    )
  })

  it('rejects symlink/foreign stores and tampered row signatures instead of silently repairing', async () => {
    const f = fixture()
    const link = join(f.dir, 'linked.sqlite')
    symlinkSync(f.options.path, link)
    expect(() => new LocalFakeProvider({ ...f.options, path: link })).toThrow()
    await f.provider.execute(f.context)
    const native = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const db = new native.DatabaseSync(f.options.path)
    try {
      db.prepare('UPDATE provider_executions SET signature=?').run('0'.repeat(64))
    } finally {
      db.close()
    }
    await expect(f.provider.inspect()).rejects.toThrow()
    const foreign = join(f.dir, 'foreign.sqlite')
    writeFileSync(foreign, 'not sqlite', { mode: 0o600 })
    expect(() => new LocalFakeProvider({ ...f.options, path: foreign })).toThrow()
  })

  it('does not leak signing keys or persist plaintext keys in journal rows/identity marker', async () => {
    const f = fixture()
    await f.provider.execute(f.context)
    const inventory = canonicalJson(await f.provider.inspect())
    for (const key of [f.options.contextSecret, f.options.receiptSecret]) {
      expect(inventory).not.toContain(key)
      expect(readFileSync(f.options.path).includes(Buffer.from(key))).toBe(false)
      expect(readFileSync(`${f.options.path}-wal`).includes(Buffer.from(key))).toBe(false)
    }
  })
})
