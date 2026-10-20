import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { defaultDesign, parseDesign } from '../src/domain/design'
import {
  CONTRACT_VERSION,
  RECIPE_RELEASE,
  apiErrorSchema,
  createJobRequestSchema,
  imageDescriptorSchema,
  lookupRequestSchema,
  lookupResponseSchema,
  retryJobRequestSchema,
  sessionResponseSchema,
  setSnapshotSchema,
  safeError,
} from '../src/render-library/contracts'
import { computeSetIdentity, identityPayload } from '../src/render-library/identity'
import { normalizeCustomerDesign } from '../src/render-library/views'
import {
  EXECUTION_LIMITS,
  artifactReceiptSchema,
  artifactEventSchema,
  claimRequestSchema,
  claimResponseSchema,
  dispatchEnvelopeSchema,
  dispatchResultSchema,
  eventResponseSchema,
  stagingObjectKey,
  uploadTicketSchema,
  workerClaimSchema,
  workerEventSchema,
} from '../src/render-library/workerProtocol'
import { DATABASE_CONTRACT } from '../src/render-library/server/databaseContract'
import { seedImagesForSet } from '../src/render-library/server/seedCache'

/** Deterministic TEST vectors only; never prepares scenes, calls providers, or writes image bytes. */
export async function contractFixtures(root: string) {
  const design = defaultDesign()
  const container = normalizeCustomerDesign(defaultDesign({ family: 'container', lengthFt: 40 }))
  const identity = await computeSetIdentity(design)
  const jobId = '00000000-0000-4000-8000-000000000001'
  const dispatchId = '00000000-0000-4000-8000-000000000002'
  const attemptId = '00000000-0000-4000-8000-000000000003'
  const eventId = '00000000-0000-4000-8000-000000000004'
  const lookup = lookupRequestSchema.parse({ contractVersion: CONTRACT_VERSION, design })
  const create = createJobRequestSchema.parse({
    ...lookup,
    intent: 'render-missing',
    idempotencyKey: jobId,
  })
  const bytes = readFileSync(resolve(root, 'public/native-library/manifest.json'))
  const images = await seedImagesForSet(bytes, design)
  const interiorKey = identity.imageKeys['entry-draft@1']
  const syntheticInterior = imageDescriptorSchema.parse({
    ...images[0],
    imageKey: interiorKey,
    design: { ...design, presentation: { ...design.presentation, cameraRef: 'entry-draft@1' } },
    url: `https://storage.example/storage/v1/object/public/render-library/${identity.setKey}/${interiorKey}/${images[0].sha256}.webp`,
    provenance: {
      kind: 'native-worker',
      jobId,
      attemptId,
      workerBuildSha256: 'a'.repeat(64),
      recipeBundleSha256: 'b'.repeat(64),
      receiptSha256: 'c'.repeat(64),
    },
  })
  const disabled = {
    status: 'unavailable',
    reason: {
      code: 'rendering-disabled',
      message: 'Rendering is not enabled. Existing images remain available.',
      retryable: false,
    },
  }
  const complete = setSnapshotSchema.parse({
    contractVersion: CONTRACT_VERSION,
    status: 'ok',
    identity,
    coverage: 'complete',
    views: [...images, syntheticInterior].map((image) => ({
      cameraRef: image.design.presentation.cameraRef,
      imageKey: image.imageKey,
      status: 'ready',
      image,
    })),
    job: null,
    rendering: disabled,
  })
  const night = parseDesign({
    ...design,
    presentation: { ...design.presentation, lookRef: 'studio-night-draft@1' },
  })
  const nightIdentity = await computeSetIdentity(night)
  const nightImages = await seedImagesForSet(bytes, night)
  const partial = setSnapshotSchema.parse({
    ...complete,
    identity: nightIdentity,
    coverage: 'partial',
    views: Object.entries(nightIdentity.imageKeys).map(([cameraRef, imageKey]) => {
      const image = nightImages.find((entry) => entry.imageKey === imageKey)
      return image
        ? { cameraRef, imageKey, status: 'ready', image }
        : { cameraRef, imageKey, status: 'missing' }
    }),
  })
  const absent = parseDesign({
    ...design,
    presentation: { ...design.presentation, lookRef: 'desert-night-draft@1' },
  })
  const absentIdentity = await computeSetIdentity(absent)
  const missing = setSnapshotSchema.parse({
    ...complete,
    identity: absentIdentity,
    coverage: 'missing',
    views: Object.entries(absentIdentity.imageKeys).map(([cameraRef, imageKey]) => ({
      cameraRef,
      imageKey,
      status: 'missing',
    })),
  })
  const stages = [
    'queued',
    'preparing',
    'rendering',
    'saving',
    'verifying',
    'failed',
    'blocked',
    'dispatch-uncertain',
  ] as const
  const jobStates = Object.fromEntries(
    stages.map((stage) => {
      const terminal = ['failed', 'blocked', 'dispatch-uncertain'].includes(stage)
      const error = terminal
        ? safeError(
            stage === 'dispatch-uncertain'
              ? stage
              : stage === 'blocked'
                ? 'rendering-disabled'
                : 'worker-failed',
          )
        : null
      return [
        stage,
        setSnapshotSchema.parse({
          ...partial,
          views: partial.views.map((view) =>
            view.status === 'ready'
              ? view
              : terminal
                ? { ...view, status: 'failed', error, retrySafe: false }
                : { ...view, status: 'pending', stage },
          ),
          job: {
            id: jobId,
            stage,
            completedImages: 1,
            totalImages: 5,
            currentCamera: terminal ? null : 'front-draft@1',
            retrySafe: false,
            error,
            updatedAt: '2030-01-01T00:00:00.000Z',
          },
        }),
      ]
    }),
  )
  const dispatch = dispatchEnvelopeSchema.parse({
    contractVersion: CONTRACT_VERSION,
    jobId,
    dispatchId,
  })
  const claim = workerClaimSchema.parse({
    ...dispatch,
    attemptId,
    fence: 1,
    design: night,
    identity: nightIdentity,
    workerBuildSha256: 'a'.repeat(64),
    recipeBundleSha256: 'b'.repeat(64),
    views: partial.views
      .filter((view) => view.status === 'missing')
      .map(({ cameraRef, imageKey }) => ({ cameraRef, imageKey })),
    limits: EXECUTION_LIMITS,
    deadlineAt: '2030-01-01T00:00:00.000Z',
  })
  const receipt = artifactReceiptSchema.parse({
    contractVersion: CONTRACT_VERSION,
    jobId,
    attemptId,
    imageKey: claim.views[0].imageKey,
    design: {
      ...night,
      presentation: { ...night.presentation, cameraRef: claim.views[0].cameraRef },
    },
    recipeRelease: RECIPE_RELEASE,
    workerBuildSha256: claim.workerBuildSha256,
    recipeBundleSha256: claim.recipeBundleSha256,
    sceneManifestSha256: 'c'.repeat(64),
    cameraBindingSha256: 'd'.repeat(64),
    sha256: 'e'.repeat(64),
    bytes: 1000,
    width: 1920,
    height: 1200,
    mime: 'image/webp',
    samples: 1024,
    completedSamples: 1024,
    adaptiveSampling: false,
    quality: 95,
    device: 'NVIDIA L40S',
    engine: 'CYCLES',
    backend: 'OPTIX',
    blenderVersion: '4.5.0',
    renderSeconds: 60,
    cpuFallback: false,
  })
  const event = workerEventSchema.parse({
    contractVersion: CONTRACT_VERSION,
    jobId,
    attemptId,
    fence: 1,
    eventId,
    sequence: 1,
    kind: 'progress',
    cameraRef: claim.views[0].cameraRef,
    stage: 'preparing',
  })
  const uploadRequest = artifactEventSchema.parse({
    contractVersion: CONTRACT_VERSION,
    jobId,
    attemptId,
    fence: 1,
    eventId: '00000000-0000-4000-8000-000000000005',
    sequence: 2,
    kind: 'artifact',
    receipt,
  })
  const uploadTicket = uploadTicketSchema.parse({
    bucket: 'render-library-staging',
    objectKey: stagingObjectKey(receipt),
    uploadUrl: `https://storage.example/storage/v1/object/upload/sign/render-library-staging/${stagingObjectKey(receipt)}?token=TEST_ONLY`,
    expiresAt: '2030-01-01T00:00:00.000Z',
    maxBytes: receipt.bytes,
    overwrite: false,
  })
  const schemas = {
    lookupRequestSchema,
    createJobRequestSchema,
    retryJobRequestSchema,
    lookupResponseSchema,
    imageDescriptorSchema,
    sessionResponseSchema,
    dispatchEnvelopeSchema,
    dispatchResultSchema,
    claimRequestSchema,
    claimResponseSchema,
    workerClaimSchema,
    workerEventSchema,
    artifactReceiptSchema,
    artifactEventSchema,
    eventResponseSchema,
    uploadTicketSchema,
  }
  return {
    'container-camera.json': {
      testOnly: true,
      design: container,
      identity: await computeSetIdentity(container),
      canonicalSet: identityPayload(container, 'set'),
      canonicalImage: identityPayload(container, 'image'),
    },
    'http-contract.json': {
      contractVersion: CONTRACT_VERSION,
      canonicalization:
        'UTF-8 JSON; recursive lexicographic object-key sort; arrays retain order; separators comma/colon; no whitespace; finite numbers only. Parse via parseDesign/serializeDesign first.',
      design,
      identity,
      canonicalSet: identityPayload(design, 'set'),
      canonicalImage: identityPayload(design, 'image'),
      lookup,
      create,
      complete,
      partial,
      missing,
      jobStates,
      lookupFailure: apiErrorSchema.parse({
        contractVersion: CONTRACT_VERSION,
        status: 'error',
        error: {
          code: 'lookup-unavailable',
          message: 'Could not check the image library.',
          retryable: true,
        },
      }),
    },
    'worker-adapter.json': {
      testOnly: true,
      contractVersion: CONTRACT_VERSION,
      dispatch,
      claim,
      progress: event,
      receipt,
      uploadRequest,
      uploadTicket,
      uncertain: dispatchResultSchema.parse({
        status: 'uncertain',
        reason: safeError('dispatch-uncertain'),
      }),
    },
    'database-contract.json': DATABASE_CONTRACT,
    'schemas.json': Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema, { io: 'input' }),
      ]),
    ),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  for (const [name, fixture] of Object.entries(await contractFixtures(root)))
    writeFileSync(
      resolve(root, 'src/render-library/fixtures', name),
      JSON.stringify(fixture, null, 2) + '\n',
    )
}
