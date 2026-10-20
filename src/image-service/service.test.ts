// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDesign } from '../domain/design'
import { createImageRequest, createMockArtifact, parseImageReply } from './protocol'
import { FakeRenderer } from './fakeRenderer'
import { MockImageService } from './service'
import { MockJobStore, type MockPolicy } from './store'

const alice = 'a'.repeat(32)
const bob = 'b'.repeat(32)
const roots: string[] = []
const stores: MockJobStore[] = []
function fixture(policy: Partial<MockPolicy> = {}, renderer = new FakeRenderer()) {
  const directory = mkdtempSync(join(tmpdir(), 'fury-mock-service-'))
  roots.push(directory)
  const path = join(directory, 'jobs.sqlite')
  let time = 1000
  const now = () => time
  const open = () => {
    const store = new MockJobStore({ path, now, policy })
    stores.push(store)
    return store
  }
  const store = open()
  const service = new MockImageService({ store, now, renderer })
  return {
    path,
    store,
    service,
    renderer,
    now,
    open,
    advance: (ms: number) => {
      time += ms
    },
  }
}
function alternate() {
  const design = defaultDesign()
  return {
    ...design,
    config: { ...design.config, appearance: { ...design.config.appearance, accent: true } },
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable CPU-only diagnostic jobs', () => {
  it('coalesces simultaneous duplicates across independent instances, reserves once and survives restart', async () => {
    const f = fixture()
    const otherStore = f.open()
    const other = new MockImageService({ store: otherStore, now: f.now })
    const request = createImageRequest(defaultDesign(), 'first-idempotency-key')
    const [one, two, repeated] = await Promise.all([
      f.service.submit(alice, request),
      other.submit(bob, request),
      f.service.submit(alice, request),
    ])
    expect(one.status).toBe(202)
    expect(one.body.interestId).toBe(repeated.body.interestId)
    expect(two.body.interestId).not.toBe(one.body.interestId)
    expect(f.store.inspect()).toMatchObject({ jobs: 1, interests: 2, reserved: 2, spent: 0 })
    const secret = f.store.principalSecret()
    f.service.close()
    other.close()
    const reopened = f.open()
    expect(reopened.principalSecret()).toBe(secret)
    const resumed = new MockImageService({ store: reopened, now: f.now })
    expect(await resumed.runOnce()).toBe(1)
    const ready = await resumed.status(alice, one.body.interestId)
    expect(ready.state).toBe('ready')
    await expect(
      parseImageReply(ready, defaultDesign(), one.body.interestId),
    ).resolves.toMatchObject({
      state: 'ready',
      artifact: { exactMatch: false, approvedCurrentImage: false },
    })
    expect(reopened.inspect()).toMatchObject({ jobs: 1, reserved: 0, spent: 1 })
    expect((await resumed.submit(alice, createImageRequest(defaultDesign()))).status).toBe(200)
    expect(await resumed.runOnce()).toBe(0)
  })

  it('binds idempotency to principal AND request; does not let callers attach to another interest', async () => {
    const f = fixture()
    const request = createImageRequest(defaultDesign(), 'same-idempotency-key')
    const one = await f.service.submit(alice, request)
    await expect(
      f.service.submit(alice, createImageRequest(alternate(), request.idempotencyKey)),
    ).rejects.toMatchObject({ code: 'idempotency-conflict', status: 409 })
    await expect(
      f.service.submit(bob, createImageRequest(alternate(), request.idempotencyKey)),
    ).resolves.toHaveProperty('status', 202)
    await expect(f.service.status(bob, one.body.interestId)).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(f.service.detach(bob, one.body.interestId)).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('detaches one owner idempotently without cancelling shared work', async () => {
    const f = fixture()
    const a = await f.service.submit(
      alice,
      createImageRequest(defaultDesign(), 'detach-idempotency'),
    )
    const b = await f.service.submit(bob, createImageRequest(defaultDesign()))
    expect(await f.service.detach(alice, a.body.interestId)).toMatchObject({
      state: 'cancelled',
      cancellationScope: 'interest-only',
      sharedWorkCancelled: false,
    })
    expect(await f.service.detach(alice, a.body.interestId)).toMatchObject({ state: 'cancelled' })
    await f.service.runOnce()
    expect((await f.service.status(bob, b.body.interestId)).state).toBe('ready')
    expect((await f.service.status(alice, a.body.interestId)).state).toBe('cancelled')
    await expect(
      f.service.submit(alice, createImageRequest(defaultDesign(), 'detach-idempotency')),
    ).rejects.toMatchObject({ code: 'expired' })
  })

  it.each([
    { unexpected: true },
    { protocolVersion: 2 },
    { artifactUrl: 'http://169.254.169.254/' },
    { callback: 'https://example.invalid' },
    { samples: 1024 },
    { principal: bob },
    { requestDigest: 'sha256:' + 'a'.repeat(64) },
  ])('rejects malformed, future and injected root fields %j', async (extra) => {
    const f = fixture()
    await expect(
      f.service.submit(alice, { ...createImageRequest(defaultDesign()), ...extra }),
    ).rejects.toMatchObject({ code: 'invalid-request' })
    expect(f.store.inspect()).toMatchObject({ jobs: 0, spent: 0, reserved: 0 })
  })

  it('rejects future and injected nested designs without normalizing away evidence', async () => {
    const f = fixture()
    const request = createImageRequest(defaultDesign())
    for (const config of [
      { ...request.design.config, schemaVersion: 5 },
      { ...request.design.config, equipment: [{ x: 10 }] },
    ]) {
      await expect(
        f.service.submit(alice, { ...request, design: { ...request.design, config } }),
      ).rejects.toMatchObject({ code: 'invalid-request' })
    }
  })

  it('snapshots input before asynchronous hashing', async () => {
    const f = fixture()
    const input = createImageRequest(defaultDesign())
    const pending = f.service.submit(alice, input)
    input.design.config.appearance.accent = true
    const result = await pending
    await expect(parseImageReply(result.body, defaultDesign())).resolves.toMatchObject({
      state: 'queued',
    })
  })

  it('rejects expired-worker late publication and holds liability until explicit stopped-mock reconciliation', async () => {
    const renderer = new FakeRenderer({ held: true })
    const f = fixture({ leaseMs: 100, maxConcurrency: 1, retryDelayMs: 0 }, renderer)
    const submitted = await f.service.submit(alice, createImageRequest(defaultDesign()))
    const oldWorker = f.service.runOnce()
    expect(renderer.pending).toBe(1)
    f.advance(101)
    expect((await f.service.status(alice, submitted.body.interestId)).state).toBe('failed')
    expect(f.store.inspect()).toMatchObject({ uncertain: 1, reserved: 2, spent: 0 })
    expect(await f.service.runOnce()).toBe(0)
    renderer.releaseNext()
    await oldWorker
    expect((await f.service.status(alice, submitted.body.interestId)).state).toBe('failed')
    const uncertain = f.store.uncertainAttempts()[0]
    expect(
      f.store.reconcileStoppedMock(uncertain.jobId, uncertain.fence - 1, {
        confirmedStopped: true,
      }),
    ).toBe(false)
    expect(
      f.store.reconcileStoppedMock(uncertain.jobId, uncertain.fence, { confirmedStopped: true }),
    ).toBe(true)
    expect(f.store.inspect()).toMatchObject({ reserved: 1, spent: 1, uncertain: 0 })
    const replacement = f.service.runOnce()
    renderer.releaseNext()
    await replacement
    expect((await f.service.status(alice, submitted.body.interestId)).state).toBe('ready')
    expect(f.store.inspect()).toMatchObject({ reserved: 0, spent: 2 })
  })

  it('fences duplicate completions and caps lease renewal at the original job deadline', async () => {
    const f = fixture({ leaseMs: 100, jobTtlMs: 250, retryDelayMs: 0 })
    await f.service.submit(alice, createImageRequest(defaultDesign()))
    const lease = f.store.claim()!
    expect(lease.deadline).toBe(1100)
    f.advance(90)
    expect(f.store.renew(lease)).toBe(1190)
    expect(f.store.renew({ ...lease, fence: lease.fence - 1 })).toBeNull()
    f.advance(90)
    expect(f.store.renew(lease)).toBe(1250)
    f.advance(70)
    expect(f.store.renew(lease)).toBeNull()
    const artifact = await createMockArtifact(lease.design)
    expect(f.store.publishVerified(lease, artifact)).toBe(false)
    const unknown = f.store.uncertainAttempts()[0]
    f.store.reconcileStoppedMock(unknown.jobId, unknown.fence, { confirmedStopped: true })
    expect(f.store.publishVerified(lease, artifact)).toBe(false)
    expect(f.store.inspect()).toMatchObject({ spent: 1, reserved: 0 })
  })

  it('enforces global concurrency and retained unique-job capacity across two instances', async () => {
    const renderer = new FakeRenderer({ held: true })
    const f = fixture({ maxConcurrency: 1, maxJobs: 2 }, renderer)
    await f.service.submit(alice, createImageRequest(defaultDesign()))
    await f.service.submit(bob, createImageRequest(alternate()))
    const extra = createImageRequest(defaultDesign())
    extra.design.presentation.aspect = 'tall'
    await expect(f.service.submit(alice, extra)).rejects.toMatchObject({
      code: 'capacity-exceeded',
    })
    const first = f.service.runOnce()
    const other = new MockImageService({ store: f.open(), now: f.now })
    expect(await other.runOnce()).toBe(0)
    expect(renderer.pending).toBe(1)
    renderer.releaseNext()
    await first
    expect(await other.runOnce()).toBe(1)
    expect(f.store.inspect()).toMatchObject({ jobs: 2, spent: 2, reserved: 0 })
  })

  it('persists in-flight unknown reservations across process-style restart', async () => {
    const f = fixture({ leaseMs: 100, retryDelayMs: 0 }, new FakeRenderer({ held: true }))
    const submitted = await f.service.submit(alice, createImageRequest(defaultDesign()))
    const pending = f.service.runOnce()
    f.service.close()
    const reopened = f.open()
    f.advance(101)
    expect(reopened.inspect()).toMatchObject({ uncertain: 1, reserved: 2 })
    f.renderer.releaseNext()
    await pending
    const resumed = new MockImageService({ store: reopened, now: f.now })
    expect((await resumed.status(alice, submitted.body.interestId)).state).toBe('failed')
    const unknown = reopened.uncertainAttempts()[0]
    reopened.reconcileStoppedMock(unknown.jobId, unknown.fence, { confirmedStopped: true })
    await resumed.runOnce()
    expect((await resumed.status(alice, submitted.body.interestId)).state).toBe('ready')
  })

  it('reserves worst-case retry units up front, charges known failures and cannot retry past its cap', async () => {
    const renderer = new FakeRenderer({ outcomes: ['known-failure', 'known-failure'] })
    const f = fixture({ maxWorkUnits: 2, maxPrincipalWorkUnits: 2, retryDelayMs: 10 }, renderer)
    const first = await f.service.submit(alice, createImageRequest(defaultDesign()))
    await expect(f.service.submit(bob, createImageRequest(alternate()))).rejects.toMatchObject({
      code: 'capacity-exceeded',
    })
    await f.service.runOnce()
    expect(f.store.inspect()).toMatchObject({ spent: 1, reserved: 1 })
    expect(await f.service.runOnce()).toBe(0)
    f.advance(10)
    await f.service.runOnce()
    expect((await f.service.status(alice, first.body.interestId)).state).toBe('failed')
    expect(f.store.inspect()).toMatchObject({ spent: 2, reserved: 0 })
    expect(await f.service.runOnce()).toBe(0)
    await expect(f.service.submit(bob, createImageRequest(alternate()))).rejects.toMatchObject({
      code: 'capacity-exceeded',
    })
    expect(renderer.calls).toBe(2)
  })

  it('charges the admitting sponsor and enforces principal, interest, principal-count and queue bounds', async () => {
    const f = fixture({
      maxPrincipalWorkUnits: 2,
      maxPrincipalInterests: 2,
      maxInterests: 3,
      maxPrincipals: 2,
      maxJobs: 2,
    })
    await f.service.submit(alice, createImageRequest(defaultDesign()))
    await expect(f.service.submit(alice, createImageRequest(alternate()))).rejects.toMatchObject({
      code: 'capacity-exceeded',
    })
    await f.service.submit(bob, createImageRequest(defaultDesign()))
    await expect(
      f.service.submit('c'.repeat(32), createImageRequest(defaultDesign())),
    ).rejects.toMatchObject({ code: 'capacity-exceeded' })
    await f.service.submit(alice, createImageRequest(defaultDesign()))
    await expect(
      f.service.submit(alice, createImageRequest(defaultDesign())),
    ).rejects.toMatchObject({ code: 'capacity-exceeded' })
    await expect(f.service.submit(bob, createImageRequest(defaultDesign()))).rejects.toMatchObject({
      code: 'capacity-exceeded',
    })
    expect(f.store.inspect()).toMatchObject({ jobs: 1, interests: 3, reserved: 2 })
  })

  it('keeps cancelled-interest limits intact and rejects immediate retry without new work', async () => {
    const f = fixture({ maxPrincipalInterests: 1 })
    const first = await f.service.submit(alice, createImageRequest(defaultDesign()))
    await f.service.detach(alice, first.body.interestId)
    const before = f.store.inspect()
    await expect(f.service.submit(alice, createImageRequest(alternate()))).rejects.toMatchObject({
      code: 'capacity-exceeded',
      retryable: false,
      message: expect.stringContaining('Immediate retries are disabled'),
    })
    expect(f.store.inspect()).toEqual(before)
  })
  it('expires queued work, bounds retention, but never cleans away spent budget', async () => {
    const f = fixture({ jobTtlMs: 100, interestTtlMs: 100, retentionMs: 100 })
    const expired = await f.service.submit(alice, createImageRequest(defaultDesign()))
    f.advance(100)
    expect((await f.service.status(alice, expired.body.interestId)).state).toBe('expired')
    expect(f.store.inspect()).toMatchObject({ reserved: 0, spent: 0 })
    f.advance(100)
    expect(f.store.inspect()).toMatchObject({ interests: 0, jobs: 0 })
    await f.service.submit(alice, createImageRequest(defaultDesign()))
    await f.service.runOnce()
    f.advance(200)
    expect(f.store.inspect()).toMatchObject({ interests: 0, jobs: 0, spent: 1 })
  })

  it('keeps unknown-outcome reservations until proven stopped and never publishes wrong artifacts', async () => {
    const f = fixture({}, new FakeRenderer({ outcomes: ['unknown-failure', 'wrong-artifact'] }))
    const unknown = await f.service.submit(alice, createImageRequest(defaultDesign()))
    await f.service.runOnce()
    expect((await f.service.status(alice, unknown.body.interestId)).state).toBe('failed')
    expect(f.store.inspect()).toMatchObject({ uncertain: 1, reserved: 2, spent: 0 })
    const mismatch = await f.service.submit(bob, createImageRequest(alternate()))
    await f.service.runOnce()
    expect(await f.service.status(bob, mismatch.body.interestId)).toMatchObject({
      state: 'failed',
      error: { code: 'identity-mismatch' },
    })
    expect(f.store.inspect()).toMatchObject({ uncertain: 1, reserved: 2, spent: 1 })
  })

  it('fails closed for closed/locked stores and rejects policy or future-schema budget bypass', async () => {
    const f = fixture()
    const locker = new DatabaseSync(f.path)
    locker.exec('BEGIN IMMEDIATE')
    await expect(
      f.service.submit(alice, createImageRequest(defaultDesign())),
    ).rejects.toMatchObject({ code: 'unavailable' })
    locker.exec('ROLLBACK')
    expect(f.store.inspect()).toMatchObject({ jobs: 0, reserved: 0 })
    expect(() => new MockJobStore({ path: f.path, policy: { maxWorkUnits: 999 } })).toThrow()
    locker.exec('PRAGMA user_version=2')
    expect(() => new MockJobStore({ path: f.path })).toThrow()
    locker.close()
    f.store.close()
    await expect(
      f.service.submit(alice, createImageRequest(defaultDesign())),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('retains the entire reservation when artifact publication fails transactionally', async () => {
    const f = fixture()
    const submitted = await f.service.submit(alice, createImageRequest(defaultDesign()))
    const db = new DatabaseSync(f.path)
    db.exec(
      "CREATE TRIGGER deny_ready BEFORE UPDATE ON jobs WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'simulated publication denial'); END;",
    )
    await f.service.runOnce()
    expect(await f.service.status(alice, submitted.body.interestId)).toMatchObject({
      state: 'failed',
      error: { code: 'unavailable' },
    })
    expect(f.store.inspect()).toMatchObject({ uncertain: 1, reserved: 2, spent: 0 })
    db.exec('DROP TRIGGER deny_ready')
    db.close()
  })

  it('rejects tampered stored artifact bytes rather than calling them a matching hit', async () => {
    const f = fixture()
    const submitted = await f.service.submit(alice, createImageRequest(defaultDesign()))
    await f.service.runOnce()
    const db = new DatabaseSync(f.path)
    db.prepare("UPDATE jobs SET artifact=json_set(artifact,'$.width',1)").run()
    db.close()
    await expect(f.service.status(alice, submitted.body.interestId)).rejects.toMatchObject({
      code: 'identity-mismatch',
    })
  })

  it('enforces a persisted kill switch, refunds queued only and blocks racing publication/admission', async () => {
    const renderer = new FakeRenderer({ held: true })
    const f = fixture({ maxConcurrency: 1 }, renderer)
    let stop = false
    const guarded = new MockImageService({
      store: f.store,
      renderer,
      now: f.now,
      stopRequested: () => stop,
    })
    const first = await guarded.submit(alice, createImageRequest(defaultDesign()))
    const running = guarded.runOnce()
    await guarded.submit(bob, createImageRequest(alternate()))
    stop = true
    await expect(guarded.submit(alice, createImageRequest(defaultDesign()))).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(f.store.inspect()).toMatchObject({ killed: true, uncertain: 1, reserved: 2, spent: 0 })
    renderer.releaseNext()
    await running
    expect((await guarded.status(alice, first.body.interestId)).state).toBe('failed')
    const replacement = new MockImageService({ store: f.open(), now: f.now })
    await expect(
      replacement.submit(alice, createImageRequest(defaultDesign())),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('denies shutdown and a kill/store check failure, including a digest admission race', async () => {
    const f = fixture()
    const pending = f.service.submit(alice, createImageRequest(defaultDesign()))
    f.service.shutdown()
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    await expect(f.service.runOnce()).rejects.toMatchObject({ code: 'unavailable' })
    const broken = new MockImageService({
      store: f.store,
      now: f.now,
      stopRequested: () => {
        throw new Error('EACCES')
      },
    })
    await expect(broken.submit(alice, createImageRequest(defaultDesign()))).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(f.store.inspect()).toMatchObject({ jobs: 0, reserved: 0 })
  })
})
