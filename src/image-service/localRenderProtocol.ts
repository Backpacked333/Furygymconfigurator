import { z } from 'zod'
import {
  DESIGN_CATALOG_VERSION,
  designEnvelopeSchema,
  designReviewHolds,
  freezeDesignValue,
  parseDesign,
} from '../domain/design'
import { designIdentity, type DesignIdentity } from '../domain/designIdentity'
import { LOCAL_RENDER_SAMPLE_IDS, matchLocalRenderSample } from '../domain/localRenderSlice'
export {
  LOCAL_RENDER_SAMPLES,
  localRenderDesign,
  matchLocalRenderSample,
} from '../domain/localRenderSlice'
export type { LocalRenderSampleId } from '../domain/localRenderSlice'

/** Browser-safe wire shapes only: no Node, Three, private capture, mock-v1 or fetch imports. */
export const LOCAL_RENDER_PROTOCOL = 'fury.local-render-images' as const
export const LOCAL_RENDER_PROTOCOL_VERSION = 1 as const
export const LOCAL_RENDER_MODE = 'local-real' as const
export const LOCAL_RENDER_API_PREFIX = '/__fury-prototype/local-render/v1' as const
export const LOCAL_RENDER_REQUEST_PATH = `${LOCAL_RENDER_API_PREFIX}/images` as const
export const LOCAL_RENDER_LABEL = 'Local render — unqualified software preview' as const
export const MAX_LOCAL_RENDER_REQUEST_BYTES = 16 * 1024
export const MAX_LOCAL_RENDER_REPLY_BYTES = 64 * 1024
export const MAX_LOCAL_RENDER_PNG_BYTES = 2 * 1024 * 1024

/** Actual output, not the domain's aspirational web-hero dimensions. Kept wire-only. */
export const LOCAL_RENDER_PROFILE = Object.freeze({
  version: 1,
  purpose: 'draft-local-integration-review',
  quality: 'lite',
  pipeline: 'three-tsl-raster-lite',
  pixelRatio: 1,
  msaaSamples: 4,
  minFrames: 8,
  maxFrames: 64,
  quietMs: 500,
  postReadyFrames: 2,
  format: 'image/png',
  colorSpace: 'srgb',
  toneMapping: 'AgX',
  maxPngBytes: MAX_LOCAL_RENDER_PNG_BYTES,
  deadlineMs: 180_000,
  id: 'local-review-wide@1',
  aspect: 'wide',
  width: 640,
  height: 400,
} as const)
export const localRenderProfileSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal('draft-local-integration-review'),
    quality: z.literal('lite'),
    pipeline: z.literal('three-tsl-raster-lite'),
    pixelRatio: z.literal(1),
    msaaSamples: z.literal(4),
    minFrames: z.literal(8),
    maxFrames: z.literal(64),
    quietMs: z.literal(500),
    postReadyFrames: z.literal(2),
    format: z.literal('image/png'),
    colorSpace: z.literal('srgb'),
    toneMapping: z.literal('AgX'),
    maxPngBytes: z.literal(MAX_LOCAL_RENDER_PNG_BYTES),
    deadlineMs: z.literal(180_000),
    id: z.literal('local-review-wide@1'),
    aspect: z.literal('wide'),
    width: z.literal(640),
    height: z.literal(400),
  })
  .strict()
export const localRenderDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const localRenderInterestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{24,128}$/)
export const localRenderRequestIdentitySchema = z
  .object({
    designDigest: localRenderDigestSchema,
    presentationDigest: localRenderDigestSchema,
    requestDigest: localRenderDigestSchema,
  })
  .strict()
export const localRenderBuildSchema = z
  .object({
    sourceManifestDigest: localRenderDigestSchema,
    assetManifestDigest: localRenderDigestSchema,
    bundleDigest: localRenderDigestSchema,
    lockfileDigest: localRenderDigestSchema,
    threeRevision: z.string().regex(/^\d{1,4}$/),
  })
  .strict()
export const localRenderCaptureBindingSchema = z
  .object({
    captureDigest: localRenderDigestSchema,
    build: localRenderBuildSchema,
    profile: localRenderProfileSchema,
  })
  .strict()
export type LocalRenderBuild = z.infer<typeof localRenderBuildSchema>
export type LocalRenderCaptureBinding = z.infer<typeof localRenderCaptureBindingSchema>
const version = {
  protocol: z.literal(LOCAL_RENDER_PROTOCOL),
  protocolVersion: z.literal(LOCAL_RENDER_PROTOCOL_VERSION),
  mode: z.literal(LOCAL_RENDER_MODE),
}
export const LOCAL_RENDER_FLAGS = Object.freeze({
  productionAllowed: false,
  paidExecutionAllowed: false,
  strictReference: false,
  g1Qualified: false,
  visualParityClaimed: false,
} as const)
const flagsSchema = z
  .object({
    productionAllowed: z.literal(false),
    paidExecutionAllowed: z.literal(false),
    strictReference: z.literal(false),
    g1Qualified: z.literal(false),
    visualParityClaimed: z.literal(false),
  })
  .strict()
export const localRenderRequestSchema = z
  .object({ ...version, design: designEnvelopeSchema })
  .strict()
export type LocalRenderRequest = ReturnType<typeof parseLocalRenderRequest>
export class UnsupportedLocalRenderDesignError extends Error {
  readonly code = 'unsupported-design' as const
  constructor() {
    super(
      'No matching rendered preview: only the two pinned Studio-20 front-left wide designs are supported.',
    )
  }
}
export function parseLocalRenderRequest(input: unknown) {
  const request = localRenderRequestSchema.parse(input)
  if (!matchLocalRenderSample(request.design)) throw new UnsupportedLocalRenderDesignError()
  return freezeDesignValue(request)
}
export function parseLocalRenderRequestText(text: string): LocalRenderRequest {
  if (new TextEncoder().encode(text).byteLength > MAX_LOCAL_RENDER_REQUEST_BYTES)
    throw new Error('Local render request exceeds byte cap.')
  return parseLocalRenderRequest(JSON.parse(text))
}
export function createLocalRenderRequest(design: unknown): LocalRenderRequest {
  return parseLocalRenderRequest({
    protocol: LOCAL_RENDER_PROTOCOL,
    protocolVersion: LOCAL_RENDER_PROTOCOL_VERSION,
    mode: LOCAL_RENDER_MODE,
    design,
  })
}

/** The host must independently check DEV/serve/not-preview and both explicit server flags. */
export function isLocalRenderSelection(dev: boolean, search: string): boolean {
  const query = new URLSearchParams(search)
  return (
    dev &&
    query.getAll('prototype').length === 1 &&
    query.get('prototype') === 'images' &&
    query.getAll('imageMode').length === 1 &&
    query.get('imageMode') === LOCAL_RENDER_MODE
  )
}
export function localRenderStatusPath(interestId: string): string {
  return `${LOCAL_RENDER_API_PREFIX}/image-jobs/${localRenderInterestIdSchema.parse(interestId)}`
}
export function localRenderCancelPath(interestId: string): string {
  return `${localRenderStatusPath(interestId)}/cancel`
}
export function localRenderImagePath(interestId: string, checksum: string): string {
  return `${localRenderStatusPath(interestId)}/image/${localRenderDigestSchema.parse(checksum).slice(7)}.png`
}
export const localRenderCancelRequestSchema = z
  .object({
    ...version,
    interestId: localRenderInterestIdSchema,
  })
  .strict()
export function createLocalRenderCancelRequest(interestId: string) {
  return localRenderCancelRequestSchema.parse({
    protocol: LOCAL_RENDER_PROTOCOL,
    protocolVersion: LOCAL_RENDER_PROTOCOL_VERSION,
    mode: LOCAL_RENDER_MODE,
    interestId,
  })
}
const note = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (text) =>
      Array.from(text).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    'No control characters.',
  )
export const localRenderErrorSchema = z
  .object({
    code: z.enum([
      'invalid-json',
      'invalid-request',
      'body-too-large',
      'unsupported-media-type',
      'unsupported-design',
      'not-found',
      'method-not-allowed',
      'forbidden',
      'production-denied',
      'capacity-exceeded',
      'unavailable',
      'identity-mismatch',
      'invalid-artifact',
      'capture-failed',
      'timeout',
      'expired',
    ]),
    message: note,
    // No automatic capture retries; any diagnostic retry requires operator admission to SAME ledger.
    retryable: z.literal(false),
  })
  .strict()
export type LocalRenderError = z.infer<typeof localRenderErrorSchema>
export const localRenderErrorReplySchema = z
  .object({ ...version, error: localRenderErrorSchema })
  .strict()
export type LocalRenderErrorReply = z.infer<typeof localRenderErrorReplySchema>

/** Receipt observations copied to wire, not fabricated browser capability detection. */
export const LOCAL_RENDER_EFFECTS = [
  'architecture',
  'fixed-equipment',
  'material-textures',
  'console-canvas',
  'signature-canvas',
  'environment',
  'fixture-lighting',
  'interior-probe',
  'site-probe',
  'site-light-field',
  'thin-glass',
  'mirror',
  'msaa',
  'ambient-occlusion',
  'screen-space-gi',
  'screen-space-reflections',
  'bloom',
  'path-tracing',
] as const
export const localRenderRuntimeSchema = z
  .object({
    backend: z.literal('webgl2'),
    acceleration: z.literal('software'),
    adapter: note.refine((value) => /swiftshader|software/i.test(value)),
    browserVersion: note,
    userAgent: note,
    effects: z
      .array(
        z
          .object({
            id: z.enum(LOCAL_RENDER_EFFECTS),
            state: z.enum(['enabled', 'approximate', 'omitted', 'not-applicable']),
            detail: note,
          })
          .strict(),
      )
      .length(LOCAL_RENDER_EFFECTS.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.effects.map((effect) => effect.id)).size !== LOCAL_RENDER_EFFECTS.length)
      context.addIssue({ code: 'custom', message: 'Every runtime effect must be reported once.' })
    for (const id of [
      'ambient-occlusion',
      'screen-space-gi',
      'screen-space-reflections',
      'bloom',
      'path-tracing',
    ])
      if (value.effects.find((effect) => effect.id === id)?.state !== 'omitted')
        context.addIssue({ code: 'custom', message: `${id} is omitted in Lite.` })
    if (value.effects.find((effect) => effect.id === 'mirror')?.state === 'enabled')
      context.addIssue({ code: 'custom', message: 'Lite mirror is not planar reflection.' })
    for (const id of [
      'architecture',
      'fixed-equipment',
      'material-textures',
      'environment',
      'fixture-lighting',
      'interior-probe',
      'site-probe',
      'msaa',
    ])
      if (value.effects.find((effect) => effect.id === id)?.state !== 'enabled')
        context.addIssue({ code: 'custom', message: `Missing required capability: ${id}.` })
  })
export const localRenderArtifactSchema = z
  .object({
    checksum: localRenderDigestSchema,
    mediaType: z.literal('image/png'),
    src: z
      .string()
      .max(320)
      .regex(
        /^\/__fury-prototype\/local-render\/v1\/image-jobs\/[A-Za-z0-9_-]{24,128}\/image\/[a-f0-9]{64}\.png$/,
      ),
    width: z.literal(640),
    height: z.literal(400),
    byteLength: z.number().int().min(44).max(MAX_LOCAL_RENDER_PNG_BYTES),
    exactMatch: z.literal(true),
    approvedCurrentImage: z.literal(false),
    cacheStatus: z.enum(['verified-exact-hit', 'captured-miss']),
    provenance: z
      .object({
        kind: z.literal('local-three-capture'),
        label: z.literal(LOCAL_RENDER_LABEL),
        captureProtocol: z.literal('fury.local-three-capture@1'),
        jobId: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9][a-z0-9-]*$/),
        sampleId: z.enum(LOCAL_RENDER_SAMPLE_IDS),
        receiptDigest: localRenderDigestSchema,
        runtime: localRenderRuntimeSchema,
        holds: z.array(note).min(1).max(32),
        flags: flagsSchema,
      })
      .strict(),
  })
  .strict()
export type LocalRenderArtifact = z.infer<typeof localRenderArtifactSchema>
const replyBase = {
  ...version,
  catalogVersion: z.literal(DESIGN_CATALOG_VERSION),
  productionAllowed: z.literal(false),
  interestId: localRenderInterestIdSchema,
  requested: localRenderRequestIdentitySchema,
  capture: localRenderCaptureBindingSchema,
}
export const localRenderReplySchema = z.discriminatedUnion('state', [
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
  z
    .object({ ...replyBase, state: z.literal('ready'), artifact: localRenderArtifactSchema })
    .strict(),
  z.object({ ...replyBase, state: z.literal('failed'), error: localRenderErrorSchema }).strict(),
  z.object({ ...replyBase, state: z.literal('expired') }).strict(),
  z
    .object({
      ...replyBase,
      state: z.literal('cancelled'),
      cancellationScope: z.literal('interest-only'),
      sharedWorkCancelled: z.literal(false),
    })
    .strict(),
])
export type LocalRenderReply = z.infer<typeof localRenderReplySchema>
export type LocalRenderReadyReply = Extract<LocalRenderReply, { state: 'ready' }>
export type LocalRenderPendingReply = Extract<LocalRenderReply, { state: 'queued' | 'rendering' }>
export type LocalRenderSubmissionReply =
  { status: 200; body: LocalRenderReadyReply } | { status: 202; body: LocalRenderPendingReply }
export function localRenderReplyBase(
  interestId: string,
  requested: DesignIdentity,
  capture: unknown,
) {
  return {
    protocol: LOCAL_RENDER_PROTOCOL,
    protocolVersion: LOCAL_RENDER_PROTOCOL_VERSION,
    mode: LOCAL_RENDER_MODE,
    catalogVersion: DESIGN_CATALOG_VERSION,
    productionAllowed: false as const,
    interestId: localRenderInterestIdSchema.parse(interestId),
    // A private capture identity has one additional digest; keep it in capture, not requested.
    requested: localRenderRequestIdentitySchema.parse({
      designDigest: requested.designDigest,
      presentationDigest: requested.presentationDigest,
      requestDigest: requested.requestDigest,
    }),
    capture: localRenderCaptureBindingSchema.parse(capture),
  }
}

/** Node validates captureDigest against current sources/assets/profile via the PRIVATE contract.
 * Browser checks logical binding, immutable status binding and bytes; JSON alone is not a capture.
 * After every await/decode the client must also compare its selection generation with the latest.
 */
export async function parseLocalRenderReply(
  input: unknown,
  expectedDesign: unknown,
  expectedInterestId?: string,
  expectedCapture?: LocalRenderCaptureBinding,
): Promise<LocalRenderReply> {
  const reply = localRenderReplySchema.parse(input)
  const request = createLocalRenderRequest(expectedDesign)
  const expected = await designIdentity(request.design)
  if (JSON.stringify(reply.requested) !== JSON.stringify(expected))
    throw new Error('Local render reply does not match the requested revision.')
  if (
    expectedInterestId !== undefined &&
    reply.interestId !== localRenderInterestIdSchema.parse(expectedInterestId)
  )
    throw new Error('Local render reply belongs to a different interest.')
  if (
    expectedCapture !== undefined &&
    JSON.stringify(reply.capture) !==
      JSON.stringify(localRenderCaptureBindingSchema.parse(expectedCapture))
  )
    throw new Error('Local render capture/build/profile changed during polling.')
  if (reply.state === 'ready') {
    const artifact = reply.artifact
    if (
      artifact.src !== localRenderImagePath(reply.interestId, artifact.checksum) ||
      artifact.provenance.sampleId !== matchLocalRenderSample(request.design)!.id ||
      JSON.stringify(artifact.provenance.holds) !==
        JSON.stringify(designReviewHolds(request.design))
    )
      throw new Error('Local render artifact route, sample or review holds do not match.')
  }
  return reply
}
export async function parseLocalRenderSubmissionReply(
  status: number,
  input: unknown,
  expectedDesign: unknown,
): Promise<LocalRenderSubmissionReply> {
  const body = await parseLocalRenderReply(input, expectedDesign)
  if (status === 200 && body.state === 'ready') return { status, body }
  if (status === 202 && (body.state === 'queued' || body.state === 'rendering'))
    return { status, body }
  throw new Error('Local render submission HTTP status and state disagree.')
}
export async function parseLocalRenderStatusReply(
  input: unknown,
  expectedDesign: unknown,
  interestId: string,
  capture: LocalRenderCaptureBinding,
) {
  return parseLocalRenderReply(input, expectedDesign, interestId, capture)
}
export async function parseLocalRenderCancelReply(
  input: unknown,
  expectedDesign: unknown,
  interestId: string,
  capture: LocalRenderCaptureBinding,
) {
  const reply = await parseLocalRenderReply(input, expectedDesign, interestId, capture)
  if (reply.state !== 'cancelled') throw new Error('Expected interest-only cancellation.')
  return reply
}

export type LocalRenderImageDecoder = (
  bytes: Uint8Array,
) => Promise<{ width: number; height: number }>
/** Separate from JSON: hash actual bytes, inspect PNG header, then independently decode same bytes.
 * Browser decoder must use createImageBitmap/Image.decode; Node uses decodeCapturePng plus pixel
 * checks. An injected decoder is a test seam, never evidence of a real capture by itself.
 */
export async function validateLocalRenderImage(
  input: unknown,
  inputBytes: Uint8Array,
  decode: LocalRenderImageDecoder,
): Promise<void> {
  const artifact = localRenderArtifactSchema.parse(input)
  if (
    inputBytes.byteLength !== artifact.byteLength ||
    inputBytes.byteLength > MAX_LOCAL_RENDER_PNG_BYTES
  )
    throw new Error('Local render image byte length differs.')
  const bytes = new Uint8Array(inputBytes)
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
    throw new Error('Expected PNG bytes, never SVG/mock/historical substitution.')
  const header = new DataView(bytes.buffer)
  if (
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) !== artifact.width ||
    header.getUint32(20) !== artifact.height
  )
    throw new Error('PNG dimensions differ from the local profile.')
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const checksum = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  if (checksum !== artifact.checksum) throw new Error('PNG byte checksum differs.')
  const decoded = await decode(bytes)
  if (decoded.width !== artifact.width || decoded.height !== artifact.height)
    throw new Error('Decoded PNG dimensions differ from the local profile.')
}

/** Compare a captured submission with the current full envelope, never just its finish. */
export function isCurrentLocalRenderDesign(submitted: unknown, current: unknown): boolean {
  return JSON.stringify(parseDesign(submitted)) === JSON.stringify(parseDesign(current))
}
