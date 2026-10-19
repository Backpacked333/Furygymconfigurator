import { z } from 'zod'
import {
  DESIGN_CATALOG_VERSION,
  designEnvelopeSchema,
  parseDesign,
  type DesignEnvelope,
} from '../domain/design'
import { designIdentity, sha256Text, type DesignIdentity } from '../domain/designIdentity'

/** DEV-only, local, mock-only. The hosting integration MUST NOT mount this in production. */
export const PROTOTYPE_API_PREFIX = '/__fury-prototype/v1' as const
export const IMAGE_REQUEST_PATH = `${PROTOTYPE_API_PREFIX}/images` as const
export const IMAGE_PROTOCOL = 'fury.prototype-images' as const
export const IMAGE_PROTOCOL_VERSION = 1 as const
/** Enforce on uncompressed UTF-8 bytes BEFORE JSON parsing in the HTTP adapter. */
export const MAX_IMAGE_REQUEST_BYTES = 16 * 1024
export const MOCK_ARTIFACT_LABEL = 'MOCK DIAGNOSTIC — NOT A CURRENT DESIGN IMAGE' as const
export const MOCK_GENERATOR_VERSION = 'diagnostic-svg@1' as const
export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
export const digestSchema = z.string().regex(SHA256_PATTERN)
/** Server-issued random interests, not request hashes, principal IDs or artifact authorizations. */
export const interestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{24,128}$/)
export const requestIdentitySchema = z
  .object({
    designDigest: digestSchema,
    presentationDigest: digestSchema,
    requestDigest: digestSchema,
  })
  .strict()
const wireVersion = {
  protocol: z.literal(IMAGE_PROTOCOL),
  protocolVersion: z.literal(IMAGE_PROTOCOL_VERSION),
}
export const imageRequestSchema = z
  .object({
    ...wireVersion,
    design: designEnvelopeSchema,
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,128}$/)
      .optional(),
  })
  .strict()
export type ImageRequest = z.infer<typeof imageRequestSchema>
export function parseImageRequest(input: unknown): ImageRequest {
  return imageRequestSchema.parse(input)
}
export function createImageRequest(design: unknown, idempotencyKey?: string): ImageRequest {
  return parseImageRequest({
    protocol: IMAGE_PROTOCOL,
    protocolVersion: IMAGE_PROTOCOL_VERSION,
    design: parseDesign(design),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  })
}

// GET /image-jobs/:interestId; POST /image-jobs/:interestId/cancel with this versioned body.
export const imageStatusRequestSchema = z
  .object({ ...wireVersion, interestId: interestIdSchema })
  .strict()
export const imageCancelRequestSchema = imageStatusRequestSchema
export type ImageStatusRequest = z.infer<typeof imageStatusRequestSchema>
export type ImageCancelRequest = z.infer<typeof imageCancelRequestSchema>
export function imageStatusPath(interestId: string): string {
  return `${PROTOTYPE_API_PREFIX}/image-jobs/${interestIdSchema.parse(interestId)}`
}
export function imageCancelPath(interestId: string): string {
  return `${imageStatusPath(interestId)}/cancel`
}
export function createImageCancelRequest(interestId: string): ImageCancelRequest {
  return imageCancelRequestSchema.parse({
    protocol: IMAGE_PROTOCOL,
    protocolVersion: IMAGE_PROTOCOL_VERSION,
    interestId,
  })
}

export const imageErrorCodeSchema = z.enum([
  'invalid-json',
  'invalid-request',
  'body-too-large',
  'unsupported-media-type',
  'not-found',
  'capacity-exceeded',
  'idempotency-conflict',
  'identity-mismatch',
  'production-denied',
  'internal-error',
  'expired',
  'method-not-allowed',
  'forbidden',
  'unavailable',
])
export const imageErrorSchema = z
  .object({
    code: imageErrorCodeSchema,
    message: z.string().min(1).max(240),
    retryable: z.boolean(),
  })
  .strict()
export type ImageError = z.infer<typeof imageErrorSchema>
export const imageErrorReplySchema = z
  .object({ ...wireVersion, mode: z.literal('mock'), error: imageErrorSchema })
  .strict()
export type ImageErrorReply = z.infer<typeof imageErrorReplySchema>

/**
 * The sole v1 artifact format is an inline percent-encoded diagnostic SVG, generated below.
 * No asset URL, historical bake, current-design image or approved cache hit is accepted.
 * artifactId/checksum hash the ACTUAL diagnostic SVG bytes, never a presumed renderer release.
 */
export const mockArtifactSchema = z
  .object({
    artifactId: digestSchema,
    checksum: digestSchema,
    mediaType: z.literal('image/svg+xml'),
    src: z
      .string()
      .max(16 * 1024)
      .startsWith('data:image/svg+xml;charset=utf-8,'),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(12 * 1024),
    exactMatch: z.literal(false),
    approvedCurrentImage: z.literal(false),
    cacheStatus: z.literal('not-a-production-cache-result'),
    provenance: z
      .object({
        kind: z.literal('mock-diagnostic'),
        generatorVersion: z.literal(MOCK_GENERATOR_VERSION),
        label: z.literal(MOCK_ARTIFACT_LABEL),
        productionAllowed: z.literal(false),
      })
      .strict(),
  })
  .strict()
export type MockArtifact = z.infer<typeof mockArtifactSchema>
const replyBase = {
  ...wireVersion,
  mode: z.literal('mock'),
  catalogVersion: z.literal(DESIGN_CATALOG_VERSION),
  productionAllowed: z.literal(false),
  interestId: interestIdSchema,
  requested: requestIdentitySchema,
}
export const imageReplySchema = z.discriminatedUnion('state', [
  z
    .object({
      ...replyBase,
      state: z.literal('queued'),
      retryAfterMs: z.number().int().min(100).max(30000),
    })
    .strict(),
  z
    .object({
      ...replyBase,
      state: z.literal('rendering'),
      retryAfterMs: z.number().int().min(100).max(30000),
    })
    .strict(),
  z.object({ ...replyBase, state: z.literal('ready'), artifact: mockArtifactSchema }).strict(),
  z.object({ ...replyBase, state: z.literal('failed'), error: imageErrorSchema }).strict(),
  z
    .object({
      ...replyBase,
      state: z.literal('cancelled'),
      cancellationScope: z.literal('interest-only'),
      sharedWorkCancelled: z.literal(false),
    })
    .strict(),
  z.object({ ...replyBase, state: z.literal('expired') }).strict(),
])
export type ImageReply = z.infer<typeof imageReplySchema>
export type ImageJobState = ImageReply['state']
export type ImageReadyReply = Extract<ImageReply, { state: 'ready' }>
export type ImagePendingReply = Extract<ImageReply, { state: 'queued' | 'rendering' }>
export type ImageSubmissionReply = Readonly<
  { status: 200; body: ImageReadyReply } | { status: 202; body: ImagePendingReply }
>

export function imageReplyBase(interestId: string, requested: DesignIdentity) {
  return {
    protocol: IMAGE_PROTOCOL,
    protocolVersion: IMAGE_PROTOCOL_VERSION,
    mode: 'mock' as const,
    catalogVersion: DESIGN_CATALOG_VERSION,
    productionAllowed: false as const,
    interestId: interestIdSchema.parse(interestId),
    requested: requestIdentitySchema.parse(requested),
  }
}

/** Fixed dimensions are diagnostic-only, not a promise for the eventual approved web profiles. */
export function mockArtifactDimensions(design: DesignEnvelope): { width: number; height: number } {
  const tall = design.presentation.aspect === 'tall'
  return design.outputProfile === 'web-thumbnail'
    ? tall
      ? { width: 240, height: 300 }
      : { width: 320, height: 200 }
    : tall
      ? { width: 600, height: 750 }
      : { width: 960, height: 600 }
}

/** Pure deterministic SVG recipe: no I/O, provider calls, user text or arbitrary SVG injection. */
export async function createMockArtifact(input: unknown): Promise<MockArtifact> {
  const design = parseDesign(input)
  const identity = await designIdentity(design)
  const { width, height } = mockArtifactDimensions(design)
  const { product } = design.config
  // A fixed 960x600 diagnostic canvas scales with the declared aspect; it is not product geometry.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 960 600"><desc>Mock diagnostic request ${identity.requestDigest}</desc><rect width="960" height="600" fill="#18221f"/><rect x="24" y="24" width="912" height="116" rx="8" fill="#f3cc73"/><text x="48" y="74" font-family="sans-serif" font-size="26" font-weight="bold" fill="#18221f">MOCK DIAGNOSTIC</text><text x="48" y="114" font-family="sans-serif" font-size="24" fill="#18221f">NOT A CURRENT DESIGN IMAGE</text><g font-family="sans-serif" fill="#edf1eb" font-size="24"><text x="48" y="212">DRAFT ${product.family} ${product.lengthFt} ft · ${design.config.appearance.finish}</text><text x="48" y="264">${design.presentation.lookRef}</text><text x="48" y="316">${design.presentation.cameraRef} · ${design.presentation.aspect}</text><text x="48" y="380" font-size="17">Request ${identity.requestDigest.slice(7, 39)}</text><text x="48" y="450">No renderer, approved image or production cache hit.</text><text x="48" y="494">Arrangement, access, ceiling and art approval on hold.</text></g></svg>`
  const checksum = await sha256Text(svg)
  return mockArtifactSchema.parse({
    artifactId: checksum,
    checksum,
    mediaType: 'image/svg+xml',
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width,
    height,
    byteLength: new TextEncoder().encode(svg).byteLength,
    exactMatch: false,
    approvedCurrentImage: false,
    cacheStatus: 'not-a-production-cache-result',
    provenance: {
      kind: 'mock-diagnostic',
      generatorVersion: MOCK_GENERATOR_VERSION,
      label: MOCK_ARTIFACT_LABEL,
      productionAllowed: false,
    },
  })
}

/**
 * Runtime response validation MUST accompany fetch().json(): schema alone is not identity matching.
 * Captured expectedDesign must be the submitted revision. UI must additionally compare that
 * revision with its latest selection AFTER asynchronous validation/decode before displaying it.
 */
export async function parseImageReply(
  input: unknown,
  expectedDesign: unknown,
  expectedInterestId?: string,
): Promise<ImageReply> {
  const reply = imageReplySchema.parse(input)
  const design = parseDesign(expectedDesign)
  const expected = await designIdentity(design)
  for (const key of ['designDigest', 'presentationDigest', 'requestDigest'] as const)
    if (reply.requested[key] !== expected[key])
      throw new Error(`Image reply ${key} does not match the requested revision.`)
  if (
    expectedInterestId !== undefined &&
    reply.interestId !== interestIdSchema.parse(expectedInterestId)
  )
    throw new Error('Image reply belongs to a different interest.')
  if (reply.state === 'ready') {
    const artifact = await createMockArtifact(design)
    // Parsing produces a fixed key order, making this comparison independent of incoming JSON order.
    if (JSON.stringify(reply.artifact) !== JSON.stringify(artifact))
      throw new Error('Diagnostic artifact metadata or bytes do not match the requested revision.')
  }
  return reply
}
export async function parseImageSubmissionReply(
  status: number,
  input: unknown,
  expectedDesign: unknown,
): Promise<ImageSubmissionReply> {
  const body = await parseImageReply(input, expectedDesign)
  if (status === 200 && body.state === 'ready') return { status, body }
  if (status === 202 && (body.state === 'queued' || body.state === 'rendering'))
    return { status, body }
  throw new Error('Image submission HTTP status and state do not agree.')
}
export async function parseImageStatusReply(
  input: unknown,
  expectedDesign: unknown,
  expectedInterestId: string,
): Promise<ImageReply> {
  return parseImageReply(input, expectedDesign, expectedInterestId)
}
export async function parseImageCancelReply(
  input: unknown,
  expectedDesign: unknown,
  expectedInterestId: string,
): Promise<Extract<ImageReply, { state: 'cancelled' }>> {
  const reply = await parseImageReply(input, expectedDesign, expectedInterestId)
  if (reply.state !== 'cancelled')
    throw new Error('Cancel must acknowledge only this interest as cancelled.')
  return reply
}
