import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { designReviewHolds, projectDesignToConfig } from '../../../domain/design'
import { designIdentity } from '../../../domain/designIdentity'
import { LOCAL_RENDER_SAMPLES } from '../../../domain/localRenderSlice'
import {
  CAPTURE_EFFECTS,
  CAPTURE_FLAGS,
  CAPTURE_LIMITS,
  CAPTURE_PROTOCOL,
  LOCAL_REVIEW_PROFILES,
  SAMPLE_IDS,
  CaptureContractError,
  assertCanStartAttempt,
  assertCaptureActive,
  captureArtifactSchema,
  captureBuildSchema,
  captureCompleteSchema,
  captureIdentity,
  captureProfileSchema,
  captureReceiptSchema,
  captureRequestSchema,
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
  type CaptureAttempt,
  type CaptureBuild,
  type CaptureFailureCode,
} from './contract'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const build: CaptureBuild = {
  sourceManifestDigest: hash('a'),
  assetManifestDigest: hash('b'),
  bundleDigest: hash('c'),
  lockfileDigest: hash('d'),
  threeRevision: '186',
}
const samples = createCaptureSamples()
const sample = samples[0]
const newJob = () => createCaptureJob('test-attempt-1', sample.id, sample.request, build)
const omissions = new Set([
  'ambient-occlusion',
  'screen-space-gi',
  'screen-space-reflections',
  'bloom',
  'path-tracing',
])
const runtime = () => ({
  backend: 'webgl2',
  acceleration: 'software',
  adapter: 'Synthetic test adapter, not a measured renderer',
  browserVersion: 'Test only',
  userAgent: 'Test only',
  effects: CAPTURE_EFFECTS.map((id) => ({
    id,
    state: omissions.has(id) ? 'omitted' : id === 'mirror' ? 'approximate' : 'enabled',
    detail: 'Synthetic protocol test only',
  })),
})
function expectCode(fn: () => unknown, code: CaptureFailureCode) {
  try {
    fn()
    expect.fail('Expected contract rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureContractError)
    expect((error as CaptureContractError).code).toBe(code)
  }
}
function rgbaFixture() {
  const { width, height } = LOCAL_REVIEW_PROFILES.wide
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = (i / 4) % 256
    rgba[i + 3] = 255
  }
  return { width, height, rgba }
}
/** Genuine synthetic PNG bytes, for contract tests only; never written or claimed as a capture. */
function pngFixture(decoded = rgbaFixture()) {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(decoded.width, 0)
  ihdr.writeUInt32BE(decoded.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const scanlines = Buffer.alloc((decoded.width * 4 + 1) * decoded.height)
  for (let y = 0; y < decoded.height; y++)
    scanlines.set(
      decoded.rgba.subarray(y * decoded.width * 4, (y + 1) * decoded.width * 4),
      y * (decoded.width * 4 + 1) + 1,
    )
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', new Uint8Array()),
  ])
}
async function receiptFixture() {
  const job = await newJob()
  const artifact = await validateDecodedArtifact(job.profile, pngFixture(), rgbaFixture())
  return {
    protocol: CAPTURE_PROTOCOL,
    state: 'validated-draft-capture',
    job,
    artifact,
    camera: resolveCaptureCamera(job.request.design),
    runtime: runtime(),
    renderedFrames: 8,
    elapsedMs: 100,
    holds: designReviewHolds(job.request.design),
    flags: CAPTURE_FLAGS,
  }
}

describe('private local capture authority', () => {
  it('preserves six prior compositions and adds the single non-aliased Bronze comparison', () => {
    expect(samples.map((s) => s.id)).toEqual(SAMPLE_IDS)
    expect(samples.slice(0, 4).map((s) => s.request.design.config.product)).toEqual([
      { family: 'studio', lengthFt: 20 },
      { family: 'studio', lengthFt: 40 },
      { family: 'container', lengthFt: 20 },
      { family: 'container', lengthFt: 40 },
    ])
    expect(samples.slice(0, 6).map((s) => s.request.design.presentation.aspect)).toEqual([
      'wide',
      'tall',
      'wide',
      'tall',
      'wide',
      'wide',
    ])
    expect(
      samples.slice(0, 6).map((s) => projectDesignToConfig(s.request.design).items.length),
    ).toEqual([3, 6, 3, 6, 6, 6])
    expect(samples[4].request.design.config.structure.addons).toEqual([])
    expect(samples[4].request.design.presentation).toMatchObject({
      lookRef: 'courtyard-night-draft@1',
      cameraRef: 'centre-draft@1',
      doorPose: 'open',
    })
    expect(samples[5].request.design.config.structure.addons).toEqual([
      'canopy',
      'deck',
      'roof',
      'stairs',
    ])
    expect(samples[5].request.design.presentation).toMatchObject({
      lookRef: 'courtyard-day-draft@1',
      cameraRef: 'top-draft@1',
      doorPose: 'open',
    })
    expect(samples).toHaveLength(7)
    for (const selected of LOCAL_RENDER_SAMPLES) {
      const matches = samples.filter((entry) => entry.id === selected.id)
      expect(matches).toHaveLength(1)
      expect(matches[0].request.design).toEqual(selected.design)
    }
    expect(samples[6].role).toBe('local-finish-comparison')
    expect(samples[6].request.profileId).toBe(LOCAL_REVIEW_PROFILES.wide.id)
  })

  it('snapshots deeply, fixes output settings, and leaves every qualification flag false', () => {
    const raw = captureRequestSchema.parse(sample.request)
    const parsed = parseCaptureRequest(raw)
    raw.design.config.appearance.finish = 'chalk'
    expect(parsed.design.config.appearance.finish).toBe('obsidian')
    expect(Object.isFrozen(parsed.design.config.appearance)).toBe(true)
    expect(Object.isFrozen(LOCAL_REVIEW_PROFILES.wide)).toBe(true)
    expect(Object.values(CAPTURE_FLAGS).every((v) => v === false)).toBe(true)
    for (const profile of Object.values(LOCAL_REVIEW_PROFILES)) {
      expect(captureProfileSchema.parse(profile)).toEqual(profile)
      expect(captureProfileSchema.safeParse({ ...profile, width: 1600 }).success).toBe(false)
      expect(captureProfileSchema.safeParse({ ...profile, samples: 1024 }).success).toBe(false)
    }
  })

  it.each(['url', 'path', 'meshes', 'script', 'shader', 'items', 'backend', 'deadlineMs'])(
    'rejects arbitrary %s ingress',
    (key) => {
      expect(() => parseCaptureRequest({ ...sample.request, [key]: 'injected' })).toThrow()
    },
  )

  it('rejects unknown/future/legacy design, equipment edits, aspect mismatch and oversized UTF-8', () => {
    const unknown = structuredClone(sample.request)
    expect(() =>
      parseCaptureRequest({ ...unknown, design: { ...unknown.design, items: [] } }),
    ).toThrow()
    expect(() =>
      parseCaptureRequest({
        ...unknown,
        design: { ...unknown.design, config: { ...unknown.design.config, schemaVersion: 5 } },
      }),
    ).toThrow()
    expect(() =>
      parseCaptureRequest({ ...unknown, design: projectDesignToConfig(unknown.design) }),
    ).toThrow()
    expect(() => parseCaptureRequest({ ...unknown, profileId: 'local-review-tall@1' })).toThrow()
    expectCode(
      () => parseCaptureRequestText('é'.repeat(CAPTURE_LIMITS.requestBytes)),
      'invalid-input',
    )
    expect(parseCaptureRequestText(JSON.stringify(sample.request))).toEqual(sample.request)
    expect(() => parseCaptureRequestText('{')).toThrow()
  })

  it('uses domain logical identity and independently binds selected pose/look/door/aspect and source metadata', async () => {
    const original = await captureIdentity(sample.request, build)
    expect(original).toMatchObject(await designIdentity(sample.request.design))
    for (const field of [
      'sourceManifestDigest',
      'assetManifestDigest',
      'bundleDigest',
      'lockfileDigest',
    ] as const) {
      const changed = await captureIdentity(sample.request, { ...build, [field]: hash('e') })
      expect(changed.designDigest).toBe(original.designDigest)
      expect(changed.captureDigest).not.toBe(original.captureDigest)
    }
    for (const presentation of [
      { cameraRef: 'entry-draft@1' },
      { lookRef: 'courtyard-night-draft@1' },
      { doorPose: 'open' },
      { aspect: 'tall' },
    ]) {
      const request = {
        ...sample.request,
        design: {
          ...sample.request.design,
          presentation: { ...sample.request.design.presentation, ...presentation },
        },
        profileId: presentation.aspect ? LOCAL_REVIEW_PROFILES.tall.id : sample.request.profileId,
      }
      const changed = await captureIdentity(request, build)
      expect(changed.designDigest).toBe(original.designDigest)
      expect(changed.presentationDigest).not.toBe(original.presentationDigest)
      expect(changed.captureDigest).not.toBe(original.captureDigest)
    }
    const changed = await captureIdentity(
      { ...sample.request, design: { ...sample.request.design, outputProfile: 'web-thumbnail' } },
      build,
    )
    expect(changed.requestDigest).not.toBe(original.requestDigest)
    expect(changed.captureDigest).not.toBe(original.captureDigest)
  })

  it('rejects stale identities, profiles, unpinned compositions and unexpected page builds', async () => {
    const job = await newJob()
    await expect(validateCaptureJob(job, build)).resolves.toEqual(job)
    await expect(
      validateCaptureJob({ ...job, identity: { ...job.identity, captureDigest: hash('f') } }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(
      validateCaptureJob({ ...job, profile: LOCAL_REVIEW_PROFILES.tall }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(
      validateCaptureJob(job, { ...build, bundleDigest: hash('f') }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(
      createCaptureJob('attempt-2', sample.id, samples[1].request, build),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(
      captureBuildSchema.safeParse({ ...build, assetUrl: 'https://invalid.example' }).success,
    ).toBe(false)
    expect(Object.isFrozen(job.build)).toBe(true)
    for (const selected of samples)
      await expect(
        createCaptureJob('accepted-job', selected.id, selected.request, build),
      ).resolves.toMatchObject({ sampleId: selected.id })
  })
})

describe('worker protocol, bounded attempts and truthful failures', () => {
  it('separates page readiness from backend support and checks exact worker bindings and camera', async () => {
    const job = await newJob()
    expect(
      validateWorkerReady(
        { protocol: CAPTURE_PROTOCOL, state: 'ready', build, flags: CAPTURE_FLAGS },
        build,
      ).state,
    ).toBe('ready')
    expectCode(
      () =>
        validateWorkerReady(
          { protocol: CAPTURE_PROTOCOL, state: 'ready', build, flags: CAPTURE_FLAGS },
          { ...build, bundleDigest: hash('f') },
        ),
      'identity-mismatch',
    )
    const result = {
      protocol: CAPTURE_PROTOCOL,
      jobId: job.jobId,
      captureDigest: job.identity.captureDigest,
      state: 'captured',
      pngBase64: pngFixture().toString('base64'),
      camera: resolveCaptureCamera(job.request.design),
      runtime: runtime(),
      renderedFrames: 8,
      elapsedMs: 100,
      flags: CAPTURE_FLAGS,
    }
    expect(validateWorkerResult(result, job).state).toBe('captured')
    expectCode(
      () =>
        validateWorkerResult(
          { ...result, camera: { ...result.camera, fov: result.camera.fov + 1 } },
          job,
        ),
      'identity-mismatch',
    )
    expectCode(
      () => validateWorkerResult({ ...result, jobId: 'stale-job' }, job),
      'identity-mismatch',
    )
    expect(() =>
      validateWorkerResult({ ...result, pngBase64: 'data:image/png;base64,AA==' }, job),
    ).toThrow()
  })

  it('reports all runtime effects and denies unsupported parity/qualification claims', () => {
    expect(captureRuntimeSchema.parse(runtime()).acceleration).toBe('software')
    const duplicate = runtime()
    duplicate.effects[0] = duplicate.effects[1]
    expect(captureRuntimeSchema.safeParse(duplicate).success).toBe(false)
    const planar = runtime()
    planar.effects.find((e) => e.id === 'mirror')!.state = 'enabled'
    expect(captureRuntimeSchema.safeParse(planar).success).toBe(false)
    const traced = runtime()
    traced.effects.find((e) => e.id === 'path-tracing')!.state = 'enabled'
    expect(captureRuntimeSchema.safeParse(traced).success).toBe(false)
    expect(captureRuntimeSchema.safeParse({ ...runtime(), approved: true }).success).toBe(false)
  })

  it('validates monotonic bounded progress, never progress=complete', async () => {
    const job = await newJob()
    const p = {
      protocol: CAPTURE_PROTOCOL,
      jobId: job.jobId,
      captureDigest: job.identity.captureDigest,
      sequence: 0,
      phase: 'loading',
      elapsedMs: 0,
      renderedFrames: 0,
    }
    const first = validateCaptureProgress(p, job)
    expect(
      validateCaptureProgress(
        { ...p, phase: 'settling', sequence: 1, elapsedMs: 1, renderedFrames: 8 },
        job,
        first,
      ).phase,
    ).toBe('settling')
    expectCode(() => validateCaptureProgress(p, job, first), 'invalid-input')
    expectCode(() => validateCaptureProgress({ ...p, jobId: 'stale' }, job), 'identity-mismatch')
    expect(() => validateCaptureProgress({ ...p, phase: 'complete' }, job)).toThrow()
    expect(() => validateCaptureProgress({ ...p, sequence: 128 }, job)).toThrow()
  })

  it('distinguishes cancellation and deadlines from renderer and pixel failures', async () => {
    const signal = new AbortController()
    assertCaptureActive(signal.signal, 1, 2)
    expectCode(() => assertCaptureActive(signal.signal, 2, 2), 'timeout')
    signal.abort()
    expectCode(() => assertCaptureActive(signal.signal, 2, 2), 'cancelled')
    const job = await newJob()
    for (const code of ['cancelled', 'timeout', 'bad-pixels', 'unsupported-renderer'] as const) {
      const terminal = {
        protocol: CAPTURE_PROTOCOL,
        jobId: job.jobId,
        captureDigest: job.identity.captureDigest,
        state: 'failed',
        code,
        elapsedMs: CAPTURE_LIMITS.jobMs + 10,
        message: 'Bounded test failure',
        flags: CAPTURE_FLAGS,
      }
      expect(validateCaptureTerminal(terminal, job)).toMatchObject({ state: 'failed', code })
      expect(captureTerminalSchema.safeParse({ ...terminal, marker: {} }).success).toBe(false)
    }
  })

  it('permits the one approved extra retry while preserving concurrency, repeat and total limits', () => {
    const history: CaptureAttempt[] = []
    assertCanStartAttempt(history, sample.id, 'sample')
    history.push({ jobId: 'one', sampleId: sample.id, kind: 'sample', state: 'running' })
    expectCode(() => assertCanStartAttempt(history, samples[1].id, 'sample'), 'limit-exceeded')
    history[0] = { ...history[0], state: 'failed' }
    assertCanStartAttempt(history, sample.id, 'diagnostic-retry')
    expectCode(() => assertCanStartAttempt(history, sample.id, 'sample'), 'limit-exceeded')
    expectCode(
      () => assertCanStartAttempt(history, samples[1].id, 'diagnostic-retry'),
      'limit-exceeded',
    )
    history.push({ jobId: 'two', sampleId: sample.id, kind: 'diagnostic-retry', state: 'failed' })
    history.push({ jobId: 'three', sampleId: sample.id, kind: 'diagnostic-retry', state: 'failed' })
    assertCanStartAttempt(history, sample.id, 'diagnostic-retry')
    history.push({ jobId: 'four', sampleId: sample.id, kind: 'diagnostic-retry', state: 'failed' })
    expectCode(
      () => assertCanStartAttempt(history, sample.id, 'diagnostic-retry'),
      'limit-exceeded',
    )
    const complete: CaptureAttempt[] = samples.slice(0, 6).map((s, index) => ({
      jobId: `done-${index}`,
      sampleId: s.id,
      kind: 'sample',
      state: 'succeeded',
    }))
    expect(CAPTURE_LIMITS).toMatchObject({
      successfulSamples: 6,
      attempts: 8,
      diagnosticRetries: 3,
      concurrency: 1,
      jobMs: 180_000,
      runMs: 1_530_000,
    })
    expectCode(() => assertCanStartAttempt(complete, samples[6].id, 'sample'), 'limit-exceeded')
    expectCode(
      () => assertCanStartAttempt(complete, sample.id, 'diagnostic-retry'),
      'limit-exceeded',
    )
    expectCode(
      () => assertCanStartAttempt([complete[0], complete[0]], samples[1].id, 'sample'),
      'invalid-input',
    )
  })
})

describe('decoded evidence and exclusive publication metadata', () => {
  it('checks real bounded bytes separately from logical equality and decoded pixel sanity', async () => {
    const decoded = rgbaFixture(),
      png = pngFixture(decoded)
    const artifact = await validateDecodedArtifact(LOCAL_REVIEW_PROFILES.wide, png, decoded)
    expect(artifact.digest).toBe(`sha256:${createHash('sha256').update(png).digest('hex')}`)
    expect(artifact.pixels).toMatchObject({
      width: 640,
      height: 400,
      rgbaBytes: 640 * 400 * 4,
      opaquePixels: 640 * 400,
      distinctRgbAtLeast: 256,
    })
    expect(captureArtifactSchema.parse(artifact)).toEqual(artifact)
    expectCode(
      () =>
        inspectDecodedPixels(
          LOCAL_REVIEW_PROFILES.tall,
          decoded.width,
          decoded.height,
          decoded.rgba,
        ),
      'invalid-artifact',
    )
    const pngWrong = Buffer.from(png)
    pngWrong.writeUInt32BE(123, 16)
    await expect(
      validateDecodedArtifact(LOCAL_REVIEW_PROFILES.wide, pngWrong, decoded),
    ).rejects.toMatchObject({ code: 'invalid-artifact' })
    await expect(
      validateDecodedArtifact(
        LOCAL_REVIEW_PROFILES.wide,
        new Uint8Array(CAPTURE_LIMITS.pngBytes + 1),
        decoded,
      ),
    ).rejects.toMatchObject({ code: 'invalid-artifact' })
    await expect(
      validateDecodedArtifact(
        LOCAL_REVIEW_PROFILES.wide,
        new TextEncoder().encode('<svg>not an image</svg>'),
        decoded,
      ),
    ).rejects.toMatchObject({ code: 'invalid-artifact' })
  })

  it.each(['transparent', 'solid-black', 'solid-white', 'low-range'])(
    'rejects %s decoded pixels without substituting a stub',
    (bad) => {
      const d = rgbaFixture()
      if (bad === 'transparent') d.rgba[3] = 0
      else
        for (let i = 0; i < d.rgba.length; i += 4) {
          const level = bad === 'solid-white' ? 255 : bad === 'low-range' ? (i / 4) % 4 : 0
          d.rgba[i] = d.rgba[i + 1] = d.rgba[i + 2] = level
        }
      expectCode(
        () => inspectDecodedPixels(LOCAL_REVIEW_PROFILES.wide, d.width, d.height, d.rgba),
        'bad-pixels',
      )
    },
  )

  it('requires consistent receipt identity, camera, domain holds, effects and qualification flags', async () => {
    const receipt = await receiptFixture()
    await expect(validateCaptureReceipt(receipt, receipt.job)).resolves.toMatchObject({
      state: 'validated-draft-capture',
    })
    await expect(
      validateCaptureReceipt({ ...receipt, holds: ['approved'] }, receipt.job),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      validateCaptureReceipt(
        { ...receipt, camera: { ...receipt.camera, near: 0.05 } },
        receipt.job,
      ),
    ).rejects.toThrow()
    const missing = runtime()
    missing.effects.find((e) => e.id === 'material-textures')!.state = 'omitted'
    await expect(
      validateCaptureReceipt({ ...receipt, runtime: missing }, receipt.job),
    ).rejects.toMatchObject({ code: 'scene-failed' })
    expect(
      captureReceiptSchema.safeParse({
        ...receipt,
        flags: { ...CAPTURE_FLAGS, productionAllowed: true },
      }).success,
    ).toBe(false)
  })

  it('reserves complete for an exact publication marker, not page capture or progress', async () => {
    const receipt = await receiptFixture()
    const marker = {
      protocol: CAPTURE_PROTOCOL,
      state: 'complete-draft-capture',
      jobId: receipt.job.jobId,
      captureDigest: receipt.job.identity.captureDigest,
      image: receipt.artifact,
      receipt: { filename: 'receipt.json', bytes: 1234, digest: hash('e') },
      flags: CAPTURE_FLAGS,
    }
    expect(captureCompleteSchema.parse(marker)).toEqual(marker)
    const terminal = {
      protocol: CAPTURE_PROTOCOL,
      state: 'complete',
      jobId: receipt.job.jobId,
      captureDigest: receipt.job.identity.captureDigest,
      marker,
      flags: CAPTURE_FLAGS,
    }
    expect(validateCaptureTerminal(terminal, receipt.job).state).toBe('complete')
    expectCode(
      () =>
        validateCaptureTerminal({ ...terminal, marker: { ...marker, jobId: 'old' } }, receipt.job),
      'identity-mismatch',
    )
    expect(
      captureCompleteSchema.safeParse({
        ...marker,
        image: { ...marker.image, filename: '../old.png' },
      }).success,
    ).toBe(false)
    expect(captureTerminalSchema.safeParse({ ...terminal, state: 'captured' }).success).toBe(false)
  })
})
