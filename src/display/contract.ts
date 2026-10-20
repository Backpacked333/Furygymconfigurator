import { z } from 'zod'
import {
  designEnvelopeSchema,
  designReviewHolds,
  freezeDesignValue,
  parseDesign,
} from '../domain/design'
import { designIdentity, sha256Text } from '../domain/designIdentity'

/** Frozen browser-safe display contract. No renderer, Node, P04 or Lite imports. */
export const DISPLAY_PROTOCOL = 'fury.private-display@1' as const
export const DISPLAY_MODE = 'private-display' as const
export const DISPLAY_API_PREFIX = '/__fury-display/v1' as const
export const DISPLAY_REQUEST_PATH = `${DISPLAY_API_PREFIX}/images` as const
export const DISPLAY_LABEL = 'Private Three display candidate — unqualified' as const
export const DISPLAY_FLAGS = Object.freeze({
  productionAllowed: false,
  paidExecutionAllowed: false,
  strictReference: false,
  qualified: false,
  visualParityClaimed: false,
} as const)
export const DISPLAY_LIMITS = Object.freeze({
  requestBytes: 16 * 1024,
  replyBytes: 64 * 1024,
  pngBytes: 16 * 1024 * 1024,
  activeSessions: 1,
  activeJobs: 1,
  queuedJobs: 4,
  interests: 32,
  startupMs: 60_000,
  jobMs: 180_000,
  idleMs: 30_000,
  lifetimeMs: 600_000,
  cleanupMs: 5_000,
  jobsPerSession: 24,
  sessionOutputBytes: 128 * 1024 * 1024,
  cacheBytes: 256 * 1024 * 1024,
  cacheEntries: 64,
  interestMs: 600_000,
} as const)
const commonProfile = {
  version: 1,
  purpose: 'display-only',
  quality: 'ultra',
  pipeline: 'three-tsl-raster-ultra',
  backend: 'webgpu',
  pixelRatio: 1,
  colorSpace: 'srgb',
  toneMapping: 'AgX',
  format: 'image/png',
  temporalFrames: 40,
  quietMs: 500,
  postReadyFrames: 2,
  maxFrames: 240,
  motionBlur: false,
  pathTracing: false,
  fallbackAllowed: false,
} as const
/** Full supported raster effects, NOT a strict/Cycles export or an art-quality promise. */
export const DISPLAY_PROFILES = freezeDesignValue({
  wide: {
    ...commonProfile,
    id: 'three-display-wide-ultra@1',
    aspect: 'wide',
    width: 1600,
    height: 1000,
  },
  tall: {
    ...commonProfile,
    id: 'three-display-portrait-ultra@1',
    aspect: 'tall',
    width: 1200,
    height: 1500,
  },
})
export type DisplayProfile = (typeof DISPLAY_PROFILES)[keyof typeof DISPLAY_PROFILES]
export const displayDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const displayIdSchema = z.string().regex(/^[A-Za-z0-9_-]{24,128}$/)
export const displayBuildSchema = z
  .object({
    sourceManifestDigest: displayDigestSchema,
    assetManifestDigest: displayDigestSchema,
    bundleDigest: displayDigestSchema,
    lockfileDigest: displayDigestSchema,
    runtimePolicyDigest: displayDigestSchema,
    threeRevision: z.string().regex(/^\d{1,4}$/),
  })
  .strict()
export type DisplayBuild = Readonly<z.infer<typeof displayBuildSchema>>
const identitySchema = z
  .object({
    designDigest: displayDigestSchema,
    presentationDigest: displayDigestSchema,
    requestDigest: displayDigestSchema,
  })
  .strict()
function literalProfile<T extends DisplayProfile>(profile: T) {
  // Exact canonical profile equality: no resolution, quality or temporal override accepted.
  return z.custom<T>((value) => {
    try {
      return stableDisplayJson(value) === stableDisplayJson(profile)
    } catch {
      return false
    }
  }, 'Expected a fixed full-quality display profile.')
}
export const displayProfileSchema = z.union([
  literalProfile(DISPLAY_PROFILES.wide),
  literalProfile(DISPLAY_PROFILES.tall),
])
export function displayProfileFor(design: unknown): DisplayProfile {
  return DISPLAY_PROFILES[parseDesign(design).presentation.aspect]
}
export const displayBindingSchema = z
  .object({
    requested: identitySchema,
    build: displayBuildSchema,
    profile: displayProfileSchema,
    displayDigest: displayDigestSchema,
  })
  .strict()
export type DisplayBinding = Readonly<z.infer<typeof displayBindingSchema>>

/** Restricted canonical JSON; inputs must additionally pass their strict domain/schema parser. */
export function stableDisplayJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableDisplayJson).join(',')}]`
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableDisplayJson(entry)}`)
      .join(',')}}`
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value)
  throw new Error('Noncanonical display value.')
}
export async function bindDisplay(design: unknown, build: unknown): Promise<DisplayBinding> {
  const value = {
    requested: await designIdentity(design),
    build: displayBuildSchema.parse(build),
    profile: displayProfileFor(design),
  }
  return freezeDesignValue({
    ...value,
    displayDigest: await sha256Text(stableDisplayJson({ protocol: DISPLAY_PROTOCOL, ...value })),
  })
}
export const displayRequestSchema = z
  .object({ protocol: z.literal(DISPLAY_PROTOCOL), design: designEnvelopeSchema })
  .strict()
export function createDisplayRequest(design: unknown) {
  return freezeDesignValue(displayRequestSchema.parse({ protocol: DISPLAY_PROTOCOL, design }))
}
export function parseDisplayRequestText(text: string) {
  if (new TextEncoder().encode(text).byteLength > DISPLAY_LIMITS.requestBytes)
    throw new Error('Display request byte cap.')
  return freezeDesignValue(displayRequestSchema.parse(JSON.parse(text)))
}
export function isDisplaySelection(dev: boolean, search: string) {
  const query = new URLSearchParams(search)
  return (
    dev &&
    query.getAll('prototype').length === 1 &&
    query.get('prototype') === 'images' &&
    query.getAll('imageMode').length === 1 &&
    query.get('imageMode') === DISPLAY_MODE
  )
}
export function displayStatusPath(interestId: string) {
  return `${DISPLAY_API_PREFIX}/jobs/${displayIdSchema.parse(interestId)}`
}
export function displayCancelPath(interestId: string) {
  return `${displayStatusPath(interestId)}/cancel`
}
export function displayImagePath(interestId: string, checksum: string) {
  return `${displayStatusPath(interestId)}/image/${displayDigestSchema.parse(checksum).slice(7)}.png`
}
export const displayCancelSchema = z.object({ protocol: z.literal(DISPLAY_PROTOCOL) }).strict()
export const displayErrorSchema = z
  .object({
    code: z.enum([
      'invalid-request',
      'forbidden',
      'unavailable',
      'capacity-exceeded',
      'not-found',
      'identity-mismatch',
      'invalid-artifact',
      'render-failed',
      'timeout',
      'execution-denied',
    ]),
    message: z.string().min(1).max(512),
    retryable: z.literal(false),
  })
  .strict()
export type DisplayError = z.infer<typeof displayErrorSchema>
export const displayErrorReplySchema = z
  .object({ protocol: z.literal(DISPLAY_PROTOCOL), error: displayErrorSchema })
  .strict()
const flagsSchema = z
  .object({
    productionAllowed: z.literal(false),
    paidExecutionAllowed: z.literal(false),
    strictReference: z.literal(false),
    qualified: z.literal(false),
    visualParityClaimed: z.literal(false),
  })
  .strict()
export const displayArtifactSchema = z
  .object({
    checksum: displayDigestSchema,
    receiptDigest: displayDigestSchema,
    mediaType: z.literal('image/png'),
    byteLength: z.number().int().min(44).max(DISPLAY_LIMITS.pngBytes),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    src: z.string().max(320),
    exactMatch: z.literal(true),
    approvedCurrentImage: z.literal(false),
    cacheStatus: z.enum(['verified-exact-hit', 'rendered-miss']),
    provenance: z
      .object({
        kind: z.literal('private-three-display'),
        label: z.literal(DISPLAY_LABEL),
        sessionId: displayIdSchema,
        revision: z.number().int().positive(),
        flags: flagsSchema,
        holds: z.array(z.string().min(1).max(512)).min(1).max(32),
      })
      .strict(),
  })
  .strict()
export type DisplayArtifact = z.infer<typeof displayArtifactSchema>
const replyBase = {
  protocol: z.literal(DISPLAY_PROTOCOL),
  mode: z.literal(DISPLAY_MODE),
  interestId: displayIdSchema,
  binding: displayBindingSchema,
}
export const displayReplySchema = z.discriminatedUnion('state', [
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
  z.object({ ...replyBase, state: z.literal('ready'), artifact: displayArtifactSchema }).strict(),
  z.object({ ...replyBase, state: z.literal('failed'), error: displayErrorSchema }).strict(),
  z
    .object({
      ...replyBase,
      state: z.literal('cancelled'),
      cancellationScope: z.literal('interest-only'),
    })
    .strict(),
  z.object({ ...replyBase, state: z.literal('expired') }).strict(),
])
export type DisplayReply = z.infer<typeof displayReplySchema>
export type DisplayReadyReply = Extract<DisplayReply, { state: 'ready' }>
export const DISPLAY_HOLDS = Object.freeze([
  'Unqualified Three display candidate; no visual quality or latency validation.',
  'Asset rights, fonts and art direction remain held; not a strict export.',
] as const)
export function displayHolds(design: unknown) {
  return [...designReviewHolds(design), ...DISPLAY_HOLDS]
}
export async function parseDisplayReply(
  input: unknown,
  design: unknown,
  expected?: { interestId: string; binding: DisplayBinding },
): Promise<DisplayReply> {
  const reply = displayReplySchema.parse(input)
  const binding = await bindDisplay(design, reply.binding.build)
  if (
    stableDisplayJson(binding) !== stableDisplayJson(reply.binding) ||
    (expected &&
      (reply.interestId !== expected.interestId ||
        stableDisplayJson(reply.binding) !== stableDisplayJson(expected.binding)))
  )
    throw new Error('Display identity or immutable poll binding mismatch.')
  if (reply.state === 'ready') {
    const a = reply.artifact
    if (
      a.src !== displayImagePath(reply.interestId, a.checksum) ||
      a.width !== binding.profile.width ||
      a.height !== binding.profile.height ||
      stableDisplayJson(a.provenance.holds) !== stableDisplayJson(displayHolds(design))
    )
      throw new Error('Display artifact route, dimensions or holds mismatch.')
  }
  return reply
}
/** Hash and decode the SAME bounded bytes. A decoder seam is not capture evidence. */
export async function validateDisplayImage(
  artifact: DisplayArtifact,
  input: Uint8Array,
  decode: (bytes: Uint8Array) => Promise<{ width: number; height: number }>,
) {
  const a = displayArtifactSchema.parse(artifact)
  if (input.byteLength !== a.byteLength || input.byteLength > DISPLAY_LIMITS.pngBytes)
    throw new Error('Display PNG byte cap/length mismatch.')
  const bytes = new Uint8Array(input)
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    throw new Error('Display requires PNG, not diagnostic/historical substitution.')
  const header = new DataView(bytes.buffer)
  if (
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) !== a.width ||
    header.getUint32(20) !== a.height
  )
    throw new Error('Display PNG header mismatch.')
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const checksum = `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`
  if (checksum !== a.checksum) throw new Error('Display PNG checksum mismatch.')
  const decoded = await decode(bytes)
  if (decoded.width !== a.width || decoded.height !== a.height)
    throw new Error('Display PNG decode mismatch.')
}
