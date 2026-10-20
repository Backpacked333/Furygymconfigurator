import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { defaultDesign, parseDesign } from '../../domain/design'
import { createDesignFixtures } from '../../domain/designFixtures'
import { designIdentity } from '../../domain/designIdentity'
import { createMockArtifact } from '../protocol'
import {
  CONTROL_PROTOCOL,
  DEFAULT_POLICY,
  EXECUTION_POLICY,
  EXPORT_PATH,
  IMAGE_PATH,
  PAID_EXECUTION_ALLOWED,
  PUBLIC_STREAMS_ENABLED,
  artifactDescriptorSchema,
  artifactPath,
  assertTransition,
  authContextSchema,
  bindRequest,
  bindRequestSync,
  canTransition,
  canonicalJson,
  checkedAdd,
  checkedMultiply,
  describeArtifact,
  diagnosticBytes,
  eventKindSchema,
  executionIdentitySchema,
  exportRequestFixture,
  exportRequestSchema,
  imageRequestFixture,
  imageRequestSchema,
  immutableObjectKey,
  interestPath,
  isSettledReceipt,
  jobStateSchema,
  microcurrencySchema,
  objectKeySchema,
  parseExportRequest,
  parseImageRequest,
  parseSubmissionReply,
  policySchema,
  providerReceiptSchema,
  quoteSchema,
  receiptClaimsSchema,
  requestBindingSchema,
  sameExecution,
  sha256Bytes,
  signProviderReceipt,
  signVerifiedObject,
  signWorkerContext,
  signedWorkerContextSchema,
  statusReplySchema,
  verifyDiagnosticArtifact,
  verifyObjectReceipt,
  verifyProviderReceipt,
  verifyWorkerContext,
  workerClaimsForLease,
  workerClaimsSchema,
  worstCaseQuote,
  type AuthContext,
  type Lease,
  type ReceiptClaims,
  type StatusReply,
} from './contracts'

// Synthetic identities injected by tests, not an auth implementation or grants to real users.
const auth: AuthContext = authContextSchema.parse({
  principalId: 'test-principal-00000001',
  experimentId: 'test-experiment-0000001',
  scopes: ['images:read', 'images:write', 'exports:write'],
})
const secondAuth: AuthContext = { ...auth, principalId: 'test-principal-00000002' }
const now = 1_000
const key = () => randomBytes(32).toString('base64url')
function leaseFixture(): Lease {
  const design = defaultDesign()
  return {
    execution: executionIdentitySchema.parse({
      provider: 'fake-local',
      executionId: 'execution-fixture-00001',
      jobId: 'job-fixture-0000000001',
      fence: 1,
      attempt: 1,
    }),
    workerId: 'worker-fixture-0000001',
    design,
    binding: bindRequestSync(design, 'image', auth),
    quote: worstCaseQuote(),
    policy: DEFAULT_POLICY,
    leaseUntil: now + 10_000,
    deadline: now + 60_000,
  }
}
function receiptFixture(overrides: Partial<ReceiptClaims> = {}): ReceiptClaims {
  return receiptClaimsSchema.parse({
    execution: leaseFixture().execution,
    sequence: 1,
    observedAt: now,
    outcome: 'completed',
    cumulativeCostMicro: 100,
    runtimeMs: 100,
    finalMeter: true,
    startForbidden: true,
    ...overrides,
  })
}
function pendingStatus(): StatusReply {
  const lease = leaseFixture()
  return statusReplySchema.parse({
    protocol: CONTROL_PROTOCOL,
    mode: 'mock-diagnostic',
    productionAllowed: false,
    paidExecutionAllowed: false,
    interestId: 'interest-fixture-00001',
    jobId: lease.execution.jobId,
    purpose: 'image',
    requested: lease.binding.identity,
    state: 'queued',
    interestState: 'active',
    reconciliationRequired: false,
    cancellationScope: null,
    sharedWorkCancelled: false,
    artifact: null,
    error: null,
    retryAfterMs: 250,
  })
}

describe('P04 strict request contracts', () => {
  it('reuses the four domain fixtures with required named v4 presentation and profile', () => {
    for (const design of createDesignFixtures()) {
      const request = imageRequestFixture(design)
      expect(parseImageRequest(request).design).toEqual(design)
      expect(request.design.config.schemaVersion).toBe(4)
      expect(exportRequestSchema.parse(exportRequestFixture(design)).format).toBe('diagnostic-svg')
    }
  })

  it.each([
    'assetURLs',
    'assetUrl',
    'meshes',
    'camera',
    'samples',
    'scripts',
    'callback',
    'workerCommand',
    'priority',
    'principalId',
    'experimentId',
    'auth',
    'outputProfile',
    'paidExecutionAllowed',
    'requestDigest',
    'format',
  ])('rejects top-level forbidden or unknown image field %s', (field) => {
    expect(
      imageRequestSchema.safeParse({ ...imageRequestFixture(), [field]: 'untrusted' }).success,
    ).toBe(false)
  })

  it('strictness persists at every nested design authority', () => {
    const request = imageRequestFixture()
    const design = request.design
    const badDesigns = [
      { ...design, unknown: true },
      { ...design, outputProfile: '1024-unrestricted' },
      { ...design, presentation: undefined },
      { ...design, config: { ...design.config, schemaVersion: 3 } },
      { ...design, config: { ...design.config, meshes: [] } },
      {
        ...design,
        config: { ...design.config, product: { ...design.config.product, custom: true } },
      },
      {
        ...design,
        config: { ...design.config, structure: { ...design.config.structure, script: 'ignored?' } },
      },
      {
        ...design,
        config: {
          ...design.config,
          appearance: { ...design.config.appearance, textureURL: 'https://invalid/' },
        },
      },
      { ...design, presentation: { ...design.presentation, camera: { position: [1, 2, 3] } } },
      { ...design, presentation: { ...design.presentation, cameraRef: 'arbitrary-camera' } },
      { ...design, presentation: { ...design.presentation, lookRef: 'user-look' } },
    ]
    for (const invalid of badDesigns)
      expect(imageRequestSchema.safeParse({ ...request, design: invalid }).success).toBe(false)
  })

  it('requires bounded idempotency and keeps export an explicit separate route', () => {
    const image = imageRequestFixture()
    const exported = exportRequestFixture()
    expect(IMAGE_PATH).not.toBe(EXPORT_PATH)
    expect(imageRequestSchema.safeParse(exported).success).toBe(false)
    expect(exportRequestSchema.safeParse(image).success).toBe(false)
    for (const idempotencyKey of [
      undefined,
      '',
      'short',
      'x'.repeat(129),
      'space is invalid!',
      '../traversal/path',
    ]) {
      expect(imageRequestSchema.safeParse({ ...image, idempotencyKey }).success).toBe(false)
    }
    for (const format of ['pdf', 'png', 'strict-svg', 'photoreal']) {
      expect(exportRequestSchema.safeParse({ ...exported, format }).success).toBe(false)
    }
    expect(parseExportRequest(exported)).toEqual(exported)
    expect(exportRequestSchema.safeParse({ ...exported, rightsApproved: true }).success).toBe(false)
  })

  it('auth shape does not accept arbitrary rights, duplicate scopes or request-body identity', () => {
    expect(authContextSchema.safeParse({ ...auth, scopes: ['admin'] }).success).toBe(false)
    expect(
      authContextSchema.safeParse({ ...auth, scopes: ['images:read', 'images:read'] }).success,
    ).toBe(false)
    expect(authContextSchema.safeParse({ ...auth, authenticated: true }).success).toBe(false)
    expect(imageRequestSchema.safeParse({ ...imageRequestFixture(), auth }).success).toBe(false)
    expect(authContextSchema.safeParse({ ...auth, principalId: '../principal' }).success).toBe(
      false,
    )
  })

  it('keeps execution and streams immutable-denied with no policy override', () => {
    expect(PAID_EXECUTION_ALLOWED).toBe(false)
    expect(PUBLIC_STREAMS_ENABLED).toBe(false)
    expect(Object.isFrozen(EXECUTION_POLICY)).toBe(true)
    expect(() => Object.assign(EXECUTION_POLICY, { paidExecutionAllowed: true })).toThrow()
    expect(policySchema.safeParse({ paidExecutionAllowed: true }).success).toBe(false)
    expect(policySchema.safeParse({ maxConcurrency: 5 }).success).toBe(false)
  })
})

describe('P04 identity and bounded accounting helpers', () => {
  it('sync and async bindings reuse exactly the original domain identity', async () => {
    for (const design of createDesignFixtures()) {
      const binding = bindRequestSync(design, 'image', auth)
      expect(binding.identity).toEqual(await designIdentity(design))
      expect(await bindRequest(design, 'image', auth)).toEqual(binding)
      expect(binding.revision).toBe(binding.identity.requestDigest)
    }
  })

  it('coalesces public bytes independently of principal/experiment, isolates private exports', async () => {
    const design = defaultDesign()
    const otherExperiment = { ...auth, experimentId: 'test-experiment-0000002' }
    const image = await bindRequest(design, 'image', auth)
    expect(await bindRequest(design, 'image', secondAuth)).toEqual(image)
    expect(await bindRequest(design, 'image', otherExperiment)).toEqual(image)
    const exported = await bindRequest(design, 'export', auth)
    expect(exported.visibility).toBe('private')
    expect(exported.cacheKey).not.toBe(image.cacheKey)
    expect((await bindRequest(design, 'export', secondAuth)).cacheKey).not.toBe(exported.cacheKey)
    expect((await bindRequest(design, 'export', otherExperiment)).cacheKey).not.toBe(
      exported.cacheKey,
    )
    expect(requestBindingSchema.safeParse({ ...exported, visibility: 'public' }).success).toBe(
      false,
    )
    expect(
      requestBindingSchema.safeParse({ ...image, revision: `sha256:${'0'.repeat(64)}` }).success,
    ).toBe(false)
  })

  it('captures named presentation/profile revision rather than just product identity', () => {
    const design = defaultDesign()
    const original = bindRequestSync(design, 'image', auth)
    for (const revision of [
      parseDesign({ ...design, outputProfile: 'web-thumbnail' }),
      parseDesign({ ...design, presentation: { ...design.presentation, aspect: 'tall' } }),
      parseDesign({
        ...design,
        presentation: { ...design.presentation, lookRef: 'studio-neutral-draft@1' },
      }),
    ])
      expect(bindRequestSync(revision, 'image', auth).cacheKey).not.toBe(original.cacheKey)
  })

  it('quotes every component, all retries, full delivery allowance and staged storage margin', () => {
    const p = policySchema.parse({
      maxAttempts: 3,
      maxStartupMs: 2,
      maxRuntimeMs: 5,
      maxIdleMs: 3,
      maxShutdownMs: 4,
      delayedMeterMarginMs: 6,
      runtimeMicroPerMs: 2,
      maxOutputBytes: 1024,
      maxDeliveriesPerJob: 2,
      retentionMs: 3_600_000,
      jobTtlMs: 100,
      deliveryMicroPerKiB: 3,
      storageMicroPerKiBHour: 4,
    })
    const quote = worstCaseQuote(p)
    expect(quote).toEqual({
      currency: 'synthetic-micro',
      startup: 4,
      runtime: 10,
      idle: 6,
      shutdown: 8,
      delayedMeter: 12,
      retries: 80,
      delivery: 6,
      storage: 24,
      total: 150,
      maxAttempts: 3,
      reservedStorageBytes: 3072,
      reservedDeliveryBytes: 2048,
    })
    expect(Object.isFrozen(quote)).toBe(true)
    expect(quoteSchema.safeParse({ ...quote, total: quote.total - 1 }).success).toBe(false)
    expect(worstCaseQuote(policySchema.parse({ ...p, maxAttempts: 1 })).retries).toBe(0)
  })

  it.each([-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid accounting integer %s',
    (value) => {
      expect(microcurrencySchema.safeParse(value).success).toBe(false)
      expect(() => checkedAdd(value)).toThrow()
      expect(() => checkedMultiply(value, 1)).toThrow()
    },
  )

  it('rejects aggregate and rate multiplication overflow instead of rounding', () => {
    expect(checkedAdd(0, 5, 7)).toBe(12)
    expect(checkedMultiply(7, 9)).toBe(63)
    expect(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError)
    expect(() => checkedMultiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError)
    expect(() =>
      worstCaseQuote(policySchema.parse({ runtimeMicroPerMs: Number.MAX_SAFE_INTEGER })),
    ).toThrow()
    expect(() => canonicalJson(undefined)).toThrow()
    expect(canonicalJson({ z: 2, a: { b: 1, a: 0 } })).toBe('{"a":{"a":0,"b":1},"z":2}')
  })
})

describe('P04 bounded signed worker context and execution receipts', () => {
  it('signs bounded private context without commands and respects lease/deadline expiration', () => {
    const secret = key()
    const lease = leaseFixture()
    const claims = workerClaimsForLease(
      { ...lease, leaseUntil: now + 900, deadline: now + 800 },
      now,
    )
    expect(claims.expiresAt).toBe(now + 800)
    expect(claims.maxCostMicro).toBe(1500)
    expect(claims.maxRuntimeMs).toBe(lease.policy.maxRuntimeMs)
    const signed = signWorkerContext(claims, secret)
    expect(verifyWorkerContext(signed, secret, now)).toEqual(claims)
    expect(() => verifyWorkerContext(signed, secret, claims.expiresAt)).toThrow()
    expect(() => verifyWorkerContext(signed, secret, now - 1)).toThrow()
    expect(() => signWorkerContext(claims, 'short')).toThrow()
    expect(() => workerClaimsForLease({ ...lease, leaseUntil: now }, now)).toThrow()
  })

  it('rejects signature substitution, wrong key, changed bounds and unknown worker fields', () => {
    const secret = key()
    const claims = workerClaimsForLease(leaseFixture(), now)
    const signed = signWorkerContext(claims, secret)
    expect(() => verifyWorkerContext(signed, key(), now)).toThrow()
    expect(() =>
      verifyWorkerContext({ ...signed, claims: { ...claims, maxOutputBytes: 1 } }, secret, now),
    ).toThrow()
    expect(() =>
      verifyWorkerContext({ ...signed, signature: '0'.repeat(64) }, secret, now),
    ).toThrow()
    expect(
      signedWorkerContextSchema.safeParse({ ...signed, callback: 'https://invalid/' }).success,
    ).toBe(false)
    for (const modified of [
      { ...claims, paidExecutionAllowed: true },
      { ...claims, expiresAt: now + 60_001 },
      { ...claims, maxRuntimeMs: 30_001 },
      { ...claims, audience: 'public-worker' },
      { ...claims, workerCommand: 'arbitrary' },
      { ...claims, maxOutputBytes: 12 * 1024 + 1 },
      { ...claims, execution: { ...claims.execution, provider: 'paid-provider' } },
    ])
      expect(workerClaimsSchema.safeParse(modified).success).toBe(false)
  })

  it('uses signed execution-bound final stop/completion receipts, never boolean assertions', () => {
    const secret = key()
    const claims = receiptFixture()
    const receipt = signProviderReceipt(claims, secret)
    expect(verifyProviderReceipt(receipt, secret)).toEqual(claims)
    expect(isSettledReceipt(claims)).toBe(true)
    expect(isSettledReceipt(receiptFixture({ outcome: 'stopped' }))).toBe(true)
    expect(providerReceiptSchema.safeParse({ confirmedStopped: true }).success).toBe(false)
    for (const outcome of ['running', 'stop-requested', 'unknown'] as const) {
      const pending = receiptFixture({ outcome, finalMeter: false })
      expect(isSettledReceipt(pending)).toBe(false)
      expect(receiptClaimsSchema.safeParse({ ...pending, finalMeter: true }).success).toBe(false)
    }
    expect(isSettledReceipt(receiptFixture({ outcome: 'stopped', finalMeter: false }))).toBe(false)
    expect(receiptClaimsSchema.safeParse({ ...claims, startForbidden: false }).success).toBe(false)
  })

  it('binds receipt execution, fence, attempt, sequence, meter and timestamp cryptographically', () => {
    const secret = key()
    const claims = receiptFixture()
    const receipt = signProviderReceipt(claims, secret)
    for (const changed of [
      { ...claims, execution: { ...claims.execution, executionId: 'other-execution-00001' } },
      { ...claims, execution: { ...claims.execution, jobId: 'other-job-00000000001' } },
      { ...claims, execution: { ...claims.execution, fence: 2 } },
      { ...claims, execution: { ...claims.execution, attempt: 2 } },
      { ...claims, sequence: 2 },
      { ...claims, cumulativeCostMicro: 0 },
      { ...claims, observedAt: now + 1 },
    ])
      expect(() => verifyProviderReceipt({ ...receipt, claims: changed }, secret)).toThrow()
    expect(sameExecution(claims.execution, { ...claims.execution })).toBe(true)
    expect(sameExecution(claims.execution, { ...claims.execution, fence: 2 })).toBe(false)
    expect(() => verifyProviderReceipt(receipt, key())).toThrow()
  })
})

describe('P04 immutable diagnostic publication boundary', () => {
  it('verifies deterministic byte checksum and profile-specific dimensions without rendering', async () => {
    const original = defaultDesign()
    for (const profile of ['web-hero', 'web-thumbnail'] as const) {
      for (const aspect of ['wide', 'tall'] as const) {
        const design = parseDesign({
          ...original,
          outputProfile: profile,
          presentation: { ...original.presentation, aspect },
        })
        const artifact = await createMockArtifact(design)
        expect(await verifyDiagnosticArtifact(artifact, design)).toEqual(artifact)
        const bytes = diagnosticBytes(artifact)
        expect(bytes.byteLength).toBe(artifact.byteLength)
        expect(sha256Bytes(bytes)).toBe(artifact.checksum)
        const object = describeArtifact(artifact, design, bindRequestSync(design, 'image', auth))
        expect(object.outputProfile).toBe(profile)
        expect(object.objectKey).toBe(immutableObjectKey(object.binding, artifact.checksum))
        expect(object.approvedCurrentImage).toBe(false)
        expect(object.strictExport).toBe(false)
        expect(new TextDecoder().decode(bytes)).toContain('NOT A CURRENT DESIGN IMAGE')
      }
    }
  })

  it('rejects wrong bytes, checksums, dimensions, size, media and purported approved outputs', async () => {
    const design = defaultDesign()
    const artifact = await createMockArtifact(design)
    const invalid = [
      { ...artifact, checksum: `sha256:${'0'.repeat(64)}` },
      { ...artifact, artifactId: `sha256:${'0'.repeat(64)}` },
      { ...artifact, width: artifact.width + 1 },
      { ...artifact, height: artifact.height + 1 },
      { ...artifact, byteLength: artifact.byteLength - 1 },
      { ...artifact, mediaType: 'image/png' },
      { ...artifact, src: `${artifact.src}x` },
      { ...artifact, exactMatch: true },
      { ...artifact, approvedCurrentImage: true },
      { ...artifact, provenance: { ...artifact.provenance, productionAllowed: true } },
    ]
    for (const value of invalid)
      await expect(verifyDiagnosticArtifact(value, design)).rejects.toThrow()
    await expect(
      verifyDiagnosticArtifact(artifact, design, artifact.byteLength - 1),
    ).rejects.toThrow()
    await expect(
      verifyDiagnosticArtifact(artifact, defaultDesign({ family: 'container', lengthFt: 40 })),
    ).rejects.toThrow()
  })

  it('isolates object keys even when private export and public diagnostic bytes are identical', async () => {
    const design = defaultDesign()
    const artifact = await createMockArtifact(design)
    const image = describeArtifact(artifact, design, bindRequestSync(design, 'image', auth))
    const exported = describeArtifact(artifact, design, bindRequestSync(design, 'export', auth))
    expect(image.checksum).toBe(exported.checksum)
    expect(image.objectKey).not.toBe(exported.objectKey)
    expect(exported.objectKey).toContain('/private/')
    expect(
      artifactDescriptorSchema.safeParse({ ...exported, objectKey: image.objectKey }).success,
    ).toBe(false)
    expect(
      artifactDescriptorSchema.safeParse({ ...image, artifactId: `sha256:${'f'.repeat(64)}` })
        .success,
    ).toBe(false)
    for (const path of [
      '../../outside.svg',
      '/tmp/file.svg',
      'https://invalid/image.svg',
      `${image.objectKey}/..`,
    ]) {
      expect(objectKeySchema.safeParse(path).success).toBe(false)
    }
  })

  it('authenticates immutable verification with stage and execution binding, not a ready boolean', async () => {
    const secret = key()
    const lease = leaseFixture()
    const artifact = await createMockArtifact(lease.design)
    const object = describeArtifact(artifact, lease.design, lease.binding)
    const claims = {
      stageId: 'stage-fixture-00000001',
      execution: lease.execution,
      object,
      verifiedAt: now,
    }
    const verified = signVerifiedObject(claims, secret)
    expect(verifyObjectReceipt(verified, secret)).toEqual(claims)
    expect(() =>
      verifyObjectReceipt(
        { ...verified, claims: { ...claims, stageId: 'other-stage-000000001' } },
        secret,
      ),
    ).toThrow()
    expect(() =>
      verifyObjectReceipt(
        { ...verified, claims: { ...claims, execution: { ...lease.execution, fence: 2 } } },
        secret,
      ),
    ).toThrow()
    expect(() => verifyObjectReceipt({ verified: true, object }, secret)).toThrow()
    expect(() => verifyObjectReceipt(verified, key())).toThrow()
  })
})

describe('P04 lifecycle and truthful HTTP response contracts', () => {
  it('declares every durable state and atomic requested/reserved/queued events', () => {
    const sequence = [
      'requested',
      'reserved',
      'queued',
      'leased',
      'rendering',
      'publishing',
      'ready',
    ] as const
    for (const state of [...sequence, 'failed', 'cancelled', 'expired']) {
      expect(jobStateSchema.safeParse(state).success).toBe(true)
      expect(eventKindSchema.safeParse(state).success).toBe(true)
    }
    for (let i = 1; i < sequence.length; i++)
      expect(canTransition(sequence[i - 1], sequence[i])).toBe(true)
    expect(canTransition('queued', 'ready')).toBe(false)
    expect(canTransition('failed', 'queued')).toBe(false)
    expect(canTransition('ready', 'expired')).toBe(true)
    expect(canTransition('rendering', 'rendering')).toBe(true)
    expect(jobStateSchema.safeParse('stopped').success).toBe(false)
    expect(jobStateSchema.safeParse('uncertain').success).toBe(false)
  })

  it('uncertainty forbids cancelled/expired/ready/retry until reconciliation', () => {
    for (const target of ['cancelled', 'expired', 'ready', 'queued'] as const) {
      expect(() => assertTransition('publishing', target, true)).toThrow()
    }
    expect(() => assertTransition('rendering', 'rendering', true)).not.toThrow()
    expect(() => assertTransition('rendering', 'queued', false)).not.toThrow()
    expect(() => assertTransition('cancelled', 'cancelled', true)).toThrow()
    expect(() => assertTransition('requested', 'ready')).toThrow()
  })

  it('interest-only cancellation truthfully preserves uncertain active shared work', () => {
    const pending = pendingStatus()
    const detached = {
      ...pending,
      state: 'rendering',
      interestState: 'cancelled',
      reconciliationRequired: true,
      cancellationScope: 'interest-only',
    }
    expect(statusReplySchema.parse(detached)).toMatchObject({
      state: 'rendering',
      interestState: 'cancelled',
      sharedWorkCancelled: false,
    })
    expect(statusReplySchema.safeParse({ ...detached, state: 'cancelled' }).success).toBe(false)
    expect(statusReplySchema.safeParse({ ...detached, sharedWorkCancelled: true }).success).toBe(
      false,
    )
    expect(statusReplySchema.safeParse({ ...detached, cancellationScope: null }).success).toBe(
      false,
    )
    expect(() => parseSubmissionReply(202, detached)).toThrow()
  })

  it('requires exact ready artifact for 200, pending for 202, never unknown execution or ended interest', async () => {
    const pending = pendingStatus()
    expect(parseSubmissionReply(202, pending).status).toBe(202)
    expect(() => parseSubmissionReply(200, pending)).toThrow()
    expect(() => parseSubmissionReply(202, { ...pending, reconciliationRequired: true })).toThrow()
    expect(statusReplySchema.safeParse({ ...pending, state: 'ready' }).success).toBe(false)
    const lease = leaseFixture()
    const artifact = await createMockArtifact(lease.design)
    const object = describeArtifact(artifact, lease.design, lease.binding)
    const ready = { ...pending, state: 'ready', artifact: object, retryAfterMs: null }
    expect(parseSubmissionReply(200, ready).body.state).toBe('ready')
    expect(() => parseSubmissionReply(202, ready)).toThrow()
    expect(statusReplySchema.safeParse({ ...ready, reconciliationRequired: true }).success).toBe(
      false,
    )
    expect(statusReplySchema.safeParse({ ...ready, purpose: 'export' }).success).toBe(false)
    expect(
      statusReplySchema.safeParse({
        ...ready,
        requested: { ...pending.requested, requestDigest: `sha256:${'0'.repeat(64)}` },
      }).success,
    ).toBe(false)
    expect(() =>
      parseSubmissionReply(200, { ...ready, interestState: 'expired', artifact: null }),
    ).toThrow()
  })

  it('constructs only bounded fixed local interest/artifact paths', () => {
    expect(interestPath('interest-fixture-00001')).toBe(
      '/__fury-control/v1/interests/interest-fixture-00001',
    )
    expect(artifactPath('interest-fixture-00001')).toBe(
      '/__fury-control/v1/interests/interest-fixture-00001/artifact',
    )
    for (const value of ['../private', 'x'.repeat(129), 'https://invalid/'])
      expect(() => interestPath(value)).toThrow()
  })
})
