import { describe, expect, it, vi } from 'vitest'
import { createMockArtifact } from '../protocol'
import { SafeImageService } from './service'
import {
  bindRequestSync,
  ControlError,
  DEFAULT_POLICY,
  describeArtifact,
  diagnosticBytes,
  exportRequestFixture,
  imageRequestFixture,
  worstCaseQuote,
  type AuthContext,
  type InterestView,
  type JobRecord,
  type Ledger,
  type LedgerSnapshot,
  type ObjectStore,
  type Purpose,
} from './contracts'

const auth: AuthContext = {
  principalId: 'principal-service-01',
  experimentId: 'experiment-service1',
  scopes: ['images:read', 'images:write', 'exports:write'],
}
const foreign: AuthContext = { ...auth, principalId: 'principal-service-02' }

async function fixture(purpose: Purpose = 'image') {
  const request = purpose === 'image' ? imageRequestFixture() : exportRequestFixture()
  const binding = bindRequestSync(request.design, purpose, auth)
  const mock = await createMockArtifact(request.design)
  const object = describeArtifact(mock, request.design, binding)
  const bytes = diagnosticBytes(mock)
  let now = 1000
  let killed = false
  let current: InterestView = {
    interest: {
      id: 'interest-service-01',
      jobId: 'job-service-00001',
      principalId: auth.principalId,
      experimentId: auth.experimentId,
      idempotencyKey: request.idempotencyKey,
      cancelled: false,
      createdAt: now,
      expiresAt: 50_000,
    },
    job: {
      id: 'job-service-00001',
      design: request.design,
      binding,
      state: 'queued',
      sponsorPrincipalId: auth.principalId,
      sponsorExperimentId: auth.experimentId,
      quote: worstCaseQuote(),
      fence: 0,
      attempts: 0,
      execution: null,
      leaseUntil: 0,
      deadline: 40_000,
      availableAt: now,
      createdAt: now,
      finishedAt: null,
      reconciliationRequired: false,
      reservedMicro: worstCaseQuote().total,
      spentMicro: 0,
      artifact: null,
      error: null,
    },
  }
  const snapshot = vi.fn((): LedgerSnapshot => ({
    killed,
    killedAt: killed ? now : null,
    killReason: killed ? 'test kill' : null,
    policy: DEFAULT_POLICY,
    global: { id: 'global', spentMicro: 0, reservedMicro: 0, uniqueMisses: 0 },
    experiments: [],
    principals: [],
    jobs: 1,
    interests: 1,
    activeExecutions: [],
    quarantinedExecutions: [],
    streams: [],
    objects: [],
    storageBytes: 0,
    deliveredBytes: 0,
    reservedDeliveryBytes: 0,
  }))
  const getInterest = vi.fn((identity: AuthContext, id: string) => {
    if (
      id !== current.interest.id ||
      identity.principalId !== current.interest.principalId ||
      identity.experimentId !== current.interest.experimentId
    )
      throw new ControlError(404, 'not-found', 'Interest was not found.')
    return current
  })
  const cancelInterest = vi.fn(() => {
    current = { ...current, interest: { ...current.interest, cancelled: true } }
    return current
  })
  const admit = vi.fn<Ledger['admit']>(() => ({ view: current, disposition: 'created' }))
  const recordDelivery = vi.fn<Ledger['recordDelivery']>(() => {
    if (killed) throw new ControlError(503, 'killed', 'Test killed.')
    return current.job.artifact!
  })
  // Intentionally a service-boundary fake, NOT evidence of durable accounting or coalescing.
  // Unused provider/lifecycle methods are absent, so any accidental dispatch fails the test.
  const ledger = {
    policy: DEFAULT_POLICY,
    snapshot,
    getInterest,
    cancelInterest,
    admit,
    recordDelivery,
  } as unknown as Ledger
  const verify = vi.fn(async () => true)
  const read = vi.fn(async () => bytes)
  const objects = { verify, read } as unknown as ObjectStore
  const service = new SafeImageService({ ledger, objects, now: () => now })
  const job = (patch: Partial<JobRecord>) => {
    current = { ...current, job: { ...current.job, ...patch } }
  }
  return {
    service,
    request,
    binding,
    bytes,
    object,
    admit,
    getInterest,
    cancelInterest,
    recordDelivery,
    verify,
    read,
    snapshot,
    job,
    current: () => current,
    ready: () => job({ state: 'ready', artifact: object, finishedAt: now }),
    kill: () => {
      killed = true
    },
    setNow: (at: number) => {
      now = at
    },
    detach: () => {
      current = { ...current, interest: { ...current.interest, cancelled: true } }
    },
    setView: (view: InterestView) => {
      current = view
    },
  }
}

describe('SafeImageService strict private control boundary', () => {
  it('returns 202 queued from atomic admission with canonical binding and worst-case policy quote', async () => {
    const f = await fixture()
    const reply = await f.service.submitImage(auth, f.request)
    expect(reply.status).toBe(202)
    expect(reply.body).toMatchObject({
      state: 'queued',
      interestState: 'active',
      artifact: null,
      productionAllowed: false,
      paidExecutionAllowed: false,
      mode: 'mock-diagnostic',
    })
    expect(f.admit).toHaveBeenCalledExactlyOnceWith({
      auth,
      purpose: 'image',
      request: f.request,
      binding: f.binding,
      quote: worstCaseQuote(DEFAULT_POLICY),
    })
    expect(f.verify).not.toHaveBeenCalled()
  })

  it('verifies a ready hit and preserves exactly the same immutable diagnostic object on replay', async () => {
    const f = await fixture()
    f.ready()
    const first = await f.service.submitImage(auth, f.request)
    const replay = await f.service.submitImage(auth, f.request)
    expect(first.status).toBe(200)
    expect(replay).toEqual(first)
    expect(first.body.artifact).toEqual(f.object)
    expect(f.verify).toHaveBeenCalledTimes(2)
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.recordDelivery).not.toHaveBeenCalled()
  })

  it('freezes separate diagnostic export revision with private principal-and-experiment identity', async () => {
    const f = await fixture('export')
    f.ready()
    const result = await f.service.submitExport(auth, f.request)
    expect(result.status).toBe(200)
    expect(result.body.artifact).toMatchObject({
      strictExport: false,
      approvedCurrentImage: false,
      binding: {
        purpose: 'export',
        visibility: 'private',
        revision: f.binding.identity.requestDigest,
      },
    })
    expect(f.binding.cacheKey).not.toBe(
      bindRequestSync(f.request.design, 'export', foreign).cacheKey,
    )
    expect(f.binding.cacheKey).not.toBe(
      bindRequestSync(f.request.design, 'export', { ...auth, experimentId: 'experiment-service2' })
        .cacheKey,
    )
    expect(f.binding.cacheKey).not.toBe(bindRequestSync(f.request.design, 'image', auth).cacheKey)
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
    'principalId',
    'experimentId',
    'paidExecutionAllowed',
    'outputProfile',
  ])('rejects unknown top-level %s before admission', async (field) => {
    const f = await fixture()
    await expect(
      f.service.submitImage(auth, { ...f.request, [field]: 'untrusted' }),
    ).rejects.toMatchObject({ status: 422 })
    expect(f.admit).not.toHaveBeenCalled()
  })

  it('rejects wrong version, missing presentation, unknown nested fields and output profiles', async () => {
    const f = await fixture()
    const withoutPresentation = {
      config: f.request.design.config,
      outputProfile: f.request.design.outputProfile,
    }
    for (const design of [
      { ...f.request.design, config: { ...f.request.design.config, schemaVersion: 3 } },
      withoutPresentation,
      { ...f.request.design, outputProfile: 'free-form-8k' },
      { ...f.request.design, samples: 4096 },
    ])
      await expect(f.service.submitImage(auth, { ...f.request, design })).rejects.toMatchObject({
        status: 422,
      })
    expect(f.admit).not.toHaveBeenCalled()
  })

  it('does not accept export format on image route or missing/real format on export route', async () => {
    const f = await fixture()
    await expect(f.service.submitImage(auth, exportRequestFixture())).rejects.toMatchObject({
      status: 422,
    })
    await expect(f.service.submitExport(auth, f.request)).rejects.toMatchObject({ status: 422 })
    await expect(
      f.service.submitExport(auth, { ...exportRequestFixture(), format: 'pdf' }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it('requires explicit scope on each entrypoint and never trusts malformed body auth', async () => {
    const f = await fixture()
    const readOnly: AuthContext = { ...auth, scopes: ['images:read'] }
    await expect(f.service.submitImage(readOnly, f.request)).rejects.toMatchObject({ status: 403 })
    await expect(f.service.submitExport(readOnly, exportRequestFixture())).rejects.toMatchObject({
      status: 403,
    })
    await expect(f.service.cancel(readOnly, f.current().interest.id)).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      f.service.status({ ...auth, scopes: ['images:write'] }, f.current().interest.id),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      f.service.artifact({ ...auth, scopes: ['images:write'] }, f.current().interest.id),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      f.service.submitImage(null as unknown as AuthContext, f.request),
    ).rejects.toMatchObject({ status: 401 })
    expect(f.admit).not.toHaveBeenCalled()
  })

  it('returns 404 for another principal/experiment and malformed interest IDs', async () => {
    const f = await fixture()
    for (const identity of [foreign, { ...auth, experimentId: 'experiment-service2' }]) {
      await expect(f.service.status(identity, f.current().interest.id)).rejects.toMatchObject({
        status: 404,
      })
      await expect(f.service.cancel(identity, f.current().interest.id)).rejects.toMatchObject({
        status: 404,
      })
      await expect(f.service.artifact(identity, f.current().interest.id)).rejects.toMatchObject({
        status: 404,
      })
    }
    await expect(f.service.status(auth, '../outside')).rejects.toMatchObject({ status: 404 })
  })

  it('defends ownership even if a broken ledger returns a foreign interest', async () => {
    const f = await fixture()
    f.getInterest.mockImplementation(() => f.current())
    await expect(f.service.status(foreign, f.current().interest.id)).rejects.toMatchObject({
      status: 404,
    })
  })

  it('cancels only interest; unknown shared execution remains rendering and reconciliation required', async () => {
    const f = await fixture()
    f.job({ state: 'rendering', reconciliationRequired: true })
    const result = await f.service.cancel(auth, f.current().interest.id)
    expect(result).toMatchObject({
      state: 'rendering',
      interestState: 'cancelled',
      reconciliationRequired: true,
      cancellationScope: 'interest-only',
      sharedWorkCancelled: false,
      artifact: null,
    })
    expect(await f.service.cancel(auth, f.current().interest.id)).toEqual(result)
    await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({ status: 410 })
  })

  it('uses export-write, not image-write, to detach an export', async () => {
    const f = await fixture('export')
    await expect(
      f.service.cancel({ ...auth, scopes: ['images:write'] }, f.current().interest.id),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      (await f.service.cancel({ ...auth, scopes: ['exports:write'] }, f.current().interest.id))
        .interestState,
    ).toBe('cancelled')
  })

  it('does not resurrect expired interest, and hides its ready artifact', async () => {
    const f = await fixture()
    f.ready()
    f.setNow(50_000)
    expect(await f.service.status(auth, f.current().interest.id)).toMatchObject({
      state: 'ready',
      interestState: 'expired',
      artifact: null,
    })
    await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({ status: 410 })
    await expect(f.service.artifact(auth, f.current().interest.id)).rejects.toMatchObject({
      status: 410,
    })
    expect(f.read).not.toHaveBeenCalled()
  })

  it.each([
    [429, 'budget-exceeded'],
    [429, 'capacity-exceeded'],
    [503, 'store-unavailable'],
    [503, 'killed'],
    [409, 'idempotency-conflict'],
  ] as const)(
    'preserves truthful admission failure %s/%s without dispatch',
    async (status, code) => {
      const f = await fixture()
      f.admit.mockImplementation(() => {
        throw new ControlError(status, code, 'Controlled failure.')
      })
      await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({ status, code })
      expect(f.read).not.toHaveBeenCalled()
    },
  )

  it('fails closed on arbitrary ledger and object errors without exposing their messages', async () => {
    const f = await fixture()
    f.snapshot.mockImplementation(() => {
      throw new Error('sensitive /filesystem/path')
    })
    await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({
      status: 503,
      code: 'store-unavailable',
    })
    await expect(f.service.submitImage(auth, f.request)).rejects.not.toThrow('sensitive')
    const other = await fixture()
    other.ready()
    other.read.mockRejectedValue(new Error('sensitive object details'))
    await expect(other.service.status(auth, other.current().interest.id)).rejects.toMatchObject({
      status: 503,
      code: 'store-unavailable',
    })
  })

  it.each(['failed', 'cancelled', 'expired'] as const)(
    'does not mislabel terminal job %s as accepted work',
    async (state) => {
      const f = await fixture()
      f.job({ state })
      await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({
        status: state === 'failed' ? 503 : 410,
      })
    },
  )

  it('exposes unresolved execution in status but never as a successful submission', async () => {
    const f = await fixture()
    f.job({ state: 'rendering', reconciliationRequired: true })
    expect((await f.service.status(auth, f.current().interest.id)).reconciliationRequired).toBe(
      true,
    )
    await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({
      status: 503,
      code: 'reconciliation-required',
    })
  })

  it('rejects ready metadata for a different bound request and does not access its objects', async () => {
    const f = await fixture()
    f.ready()
    f.job({ artifact: { ...f.object, width: f.object.width - 1 } })
    await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({
      status: 503,
      code: 'identity-mismatch',
    })
    expect(f.verify).not.toHaveBeenCalled()
  })

  it('rejects private export binding from another principal', async () => {
    const f = await fixture('export')
    f.job({ binding: bindRequestSync(f.request.design, 'export', foreign) })
    await expect(f.service.status(auth, f.current().interest.id)).rejects.toMatchObject({
      status: 503,
      code: 'identity-mismatch',
    })
  })

  it('rejects missing/corrupt publication before 200 or byte delivery', async () => {
    const f = await fixture()
    f.ready()
    f.verify.mockResolvedValue(false)
    await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({
      status: 503,
      code: 'publication-failed',
    })
    expect(f.read).not.toHaveBeenCalled()
    f.verify.mockResolvedValue(true)
    const corrupt = f.bytes.slice()
    corrupt[0] ^= 1
    f.read.mockResolvedValue(corrupt)
    await expect(f.service.status(auth, f.current().interest.id)).rejects.toMatchObject({
      status: 503,
      code: 'publication-failed',
    })
    await expect(f.service.artifact(auth, f.current().interest.id)).rejects.toMatchObject({
      status: 503,
      code: 'publication-failed',
    })
    expect(f.recordDelivery).not.toHaveBeenCalled()
  })

  it('records actual byte delivery only after verification and checksum-read', async () => {
    const f = await fixture('export')
    f.ready()
    const delivered = await f.service.artifact(auth, f.current().interest.id)
    expect(delivered).toEqual({ object: f.object, bytes: f.bytes })
    expect(f.recordDelivery).toHaveBeenCalledExactlyOnceWith(
      auth,
      f.current().interest.id,
      f.bytes.byteLength,
    )
    expect(f.read.mock.invocationCallOrder[0]).toBeLessThan(
      f.recordDelivery.mock.invocationCallOrder[0],
    )
  })

  it.each(['kill', 'detach', 'expire', 'change-artifact'] as const)(
    'rechecks %s after awaited object read',
    async (race) => {
      const f = await fixture()
      f.ready()
      f.read.mockImplementation(async () => {
        if (race === 'kill') f.kill()
        if (race === 'detach') f.detach()
        if (race === 'expire') f.setNow(50_000)
        if (race === 'change-artifact') f.job({ artifact: { ...f.object, width: 1 } })
        return f.bytes
      })
      await expect(f.service.artifact(auth, f.current().interest.id)).rejects.toMatchObject({
        status: ['detach', 'expire'].includes(race) ? 410 : 503,
      })
      expect(f.recordDelivery).not.toHaveBeenCalled()
    },
  )

  it('does not report a ready hit when killed during verification', async () => {
    const f = await fixture()
    f.ready()
    f.verify.mockImplementation(async () => {
      f.kill()
      return true
    })
    await expect(f.service.submitImage(auth, f.request)).rejects.toMatchObject({
      status: 503,
      code: 'killed',
    })
  })

  it('preserves delivery-cap denial and rejects a mismatched final delivery identity', async () => {
    const f = await fixture()
    f.ready()
    f.recordDelivery.mockImplementation(() => {
      throw new ControlError(429, 'capacity-exceeded', 'Byte cap reached.')
    })
    await expect(f.service.artifact(auth, f.current().interest.id)).rejects.toMatchObject({
      status: 429,
    })
    f.recordDelivery.mockReturnValue({ ...f.object, width: 1 })
    await expect(f.service.artifact(auth, f.current().interest.id)).rejects.toMatchObject({
      status: 503,
      code: 'identity-mismatch',
    })
  })
})
