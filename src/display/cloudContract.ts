import { z } from 'zod'
import { designEnvelopeSchema, freezeDesignValue } from '../domain/design'
import { sha256Text } from '../domain/designIdentity'
import {
  bindDisplay,
  displayBindingSchema,
  displayDigestSchema,
  displayErrorSchema,
  displayIdSchema,
  displayHolds,
  DISPLAY_LIMITS,
  stableDisplayJson,
} from './contract'

/** Additive wire contract only. No provider, process, operator or execution authority. */
export const CLOUD_DISPLAY_PROTOCOL = 'fury.private-cloud-display@1' as const
export const CLOUD_DISPLAY_MODE = 'private-cloud-display' as const
export const CLOUD_DISPLAY_PREFIX = '/__fury-display-cloud/v1' as const
export const CLOUD_DISPLAY_REQUEST_PATH = `${CLOUD_DISPLAY_PREFIX}/images` as const
export const CLOUD_DISPLAY_LABEL = 'Private GPU display candidate — unqualified' as const
export const CLOUD_DISPLAY_BUILD_GATE = Object.freeze({
  dispatchAllowed: false,
  productionAllowed: false,
  qualified: false,
} as const)
export const cloudDisplayRequestSchema = z
  .object({ protocol: z.literal(CLOUD_DISPLAY_PROTOCOL), design: designEnvelopeSchema })
  .strict()
export function createCloudDisplayRequest(design: unknown) {
  return freezeDesignValue(
    cloudDisplayRequestSchema.parse({ protocol: CLOUD_DISPLAY_PROTOCOL, design }),
  )
}
export const cloudRecipeSchema = z
  .object({
    binding: displayBindingSchema,
    workerPackageDigest: displayDigestSchema,
    cameraDigest: displayDigestSchema,
    recipeDigest: displayDigestSchema,
  })
  .strict()
export type CloudRecipe = z.infer<typeof cloudRecipeSchema>
/** Package and camera digests are trusted service inputs, NEVER request fields. */
export async function bindCloudRecipe(
  design: unknown,
  build: unknown,
  workerPackageDigest: string,
  cameraDigest: string,
): Promise<CloudRecipe> {
  const value = {
    binding: await bindDisplay(design, build),
    workerPackageDigest: displayDigestSchema.parse(workerPackageDigest),
    cameraDigest: displayDigestSchema.parse(cameraDigest),
  }
  return freezeDesignValue({
    ...value,
    recipeDigest: await sha256Text(
      stableDisplayJson({ protocol: CLOUD_DISPLAY_PROTOCOL, ...value }),
    ),
  })
}
export const cloudBlockerSchema = z.enum([
  'not-configured',
  'approval-required',
  'sdk-runtime-incompatible',
  'runtime-unproven',
  'package-mismatch',
  'hardware-unproven',
  'termination-unproven',
  'billing-unreconciled',
  'quarantined',
])
export const cloudDisplayErrorSchema = displayErrorSchema
  .extend({ blocker: cloudBlockerSchema.optional() })
  .strict()
export const cloudDisplayErrorReplySchema = z
  .object({ protocol: z.literal(CLOUD_DISPLAY_PROTOCOL), error: cloudDisplayErrorSchema })
  .strict()

/** Evidence labels are not permission. Unknown stays unknown; declared options never become observed. */
export const cloudObservationSchema = z
  .object({
    state: z.enum(['unobserved', 'observed']),
    evidenceDigest: displayDigestSchema.nullable(),
  })
  .strict()
  .refine(
    (v) => (v.state === 'observed') === (v.evidenceDigest !== null),
    'Observation requires evidence.',
  )
export const cloudProofSchema = z
  .object({
    kind: z.literal('external-private-gpu-proof@1'),
    workerPackageDigest: displayDigestSchema,
    runtimePolicyDigest: displayDigestSchema,
    observedRuntime: cloudObservationSchema,
    observedHardware: cloudObservationSchema,
    observedProcessExit: cloudObservationSchema,
    observedProviderTermination: cloudObservationSchema,
    observedBillingFinal: cloudObservationSchema,
  })
  .strict()
export type CloudProof = z.infer<typeof cloudProofSchema>
export const cloudProvenanceSchema = z
  .object({
    kind: z.literal('external-private-three-display'),
    label: z.literal(CLOUD_DISPLAY_LABEL),
    sessionId: displayIdSchema,
    revision: z.number().int().min(1).max(DISPLAY_LIMITS.jobsPerSession),
    proofDigest: displayDigestSchema,
    qualified: z.literal(false),
    productionAllowed: z.literal(false),
    strictReference: z.literal(false),
    visualParityClaimed: z.literal(false),
    holds: z.array(z.string().min(1).max(512)).min(1).max(32),
  })
  .strict()
export const cloudArtifactSchema = z
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
    provenance: cloudProvenanceSchema,
  })
  .strict()
const replyBase = {
  protocol: z.literal(CLOUD_DISPLAY_PROTOCOL),
  mode: z.literal(CLOUD_DISPLAY_MODE),
  interestId: displayIdSchema,
  recipe: cloudRecipeSchema,
}
export const cloudDisplayReplySchema = z.discriminatedUnion('state', [
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
  z.object({ ...replyBase, state: z.literal('ready'), artifact: cloudArtifactSchema }).strict(),
  z.object({ ...replyBase, state: z.literal('failed'), error: cloudDisplayErrorSchema }).strict(),
  z
    .object({
      ...replyBase,
      state: z.literal('cancelled'),
      cancellationScope: z.literal('interest-only'),
    })
    .strict(),
  z.object({ ...replyBase, state: z.literal('expired') }).strict(),
])
export type CloudDisplayReply = z.infer<typeof cloudDisplayReplySchema>
export type CloudDisplayReadyReply = Extract<CloudDisplayReply, { state: 'ready' }>
export function cloudDisplayStatusPath(interestId: string) {
  return `${CLOUD_DISPLAY_PREFIX}/jobs/${displayIdSchema.parse(interestId)}`
}
export function cloudDisplayCancelPath(interestId: string) {
  return `${cloudDisplayStatusPath(interestId)}/cancel`
}
export function cloudDisplayImagePath(interestId: string, checksum: string) {
  return `${cloudDisplayStatusPath(interestId)}/image/${displayDigestSchema.parse(checksum).slice(7)}.png`
}
export const cloudDisplayCancelSchema = z
  .object({ protocol: z.literal(CLOUD_DISPLAY_PROTOCOL) })
  .strict()
export function isCloudDisplaySelection(dev: boolean, search: string) {
  const query = new URLSearchParams(search)
  return (
    dev &&
    query.getAll('prototype').length === 1 &&
    query.get('prototype') === 'images' &&
    query.getAll('imageMode').length === 1 &&
    query.get('imageMode') === CLOUD_DISPLAY_MODE
  )
}
export async function parseCloudDisplayReply(
  input: unknown,
  design: unknown,
  expected?: { interestId: string; recipe: CloudRecipe },
): Promise<CloudDisplayReply> {
  const reply = cloudDisplayReplySchema.parse(input)
  const recipe = await bindCloudRecipe(
    design,
    reply.recipe.binding.build,
    reply.recipe.workerPackageDigest,
    reply.recipe.cameraDigest,
  )
  if (
    stableDisplayJson(recipe) !== stableDisplayJson(reply.recipe) ||
    (expected &&
      (expected.interestId !== reply.interestId ||
        stableDisplayJson(expected.recipe) !== stableDisplayJson(recipe)))
  )
    throw new Error('Cloud display immutable recipe mismatch.')
  if (reply.state === 'ready') {
    const a = reply.artifact
    if (
      a.src !== cloudDisplayImagePath(reply.interestId, a.checksum) ||
      a.width !== recipe.binding.profile.width ||
      a.height !== recipe.binding.profile.height ||
      stableDisplayJson(a.provenance.holds) !== stableDisplayJson(displayHolds(design))
    )
      throw new Error('Cloud display artifact route, profile or holds mismatch.')
  }
  return reply
}
