// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import contract from '../../fixtures/http-contract.json'
import workerFixture from '../../fixtures/worker-adapter.json'
import {
  customerDesignSchema,
  imageDescriptorSchema,
  setSnapshotSchema,
  type SetIdentity,
} from '../../contracts'
import { canonicalJson, computeSetIdentity } from '../../identity'
import { workerClaimSchema } from '../../workerProtocol'
import type { ReserveCommand } from '../ports'
import { checksum } from '../artifacts'
import { seedImagesForSet, verifySeedManifest } from '../seedCache'

// Opt-in, Docker-only, fixed throwaway database. This suite cannot use a remote DATABASE_URL.
const container = process.env.RENDER_LIBRARY_TEST_CONTAINER
const enabled = Boolean(container)
const args = [
  'exec',
  '-i',
  container ?? 'not-configured',
  'psql',
  '-X',
  '-q',
  '-t',
  '-A',
  '-U',
  'postgres',
  '-d',
  'fury_library_test',
  '-v',
  'ON_ERROR_STOP=1',
]
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const encoded = (value: unknown) => `${quote(JSON.stringify(value))}::jsonb`
const run = (query: string) =>
  execFileSync('docker', args, {
    input: query,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
const rpc = (name: string, values: string[]) =>
  JSON.parse(run(`select to_json(public.${name}(${values.join(',')}));`) || 'null')
const asyncRun = promisify(execFile)
async function parallelRpc(name: string, value: unknown) {
  const result = await asyncRun('docker', [
    ...args,
    '-c',
    `select public.${name}(${encoded(value)});`,
  ])
  return JSON.parse(result.stdout.trim())
}
const session = 'a'.repeat(64),
  network = 'b'.repeat(64)
const registration = {
  releaseId: 'fury-native-five@2' as const,
  workerBuildSha256: '1'.repeat(64),
  recipeBundleSha256: '2'.repeat(64),
  geometrySha256: '3'.repeat(64),
  materialsSha256: '4'.repeat(64),
  camerasSha256: '5'.repeat(64),
  rendererSha256: '6'.repeat(64),
}
const approvalId = '00000000-0000-4000-8000-000000000099'
const workerRegistration = {
  ...registration,
  workerBuildSha256: '8'.repeat(64),
  recipeBundleSha256: '9'.repeat(64),
}
let expiresAt: string
let command: ReserveCommand
function touch(hash: string, net = network) {
  run(
    `select public.render_library_touch_session(${quote(hash)},${quote(net)},now()+interval '24 hours');`,
  )
}
function reserve(input = command) {
  return rpc('render_library_reserve_set', [encoded(input)])
}
function ledger() {
  return JSON.parse(run('select row_to_json(a) from public.render_library_approvals a;'))
}
function dispatch(
  lane: 'foreground' | 'background' = 'foreground',
  build: string | null = workerRegistration.workerBuildSha256,
) {
  return rpc('render_library_claim_dispatch', [
    quote('test-dispatcher'),
    quote(lane),
    build === null ? 'null' : quote(build),
  ])
}

async function variation(index: number) {
  const next = structuredClone(command)
  next.request.idempotencyKey = randomUUID()
  next.request.design.presentation.lookRef =
    index < 2 ? 'studio-day-draft@1' : 'studio-night-draft@1'
  next.request.design.presentation.aspect = index % 2 ? 'tall' : 'wide'
  return { ...next, identity: await computeSetIdentity(next.request.design) }
}
function workerClaim(envelope: unknown, build = workerRegistration.workerBuildSha256) {
  return workerClaimSchema.parse(
    rpc('render_library_claim_worker', [encoded(envelope), quote(build)]),
  )
}
function recordDispatch(
  claim: { dispatch: { dispatchId: string }; claimToken: string },
  result: unknown,
) {
  return rpc('render_library_record_dispatch', [
    quote(claim.dispatch.dispatchId),
    quote(claim.claimToken),
    encoded(result),
  ])
}
function snapshot(identity: SetIdentity) {
  return setSnapshotSchema.parse(rpc('render_library_snapshot', [encoded(identity)]))
}

function reservedAmount(claim: { dispatch: { dispatchId: string }; claimToken: string }) {
  return rpc('render_library_dispatch_reservation', [
    quote(claim.dispatch.dispatchId),
    quote(claim.claimToken),
  ])
}

function terminalEvidence(dispatchId: string) {
  return {
    kind: 'provider-terminal',
    dispatchId,
    providerCallId: 'sb-test',
    observedAt: new Date().toISOString(),
    evidenceSha256: '7'.repeat(64),
  }
}

describe.skipIf(!enabled)('real local Postgres render ledger (no providers)', () => {
  beforeAll(() => {
    if (!container || !/^[a-zA-Z0-9_-]+$/.test(container))
      throw new Error('Explicit Docker container required')
    run(
      'drop schema public cascade; create schema public; grant usage on schema public to service_role,anon,authenticated;',
    )
    run(readFileSync('supabase/migrations/202610190001_render_library.sql', 'utf8'))
    run(readFileSync('supabase/migrations/202610190003_render_library_recovery.sql', 'utf8'))
    run(readFileSync('supabase/migrations/202610190004_hosted_dispatcher.sql', 'utf8'))
    run(readFileSync('supabase/migrations/202610190005_dispatcher_headroom.sql', 'utf8'))
    run(readFileSync('supabase/migrations/202610200001_render_queue_lanes.sql', 'utf8'))
    run(readFileSync('supabase/migrations/202610200002_worker_builds.sql', 'utf8'))
    run(readFileSync('supabase/migrations/202610200003_work_conserving_dispatch.sql', 'utf8'))
  })
  beforeEach(async () => {
    run(
      'truncate public.render_library_recipes,public.render_library_approvals,public.render_library_sessions cascade;',
    )
    expiresAt = new Date(Date.now() + 3600_000).toISOString()
    const policy = {
      enabled: true as const,
      approvalId,
      expiresAt,
      globalBudgetMicroUsd: 100_000,
      maxJobLiabilityMicroUsd: 6_000,
      maxImageLiabilityMicroUsd: 1_000,
      startupLiabilityMicroUsd: 500,
      recipe: registration,
    }
    run(`insert into public.render_library_recipes(release_id,registration) values('fury-native-five@2',${encoded(registration)});
      insert into public.render_library_worker_builds(worker_build_sha256,release_id,revision,registration,max_active_jobs_per_session)
        values(${quote(registration.workerBuildSha256)},'fury-native-five@2','original',${encoded(registration)},1);
      insert into public.render_library_worker_builds(worker_build_sha256,release_id,revision,registration,max_active_jobs_per_session,parent_worker_build_sha256)
        values(${quote(workerRegistration.workerBuildSha256)},'fury-native-five@2','queue-worker@1',${encoded(workerRegistration)},2,${quote(registration.workerBuildSha256)});
      insert into public.render_library_approvals(id,enabled,expires_at,budget_micro_usd,policy,active_worker_build_sha256)
        values(${quote(approvalId)},true,${quote(expiresAt)},100000,${encoded(policy)},${quote(workerRegistration.workerBuildSha256)});`)
    touch(session)
    const design = customerDesignSchema.parse(contract.create.design)
    command = {
      request: {
        ...contract.create,
        contractVersion: 'fury.render-library@1',
        intent: 'render-missing',
        idempotencyKey: randomUUID(),
        design,
      },
      identity: await computeSetIdentity(design),
      policy,
      context: {
        sessionHash: session,
        networkHash: network,
        sameOriginVerified: true,
        csrfVerified: true,
      },
      seedImages: [],
    }
  })
  it('read-only misses leave no jobs, outbox or liability', () => {
    expect(snapshot(command.identity).coverage).toBe('missing')
    expect(run('select count(*) from public.render_library_jobs')).toBe('0')
    expect(ledger().reserved_micro_usd).toBe(0)
  })
  it('upgrades execution without rewriting the image recipe or old customer policy', () => {
    const admitted = reserve()
    const claim = workerClaim(dispatch().dispatch)
    expect(claim.workerBuildSha256).toBe(workerRegistration.workerBuildSha256)
    expect(claim.recipeBundleSha256).toBe(workerRegistration.recipeBundleSha256)
    expect(claim.identity).toEqual(admitted.snapshot.identity)
    expect(ledger().policy.recipe).toEqual(registration)
    expect(JSON.parse(run('select registration from public.render_library_recipes'))).toEqual(
      registration,
    )
    expect(() =>
      run("update public.render_library_worker_builds set revision='rewritten'"),
    ).toThrow()
    expect(() => run('delete from public.render_library_worker_builds')).toThrow()
    expect(() => run('set role anon; select * from public.render_library_worker_builds')).toThrow()
  })
  it('supports a safe legacy rollout window with the original per-session ceiling', async () => {
    run('update public.render_library_approvals set active_worker_build_sha256=null')
    reserve()
    reserve(await variation(1))
    expect(dispatch()).toBeNull()
    const first = dispatch('foreground', null)
    expect(
      workerClaim(first.dispatch, registration.workerBuildSha256).limits.maxActiveJobsPerSession,
    ).toBe(1)
    expect(dispatch('background', null)).toBeNull()
    expect(ledger().reserved_micro_usd).toBe(11000)
  })
  it('fences legacy and inactive dispatchers before consuming queued work at cutover', () => {
    reserve()
    expect(rpc('render_library_claim_dispatch', [quote('legacy-dispatcher')])).toBeNull()
    expect(dispatch('foreground', registration.workerBuildSha256)).toBeNull()
    expect(
      run('select count(*) from public.render_library_outbox where claimed_at is not null'),
    ).toBe('0')
    expect(ledger().reserved_micro_usd).toBe(5500)
    expect(dispatch().dispatch.jobId).toBeTruthy()
  })
  it('rejects inactive builds without consuming the one-shot worker claim', () => {
    reserve()
    const claimed = dispatch()
    expect(() => workerClaim(claimed.dispatch, registration.workerBuildSha256)).toThrow()
    expect(workerClaim(claimed.dispatch).limits.maxActiveJobsPerSession).toBe(2)
  })
  it('accounts for hosted CPU cycles inside the same cumulative budget', () => {
    run('update public.render_library_approvals set budget_micro_usd=1000000')
    const id = randomUUID()
    expect(
      JSON.parse(run(`select to_json(public.render_library_start_cpu_cycle(${quote(id)}))`)),
    ).toBe(true)
    expect(ledger().charged_micro_usd).toBe(250000)
    expect(
      JSON.parse(run(`select to_json(public.render_library_start_cpu_cycle(${quote(id)}))`)),
    ).toBe(false)
    rpc('render_library_finish_cpu_cycle', [quote(id), quote('idle')])
    const charged = ledger().charged_micro_usd
    expect(charged).toBeGreaterThanOrEqual(100)
    expect(charged).toBeLessThan(250000)
    rpc('render_library_finish_cpu_cycle', [quote(id), quote('idle')])
    expect(ledger().charged_micro_usd).toBe(charged)
    run('update public.render_library_approvals set budget_micro_usd=1000')
    expect(
      JSON.parse(
        run(`select to_json(public.render_library_start_cpu_cycle(${quote(randomUUID())}))`),
      ),
    ).toBe(false)
    expect(ledger().charged_micro_usd).toBe(charged)
    expect(
      run(
        "select has_function_privilege('anon','public.render_library_start_cpu_cycle(uuid)','execute')",
      ),
    ).toBe('f')
  })
  it('leaves configured CPU recovery headroom rather than spending it on a GPU job', () => {
    run('update public.render_library_approvals set dispatcher_headroom_micro_usd=95000')
    expect(reserve().error.code).toBe('budget-exhausted')
    expect(ledger().reserved_micro_usd).toBe(0)
    expect(run('select count(*) from public.render_library_jobs')).toBe('0')
  })
  it('atomically joins racing sessions and reserves exactly once', async () => {
    const sessions = Array.from({ length: 8 }, (_, i) => String(i).repeat(64))
    sessions.forEach((hash) => touch(hash))
    const results = await Promise.all(
      sessions.map((hash) =>
        parallelRpc('render_library_reserve_set', {
          ...command,
          context: { ...command.context, sessionHash: hash },
          request: { ...command.request, idempotencyKey: randomUUID() },
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'admitted')).toHaveLength(1)
    expect(new Set(results.map((result) => result.snapshot.job.id)).size).toBe(1)
    results.forEach((result) => setSnapshotSchema.parse(result.snapshot))
    expect(ledger().reserved_micro_usd).toBe(5500)
    expect(run('select count(*) from public.render_library_outbox')).toBe('1')
  })
  it('replays identical keys and rejects changed design or camera', () => {
    const result = reserve()
    expect(reserve().snapshot.job.id).toBe(result.snapshot.job.id)
    const changed = structuredClone(command)
    changed.request.design.presentation.cameraRef = 'front-draft@1'
    expect(reserve(changed).error.code).toBe('idempotency-conflict')
  })
  it('enforces expiry, activation, valid session and budget before reservation', async () => {
    run('update public.render_library_approvals set enabled=false;')
    expect(reserve().error.code).toBe('budget-unavailable')
    run(
      "update public.render_library_approvals set enabled=true,expires_at=now()-interval '1 second';",
    )
    expect(reserve().error.code).toBe('budget-unavailable')
    run(
      `update public.render_library_approvals set expires_at=${quote(expiresAt)},budget_micro_usd=1000,policy=jsonb_set(policy,'{globalBudgetMicroUsd}','1000');`,
    )
    command = { ...command, policy: { ...command.policy, globalBudgetMicroUsd: 1000 } }
    expect(reserve().error.code).toBe('budget-exhausted')
    expect(ledger().reserved_micro_usd).toBe(0)
    run(
      "update public.render_library_approvals set budget_micro_usd=100000,policy=jsonb_set(policy,'{globalBudgetMicroUsd}','100000');",
    )
    command = { ...command, policy: { ...command.policy, globalBudgetMicroUsd: 100_000 } }
    run("update public.render_library_sessions set expires_at=now()-interval '1 second';")
    expect(reserve().error.code).toBe('csrf-invalid')
  })
  it('serializes competing designs against the final available budget', async () => {
    run(
      "update public.render_library_approvals set budget_micro_usd=6000,policy=jsonb_set(policy,'{globalBudgetMicroUsd}','6000');",
    )
    command = { ...command, policy: { ...command.policy, globalBudgetMicroUsd: 6000 } }
    const other = structuredClone(command.request)
    other.design.presentation.aspect = 'tall'
    other.idempotencyKey = randomUUID()
    touch('c'.repeat(64))
    const results = await Promise.all([
      parallelRpc('render_library_reserve_set', command),
      parallelRpc('render_library_reserve_set', {
        ...command,
        request: other,
        identity: await computeSetIdentity(other.design),
        context: { ...command.context, sessionHash: 'c'.repeat(64) },
      }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['admitted', 'denied'])
    expect(results.find((result) => result.status === 'denied').error.code).toBe('budget-exhausted')
    expect(ledger().reserved_micro_usd).toBe(5500)
  })
  it(
    'enforces session and shared network admission quotas even after safe settlement',
    { timeout: 30_000 },
    () => {
      run('update public.render_library_sessions set admitted_count=3;')
      expect(reserve().error.code).toBe('rate-limited')
      run('update public.render_library_sessions set admitted_count=0;')
      reserve()
      for (let i = 0; i < 6; i++) {
        const claimed = dispatch()
        recordDispatch(claimed, {
          status: 'definitely-not-submitted',
          reason: {
            code: 'worker-failed',
            message: 'Rendering stopped. Completed images remain available.',
            retryable: false,
          },
        })
        rpc('render_library_reconcile_terminal', [
          quote(claimed.dispatch.jobId),
          encoded({ kind: 'never-submitted', dispatchId: claimed.dispatch.dispatchId }),
          '0',
        ])
        const newSession = String(i + 1).repeat(64)
        touch(newSession)
        const context = { ...command.context, sessionHash: newSession }
        // Join is free and grants polling/retry access, but cannot reserve more GPU work.
        const joined = reserve({
          ...command,
          context,
          request: { ...command.request, idempotencyKey: randomUUID() },
        })
        expect(joined.status).toBe('joined')
        const retry = {
          contractVersion: 'fury.render-library@1',
          intent: 'retry-failed-missing',
          idempotencyKey: randomUUID(),
        }
        const retried = rpc('render_library_retry_failed', [
          quote(claimed.dispatch.jobId),
          encoded(retry),
          encoded(context),
          encoded(command.policy),
        ])
        if (i === 5) expect(retried.error.code).toBe('rate-limited')
        else expect(retried.status).toBe('admitted')
      }
      expect(ledger().charged_micro_usd).toBe(0)
      expect(ledger().reserved_micro_usd).toBe(0)
    },
  )
  it('imports unchanged exteriors without jobs or budget and reserves only the new interior', async () => {
    const bytes = readFileSync('public/native-library/manifest.json')
    const design = customerDesignSchema.parse(verifySeedManifest(bytes).entries[0].design)
    const identity = await computeSetIdentity(design)
    const images = await seedImagesForSet(bytes, design)
    expect(images).toHaveLength(4)
    run(
      `select public.render_library_import_seed(${encoded(design)},${encoded(identity)},${encoded(images)});`,
    )
    run(
      `select public.render_library_import_seed(${encoded(design)},${encoded(identity)},${encoded(images)});`,
    )
    expect(snapshot(identity).coverage).toBe('partial')
    expect(run('select count(*) from public.render_library_jobs')).toBe('0')
    expect(ledger().reserved_micro_usd).toBe(0)
    const corrupt = images.map((image, i) => (i ? image : { ...image, sha256: '0'.repeat(64) }))
    expect(() =>
      run(
        `select public.render_library_import_seed(${encoded(design)},${encoded(identity)},${encoded(corrupt)});`,
      ),
    ).toThrow()
    const result = reserve({ ...command, identity, request: { ...command.request, design } })
    expect(result.status).toBe('admitted')
    expect(
      result.snapshot.views.filter((view: { status: string }) => view.status === 'ready'),
    ).toHaveLength(4)
    expect(ledger().reserved_micro_usd).toBe(1500)
    const claimed = dispatch()
    const work = workerClaim(claimed.dispatch)
    expect(work.views.map((view: { cameraRef: string }) => view.cameraRef)).toEqual([
      'entry-draft@1',
    ])
  })
  it('queues additional variations from one session while both execution lanes are busy', async () => {
    const first = reserve(await variation(0))
    const foreground = dispatch()
    expect(foreground.dispatch.jobId).toBe(first.snapshot.job.id)
    const second = reserve(await variation(1))
    const background = dispatch('background')
    expect(background.dispatch.jobId).toBe(second.snapshot.job.id)
    const thirdCommand = await variation(2)
    const third = reserve(thirdCommand)
    expect(third.status).toBe('admitted')
    expect(third.snapshot.job.stage).toBe('queued')
    expect(snapshot(thirdCommand.identity).job?.stage).toBe('queued')
    expect(workerClaim(foreground.dispatch).limits.maxActiveJobsPerSession).toBe(2)
    expect(workerClaim(background.dispatch).limits.maxActiveJobsPerSession).toBe(2)
    expect(ledger().reserved_micro_usd).toBe(3 * 5500)
    expect(dispatch()).toBeNull()
    expect(dispatch('background')).toBeNull()
    expect(reserve(await variation(3)).error.code).toBe('rate-limited')
    recordDispatch(background, {
      status: 'definitely-not-submitted',
      reason: {
        code: 'worker-failed',
        message: 'Rendering stopped. Completed images remain available.',
        retryable: false,
      },
    })
    expect(dispatch('background')).toBeNull()
    rpc('render_library_reconcile_terminal', [
      quote(background.dispatch.jobId),
      encoded({ kind: 'never-submitted', dispatchId: background.dispatch.dispatchId }),
      '0',
    ])
    expect(dispatch('background').dispatch.jobId).toBe(third.snapshot.job.id)
  })
  it('reserves the foreground lane for the latest explicit request while draining older variations FIFO', async () => {
    const old = reserve(await variation(0))
    const middle = reserve(await variation(1))
    const latest = reserve(await variation(2))
    expect(dispatch('background').dispatch.jobId).toBe(old.snapshot.job.id)
    expect(dispatch('background')).toBeNull()
    expect(dispatch().dispatch.jobId).toBe(latest.snapshot.job.id)
    expect(
      run(`select stage from public.render_library_jobs where id=${quote(middle.snapshot.job.id)}`),
    ).toBe('queued')
  })
  it('keeps the latest request prioritized through a long wait and after the browser leaves', async () => {
    const first = reserve(await variation(0))
    const second = reserve(await variation(1))
    run(
      "update public.render_library_sessions set foreground_requested_at=now()-interval '3 minutes',expires_at=now()-interval '1 second'",
    )
    expect(dispatch().dispatch.jobId).toBe(second.snapshot.job.id)
    expect(dispatch('background').dispatch.jobId).toBe(first.snapshot.job.id)
    expect(ledger().reserved_micro_usd).toBe(11000)
  })
  it('prioritizes the latest explicit selection across sessions instead of the oldest job', async () => {
    const first = reserve(await variation(0))
    const secondSession = 'c'.repeat(64)
    touch(secondSession)
    const next = await variation(1)
    const second = reserve({ ...next, context: { ...next.context, sessionHash: secondSession } })
    run(
      `update public.render_library_sessions set foreground_requested_at=now()-interval '1 minute' where session_hash=${quote(session)}`,
    )
    expect(dispatch().dispatch.jobId).toBe(second.snapshot.job.id)
    expect(dispatch('background').dispatch.jobId).toBe(first.snapshot.job.id)
  })
  it('uses an idle foreground lane after a cache hit even while background is uncertain', async () => {
    reserve(await variation(1))
    const pending = reserve(await variation(2))
    const background = dispatch('background')
    recordDispatch(background, {
      status: 'uncertain',
      reason: {
        code: 'dispatch-uncertain',
        message: 'We are checking whether rendering started. Please do not submit again.',
        retryable: false,
      },
    })
    run(`insert into public.render_library_sets(set_key,design,identity,release_id)
      values(${quote(command.identity.setKey)},${encoded(command.request.design)},${encoded(command.identity)},'fury-native-five@2');`)
    for (const view of contract.complete.views) {
      const image = imageDescriptorSchema.parse(view.image)
      run(`insert into public.render_library_images(image_key,set_key,camera_ref,descriptor,receipt)
        values(${quote(image.imageKey)},${quote(image.setKey)},${quote(image.design.presentation.cameraRef)},${encoded(image)},${encoded(image.provenance)});`)
    }
    expect(reserve().status).toBe('cached')
    expect(run('select foreground_job_id from public.render_library_sessions')).toBe('')
    expect(dispatch().dispatch.jobId).toBe(pending.snapshot.job.id)
    expect(dispatch('background')).toBeNull()
    expect(ledger().reserved_micro_usd).toBe(11000)
  })
  it('uses an idle foreground lane after joining a terminal job', async () => {
    const failed = reserve()
    const claim = dispatch()
    recordDispatch(claim, {
      status: 'definitely-not-submitted',
      reason: {
        code: 'worker-failed',
        message: 'Rendering stopped. Completed images remain available.',
        retryable: false,
      },
    })
    rpc('render_library_reconcile_terminal', [
      quote(failed.snapshot.job.id),
      encoded({ kind: 'never-submitted', dispatchId: claim.dispatch.dispatchId }),
      '0',
    ])
    reserve(await variation(1))
    dispatch('background')
    const pending = reserve(await variation(2))
    expect(
      reserve({ ...command, request: { ...command.request, idempotencyKey: randomUUID() } }).status,
    ).toBe('joined')
    expect(dispatch().dispatch.jobId).toBe(pending.snapshot.job.id)
    expect(ledger().reserved_micro_usd).toBe(11000)
  })
  it('pauses unclaimed work at approval expiry and resumes it only after operator renewal', () => {
    const pending = reserve()
    run("update public.render_library_approvals set expires_at=now()-interval '1 second'")
    expect(dispatch()).toBeNull()
    expect(dispatch('background')).toBeNull()
    expect(ledger().reserved_micro_usd).toBe(5500)
    expect(
      run('select count(*) from public.render_library_outbox where claimed_at is not null'),
    ).toBe('0')
    run(
      "update public.render_library_approvals set expires_at=now()+interval '1 hour',policy=jsonb_set(policy,'{expiresAt}',to_jsonb(public.render_library_iso(now()+interval '1 hour')))",
    )
    expect(dispatch().dispatch.jobId).toBe(pending.snapshot.job.id)
    expect(ledger().reserved_micro_usd).toBe(5500)
  })
  it('drains jobs without foreground pointers through an otherwise idle foreground lane', () => {
    const queued = reserve()
    run(
      'update public.render_library_sessions set foreground_job_id=null,foreground_requested_at=null',
    )
    expect(dispatch().dispatch.jobId).toBe(queued.snapshot.job.id)
  })
  it('does not shut down a sibling CPU cycle and fences new cycles after actual exhaustion', () => {
    run('update public.render_library_approvals set budget_micro_usd=300000')
    const cycleId = randomUUID()
    expect(rpc('render_library_start_cpu_cycle', [quote(cycleId)])).toBe(true)
    expect(rpc('render_library_start_cpu_cycle', [quote(randomUUID())])).toBe(false)
    expect(rpc('render_library_halt_dispatcher_if_exhausted', [])).toBe(false)
    rpc('render_library_finish_cpu_cycle', [quote(cycleId), quote('idle')])
    expect(rpc('render_library_halt_dispatcher_if_exhausted', [])).toBe(false)
    run('update public.render_library_approvals set charged_micro_usd=100000')
    expect(rpc('render_library_halt_dispatcher_if_exhausted', [])).toBe(true)
    run('update public.render_library_approvals set budget_micro_usd=1000000')
    expect(rpc('render_library_start_cpu_cycle', [quote(randomUUID())])).toBe(false)
    expect(ledger().enabled).toBe(true)
    run('update public.render_library_approvals set dispatcher_halted=false')
    expect(rpc('render_library_start_cpu_cycle', [quote(randomUUID())])).toBe(true)
  })
  it('can halt after a crashed CPU invocation times out without refunding its charge', () => {
    run('update public.render_library_approvals set budget_micro_usd=300000')
    const cycleId = randomUUID()
    rpc('render_library_start_cpu_cycle', [quote(cycleId)])
    run("update public.render_library_dispatcher_cycles set started_at=now()-interval '61 minutes'")
    expect(rpc('render_library_halt_dispatcher_if_exhausted', [])).toBe(true)
    expect(ledger().charged_micro_usd).toBe(250000)
  })
  it('blocks admission and dispatch while halted without cancelling queued liability', async () => {
    reserve()
    run('update public.render_library_approvals set dispatcher_halted=true')
    expect(dispatch()).toBeNull()
    expect(dispatch('background')).toBeNull()
    expect(reserve(await variation(1)).error.code).toBe('budget-unavailable')
    expect(ledger().reserved_micro_usd).toBe(5500)
    expect(ledger().enabled).toBe(true)
    run('update public.render_library_approvals set dispatcher_halted=false')
    expect(dispatch()).not.toBeNull()
  })
  it('promotes an explicitly rejoined queued design without reserving twice; retries of old requests do not promote', async () => {
    const firstCommand = await variation(0)
    const first = reserve(firstCommand)
    const secondCommand = await variation(1)
    const second = reserve(secondCommand)
    expect(reserve(firstCommand).status).toBe('joined')
    expect(run('select foreground_job_id from public.render_library_sessions')).toBe(
      second.snapshot.job.id,
    )
    const rejoin = {
      ...firstCommand,
      request: {
        ...firstCommand.request,
        idempotencyKey: randomUUID(),
        design: {
          ...firstCommand.request.design,
          presentation: {
            ...firstCommand.request.design.presentation,
            cameraRef: 'entry-draft@1' as const,
          },
        },
      },
    }
    expect(reserve(rejoin).status).toBe('joined')
    expect(dispatch().dispatch.jobId).toBe(first.snapshot.job.id)
    expect(
      run(
        `select priority_camera from public.render_library_jobs where id=${quote(first.snapshot.job.id)}`,
      ),
    ).toBe('entry-draft@1')
    expect(ledger().reserved_micro_usd).toBe(11000)
    expect(run('select admitted_count from public.render_library_sessions')).toBe('2')
  })
  it('serializes competing lane claims and holds uncertain slots until proven terminal', async () => {
    for (let i = 0; i < 3; i++) reserve(await variation(i))
    const claimConcurrently = async (lane: string) => {
      const result = await asyncRun('docker', [
        ...args,
        '-c',
        `select public.render_library_claim_dispatch('racing-dispatcher',${quote(lane)},${quote(workerRegistration.workerBuildSha256)});`,
      ])
      return JSON.parse(result.stdout.trim() || 'null')
    }
    const claims = await Promise.all(
      ['foreground', 'background', 'foreground', 'background'].map(claimConcurrently),
    )
    const claimed = claims.filter(Boolean)
    expect(claimed).toHaveLength(2)
    expect(new Set(claimed.map((entry) => entry.dispatch.jobId)).size).toBe(2)
    for (const claim of claimed)
      recordDispatch(claim, {
        status: 'uncertain',
        reason: {
          code: 'dispatch-uncertain',
          message: 'We are checking whether rendering started. Please do not submit again.',
          retryable: false,
        },
      })
    run(
      "update public.render_library_outbox set claimed_at=now()-interval '1 day' where claimed_at is not null",
    )
    expect(dispatch()).toBeNull()
    expect(dispatch('background')).toBeNull()
    expect(ledger().reserved_micro_usd).toBe(16500)
  })
  it('rejects invalid lanes before claiming anything', () => {
    reserve()
    expect(() =>
      rpc('render_library_claim_dispatch', [quote('test'), quote('unbounded')]),
    ).toThrow()
    expect(() => rpc('render_library_claim_dispatch', [quote('test'), 'null'])).toThrow()
    expect(run("select count(*) from public.render_library_outbox where state='pending'")).toBe('1')
  })
  it('does not reclaim dispatch after restart or ambiguous result and claims worker once', () => {
    reserve()
    const claim = dispatch()
    expect(dispatch()).toBeNull()
    const work = workerClaim(claim.dispatch)
    expect(work.views).toHaveLength(5)
    expect(
      rpc('render_library_claim_worker', [
        encoded(claim.dispatch),
        quote(registration.workerBuildSha256),
      ]),
    ).toBeNull()
    recordDispatch(claim, {
      status: 'uncertain',
      reason: {
        code: 'dispatch-uncertain',
        message: 'We are checking whether rendering started. Please do not submit again.',
        retryable: false,
      },
    })
    expect(snapshot(command.identity).job?.stage).toBe('dispatch-uncertain')
    expect(dispatch()).toBeNull()
    expect(ledger().reserved_micro_usd).toBe(5500)
    expect(
      reserve({ ...command, request: { ...command.request, idempotencyKey: randomUUID() } }).status,
    ).toBe('joined')
  })
  it('settles the durable full-set reservation, not a larger or subsequently changed policy ceiling', () => {
    reserve()
    const claimed = dispatch()
    workerClaim(claimed.dispatch)
    recordDispatch(claimed, { status: 'accepted', providerCallId: 'sb-test' })
    expect(command.policy.maxJobLiabilityMicroUsd).toBe(6000)
    expect(reservedAmount(claimed)).toBe(5500)
    expect(() => reservedAmount({ ...claimed, claimToken: randomUUID() })).toThrow()
    run(
      "update public.render_library_approvals set enabled=false,policy=jsonb_set(policy,'{maxJobLiabilityMicroUsd}','18000');",
    )
    expect(reservedAmount(claimed)).toBe(5500)
    const evidence = terminalEvidence(claimed.dispatch.dispatchId)
    expect(() =>
      rpc('render_library_reconcile_terminal', [
        quote(claimed.dispatch.jobId),
        encoded(evidence),
        '6000',
      ]),
    ).toThrow()
    expect(ledger().reserved_micro_usd).toBe(5500)
    for (let i = 0; i < 2; i++) {
      expect(
        rpc('render_library_reconcile_terminal', [
          quote(claimed.dispatch.jobId),
          encoded(evidence),
          String(reservedAmount(claimed)),
        ]).retrySafe,
      ).toBe(true)
    }
    expect(ledger().reserved_micro_usd).toBe(0)
    expect(ledger().charged_micro_usd).toBe(5500)
  })
  it('resolves uncertain dispatch exactly once with its fence and never changes provider or downgrades', () => {
    reserve()
    const claimed = dispatch()
    workerClaim(claimed.dispatch)
    const uncertain = workerFixture.uncertain
    recordDispatch(claimed, uncertain)
    recordDispatch(claimed, uncertain)
    expect(() => recordDispatch(claimed, { status: 'definitely-not-submitted' })).toThrow()
    const accepted = { status: 'accepted', providerCallId: 'sb-test' }
    expect(() => recordDispatch({ ...claimed, claimToken: randomUUID() }, accepted)).toThrow()
    expect(() => recordDispatch(claimed, { ...accepted, providerCallId: '' })).toThrow()
    expect(ledger().reserved_micro_usd).toBe(5500)
    recordDispatch(claimed, accepted)
    recordDispatch(claimed, accepted)
    expect(snapshot(command.identity).job?.stage).toBe('preparing')
    for (const invalid of [
      uncertain,
      { status: 'definitely-not-submitted' },
      { ...accepted, providerCallId: 'sb-another' },
    ]) {
      expect(() => recordDispatch(claimed, invalid)).toThrow()
    }
    expect(dispatch()).toBeNull()
    expect(
      rpc('render_library_claim_worker', [
        encoded(claimed.dispatch),
        quote(registration.workerBuildSha256),
      ]),
    ).toBeNull()
    expect(ledger().reserved_micro_usd).toBe(5500)
    const evidence = terminalEvidence(claimed.dispatch.dispatchId)
    expect(() =>
      rpc('render_library_reconcile_terminal', [
        quote(claimed.dispatch.jobId),
        encoded({ ...evidence, providerCallId: 'sb-another' }),
        '5500',
      ]),
    ).toThrow()
    expect(
      rpc('render_library_reconcile_terminal', [
        quote(claimed.dispatch.jobId),
        encoded(evidence),
        String(reservedAmount(claimed)),
      ]).retrySafe,
    ).toBe(true)
    recordDispatch(claimed, accepted)
    expect(() => recordDispatch(claimed, uncertain)).toThrow()
    expect(ledger().reserved_micro_usd).toBe(0)
  })
  it('prioritizes selected camera and fences duplicate/out-of-order progress', () => {
    command.request.design.presentation.cameraRef = 'entry-draft@1'
    reserve()
    const claimed = dispatch()
    const work = workerClaim(claimed.dispatch)
    expect(work.views[0].cameraRef).toBe('entry-draft@1')
    recordDispatch(claimed, { status: 'accepted', providerCallId: 'sb-test' })
    const event = {
      contractVersion: 'fury.render-library@1',
      kind: 'progress',
      jobId: work.jobId,
      attemptId: work.attemptId,
      fence: work.fence,
      eventId: randomUUID(),
      sequence: 2,
      cameraRef: work.views[0].cameraRef,
      stage: 'rendering',
    }
    expect(rpc('render_library_record_event', [encoded(event)]).accepted).toBe(true)
    expect(rpc('render_library_record_event', [encoded(event)]).accepted).toBe(true)
    expect(() =>
      rpc('render_library_record_event', [encoded({ ...event, stage: 'saving' })]),
    ).toThrow()
    expect(
      rpc('render_library_record_event', [
        encoded({ ...event, sequence: 1, eventId: randomUUID() }),
      ]).accepted,
    ).toBe(false)
    expect(
      rpc('render_library_record_event', [
        encoded({ ...event, fence: 10, sequence: 3, eventId: randomUUID() }),
      ]).accepted,
    ).toBe(false)
    expect(snapshot(command.identity).job?.stage).toBe('rendering')
    const terminal = {
      contractVersion: 'fury.render-library@1',
      kind: 'terminal',
      jobId: work.jobId,
      attemptId: work.attemptId,
      fence: work.fence,
      eventId: randomUUID(),
      sequence: 3,
      outcome: 'complete',
      error: null,
    }
    expect(rpc('render_library_record_event', [encoded(terminal)]).accepted).toBe(false)
  })
  it('requires independent terminal evidence and retains partial images during safe explicit retry', () => {
    reserve()
    const claimed = dispatch()
    const work = workerClaim(claimed.dispatch)
    recordDispatch(claimed, { status: 'accepted', providerCallId: 'sb-test' })
    const view = work.views[0]
    // SQL tests use explicit synthetic metadata; real byte validation is covered separately.
    const receipt = {
      ...workerFixture.receipt,
      jobId: work.jobId,
      attemptId: work.attemptId,
      imageKey: view.imageKey,
      design: {
        ...work.design,
        presentation: { ...work.design.presentation, cameraRef: view.cameraRef },
      },
      workerBuildSha256: work.workerBuildSha256,
      recipeBundleSha256: work.recipeBundleSha256,
    }
    const receiptSha256 = checksum(canonicalJson(receipt))
    const image = imageDescriptorSchema.parse({
      contractVersion: 'fury.render-library@1',
      setKey: work.identity.setKey,
      imageKey: view.imageKey,
      design: receipt.design,
      recipeRelease: work.identity.recipeRelease,
      url: `https://test.supabase.co/storage/v1/object/public/render-library/${work.identity.setKey}/${view.imageKey}/${receipt.sha256}.webp`,
      sha256: receipt.sha256,
      bytes: receipt.bytes,
      width: receipt.width,
      height: receipt.height,
      mime: 'image/webp',
      samples: 1024,
      adaptiveSampling: false,
      quality: 95,
      provenance: {
        kind: 'native-worker',
        jobId: work.jobId,
        attemptId: work.attemptId,
        workerBuildSha256: work.workerBuildSha256,
        recipeBundleSha256: work.recipeBundleSha256,
        receiptSha256,
      },
      productionAllowed: false,
      visuallyQualified: false,
      strictReference: false,
      engineeringApproved: false,
    })
    const artifact = { receipt, receiptSha256, image }
    const event = {
      contractVersion: 'fury.render-library@1',
      kind: 'artifact',
      jobId: work.jobId,
      attemptId: work.attemptId,
      fence: work.fence,
      eventId: randomUUID(),
      sequence: 1,
      receipt,
    }
    expect(rpc('render_library_prepare_artifact', [encoded(event)]).accepted).toBe(true)
    expect(
      rpc('render_library_publish_asset', [
        quote(work.jobId),
        quote(work.attemptId),
        String(work.fence),
        encoded(artifact),
      ]).published,
    ).toBe(true)
    expect(
      rpc('render_library_publish_asset', [
        quote(work.jobId),
        quote(work.attemptId),
        String(work.fence),
        encoded(artifact),
      ]).published,
    ).toBe(true)
    expect(() =>
      rpc('render_library_publish_asset', [
        quote(work.jobId),
        quote(work.attemptId),
        String(work.fence),
        encoded({ ...artifact, receipt: { ...receipt, quality: 90 } }),
      ]),
    ).toThrow()
    const terminal = {
      contractVersion: 'fury.render-library@1',
      kind: 'terminal',
      jobId: work.jobId,
      attemptId: work.attemptId,
      fence: work.fence,
      eventId: randomUUID(),
      sequence: 2,
      outcome: 'failed',
      error: null,
    }
    run(
      `update public.render_library_jobs set deadline_at=now()-interval '1 second' where id=${quote(work.jobId)};`,
    )
    expect(rpc('render_library_record_event', [encoded(event)]).accepted).toBe(true)
    expect(rpc('render_library_prepare_artifact', [encoded(event)]).accepted).toBe(true)
    expect(
      rpc('render_library_prepare_artifact', [
        encoded({ ...event, eventId: randomUUID(), sequence: 2 }),
      ]).accepted,
    ).toBe(false)
    expect(snapshot(command.identity).views.filter((view) => view.status === 'ready')).toHaveLength(
      1,
    )
    expect(rpc('render_library_record_event', [encoded(terminal)]).accepted).toBe(true)
    expect(ledger().reserved_micro_usd).toBe(5500)
    const retry = {
      contractVersion: 'fury.render-library@1',
      intent: 'retry-failed-missing',
      idempotencyKey: randomUUID(),
    }
    expect(
      rpc('render_library_retry_failed', [
        quote(work.jobId),
        encoded(retry),
        encoded(command.context),
        encoded(command.policy),
      ]).error.code,
    ).toBe('unsafe-retry')
    expect(() =>
      rpc('render_library_reconcile_terminal', [
        quote(work.jobId),
        encoded({ kind: 'never-submitted', dispatchId: work.dispatchId }),
        '0',
      ]),
    ).toThrow()
    const evidence = {
      kind: 'provider-terminal',
      dispatchId: work.dispatchId,
      providerCallId: 'sb-test',
      observedAt: new Date().toISOString(),
      evidenceSha256: '7'.repeat(64),
    }
    expect(() =>
      rpc('render_library_reconcile_terminal', [
        quote(work.jobId),
        encoded({ ...evidence, evidenceSha256: null }),
        '1300',
      ]),
    ).toThrow()
    expect(
      rpc('render_library_reconcile_terminal', [quote(work.jobId), encoded(evidence), '1300'])
        .retrySafe,
    ).toBe(true)
    expect(ledger().reserved_micro_usd).toBe(0)
    expect(ledger().charged_micro_usd).toBe(1300)
    const retried = rpc('render_library_retry_failed', [
      quote(work.jobId),
      encoded(retry),
      encoded(command.context),
      encoded(command.policy),
    ])
    expect(retried.status).toBe('admitted')
    expect(retried.snapshot.job.completedImages).toBe(1)
    expect(ledger().reserved_micro_usd).toBe(4500)
    const partial = dispatch()
    expect(workerClaim(partial.dispatch).views).toHaveLength(4)
    const replay = rpc('render_library_retry_failed', [
      quote(work.jobId),
      encoded(retry),
      encoded(command.context),
      encoded(command.policy),
    ])
    expect(replay.snapshot.job.id).toBe(retried.snapshot.job.id)
    recordDispatch(partial, { status: 'accepted', providerCallId: 'sb-test' })
    expect(reservedAmount(partial)).toBe(4500)
    const partialEvidence = terminalEvidence(partial.dispatch.dispatchId)
    expect(() =>
      rpc('render_library_reconcile_terminal', [
        quote(partial.dispatch.jobId),
        encoded(partialEvidence),
        '5500',
      ]),
    ).toThrow()
    expect(ledger().reserved_micro_usd).toBe(4500)
    expect(
      rpc('render_library_reconcile_terminal', [
        quote(partial.dispatch.jobId),
        encoded(partialEvidence),
        String(reservedAmount(partial)),
      ]).retrySafe,
    ).toBe(true)
    expect(ledger().reserved_micro_usd).toBe(0)
    expect(ledger().charged_micro_usd).toBe(5800)
    expect(
      snapshot(command.identity)
        .views.filter((view) => view.status === 'ready')
        .map((view) => view.image),
    ).toEqual([image])
    expect(rpc('render_library_record_event', [encoded(event)]).accepted).toBe(true)
  })
  it('denies anon/authenticated reads and writes and grants only privileged RPCs', () => {
    expect(
      run(
        "select proargnames::text from pg_proc where pronamespace='public'::regnamespace and proname='render_library_claim_dispatch';",
      ),
    ).toBe('{dispatcherId,lane,workerBuildSha256}')
    expect(
      run(
        "select proargnames::text from pg_proc where pronamespace='public'::regnamespace and proname='render_library_record_dispatch';",
      ),
    ).toBe('{dispatchId,claimToken,result}')
    expect(
      run(
        "select proargnames::text from pg_proc where pronamespace='public'::regnamespace and proname='render_library_reconcile_terminal';",
      ),
    ).toBe('{jobId,evidence,chargedMicroUsd}')
    expect(
      run(
        "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'render_library_%' and not c.relrowsecurity;",
      ),
    ).toBe('0')
    for (const role of ['anon', 'authenticated']) {
      expect(
        run(
          `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'render_library_%' and has_table_privilege(${quote(role)},c.oid,'SELECT,INSERT,UPDATE,DELETE');`,
        ),
      ).toBe('0')
      expect(
        run(
          `select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'render_library_%' and has_function_privilege(${quote(role)},p.oid,'EXECUTE');`,
        ),
      ).toBe('0')
    }
    expect(
      run(
        "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege where n.nspname='public' and c.relkind='r' and c.relname like 'render_library_%' and c.relname<>'render_library_worker_builds' and not has_table_privilege('service_role',c.oid,privilege);",
      ),
    ).toBe('0')
    expect(
      run(
        "select has_table_privilege('service_role','public.render_library_worker_builds','SELECT') and has_table_privilege('service_role','public.render_library_worker_builds','INSERT') and not has_table_privilege('service_role','public.render_library_worker_builds','UPDATE,DELETE,TRUNCATE');",
      ),
    ).toBe('t')
    expect(
      run(
        "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'render_library_%' and not has_function_privilege('service_role',p.oid,'EXECUTE');",
      ),
    ).toBe('0')
    expect(() => run('set role anon; select * from public.render_library_jobs;')).toThrow()
    expect(() =>
      run(`set role authenticated; select public.render_library_reserve_set(${encoded(command)});`),
    ).toThrow()
    expect(
      run(
        `set role service_role; select public.render_library_snapshot(${encoded(command.identity)})->>'coverage';`,
      ),
    ).toBe('missing')
    expect(() => run("update public.render_library_recipes set registration='{}';")).toThrow()
  })
  it('installs restrictive Storage policies that fence preexisting permissive policies', () => {
    // A minimal storage schema tests PostgreSQL policy semantics, not Supabase HTTP behavior.
    run(`drop schema if exists storage cascade; create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon,authenticated,service_role;
      grant all on storage.objects to anon,authenticated,service_role;
      create policy project_wide_permissive on storage.objects for all to anon,authenticated using(true) with check(true);`)
    run(readFileSync('supabase/migrations/202610190002_render_library_storage.sql', 'utf8'))
    run(
      "insert into storage.objects(bucket_id,name) values('render-library','public.webp'),('render-library-staging','private.webp'),('unrelated','ok.txt');",
    )
    expect(() =>
      run(
        "set role anon; insert into storage.objects(bucket_id,name) values('render-library','bad.webp');",
      ),
    ).toThrow()
    expect(() =>
      run(
        "set role authenticated; insert into storage.objects(bucket_id,name) values('render-library-staging','bad.webp');",
      ),
    ).toThrow()
    expect(
      run(
        "set role anon; select count(*) from storage.objects where bucket_id='render-library-staging';",
      ),
    ).toBe('0')
    run(
      "set role authenticated; update storage.objects set name='bad' where bucket_id='render-library'; delete from storage.objects where bucket_id='render-library';",
    )
    expect(run("select name from storage.objects where bucket_id='render-library';")).toBe(
      'public.webp',
    )
    expect(run('set role service_role; select count(*) from storage.objects;')).toBe('3')
  })
})
