import { describe, expect, it } from 'vitest'
import { defaultDesign, designEnvelopeSchema } from '../domain/design'
import { createDesignFixtures } from '../domain/designFixtures'
import { designIdentity, sha256Text } from '../domain/designIdentity'
import { transitionDesign } from '../domain/designTransitions'
import {
  IMAGE_PROTOCOL,
  IMAGE_PROTOCOL_VERSION,
  IMAGE_REQUEST_PATH,
  MAX_IMAGE_REQUEST_BYTES,
  MOCK_ARTIFACT_LABEL,
  PROTOTYPE_API_PREFIX,
  createImageCancelRequest,
  createImageRequest,
  createMockArtifact,
  imageCancelPath,
  imageCancelRequestSchema,
  imageErrorReplySchema,
  imageReplyBase,
  imageReplySchema,
  imageRequestSchema,
  imageStatusPath,
  mockArtifactSchema,
  parseImageCancelReply,
  parseImageReply,
  parseImageStatusReply,
  parseImageSubmissionReply,
} from './protocol'

const interest = 'local_interest_12345678901234567890'
const otherInterest = 'other_interest_12345678901234567890'
async function ready(design: unknown = defaultDesign()) {
  return {
    ...imageReplyBase(interest, await designIdentity(design)),
    state: 'ready' as const,
    artifact: await createMockArtifact(design),
  }
}

describe('frozen DEV mock image wire protocol', () => {
  it('uses only the versioned DEV endpoint namespace and an explicit 16 KiB byte cap constant', () => {
    expect(PROTOTYPE_API_PREFIX).toBe('/__fury-prototype/v1')
    expect(IMAGE_REQUEST_PATH).toBe('/__fury-prototype/v1/images')
    expect(MAX_IMAGE_REQUEST_BYTES).toBe(16384)
    expect(imageStatusPath(interest)).toBe(`${PROTOTYPE_API_PREFIX}/image-jobs/${interest}`)
    expect(imageCancelPath(interest)).toBe(`${imageStatusPath(interest)}/cancel`)
    expect(createImageCancelRequest(interest)).toEqual({
      protocol: IMAGE_PROTOCOL,
      protocolVersion: 1,
      interestId: interest,
    })
    expect(() => imageStatusPath('../admin')).toThrow()
    expect(() => imageStatusPath('short')).toThrow()
    expect(
      imageCancelRequestSchema.safeParse({ ...createImageCancelRequest(interest), cancelAll: true })
        .success,
    ).toBe(false)
  })

  it('accepts only strict wrapper/envelope inputs with no client renderer settings or identity claims', () => {
    const request = createImageRequest(defaultDesign(), 'idempotency_key_123456')
    expect(imageRequestSchema.parse(request)).toEqual(request)
    for (const input of [
      { ...request, protocolVersion: 2 },
      { ...request, protocol: 'fury.images' },
      { ...request, requestDigest: 'sha256:fake' },
      { ...request, principalId: 'someone' },
      { ...request, samples: 1024 },
      { ...request, assetUrl: 'https://invalid.example' },
      { ...request, idempotencyKey: 'with space' },
      { ...request, design: { ...request.design, unexpected: true } },
    ])
      expect(imageRequestSchema.safeParse(input).success).toBe(false)
  })

  it('defines deterministic diagnostic bytes with real byte checksum, never current-image/cache success', async () => {
    for (const design of createDesignFixtures()) {
      const [artifact, repeated] = await Promise.all([
        createMockArtifact(design),
        createMockArtifact(design),
      ])
      expect(artifact).toEqual(repeated)
      const svg = decodeURIComponent(artifact.src.split(',')[1])
      expect(svg).toContain('MOCK DIAGNOSTIC')
      expect(svg).toContain('NOT A CURRENT DESIGN IMAGE')
      expect(svg).not.toContain('<image')
      expect(svg).not.toContain('<script')
      expect(artifact.checksum).toBe(await sha256Text(svg))
      expect(artifact.artifactId).toBe(artifact.checksum)
      expect(artifact.artifactId).not.toBe((await designIdentity(design)).requestDigest)
      expect(artifact.byteLength).toBe(new TextEncoder().encode(svg).byteLength)
      expect(artifact.exactMatch).toBe(false)
      expect(artifact.approvedCurrentImage).toBe(false)
      expect(artifact.provenance.label).toBe(MOCK_ARTIFACT_LABEL)
      expect(artifact.cacheStatus).toBe('not-a-production-cache-result')
      expect(mockArtifactSchema.parse(artifact)).toEqual(artifact)
    }
  })

  it('covers both aspects/profiles with deterministic dimensions and distinct bytes', async () => {
    const checksums = new Set<string>()
    for (const aspect of ['wide', 'tall'] as const)
      for (const outputProfile of ['web-hero', 'web-thumbnail'] as const) {
        const base = defaultDesign()
        const artifact = await createMockArtifact({
          ...base,
          presentation: { ...base.presentation, aspect },
          outputProfile,
        })
        expect(artifact.width / artifact.height).toBe(aspect === 'wide' ? 1.6 : 0.8)
        checksums.add(artifact.checksum)
      }
    expect(checksums.size).toBe(4)
  })

  it('accepts identity-checked 200 ready and 202 pending replies but rejects mismatched HTTP semantics', async () => {
    const design = defaultDesign()
    const completed = await ready(design)
    const queued = {
      ...imageReplyBase(interest, await designIdentity(design)),
      state: 'queued',
      retryAfterMs: 250,
    }
    expect((await parseImageSubmissionReply(200, completed, design)).body.state).toBe('ready')
    expect((await parseImageSubmissionReply(202, queued, design)).body.state).toBe('queued')
    expect(
      (await parseImageSubmissionReply(202, { ...queued, state: 'rendering' }, design)).body.state,
    ).toBe('rendering')
    await expect(parseImageSubmissionReply(202, completed, design)).rejects.toThrow()
    await expect(parseImageSubmissionReply(200, queued, design)).rejects.toThrow()
    await expect(parseImageSubmissionReply(201, completed, design)).rejects.toThrow()
  })

  it('validates every job terminal state and interest-only cancellation', async () => {
    const design = defaultDesign()
    const base = imageReplyBase(interest, await designIdentity(design))
    const failed = {
      ...base,
      state: 'failed',
      error: { code: 'internal-error', message: 'Mock failure.', retryable: true },
    }
    const cancelled = {
      ...base,
      state: 'cancelled',
      cancellationScope: 'interest-only',
      sharedWorkCancelled: false,
    }
    expect((await parseImageStatusReply(failed, design, interest)).state).toBe('failed')
    expect(
      (await parseImageStatusReply({ ...base, state: 'expired' }, design, interest)).state,
    ).toBe('expired')
    expect((await parseImageCancelReply(cancelled, design, interest)).state).toBe('cancelled')
    await expect(parseImageCancelReply(failed, design, interest)).rejects.toThrow()
    expect(imageReplySchema.safeParse({ ...cancelled, sharedWorkCancelled: true }).success).toBe(
      false,
    )
    expect(
      imageReplySchema.safeParse({ ...base, state: 'leased', workerCommand: 'run' }).success,
    ).toBe(false)
  })

  it('rejects wrong request/design/presentation identities and cross-interest replies', async () => {
    const design = defaultDesign()
    const reply = await ready(design)
    for (const field of ['designDigest', 'presentationDigest', 'requestDigest']) {
      await expect(
        parseImageReply(
          { ...reply, requested: { ...reply.requested, [field]: `sha256:${'0'.repeat(64)}` } },
          design,
        ),
      ).rejects.toThrow(/requested revision/)
    }
    await expect(parseImageStatusReply(reply, design, otherInterest)).rejects.toThrow(
      /different interest/,
    )
    const newer = transitionDesign(design, {
      type: 'update-appearance',
      patch: { finish: 'chalk' },
    }).next
    await expect(parseImageReply(reply, newer)).rejects.toThrow(/requested revision/)
  })

  it('rejects forged approval, historical provenance, asset URLs, mismatched metadata and corrupt diagnostic bytes', async () => {
    const design = defaultDesign()
    const reply = await ready(design)
    for (const patch of [
      { exactMatch: true },
      { approvedCurrentImage: true },
      { cacheStatus: 'hit' },
      { provenance: { ...reply.artifact.provenance, kind: 'historical-reference' } },
      { src: 'https://example.invalid/render.png' },
      { src: 'data:image/svg+xml;charset=utf-8,%3Csvg%20onload%3D%22evil()%22%2F%3E' },
      { width: 1 },
      { height: 1 },
      { byteLength: 1 },
      { checksum: `sha256:${'0'.repeat(64)}` },
      { artifactId: reply.requested.requestDigest },
      { unknown: true },
    ])
      await expect(
        parseImageReply({ ...reply, artifact: { ...reply.artifact, ...patch } }, design),
      ).rejects.toThrow()
    for (const patch of [
      { productionAllowed: true },
      { mode: 'production' },
      { protocolVersion: 99 },
      { extra: true },
    ])
      await expect(parseImageReply({ ...reply, ...patch }, design)).rejects.toThrow()
  })

  it('snapshots expected design before async validation, rejecting stale identity independently of arrival order', async () => {
    const mutable = designEnvelopeSchema.parse(defaultDesign())
    const oldReply = await ready(mutable)
    const validation = parseImageReply(oldReply, mutable)
    mutable.config.appearance.finish = 'bronze'
    expect((await validation).requested).toEqual(oldReply.requested)
    const newReply = await ready(mutable)
    const [fresh, stale] = await Promise.allSettled([
      parseImageReply(newReply, mutable),
      parseImageReply(oldReply, mutable),
    ])
    expect(fresh.status).toBe('fulfilled')
    expect(stale.status).toBe('rejected')
  })

  it('bounds retry hints and typed errors rather than accepting arbitrary JSON', () => {
    const error = {
      protocol: IMAGE_PROTOCOL,
      protocolVersion: IMAGE_PROTOCOL_VERSION,
      mode: 'mock',
      error: {
        code: 'body-too-large',
        message: 'Uncompressed JSON exceeds 16384 bytes.',
        retryable: false,
      },
    }
    expect(imageErrorReplySchema.parse(error)).toEqual(error)
    expect(
      imageErrorReplySchema.safeParse({ ...error, error: { ...error.error, code: 'whatever' } })
        .success,
    ).toBe(false)
    expect(
      imageErrorReplySchema.safeParse({ ...error, error: { ...error.error, stack: 'private' } })
        .success,
    ).toBe(false)
    const base = imageReplyBase(interest, {
      designDigest: `sha256:${'a'.repeat(64)}`,
      presentationDigest: `sha256:${'b'.repeat(64)}`,
      requestDigest: `sha256:${'c'.repeat(64)}`,
    })
    for (const retryAfterMs of [-1, 0, 99, 30001, Infinity])
      expect(imageReplySchema.safeParse({ ...base, state: 'queued', retryAfterMs }).success).toBe(
        false,
      )
  })
})
