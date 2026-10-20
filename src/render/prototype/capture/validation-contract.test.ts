// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { designReviewHolds } from '../../../domain/design'
import { designIdentity } from '../../../domain/designIdentity'
import {
  CAPTURE_EFFECTS,
  CAPTURE_FAILURE_CODES,
  CAPTURE_FLAGS,
  CAPTURE_LIMITS,
  CAPTURE_PROTOCOL,
  LOCAL_REVIEW_PROFILES,
  assertCanStartAttempt,
  assertCaptureActive,
  captureBuildSchema,
  captureCompleteSchema,
  captureFailureSchema,
  captureIdentity,
  captureJobSchema,
  captureProfileSchema,
  captureReceiptSchema,
  captureRuntimeSchema,
  captureTerminalSchema,
  createCaptureJob,
  createCaptureSamples,
  inspectDecodedPixels,
  parseCaptureRequest,
  parseCaptureRequestText,
  resolveCaptureCamera,
  validateCaptureJob,
  validateCaptureProgress,
  validateCaptureReceipt,
  validateCaptureTerminal,
  validateDecodedArtifact,
  validateWorkerReady,
  validateWorkerResult,
  workerReadySchema,
  workerResultSchema,
  type CaptureAttempt,
  type CaptureBuild,
  type CaptureJob,
  type CaptureRuntime,
} from './contract'

const digest = (character: string) => `sha256:${character.repeat(64)}`
const build: CaptureBuild = {
  sourceManifestDigest: digest('a'),
  assetManifestDigest: digest('b'),
  bundleDigest: digest('c'),
  lockfileDigest: digest('d'),
  threeRevision: '186',
}
const samples = createCaptureSamples()
const sample = samples[0]
const jobFixture = () => createCaptureJob('validation-only-job', sample.id, sample.request, build)

function changed(input: unknown, path: readonly string[], value: unknown): unknown {
  const result = structuredClone(input) as Record<string, unknown>
  let cursor = result
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>
  cursor[path[path.length - 1]] = value
  return result
}

/** Synthetic protocol data ONLY: neither a browser observation nor an image receipt. */
function runtimeFixture(): CaptureRuntime {
  const omitted = new Set([
    'ambient-occlusion',
    'screen-space-gi',
    'screen-space-reflections',
    'bloom',
    'path-tracing',
  ])
  return {
    backend: 'webgl2',
    acceleration: 'software',
    adapter: 'Synthetic test data; no renderer launched',
    browserVersion: 'test',
    userAgent: 'test',
    effects: CAPTURE_EFFECTS.map((id) => ({
      id,
      state: omitted.has(id) ? 'omitted' : id === 'mirror' ? 'approximate' : 'enabled',
      detail: 'Synthetic unit-test data, not observed readiness',
    })),
  }
}
function workerFixture(job: CaptureJob) {
  return {
    protocol: CAPTURE_PROTOCOL,
    state: 'captured' as const,
    jobId: job.jobId,
    captureDigest: job.identity.captureDigest,
    pngBase64: 'A'.repeat(44), // Base64 shape fixture, deliberately NOT PNG bytes.
    camera: resolveCaptureCamera(job.request.design),
    runtime: runtimeFixture(),
    renderedFrames: 8,
    elapsedMs: 1,
    flags: CAPTURE_FLAGS,
  }
}
function receiptFixture(job: CaptureJob) {
  return {
    protocol: CAPTURE_PROTOCOL,
    state: 'validated-draft-capture' as const,
    job,
    artifact: {
      filename: 'image.png' as const,
      mediaType: 'image/png' as const,
      bytes: 44,
      digest: digest('e'),
      pixels: {
        width: job.profile.width,
        height: job.profile.height,
        rgbaBytes: job.profile.width * job.profile.height * 4,
        opaquePixels: job.profile.width * job.profile.height,
        distinctRgbAtLeast: 16,
        channelRange: 255,
        lumaVariance: 100,
      },
    },
    camera: resolveCaptureCamera(job.request.design),
    runtime: runtimeFixture(),
    renderedFrames: 8,
    elapsedMs: 1,
    holds: designReviewHolds(job.request.design),
    flags: CAPTURE_FLAGS,
  }
}
function markerFixture(job: CaptureJob) {
  return {
    protocol: CAPTURE_PROTOCOL,
    state: 'complete-draft-capture' as const,
    jobId: job.jobId,
    captureDigest: job.identity.captureDigest,
    image: receiptFixture(job).artifact,
    receipt: { filename: 'receipt.json' as const, bytes: 123, digest: digest('f') },
    flags: CAPTURE_FLAGS,
  }
}
function terminalFixture(job: CaptureJob) {
  return {
    protocol: CAPTURE_PROTOCOL,
    state: 'complete' as const,
    jobId: job.jobId,
    captureDigest: job.identity.captureDigest,
    marker: markerFixture(job),
    flags: CAPTURE_FLAGS,
  }
}

describe('strict full-v4 admission at every nested boundary', () => {
  const payloads = [
    ['url', 'https://example.invalid/texture'],
    ['path', '/etc/passwd'],
    ['mesh', { positions: [0, 1, 2] }],
    ['script', 'globalThis.fetch("https://example.invalid")'],
    ['items', [{ sku: 'rack', x: 1, z: 1, rotation: 90 }]],
    ['camera', { position: [1, 2, 3] }],
    ['approval', true],
    ['deadlineMs', 1],
  ] as const
  it.each([
    [],
    ['design'],
    ['design', 'config'],
    ['design', 'config', 'product'],
    ['design', 'config', 'structure'],
    ['design', 'config', 'appearance'],
    ['design', 'presentation'],
  ])('rejects unknown network/mesh/script/equipment/approval ingress at %j', (...path) => {
    for (const [field, value] of payloads)
      expect(() => parseCaptureRequest(changed(sample.request, [...path, field], value))).toThrow()
  })

  it.each([
    [['protocol'], 'fury.local-three-capture@2'],
    [['design', 'config', 'schemaVersion'], 3],
    [['design', 'config', 'schemaVersion'], 5],
    [['design', 'config', 'catalogVersion'], 'fury-design-approved-1'],
    [['design', 'config', 'product', 'lengthFt'], 60],
    [['design', 'config', 'arrangementRef'], 'container-20-review@1'],
    [['design', 'config', 'structure', 'layout'], 'double'],
    [
      ['design', 'config', 'structure', 'addons'],
      ['deck', 'deck'],
    ],
    [['design', 'config', 'structure', 'addons'], ['canopy']],
    [['design', 'presentation', 'lookRef'], 'https://example.invalid/look'],
    [['design', 'presentation', 'cameraRef'], 'free-camera'],
    [['design', 'presentation', 'aspect'], 'square'],
    [['design', 'outputProfile'], 'strict-cycles-1024-reference-draft@1'],
  ] as const)('rejects invalid domain field %j = %j', (path, value) => {
    expect(() => parseCaptureRequest(changed(sample.request, path, value))).toThrow()
  })

  it('rejects cross-family normalization tricks rather than silently repairing them', () => {
    const container = samples[2].request
    expect(() =>
      parseCaptureRequest(changed(container, ['design', 'config', 'appearance', 'accent'], true)),
    ).toThrow()
    expect(() =>
      parseCaptureRequest(
        changed(container, ['design', 'config', 'structure', 'infill'], 'glass-overhead'),
      ),
    ).toThrow()
    expect(() =>
      parseCaptureRequest(changed(container, ['design', 'config', 'structure', 'kind'], 'studio')),
    ).toThrow()
    const openSide = changed(container, ['design', 'config', 'structure', 'opening'], 'full')
    expect(() =>
      parseCaptureRequest(changed(openSide, ['design', 'presentation', 'doorPose'], 'open')),
    ).toThrow()
  })

  it('bounds actual UTF-8 request bytes and never accepts URL/base64/double-encoded wrappers', () => {
    const text = JSON.stringify(sample.request)
    const atCap = text + ' '.repeat(CAPTURE_LIMITS.requestBytes - Buffer.byteLength(text))
    expect(parseCaptureRequestText(atCap)).toEqual(sample.request)
    expect(() => parseCaptureRequestText(atCap + ' ')).toThrowError(/byte cap/)
    expect(() =>
      parseCaptureRequestText('é'.repeat(CAPTURE_LIMITS.requestBytes / 2 + 1)),
    ).toThrowError(/byte cap/)
    for (const raw of [
      JSON.stringify(text),
      Buffer.from(text).toString('base64'),
      'https://example.invalid/job',
      'null',
      '[]',
      '{}',
      '{',
    ])
      expect(() => parseCaptureRequestText(raw)).toThrow()
  })
})

describe('fixed profile is neither caller tuning nor a strict reference', () => {
  it.each([
    ['version', 2],
    ['purpose', 'production'],
    ['quality', 'ultra'],
    ['pipeline', 'cycles'],
    ['pixelRatio', 2],
    ['msaaSamples', 1024],
    ['minFrames', 7],
    ['maxFrames', 65],
    ['quietMs', 0],
    ['postReadyFrames', 0],
    ['format', 'image/jpeg'],
    ['colorSpace', 'display-p3'],
    ['toneMapping', 'ACES'],
    ['maxPngBytes', CAPTURE_LIMITS.pngBytes + 1],
    ['deadlineMs', CAPTURE_LIMITS.jobMs + 1],
    ['width', 1600],
    ['height', 1000],
    ['id', 'web-hero'],
    ['aspect', 'square'],
    ['adaptiveSampling', true],
    ['samples', 1024],
    ['encoder', { quality: 0.1 }],
  ] as const)('rejects profile override %s', (field, value) => {
    for (const profile of Object.values(LOCAL_REVIEW_PROFILES))
      expect(captureProfileSchema.safeParse(changed(profile, [field], value)).success).toBe(false)
  })

  it('rejects profile/aspect swaps even when both supplied objects are individually legal', async () => {
    for (const entry of samples) {
      const job = await createCaptureJob('profile-audit', entry.id, entry.request, build)
      const other =
        job.profile.aspect === 'wide' ? LOCAL_REVIEW_PROFILES.tall : LOCAL_REVIEW_PROFILES.wide
      expect(() => parseCaptureRequest({ ...entry.request, profileId: other.id })).toThrow()
      await expect(validateCaptureJob({ ...job, profile: other })).rejects.toMatchObject({
        code: 'identity-mismatch',
      })
    }
  })
})

describe('recomputed identities cannot grant unpinned capture work', () => {
  it.each(samples.flatMap((a) => samples.filter((b) => b.id !== a.id).map((b) => [a, b] as const)))(
    'rejects cross-fixture sample/request substitution %j / %j',
    async (a, b) => {
      await expect(createCaptureJob('cross-fixture', a.id, b.request, build)).rejects.toMatchObject(
        { code: 'invalid-input' },
      )
    },
  )

  it.each([
    [['design', 'config', 'appearance', 'finish'], 'chalk'],
    [['design', 'config', 'appearance', 'accent'], true],
    [['design', 'config', 'appearance', 'interior'], 'slatted'],
    [['design', 'config', 'appearance', 'floor'], 'oak'],
    [['design', 'config', 'appearance', 'mirror'], true],
    [['design', 'config', 'structure', 'door'], 'sliding'],
    [['design', 'config', 'structure', 'railing'], 'cable'],
    [['design', 'config', 'structure', 'addons'], ['deck']],
    [['design', 'presentation', 'lookRef'], 'courtyard-night-draft@1'],
    [['design', 'presentation', 'cameraRef'], 'entry-draft@1'],
    [['design', 'presentation', 'doorPose'], 'open'],
    [['design', 'outputProfile'], 'web-thumbnail'],
  ] as const)('changes identity but rejects a valid non-pinned field %j', async (path, value) => {
    const request = parseCaptureRequest(changed(sample.request, path, value))
    const before = await captureIdentity(sample.request, build)
    const after = await captureIdentity(request, build)
    expect(after.requestDigest).not.toBe(before.requestDigest)
    expect(after.captureDigest).not.toBe(before.captureDigest)
    await expect(
      createCaptureJob('valid-not-authorized', sample.id, request, build),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it.each(['designDigest', 'presentationDigest', 'requestDigest', 'captureDigest'] as const)(
    'rejects forged %s rather than trusting upstream strings',
    async (field) => {
      const job = await jobFixture()
      await expect(
        validateCaptureJob(changed(job, ['identity', field], digest('f'))),
      ).rejects.toMatchObject({ code: 'identity-mismatch' })
    },
  )

  it.each([
    'sourceManifestDigest',
    'assetManifestDigest',
    'bundleDigest',
    'lockfileDigest',
    'threeRevision',
  ] as const)('binds actual build field %s at job and bootstrap boundaries', async (field) => {
    const job = await jobFixture()
    const nextBuild = { ...build, [field]: field === 'threeRevision' ? '187' : digest('f') }
    const identity = await captureIdentity(sample.request, nextBuild)
    expect(identity.captureDigest).not.toBe(job.identity.captureDigest)
    expect(identity).toMatchObject(await designIdentity(sample.request.design))
    await expect(
      validateCaptureJob({ ...job, build: nextBuild, identity }, build),
    ).rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(() =>
      validateWorkerReady(
        { protocol: CAPTURE_PROTOCOL, state: 'ready', build: nextBuild, flags: CAPTURE_FLAGS },
        build,
      ),
    ).toThrow()
  })

  it('normalizes set order without making job IDs or object property order into visual identity', async () => {
    const roof = samples[5]
    const reordered = changed(
      roof.request,
      ['design', 'config', 'structure', 'addons'],
      ['stairs', 'roof', 'deck', 'canopy'],
    )
    const a = await createCaptureJob('identity-one', roof.id, reordered, build)
    const b = await createCaptureJob('identity-two', roof.id, roof.request, { ...build })
    expect(a.identity).toEqual(b.identity)
    expect(a.jobId).not.toBe(b.jobId)
    expect(a.request.design.config.structure.addons).toEqual(['canopy', 'deck', 'roof', 'stairs'])
    const reversed = Object.fromEntries(Object.entries(roof.request).reverse())
    expect(await captureIdentity(reversed, build)).toEqual(a.identity)
  })

  it('rejects resource/path escape fields even in operator build metadata', () => {
    for (const [field, value] of [
      ['assetUrl', 'file:///etc/passwd'],
      ['entry', '../app.ts'],
      ['cloud', true],
      ['script', 'alert(1)'],
    ] as const)
      expect(captureBuildSchema.safeParse({ ...build, [field]: value }).success).toBe(false)
    for (const invalid of ['sha256:a', 'sha256:' + 'A'.repeat(64), digest('g'), '../image.png', ''])
      expect(captureBuildSchema.safeParse({ ...build, bundleDigest: invalid }).success).toBe(false)
  })
})

describe('approval and missing-effect truth cannot be escalated by metadata', () => {
  it.each(Object.keys(CAPTURE_FLAGS))('rejects %s=true at every protocol layer', async (field) => {
    const job = await jobFixture()
    const failure = {
      protocol: CAPTURE_PROTOCOL,
      state: 'failed',
      jobId: job.jobId,
      captureDigest: job.identity.captureDigest,
      code: 'scene-failed',
      message: 'Test failure',
      elapsedMs: 0,
      flags: CAPTURE_FLAGS,
    }
    const envelopes = [
      [captureJobSchema, job],
      [workerResultSchema, workerFixture(job)],
      [
        workerReadySchema,
        { protocol: CAPTURE_PROTOCOL, state: 'ready', build, flags: CAPTURE_FLAGS },
      ],
      [captureReceiptSchema, receiptFixture(job)],
      [captureCompleteSchema, markerFixture(job)],
      [captureTerminalSchema, terminalFixture(job)],
      [captureFailureSchema, failure],
    ] as const
    for (const [schema, envelope] of envelopes) {
      expect(schema.safeParse(envelope).success).toBe(true)
      expect(schema.safeParse(changed(envelope, ['flags', field], true)).success).toBe(false)
      expect(
        schema.safeParse(changed(envelope, ['flags', 'approvedCurrentImage'], true)).success,
      ).toBe(false)
    }
  })

  it.each([
    'architecture',
    'fixed-equipment',
    'material-textures',
    'environment',
    'fixture-lighting',
    'interior-probe',
    'site-probe',
    'msaa',
  ])('rejects receipt missing required %s even if its runtime schema parses', async (id) => {
    const job = await jobFixture()
    for (const state of ['approximate', 'omitted', 'not-applicable'] as const) {
      const receipt = receiptFixture(job)
      receipt.runtime = {
        ...receipt.runtime,
        effects: receipt.runtime.effects.map((effect) =>
          effect.id === id ? { ...effect, state } : effect,
        ),
      }
      expect(captureRuntimeSchema.safeParse(receipt.runtime).success).toBe(true)
      await expect(validateCaptureReceipt(receipt, job)).rejects.toMatchObject({
        code: 'scene-failed',
      })
    }
  })

  it.each([
    'ambient-occlusion',
    'screen-space-gi',
    'screen-space-reflections',
    'bloom',
    'path-tracing',
  ])('requires known Lite omission %s to remain explicit', (id) => {
    for (const state of ['enabled', 'approximate', 'not-applicable'] as const) {
      const runtime = runtimeFixture()
      expect(
        captureRuntimeSchema.safeParse({
          ...runtime,
          effects: runtime.effects.map((effect) =>
            effect.id === id ? { ...effect, state } : effect,
          ),
        }).success,
      ).toBe(false)
    }
  })

  it('rejects duplicate, missing, invented, unbounded and control-character effect reports', () => {
    const runtime = runtimeFixture()
    for (const effects of [
      runtime.effects.slice(1),
      [...runtime.effects, runtime.effects[0]],
      [runtime.effects[0], ...runtime.effects.slice(0, -1)],
    ])
      expect(captureRuntimeSchema.safeParse({ ...runtime, effects }).success).toBe(false)
    for (const [field, value] of [
      ['id', 'cloud-gi'],
      ['state', 'approved'],
      ['detail', ''],
      ['detail', 'x'.repeat(513)],
      ['detail', 'secret\nline'],
    ] as const)
      expect(
        captureRuntimeSchema.safeParse({
          ...runtime,
          effects: runtime.effects.map((effect, i) => (i ? effect : { ...effect, [field]: value })),
        }).success,
      ).toBe(false)
    expect(
      captureRuntimeSchema.safeParse({ ...runtime, adapter: 'bad\u0000adapter' }).success,
    ).toBe(false)
    expect(
      captureRuntimeSchema.safeParse({
        ...runtime,
        effects: runtime.effects.map((effect) =>
          effect.id === 'mirror' ? { ...effect, state: 'enabled' } : effect,
        ),
      }).success,
    ).toBe(false)
  })

  it('preserves all domain holds verbatim, including order, duplicates and ceiling/access caveats', async () => {
    for (const sample of samples) {
      const job = await createCaptureJob('hold-audit', sample.id, sample.request, build)
      const receipt = receiptFixture(job)
      await expect(validateCaptureReceipt(receipt, job)).resolves.toMatchObject({
        holds: receipt.holds,
      })
      for (const holds of [
        receipt.holds.slice(1),
        [...receipt.holds].reverse(),
        [...receipt.holds, receipt.holds[0]],
        ['Approved by unit test'],
      ])
        await expect(validateCaptureReceipt({ ...receipt, holds }, job)).rejects.toMatchObject({
          code: 'invalid-input',
        })
    }
  })
})

describe('negative publication, attempt, cancellation and stale-result boundaries', () => {
  it.each(CAPTURE_FAILURE_CODES)(
    'retains typed %s failure, never an artifact/marker fallback',
    async (code) => {
      const job = await jobFixture()
      const result = {
        protocol: CAPTURE_PROTOCOL,
        state: 'failed',
        jobId: job.jobId,
        captureDigest: job.identity.captureDigest,
        code,
        message: 'Synthetic failure',
        elapsedMs: 0,
        flags: CAPTURE_FLAGS,
      }
      expect(validateWorkerResult(result, job)).toMatchObject({ state: 'failed', code })
      expect(validateCaptureTerminal(result, job)).toMatchObject({ state: 'failed', code })
      for (const extra of [
        { pngBase64: 'A'.repeat(44) },
        { marker: markerFixture(job) },
        { artifact: receiptFixture(job).artifact },
      ])
        expect(captureTerminalSchema.safeParse({ ...result, ...extra }).success).toBe(false)
    },
  )

  it('rejects stale results, receipts and terminal markers even for identical logical designs', async () => {
    const job = await jobFixture()
    const stale = await createCaptureJob('older-attempt', sample.id, sample.request, build)
    expect(stale.identity).toEqual(job.identity)
    expect(() => validateWorkerResult(workerFixture(stale), job)).toThrow()
    await expect(validateCaptureReceipt(receiptFixture(stale), job)).rejects.toMatchObject({
      code: 'identity-mismatch',
    })
    expect(() => validateCaptureTerminal(terminalFixture(stale), job)).toThrow()
    expect(() =>
      validateCaptureTerminal({ ...terminalFixture(job), marker: markerFixture(stale) }, job),
    ).toThrow()
    for (const filename of ['../image.png', '/tmp/image.png', 'https://example.invalid/image.png'])
      expect(
        captureCompleteSchema.safeParse(
          changed(markerFixture(job), ['image', 'filename'], filename),
        ).success,
      ).toBe(false)
  })

  it('rejects wrong observed camera, frame counts, profile dimensions and pixel accounting', async () => {
    const job = await jobFixture()
    const worker = workerFixture(job)
    for (const camera of [
      { ...worker.camera, position: [0, 0, 0] },
      { ...worker.camera, target: [0, 0, 0] },
      { ...worker.camera, up: [0, 0, 1] },
      { ...worker.camera, fov: 1 },
      { ...worker.camera, near: 0.05 },
      { ...worker.camera, far: 1000 },
      { ...worker.camera, units: 'metres' },
    ])
      expect(() => validateWorkerResult({ ...worker, camera }, job)).toThrow()
    for (const renderedFrames of [0, 7, 65, Infinity, NaN])
      expect(() => validateWorkerResult({ ...worker, renderedFrames }, job)).toThrow()
    for (const [field, value] of [
      ['width', 400],
      ['height', 500],
      ['rgbaBytes', 1],
      ['opaquePixels', 1],
    ] as const)
      await expect(
        validateCaptureReceipt(
          changed(receiptFixture(job), ['artifact', 'pixels', field], value),
          job,
        ),
      ).rejects.toMatchObject({ code: 'invalid-artifact' })
  })

  it('rejects progress regression and checks cancellation before expiry at the exact boundary', async () => {
    const job = await jobFixture()
    const progress = {
      protocol: CAPTURE_PROTOCOL,
      jobId: job.jobId,
      captureDigest: job.identity.captureDigest,
      sequence: 5,
      phase: 'settling',
      elapsedMs: 500,
      renderedFrames: 8,
    }
    const previous = validateCaptureProgress(progress, job)
    for (const delta of [
      { sequence: 4 },
      { sequence: 5 },
      { elapsedMs: 499 },
      { renderedFrames: 7 },
      { phase: 'loading' },
      { jobId: 'another' },
      { captureDigest: digest('f') },
    ])
      expect(() =>
        validateCaptureProgress({ ...progress, sequence: 6, ...delta }, job, previous),
      ).toThrow()
    const signal = new AbortController()
    assertCaptureActive(signal.signal, 999, 1000)
    for (const [now, deadline] of [
      [1000, 1000],
      [1001, 1000],
      [NaN, 1000],
      [1, Infinity],
    ])
      expect(() => assertCaptureActive(signal.signal, now, deadline)).toThrowError(/deadline/)
    signal.abort()
    expect(() => assertCaptureActive(signal.signal, 1000, 1000)).toThrowError(/cancelled/)
  })

  it('rejects corrupted histories, duplicate IDs, orphan retries, active children and successful repeats', () => {
    const initial: CaptureAttempt = {
      jobId: 'attempt-one',
      sampleId: sample.id,
      kind: 'sample',
      state: 'failed',
    }
    const retry: CaptureAttempt = { ...initial, jobId: 'attempt-two', kind: 'diagnostic-retry' }
    for (const history of [
      [retry],
      [initial, initial],
      [initial, { ...initial, jobId: 'duplicate-initial' }],
      [{ ...initial, state: 'succeeded' }, retry],
    ])
      expect(() => assertCanStartAttempt(history, samples[1].id, 'sample')).toThrow()
    expect(() =>
      assertCanStartAttempt([{ ...initial, state: 'running' }], samples[1].id, 'sample'),
    ).toThrow()
    expect(() =>
      assertCanStartAttempt([{ ...initial, state: 'succeeded' }], sample.id, 'diagnostic-retry'),
    ).toThrow()
    const eight: CaptureAttempt[] = [
      ...samples.map((s, i) => ({
        jobId: `attempt-${i}`,
        sampleId: s.id,
        kind: 'sample' as const,
        state: 'failed' as const,
      })),
      { ...retry, jobId: 'retry-one' },
      { ...retry, jobId: 'retry-two' },
    ]
    expect(() => assertCanStartAttempt(eight, sample.id, 'diagnostic-retry')).toThrow()
    expect(() =>
      assertCanStartAttempt(
        [initial, retry, { ...retry, jobId: 'retry-three' }, { ...retry, jobId: 'retry-four' }],
        sample.id,
        'diagnostic-retry',
      ),
    ).toThrow()
  })
})

describe('explicit protocol limits: structural success is NOT independent capture evidence', () => {
  it('demonstrates echoed identity and synthesized camera/effects can pass without observing a scene', async () => {
    const job = await jobFixture()
    // This is a verified contract gap, NOT an acceptable worker implementation or render proof.
    // There is no applied-config/scene-resource receipt in WorkerResult; the PNG below is invalid.
    expect(validateWorkerResult(workerFixture(job), job).state).toBe('captured')
    await expect(validateCaptureReceipt(receiptFixture(job), job)).resolves.toMatchObject({
      state: 'validated-draft-capture',
    })
    expect(validateCaptureTerminal(terminalFixture(job), job).state).toBe('complete')
    // Even applicability can be misreported: independent scene inspection remains mandatory.
    const stress = samples[4]
    const stressJob = await createCaptureJob('synthetic-stress', stress.id, stress.request, build)
    const receipt = receiptFixture(stressJob)
    receipt.runtime = {
      ...receipt.runtime,
      effects: receipt.runtime.effects.map((effect) =>
        ['thin-glass', 'mirror', 'console-canvas', 'signature-canvas', 'site-light-field'].includes(
          effect.id,
        )
          ? { ...effect, state: 'not-applicable' as const }
          : effect,
      ),
    }
    await expect(validateCaptureReceipt(receipt, stressJob)).resolves.toBeDefined()
  })

  it('demonstrates byte-header helper is not a PNG decoder or a rendered-subject test', async () => {
    const profile = LOCAL_REVIEW_PROFILES.wide
    const rgba = new Uint8Array(profile.width * profile.height * 4)
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = (i / 4) % 256
      rgba[i + 3] = 255
    }
    // Deliberately no IDAT, CRC or IEND: a real independent PNG decoder MUST reject these bytes.
    const headerOnly = new Uint8Array(44)
    headerOnly.set([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(headerOnly.buffer)
    view.setUint32(8, 13)
    view.setUint32(12, 0x49484452)
    view.setUint32(16, profile.width)
    view.setUint32(20, profile.height)
    expect(
      inspectDecodedPixels(profile, profile.width, profile.height, rgba).distinctRgbAtLeast,
    ).toBe(256)
    await expect(
      validateDecodedArtifact(profile, headerOnly, {
        width: profile.width,
        height: profile.height,
        rgba,
      }),
    ).resolves.toMatchObject({ bytes: 44 })
  })

  it('demonstrates a terminal shape is not byte-readback proof or persisted attempt accounting', async () => {
    const job = await jobFixture()
    const terminal = terminalFixture(job)
    const inconsistent = changed(terminal, ['marker', 'image', 'pixels', 'rgbaBytes'], 1)
    expect(validateCaptureTerminal(inconsistent, job).state).toBe('complete')
    // The schema does not read files or enforce append-only storage across invocations.
    assertCanStartAttempt([], sample.id, 'sample')
    assertCanStartAttempt([], sample.id, 'sample')
  })
})
