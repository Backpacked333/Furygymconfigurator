import { z } from 'zod'
import { designEnvelopeSchema, hasOperableDoor, type DesignEnvelope } from '../domain/design.js'
import { CUSTOMER_CAMERA_REFS, LOOK_REFS, presentationSchema } from '../domain/presentation.js'

export const CONTRACT_VERSION = 'fury.render-library@1' as const
export const RENDER_CTA = 'Bring your vision to life' as const
export const API_PATHS = Object.freeze({
  lookup: '/api/render-library/lookup',
  jobs: '/api/render-library/jobs',
  session: '/api/render-library/session',
  variants: '/api/render-library/variants',
})
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const SEED_MANIFEST_SHA256 =
  'f56574f571761b2ed3357e369d784c37318c900f0e2dc0a973a3d7a3c0a83e54'
export const SEED_MANIFEST_REVISION =
  '539b3c8b7cf3447cc331bcce0e2ae457d65237d1e04ce567c344941cdb15160b'
export const IMAGE_DIMENSIONS = Object.freeze({
  wide: { width: 1920, height: 1200 },
  tall: { width: 1200, height: 1500 },
})
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const cameraRefSchema = z.enum(CUSTOMER_CAMERA_REFS)
export const customerLookSchema = z.enum(
  LOOK_REFS.filter((ref) => ref !== 'studio-neutral-draft@1'),
)
export const setKeySchema = z.string().regex(/^set_[a-f0-9]{64}$/)
export const imageKeySchema = z.string().regex(/^img_[a-f0-9]{64}$/)
export const uuidSchema = z.uuid()

/** Source IDs are immutable releases, not permission to render or proof of pixel qualification. */
export const RECIPE_RELEASE = Object.freeze({
  id: 'fury-native-five@2',
  geometry: 'fury-fixed-arrangement-geometry@1',
  materials: 'fury-native-materials@1',
  cameras: 'fury-native-five-cameras@2',
  renderer: 'blender-4.5.0-cycles-optix-l40s@1',
  studio: 'fury-corrected-cyclorama-raycast@1',
  environments: 'fury-selected-landscape-day-night@1',
  encoding: 'webp-q95-1920x1200-1200x1500@1',
})
/** Same pinned pipeline, distinct camera recipe. Studio's existing cache keys stay unchanged. */
export const CONTAINER_RECIPE_RELEASE = Object.freeze({
  ...RECIPE_RELEASE,
  cameras: 'fury-container-open-exterior-entry-cameras@1',
})
export function recipeForDesign(design: DesignEnvelope) {
  return design.config.product.family === 'container' ? CONTAINER_RECIPE_RELEASE : RECIPE_RELEASE
}
export const recipeReleaseSchema = z
  .object({
    id: z.literal(RECIPE_RELEASE.id),
    geometry: z.literal(RECIPE_RELEASE.geometry),
    materials: z.literal(RECIPE_RELEASE.materials),
    cameras: z.enum([RECIPE_RELEASE.cameras, CONTAINER_RECIPE_RELEASE.cameras]),
    renderer: z.literal(RECIPE_RELEASE.renderer),
    studio: z.literal(RECIPE_RELEASE.studio),
    environments: z.literal(RECIPE_RELEASE.environments),
    encoding: z.literal(RECIPE_RELEASE.encoding),
  })
  .strict()
export type RecipeRelease = z.infer<typeof recipeReleaseSchema>

export const customerDesignSchema = designEnvelopeSchema
  .safeExtend({
    presentation: presentationSchema.extend({
      cameraRef: cameraRefSchema,
      lookRef: customerLookSchema,
    }),
    outputProfile: z.literal('web-hero'),
  })
  .superRefine((design, context) => {
    if (
      design.config.product.family === 'container' &&
      hasOperableDoor(design.config.structure) &&
      design.presentation.doorPose !== 'open'
    )
      context.addIssue({
        code: 'custom',
        path: ['presentation', 'doorPose'],
        message: 'Container doors must be shown open.',
      })
  })

/** Lookup is read-only even though POST avoids putting a complete design into a URL. */
export const lookupRequestSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    design: customerDesignSchema,
  })
  .strict()
export const createJobRequestSchema = lookupRequestSchema
  .extend({
    intent: z.literal('render-missing'),
    idempotencyKey: uuidSchema,
  })
  .strict()
export const retryJobRequestSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    intent: z.literal('retry-failed-missing'),
    idempotencyKey: uuidSchema,
  })
  .strict()
export type LookupRequest = z.infer<typeof lookupRequestSchema>
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>
export type RetryJobRequest = z.infer<typeof retryJobRequestSchema>

export const errorCodeSchema = z.enum([
  'invalid-request',
  'lookup-unavailable',
  'rendering-disabled',
  'budget-unavailable',
  'budget-exhausted',
  'rate-limited',
  'capacity-full',
  'origin-denied',
  'csrf-invalid',
  'unsupported-scene',
  'job-not-found',
  'idempotency-conflict',
  'unsafe-retry',
  'provider-unavailable',
  'dispatch-uncertain',
  'worker-failed',
  'verification-failed',
])
export const SAFE_ERROR_MESSAGES = {
  'invalid-request': 'This design request could not be accepted.',
  'lookup-unavailable': 'Could not check the image library.',
  'rendering-disabled': 'Rendering is not enabled. Existing images remain available.',
  'budget-unavailable': 'Rendering is awaiting operator approval.',
  'budget-exhausted': 'The approved rendering budget is currently unavailable.',
  'rate-limited': 'Too many render requests. Please try again later.',
  'capacity-full': 'All render slots are currently in use.',
  'origin-denied': 'This request must come from the configurator.',
  'csrf-invalid': 'Your session needs to be refreshed before requesting a render.',
  'unsupported-scene': 'This scene cannot currently be rendered without substitution.',
  'job-not-found': 'This render job could not be found.',
  'idempotency-conflict': 'This request identifier was already used for another request.',
  'unsafe-retry': 'This job cannot safely be retried yet.',
  'provider-unavailable': 'The rendering service is currently unavailable.',
  'dispatch-uncertain': 'We are checking whether rendering started. Please do not submit again.',
  'worker-failed': 'Rendering stopped. Completed images remain available.',
  'verification-failed': 'An image did not pass verification and was not published.',
} as const satisfies Record<z.infer<typeof errorCodeSchema>, string>
export const safeErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1).max(240),
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.message !== SAFE_ERROR_MESSAGES[error.code])
      context.addIssue({
        code: 'custom',
        message: 'Only allowlisted public error messages are permitted.',
      })
    if (error.code === 'dispatch-uncertain' && error.retryable)
      context.addIssue({ code: 'custom', message: 'Uncertain dispatch cannot be retried.' })
  })
export function safeError(code: z.infer<typeof errorCodeSchema>, retryable = false): SafeError {
  return safeErrorSchema.parse({ code, message: SAFE_ERROR_MESSAGES[code], retryable })
}
export const apiErrorSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    status: z.literal('error'),
    error: safeErrorSchema,
  })
  .strict()
export type SafeError = z.infer<typeof safeErrorSchema>

export const availabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('enabled') }).strict(),
  z.object({ status: z.literal('unavailable'), reason: safeErrorSchema }).strict(),
])
export const identitySchema = z
  .object({
    setKey: setKeySchema,
    recipeRelease: recipeReleaseSchema,
    imageKeys: z
      .object({
        'front-left-draft@1': imageKeySchema,
        'front-draft@1': imageKeySchema,
        'left-draft@1': imageKeySchema,
        'rear-left-draft@1': imageKeySchema,
        'entry-draft@1': imageKeySchema,
      })
      .strict(),
  })
  .strict()
export type SetIdentity = z.infer<typeof identitySchema>

const provenanceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('seed-cache'),
      compatibilityRule: z.literal('native-library-400-exact@1'),
      manifestSha256: z.literal(SEED_MANIFEST_SHA256),
      manifestRevision: z.literal(SEED_MANIFEST_REVISION),
      entryId: z.string().regex(/^design-\d{2}-[1-8]$/),
      requestKey: sha256Schema,
      historicalRecipeDigest: sha256Schema,
      historicalManifestSha256: sha256Schema,
      historicalWorkerSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('native-worker'),
      jobId: uuidSchema,
      attemptId: uuidSchema,
      workerBuildSha256: sha256Schema,
      recipeBundleSha256: sha256Schema,
      receiptSha256: sha256Schema,
    })
    .strict(),
])
const imageUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (/^\/native-library\/[a-f0-9]{64}\.webp$/.test(value)) return true
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }, 'Expected immutable HTTPS or seed-cache URL; host and content path must also be verified.')

export const imageDescriptorSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    setKey: setKeySchema,
    imageKey: imageKeySchema,
    design: customerDesignSchema,
    recipeRelease: recipeReleaseSchema,
    url: imageUrlSchema,
    sha256: sha256Schema,
    bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
    width: z.number().int(),
    height: z.number().int(),
    mime: z.literal('image/webp'),
    samples: z.literal(1024),
    adaptiveSampling: z.literal(false),
    quality: z.literal(95),
    provenance: provenanceSchema,
    productionAllowed: z.literal(false),
    visuallyQualified: z.literal(false),
    strictReference: z.literal(false),
    engineeringApproved: z.literal(false),
  })
  .strict()
  .superRefine((image, context) => {
    const dimensions = IMAGE_DIMENSIONS[image.design.presentation.aspect]
    if (image.width !== dimensions.width || image.height !== dimensions.height)
      context.addIssue({ code: 'custom', message: 'Image dimensions do not match the aspect.' })
    if (!image.url.endsWith(`/${image.sha256}.webp`))
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'URL must bind immutable content hash.',
      })
  })
export type ImageDescriptor = z.infer<typeof imageDescriptorSchema>

export const activeStageSchema = z.enum(['queued', 'preparing', 'rendering', 'saving', 'verifying'])
export const jobStageSchema = z.enum([
  ...activeStageSchema.options,
  'complete',
  'failed',
  'blocked',
  'dispatch-uncertain',
])
export const viewStateSchema = z.discriminatedUnion('status', [
  z
    .object({ cameraRef: cameraRefSchema, imageKey: imageKeySchema, status: z.literal('missing') })
    .strict(),
  z
    .object({
      cameraRef: cameraRefSchema,
      imageKey: imageKeySchema,
      status: z.literal('pending'),
      stage: activeStageSchema,
    })
    .strict(),
  z
    .object({
      cameraRef: cameraRefSchema,
      imageKey: imageKeySchema,
      status: z.literal('ready'),
      image: imageDescriptorSchema,
    })
    .strict(),
  z
    .object({
      cameraRef: cameraRefSchema,
      imageKey: imageKeySchema,
      status: z.literal('failed'),
      error: safeErrorSchema,
      retrySafe: z.boolean(),
    })
    .strict(),
])
export const jobSummarySchema = z
  .object({
    id: uuidSchema,
    stage: jobStageSchema,
    completedImages: z.number().int().min(0).max(5),
    totalImages: z.literal(5),
    currentCamera: cameraRefSchema.nullable(),
    retrySafe: z.boolean(),
    error: safeErrorSchema.nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.retrySafe && job.stage !== 'failed')
      context.addIssue({ code: 'custom', message: 'Only known failed work may be safe to retry.' })
    const terminalError = ['failed', 'blocked', 'dispatch-uncertain'].includes(job.stage)
    if (terminalError !== (job.error !== null))
      context.addIssue({ code: 'custom', message: 'Job error must match terminal error state.' })
    if (job.stage === 'dispatch-uncertain' && job.error?.code !== 'dispatch-uncertain')
      context.addIssue({ code: 'custom', message: 'Uncertain dispatch must remain explicit.' })
  })
export type JobSummary = z.infer<typeof jobSummarySchema>

export const setSnapshotSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    status: z.literal('ok'),
    identity: identitySchema,
    coverage: z.enum(['missing', 'partial', 'complete']),
    views: z.array(viewStateSchema).length(5),
    job: jobSummarySchema.nullable(),
    rendering: availabilitySchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    const ready = snapshot.views.filter((view) => view.status === 'ready').length
    if (new Set(snapshot.views.map((view) => view.cameraRef)).size !== 5)
      issue('Five distinct cameras required.')
    if (snapshot.coverage !== (ready === 5 ? 'complete' : ready === 0 ? 'missing' : 'partial'))
      issue('Coverage must reflect verified ready images.')
    if (snapshot.job && snapshot.job.completedImages !== ready)
      issue('Job count must reflect verified images, including cache hits.')
    if (snapshot.job?.stage === 'complete' && ready !== 5)
      issue('Incomplete set cannot be complete.')
    for (const view of snapshot.views) {
      if (view.imageKey !== snapshot.identity.imageKeys[view.cameraRef])
        issue('View identity mismatch.')
      if (
        view.status === 'ready' &&
        (view.image.setKey !== snapshot.identity.setKey ||
          view.image.imageKey !== view.imageKey ||
          view.image.design.presentation.cameraRef !== view.cameraRef)
      )
        issue('Descriptor binding mismatch.')
    }
  })
export type SetSnapshot = z.infer<typeof setSnapshotSchema>
export const lookupResponseSchema = z.union([setSnapshotSchema, apiErrorSchema])

/** Saved sets of the same configuration under another format, door pose or scene. */
export const savedVariantSchema = z
  .object({
    presentation: presentationSchema
      .pick({ aspect: true, doorPose: true })
      .extend({ lookRef: customerLookSchema })
      .strict(),
    readyViews: z.number().int().min(1).max(5),
  })
  .strict()
export const MAX_SAVED_VARIANTS = 24
export const variantsResponseSchema = z.union([
  z
    .object({
      contractVersion: z.literal(CONTRACT_VERSION),
      status: z.literal('ok'),
      variants: z.array(savedVariantSchema).max(MAX_SAVED_VARIANTS),
    })
    .strict(),
  apiErrorSchema,
])
export type SavedVariant = z.infer<typeof savedVariantSchema>
export type VariantsResponse = z.infer<typeof variantsResponseSchema>
export const jobResponseSchema = lookupResponseSchema
export type LibraryResponse = z.infer<typeof lookupResponseSchema>

export const sessionResponseSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    csrfToken: z.string().min(32).max(256),
    expiresAt: z.iso.datetime(),
  })
  .strict()
