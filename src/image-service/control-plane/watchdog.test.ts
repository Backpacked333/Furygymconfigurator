import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindRequestSync,
  imageRequestFixture,
  isSettledReceipt,
  signWorkerContext,
  workerClaimsForLease,
  worstCaseQuote,
  type AuthContext,
  type Policy,
} from './contracts'
import { SqliteLedger } from './ledger'
import { LocalFakeProvider, type FakeExecutionPlan } from './provider'
import { IndependentWatchdog } from './watchdog'
import { parseWatchdogArguments, runWatchdogCli } from '../../../scripts/p04-watchdog'

import { TEST_ROOT as ROOT } from './testPaths'
import { REPO_ROOT as REPO } from './testPaths'
const NODE = process.execPath
const auth: AuthContext = {
  principalId: 'watchdog-principal-001',
  experimentId: 'watchdog-experiment-001',
  scopes: ['images:read', 'images:write', 'exports:write'],
}
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture(plan: FakeExecutionPlan = {}, policy: Partial<Policy> = {}) {
  const dir = mkdtempSync(join(ROOT, 'watchdog-test-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1_000_000
  const keys = {
    contextSecret: randomBytes(32).toString('hex'),
    receiptSecret: randomBytes(32).toString('hex'),
    objectSecret: randomBytes(32).toString('hex'),
  }
  const ledger = new SqliteLedger({
    path: join(dir, 'ledger.sqlite'),
    policy,
    receiptSecret: keys.receiptSecret,
    objectSecret: keys.objectSecret,
    now: () => now,
  })
  cleanup.push(() => ledger.close())
  const providerOptions = {
    path: join(dir, 'provider.sqlite'),
    contextSecret: keys.contextSecret,
    receiptSecret: keys.receiptSecret,
    now: () => now,
  }
  const provider = new LocalFakeProvider(providerOptions, { plan: () => plan })
  cleanup.push(() => provider.close())
  const watchdog = new IndependentWatchdog({ ledger, provider, now: () => now })
  const request = imageRequestFixture(undefined, 'watchdog-request-0001')
  const admission = {
    auth,
    purpose: 'image' as const,
    request,
    binding: bindRequestSync(request.design, 'image', auth),
    quote: worstCaseQuote(ledger.policy),
  }
  const admitted = ledger.admit(admission)
  const claim = () => {
    const lease = ledger.claim('watchdog-worker-0001')!
    expect(lease).not.toBeNull()
    expect(ledger.beginExecution(lease)).toBe(true)
    return {
      lease,
      context: signWorkerContext(workerClaimsForLease(lease, now), keys.contextSecret),
    }
  }
  return {
    dir,
    keys,
    ledger,
    provider,
    providerOptions,
    watchdog,
    admission,
    admitted,
    claim,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

describe('IndependentWatchdog truthful shutdown and reconciliation', () => {
  it('kills queued work and internal durable streams without inventing provider resources', async () => {
    const f = fixture()
    f.ledger.openStream(auth, f.admitted.view.interest.id)
    const result = await f.watchdog.kill('operator-kill-test')
    expect(result).toMatchObject({
      killed: true,
      stopRequested: 0,
      reconciled: 0,
      retainedLiabilities: 0,
      closedStreams: 1,
      errors: [],
    })
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job.state).toBe('cancelled')
    expect(f.ledger.claim('watchdog-worker-0002')).toBeNull()
    expect(() => f.ledger.admit(f.admission)).toThrow()
    const killedAt = f.ledger.snapshot().killedAt
    f.advance(500)
    expect((await f.watchdog.kill('another-operator-code')).closedStreams).toBe(0)
    expect(f.ledger.snapshot().killedAt).toBe(killedAt)
    expect(f.ledger.snapshot().streams.every((stream) => stream.state === 'closed')).toBe(true)
  })

  it('tombstones leased but not-yet-started executions before a delayed old start can arrive', async () => {
    const f = fixture()
    const { lease, context } = f.claim()
    const result = await f.watchdog.kill('before-start-kill')
    expect(result).toMatchObject({
      killed: true,
      stopRequested: 1,
      reconciled: 1,
      retainedLiabilities: 0,
    })
    expect(await f.provider.execute(context)).toMatchObject({
      outcome: 'failure',
      receipt: { claims: { outcome: 'stopped', startForbidden: true, finalMeter: true } },
    })
    expect((await f.provider.inspect())[0].startedAt).toBeNull()
    expect(f.ledger.beginExecution(lease)).toBe(false)
  })

  it('retains active execution/meter liability across delayed stop and delayed final billing', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true, stopDelayMs: 100, meterDelayMs: 200 })
    const { lease, context } = f.claim()
    await f.provider.execute(context)
    f.ledger.openStream(auth, f.admitted.view.interest.id)
    f.advance(50)
    const first = await f.watchdog.kill('delayed-kill-test')
    expect(first).toMatchObject({
      killed: true,
      stopRequested: 1,
      reconciled: 0,
      retainedLiabilities: 1,
      closedStreams: 1,
    })
    expect((await f.provider.receipt(lease.execution)).claims).toMatchObject({
      outcome: 'stop-requested',
      finalMeter: false,
    })
    const outstanding = f.ledger.snapshot().global.reservedMicro
    expect(outstanding).toBeGreaterThan(0)
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job.reconciliationRequired).toBe(
      true,
    )
    f.advance(100)
    expect((await f.watchdog.tick()).retainedLiabilities).toBe(1)
    expect((await f.provider.receipt(lease.execution)).claims).toMatchObject({
      outcome: 'stopped',
      finalMeter: false,
    })
    f.advance(200)
    expect(await f.watchdog.tick()).toMatchObject({
      reconciled: 1,
      retainedLiabilities: 0,
      errors: [],
    })
    const finalBalance = f.ledger.snapshot().global
    expect(await f.watchdog.tick()).toMatchObject({ reconciled: 0, retainedLiabilities: 0 })
    expect(f.ledger.snapshot().global).toEqual(finalBalance)
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job.state).not.toBe('ready')
    expect(f.ledger.claim('watchdog-worker-0002')).toBeNull()
  })

  it('keeps unknown provider liability and does not label an active expired job cancelled or expired', async () => {
    const f = fixture({ mode: 'unknown', neverSettle: true }, { leaseMs: 100, jobTtlMs: 200 })
    const { context } = f.claim()
    await f.provider.execute(context)
    f.advance(500)
    expect(await f.watchdog.tick()).toMatchObject({
      killed: false,
      retainedLiabilities: 1,
      reconciled: 0,
    })
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job).toMatchObject({
      state: 'rendering',
      reconciliationRequired: true,
    })
    expect(f.ledger.snapshot().global.reservedMicro).toBeGreaterThan(0)
    f.advance(100_000)
    expect(await f.watchdog.kill('unknown-kill-test')).toMatchObject({
      killed: true,
      retainedLiabilities: 1,
      reconciled: 0,
    })
  })

  it('prevents queued retry from escaping persistent kill after known failure settlement', async () => {
    const f = fixture({ mode: 'known-failure' }, { retryDelayMs: 0 })
    const { lease, context } = f.claim()
    const result = await f.provider.execute(context)
    if (result.outcome !== 'failure' || !result.receipt)
      throw new Error('test-expected-known-failure')
    expect(f.ledger.fail(lease, result.failure, result.receipt)).toBe(true)
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job.state).toBe('queued')
    await f.watchdog.kill('retry-kill-test')
    expect(f.ledger.claim('watchdog-worker-0002')).toBeNull()
    expect((await f.provider.inspect()).length).toBe(1)
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job).toMatchObject({
      state: 'cancelled',
      attempts: 1,
    })
  })

  it('stops provider-only orphan hosts, reports unresolved orphan liability, and never refunds ledger accounting', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true, stopDelayMs: 50 })
    const { lease } = f.claim()
    const orphan = {
      ...lease,
      execution: {
        ...lease.execution,
        executionId: 'orphan-execution-0001',
        jobId: 'orphan-job-000000001',
      },
    }
    await f.provider.execute(
      signWorkerContext(workerClaimsForLease(orphan, f.now()), f.keys.contextSecret),
    )
    const before = f.ledger.snapshot().global
    expect(await f.watchdog.tick()).toMatchObject({
      orphanExecutions: 1,
      stopRequested: 1,
      retainedLiabilities: 2,
    })
    expect(f.ledger.snapshot().global).toEqual(before)
    f.advance(50)
    expect(await f.watchdog.tick()).toMatchObject({ orphanExecutions: 1, retainedLiabilities: 1 })
    expect(f.ledger.snapshot().global).toEqual(before)
    expect(isSettledReceipt((await f.provider.receipt(orphan.execution)).claims)).toBe(true)
  })

  it('uses job-specific bounded history rather than misreporting archived final executions as orphan hosts', async () => {
    const f = fixture()
    const { lease, context } = f.claim()
    const result = await f.provider.execute(context)
    if (result.outcome !== 'success') throw new Error('test-expected-success')
    f.ledger.fail(
      lease,
      { code: 'publication-failed', message: 'test-only no publication', retryable: false },
      result.receipt,
    )
    const events = f.ledger.events.bind(f.ledger)
    vi.spyOn(f.ledger, 'events').mockImplementation((jobId) => (jobId ? events(jobId) : []))
    expect(await f.watchdog.tick()).toMatchObject({
      orphanExecutions: 0,
      stopRequested: 0,
      retainedLiabilities: 0,
      errors: [],
    })
  })

  it('does not misclassify a live just-claimed dispatch window as failure or orphan', async () => {
    const f = fixture()
    f.claim()
    expect(await f.watchdog.tick()).toMatchObject({
      stopRequested: 0,
      reconciled: 0,
      orphanExecutions: 0,
      errors: [],
    })
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job.reconciliationRequired).toBe(
      false,
    )
  })

  it('a stop before delayed completion wins; late completion never changes the stopped tombstone', async () => {
    const f = fixture({ completeAfterMs: 200, loseResponse: true, stopDelayMs: 50 })
    const { lease, context } = f.claim()
    await f.provider.execute(context)
    await f.watchdog.kill('late-completion-kill')
    f.advance(300)
    expect(await f.watchdog.tick()).toMatchObject({ retainedLiabilities: 0, reconciled: 1 })
    expect((await f.provider.receipt(lease.execution)).claims.outcome).toBe('stopped')
    expect(await f.provider.execute(context)).toMatchObject({ outcome: 'failure' })
  })

  it('persists kill even when provider inventory and stop are unavailable; repeated tick later settles', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true })
    const { context } = f.claim()
    await f.provider.execute(context)
    const inspect = vi
      .spyOn(f.provider, 'inspect')
      .mockRejectedValue(new Error('do-not-log-secret'))
    const stop = vi.spyOn(f.provider, 'stop').mockRejectedValue(new Error('do-not-log-secret'))
    const report = await f.watchdog.kill('provider-outage-kill')
    expect(report).toMatchObject({ killed: true, retainedLiabilities: 1, reconciled: 0 })
    expect(report.errors).toEqual(
      expect.arrayContaining(['provider-inventory-unavailable', 'provider-stop-unconfirmed']),
    )
    expect(JSON.stringify(report)).not.toContain('do-not-log-secret')
    inspect.mockRestore()
    stop.mockRestore()
    expect(await f.watchdog.tick()).toMatchObject({
      killed: true,
      retainedLiabilities: 0,
      reconciled: 1,
    })
  })

  it('store outage stops enumerated provider resources but never claims durable kill or accounting reconciliation', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true })
    const { lease, context } = f.claim()
    await f.provider.execute(context)
    f.ledger.close()
    expect(await f.watchdog.kill('store-outage-kill')).toMatchObject({
      killed: false,
      reconciled: 0,
      stopRequested: 1,
      errors: ['ledger-unavailable-liability-count-incomplete'],
    })
    expect(isSettledReceipt((await f.provider.receipt(lease.execution)).claims)).toBe(true)
  })

  it('enforces runtime cap with dispatcher absent, but only reconciles the expired fenced lease', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true }, { maxRuntimeMs: 100, leaseMs: 100 })
    const { lease, context } = f.claim()
    await f.provider.execute(context)
    f.advance(101)
    expect(await f.watchdog.tick()).toMatchObject({ reconciled: 1, retainedLiabilities: 0 })
    expect((await f.provider.receipt(lease.execution)).claims).toMatchObject({
      outcome: 'stopped',
      runtimeMs: 100,
      finalMeter: true,
    })
    expect(f.ledger.getInterest(auth, f.admitted.view.interest.id).job.state).not.toBe('ready')
  })
})

describe('private strict --once CLI and true child-process restart', () => {
  it('a separate watchdog process progresses past a never-resolving stop and the original connection reconciles after exit', async () => {
    const f = fixture({ mode: 'hold', loseResponse: true })
    const first = f.claim()
    await f.provider.execute(first.context)
    f.ledger.openStream(auth, f.admitted.view.interest.id)
    const request = structuredClone(imageRequestFixture(undefined, 'process-second-request'))
    request.design.config.appearance.finish = 'bronze'
    f.ledger.admit({
      ...f.admission,
      request,
      binding: bindRequestSync(request.design, 'image', auth),
    })
    const second = f.claim()
    await f.provider.execute(second.context)
    const source = `
      import { SqliteLedger } from './src/image-service/control-plane/ledger.ts';
      import { LocalFakeProvider } from './src/image-service/control-plane/provider.ts';
      import { IndependentWatchdog } from './src/image-service/control-plane/watchdog.ts';
      const receiptSecret = process.env.TEST_RECEIPT, objectSecret = process.env.TEST_OBJECT;
      const now = () => 1000000;
      const ledger = new SqliteLedger({path: process.env.TEST_LEDGER, receiptSecret, objectSecret, now});
      const actual = new LocalFakeProvider({path: process.env.TEST_PROVIDER, receiptSecret, contextSecret: process.env.TEST_CONTEXT, now});
      let stops = 0;
      const provider = {provider: 'fake-local', paidExecutionAllowed: false,
        inspect: () => actual.inspect(), receipt: x => actual.receipt(x), execute: x => actual.execute(x),
        close: () => actual.close(), stop: (x, reason) => ++stops === 1 ? new Promise(() => {}) : actual.stop(x, reason)};
      const watchdog = new IndependentWatchdog({ledger, provider, now, providerCallTimeoutMs: 10});
      const first = await watchdog.kill('hung-child-stop');
      const next = await watchdog.tick();
      console.log(JSON.stringify({first, next, stops, streams: ledger.snapshot().streams}));
      await actual.close(); ledger.close();
    `
    const bundle = await build({
      absWorkingDir: REPO,
      stdin: { contents: source, resolveDir: REPO, loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      write: false,
      logLevel: 'silent',
    })
    const file = join(f.dir, 'hung-watchdog.mjs')
    writeFileSync(file, bundle.outputFiles[0].contents, { mode: 0o600 })
    const run = spawnSync(NODE, [file], {
      timeout: 10_000,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        TEST_RECEIPT: f.keys.receiptSecret,
        TEST_OBJECT: f.keys.objectSecret,
        TEST_CONTEXT: f.keys.contextSecret,
        TEST_LEDGER: join(f.dir, 'ledger.sqlite'),
        TEST_PROVIDER: f.providerOptions.path,
      },
    })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({
      stops: 2,
      first: { killed: true, closedStreams: 1, retainedLiabilities: 1 },
      next: { killed: true, retainedLiabilities: 1 },
      streams: [{ state: 'closed' }],
    })
    for (const secret of Object.values(f.keys))
      expect(run.stdout + run.stderr).not.toContain(secret)
    expect(f.ledger.snapshot().activeExecutions).toHaveLength(1)
    expect(await f.watchdog.tick()).toMatchObject({
      killed: true,
      retainedLiabilities: 0,
      reconciled: 1,
    })
  })

  it('rejects omitted --once, unknown/repeated flags, relative/traversal/equal paths and secret flags', () => {
    const valid = [
      '--once',
      '--ledger',
      '/operator/ledger.sqlite',
      '--provider',
      '/operator/provider.sqlite',
    ]
    expect(parseWatchdogArguments(valid)).toEqual({
      ledger: '/operator/ledger.sqlite',
      provider: '/operator/provider.sqlite',
    })
    for (const argv of [
      valid.slice(1),
      [...valid, '--once'],
      [...valid, '--reset'],
      [...valid, '--paid', 'true'],
      [...valid, '--receipt-secret', 'never-log'],
      ['--once', '--ledger', '../unsafe', '--provider', '/operator/provider.sqlite'],
      [
        '--once',
        '--ledger',
        '/operator/../ledger.sqlite',
        '--provider',
        '/operator/provider.sqlite',
      ],
      ['--once', '--ledger', '/operator/shared.sqlite', '--provider', '/operator/shared.sqlite'],
    ])
      expect(() => parseWatchdogArguments(argv)).toThrow()
  })

  it('never creates absent stores through CLI and emits only a generic error', async () => {
    const dir = mkdtempSync(join(ROOT, 'watchdog-cli-missing-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(
      await runWatchdogCli(
        [
          '--once',
          '--ledger',
          join(dir, 'absent.sqlite'),
          '--provider',
          join(dir, 'provider.sqlite'),
        ],
        {},
      ),
    ).toBe(1)
    expect(error).toHaveBeenCalledTimes(1)
    expect(() => readFileSync(join(dir, 'absent.sqlite'))).toThrow()
  })

  it('independent CLI kills resources/streams after dispatcher process exit and persists delayed-meter evidence across further process restarts', async () => {
    const dir = mkdtempSync(join(ROOT, 'watchdog-process-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const keys = {
      contextSecret: randomBytes(32).toString('hex'),
      receiptSecret: randomBytes(32).toString('hex'),
      objectSecret: randomBytes(32).toString('hex'),
    }
    const ledgerPath = join(dir, 'ledger.sqlite')
    const providerPath = join(dir, 'provider.sqlite')
    const childEnv = {
      PATH: process.env.PATH,
      P04_WORKER_CONTEXT_SECRET: keys.contextSecret,
      P04_PROVIDER_RECEIPT_SECRET: keys.receiptSecret,
      P04_OBJECT_SECRET: keys.objectSecret,
      P04_TEST_LEDGER: ledgerPath,
      P04_TEST_PROVIDER: providerPath,
    }
    const source = `
      import { SqliteLedger } from './src/image-service/control-plane/ledger.ts';
      import { LocalFakeProvider } from './src/image-service/control-plane/provider.ts';
      import { bindRequestSync, imageRequestFixture, signWorkerContext, workerClaimsForLease, worstCaseQuote } from './src/image-service/control-plane/contracts.ts';
      const contextSecret = process.env.P04_WORKER_CONTEXT_SECRET;
      const receiptSecret = process.env.P04_PROVIDER_RECEIPT_SECRET;
      const objectSecret = process.env.P04_OBJECT_SECRET;
      const ledger = new SqliteLedger({ path: process.env.P04_TEST_LEDGER, receiptSecret, objectSecret, policy: { maxRuntimeMs: 30000, leaseMs: 60000 } });
      const provider = new LocalFakeProvider({ path: process.env.P04_TEST_PROVIDER, contextSecret, receiptSecret }, { plan: () => ({ mode: 'hold', loseResponse: true, stopDelayMs: 500, meterDelayMs: 500 }) });
      const auth = { principalId: 'process-principal-0001', experimentId: 'process-experiment-0001', scopes: ['images:read', 'images:write'] };
      const request = imageRequestFixture();
      const admitted = ledger.admit({ auth, purpose: 'image', request, binding: bindRequestSync(request.design, 'image', auth), quote: worstCaseQuote(ledger.policy) });
      ledger.openStream(auth, admitted.view.interest.id);
      const lease = ledger.claim('process-worker-000001');
      ledger.beginExecution(lease);
      await provider.execute(signWorkerContext(workerClaimsForLease(lease, Date.now()), contextSecret));
      process.exit(0); // Deliberate abrupt dispatcher exit: no shutdown or close proves stop.
    `
    const bundle = async (path: string, stdin?: string) => {
      const result = await build({
        absWorkingDir: REPO,
        ...(stdin
          ? { stdin: { contents: stdin, resolveDir: REPO, loader: 'ts' as const } }
          : { entryPoints: ['scripts/p04-watchdog.ts'] }),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        write: false,
        logLevel: 'silent',
      })
      writeFileSync(path, result.outputFiles[0].contents, { mode: 0o600 })
    }
    const dispatcherFile = join(dir, 'dispatcher.mjs')
    const watchdogFile = join(dir, 'watchdog.mjs')
    await bundle(dispatcherFile, source)
    await bundle(watchdogFile)
    const dispatcher = spawnSync(NODE, [dispatcherFile], {
      env: childEnv,
      timeout: 10_000,
      encoding: 'utf8',
    })
    expect(dispatcher.status, dispatcher.stderr).toBe(0)
    const options = {
      path: ledgerPath,
      receiptSecret: keys.receiptSecret,
      objectSecret: keys.objectSecret,
    }
    const ledger = new SqliteLedger(options)
    cleanup.push(() => ledger.close())
    expect(ledger.snapshot().activeExecutions).toHaveLength(1)
    const args = ['--once', '--ledger', ledgerPath, '--provider', providerPath]
    const kill = spawnSync(NODE, [watchdogFile, ...args, '--kill', 'independent-process-kill'], {
      env: childEnv,
      timeout: 10_000,
      encoding: 'utf8',
    })
    expect(kill.status, kill.stderr).toBe(1) // Nonzero while any delayed provider liability remains.
    const first = JSON.parse(kill.stdout)
    expect(first.report).toMatchObject({
      killed: true,
      closedStreams: 1,
      retainedLiabilities: 1,
      reconciled: 0,
    })
    expect(first.resources[0]).toMatchObject({
      outcome: 'stop-requested',
      terminationConfirmed: false,
      billingFinal: false,
      outstanding: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const reconciliation = spawnSync(NODE, [watchdogFile, ...args], {
      env: childEnv,
      timeout: 10_000,
      encoding: 'utf8',
    })
    expect(reconciliation.status, reconciliation.stderr).toBe(0)
    const last = JSON.parse(reconciliation.stdout)
    expect(last.report).toMatchObject({
      killed: true,
      retainedLiabilities: 0,
      reconciled: 1,
      closedStreams: 0,
    })
    expect(last.resources[0]).toMatchObject({
      outcome: 'stopped',
      terminationConfirmed: true,
      billingFinal: true,
      outstanding: false,
    })
    expect(last).toMatchObject({
      paidExecutionAllowed: false,
      productionAllowed: false,
      externalProviderCapsProved: false,
    })
    expect(ledger.snapshot().activeExecutions).toHaveLength(0)
    expect(ledger.claim('process-worker-000002')).toBeNull()
    const repeated = spawnSync(NODE, [watchdogFile, ...args], {
      env: childEnv,
      timeout: 10_000,
      encoding: 'utf8',
    })
    expect(repeated.status).toBe(0)
    expect(JSON.parse(repeated.stdout).report.reconciled).toBe(0)
    for (const key of Object.values(keys))
      expect(
        kill.stdout + kill.stderr + reconciliation.stdout + reconciliation.stderr,
      ).not.toContain(key)
    if (process.env.P04_WRITE_WATCHDOG_EVIDENCE === '1') {
      writeFileSync(
        join(ROOT, 'watchdog-process-receipts.json'),
        JSON.stringify(
          {
            simulationOnly: true,
            node: process.version,
            dispatcherExitStatus: dispatcher.status,
            dispatcherClosedStores: false,
            firstWatchdogExitStatus: kill.status,
            first,
            reconciliationExitStatus: reconciliation.status,
            last,
            repeatedExitStatus: repeated.status,
            repeated: JSON.parse(repeated.stdout),
            finalSyntheticAccount: ledger.snapshot().global,
            caveat:
              'Local fake resources and synthetic meter only. No real provider termination, invoice cap, remote stream, rendering, or production readiness is proved.',
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    }
  }, 20_000)
})
