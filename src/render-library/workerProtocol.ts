import { z } from 'zod'
import {
  CONTRACT_VERSION,
  IMAGE_DIMENSIONS,
  MAX_IMAGE_BYTES,
  activeStageSchema,
  cameraRefSchema,
  customerDesignSchema,
  identitySchema,
  imageKeySchema,
  recipeReleaseSchema,
  safeErrorSchema,
  sha256Schema,
  uuidSchema,
} from './contracts'

export const WORKER_API_PATHS = Object.freeze({
  claim: '/api/render-library/worker/claim',
  events: '/api/render-library/worker/events',
  uploads: '/api/render-library/worker/uploads',
})

/** Hard ceilings; an operator may only tighten these and must separately authorize spending. */
export const EXECUTION_LIMITS = Object.freeze({
  imagesPerJob: 5,
  startupSeconds: 180,
  preparationSeconds: 120,
  imageSeconds: 300,
  jobSeconds: 2100,
  maxContainers: 2,
  concurrencyPerContainer: 1,
  maxActiveJobsPerSession: 1,
  maxCreatesPerSessionPerHour: 3,
  minContainers: 0,
  providerRetries: 0,
})
export const executionLimitsSchema = z
  .object({
    imagesPerJob: z.literal(5),
    startupSeconds: z.number().int().positive().max(180),
    preparationSeconds: z.number().int().positive().max(120),
    imageSeconds: z.number().int().positive().max(300),
    jobSeconds: z.number().int().positive().max(2100),
    maxContainers: z.number().int().positive().max(2),
    concurrencyPerContainer: z.literal(1),
    maxActiveJobsPerSession: z.literal(1),
    maxCreatesPerSessionPerHour: z.number().int().positive().max(3),
    minContainers: z.literal(0),
    providerRetries: z.literal(0),
  })
  .strict()

/** Only this is sent to Modal. The private worker obtains the trusted design via durable claim. */
export const dispatchEnvelopeSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    jobId: uuidSchema,
    dispatchId: uuidSchema,
  })
  .strict()
export type DispatchEnvelope = z.infer<typeof dispatchEnvelopeSchema>
export const claimRequestSchema = dispatchEnvelopeSchema
  .extend({
    workerBuildSha256: sha256Schema,
  })
  .strict()
export type ClaimRequest = z.infer<typeof claimRequestSchema>

export const workerClaimSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    jobId: uuidSchema,
    dispatchId: uuidSchema,
    attemptId: uuidSchema,
    fence: z.number().int().positive(),
    design: customerDesignSchema,
    identity: identitySchema,
    workerBuildSha256: sha256Schema,
    recipeBundleSha256: sha256Schema,
    views: z
      .array(z.object({ cameraRef: cameraRefSchema, imageKey: imageKeySchema }).strict())
      .min(1)
      .max(5),
    limits: executionLimitsSchema,
    deadlineAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (new Set(claim.views.map((view) => view.cameraRef)).size !== claim.views.length)
      context.addIssue({ code: 'custom', message: 'Duplicate claim camera.' })
    for (const view of claim.views)
      if (view.imageKey !== claim.identity.imageKeys[view.cameraRef])
        context.addIssue({ code: 'custom', message: 'Claim image binding mismatch.' })
  })
export type WorkerClaim = z.infer<typeof workerClaimSchema>
export const claimResponseSchema = z.object({ claim: workerClaimSchema.nullable() }).strict()

const eventBase = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    jobId: uuidSchema,
    attemptId: uuidSchema,
    fence: z.number().int().positive(),
    eventId: uuidSchema,
    sequence: z.number().int().positive(),
  })
  .strict()
export const progressEventSchema = eventBase
  .extend({
    kind: z.literal('progress'),
    cameraRef: cameraRefSchema,
    stage: activeStageSchema.exclude(['queued']),
  })
  .strict()

/** No browser input, URLs, paths, executables or arbitrary scenes cross this boundary. */
export const artifactReceiptSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    jobId: uuidSchema,
    attemptId: uuidSchema,
    imageKey: imageKeySchema,
    design: customerDesignSchema,
    recipeRelease: recipeReleaseSchema,
    workerBuildSha256: sha256Schema,
    recipeBundleSha256: sha256Schema,
    sceneManifestSha256: sha256Schema,
    cameraBindingSha256: sha256Schema,
    sha256: sha256Schema,
    bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
    width: z.number().int(),
    height: z.number().int(),
    mime: z.literal('image/webp'),
    samples: z.literal(1024),
    completedSamples: z.literal(1024),
    adaptiveSampling: z.literal(false),
    quality: z.literal(95),
    device: z.literal('NVIDIA L40S'),
    engine: z.literal('CYCLES'),
    backend: z.literal('OPTIX'),
    blenderVersion: z.literal('4.5.0'),
    renderSeconds: z.number().positive().max(EXECUTION_LIMITS.imageSeconds),
    cpuFallback: z.literal(false),
  })
  .strict()
  .superRefine((receipt, context) => {
    const expected = IMAGE_DIMENSIONS[receipt.design.presentation.aspect]
    if (receipt.width !== expected.width || receipt.height !== expected.height)
      context.addIssue({ code: 'custom', message: 'Wrong native dimensions.' })
  })
export type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>
export const artifactEventSchema = eventBase
  .extend({
    kind: z.literal('artifact'),
    receipt: artifactReceiptSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.jobId !== event.receipt.jobId || event.attemptId !== event.receipt.attemptId)
      context.addIssue({ code: 'custom', message: 'Artifact event identity mismatch.' })
  })
export const terminalEventSchema = eventBase
  .extend({
    kind: z.literal('terminal'),
    outcome: z.enum(['complete', 'failed']),
    error: safeErrorSchema.nullable(),
  })
  .strict()
export const workerEventSchema = z.union([
  progressEventSchema,
  artifactEventSchema,
  terminalEventSchema,
])
export type WorkerEvent = z.infer<typeof workerEventSchema>
export type ArtifactEvent = z.infer<typeof artifactEventSchema>
export const eventResponseSchema = z.object({ accepted: z.boolean() }).strict()

/** Private staging only. Signed uploads avoid proxying image bytes through serverless limits. */
export const uploadTicketSchema = z
  .object({
    bucket: z.literal('render-library-staging'),
    objectKey: z
      .string()
      .regex(/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/img_[a-f0-9]{64}\/[a-f0-9]{64}\.webp$/),
    uploadUrl: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      }),
    expiresAt: z.iso.datetime(),
    maxBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
    overwrite: z.literal(false),
  })
  .strict()
export type UploadTicket = z.infer<typeof uploadTicketSchema>
export function stagingObjectKey(receipt: ArtifactReceipt): string {
  return `${receipt.jobId}/${receipt.attemptId}/${receipt.imageKey}/${receipt.sha256}.webp`
}

export const dispatchResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), providerCallId: z.string().min(1).max(200) }).strict(),
  z.object({ status: z.literal('definitely-not-submitted'), reason: safeErrorSchema }).strict(),
  z.object({ status: z.literal('uncertain'), reason: safeErrorSchema }).strict(),
])
export type DispatchResult = z.infer<typeof dispatchResultSchema>
export const terminationEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never-submitted'), dispatchId: uuidSchema }).strict(),
  z
    .object({
      kind: z.literal('provider-terminal'),
      dispatchId: uuidSchema,
      providerCallId: z.string().min(1).max(200),
      observedAt: z.iso.datetime(),
      evidenceSha256: sha256Schema,
    })
    .strict(),
])
export type TerminationEvidence = z.infer<typeof terminationEvidenceSchema>
