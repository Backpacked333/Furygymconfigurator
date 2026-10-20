import { defaultDesign, type DesignEnvelope } from '../domain/design'
import {
  CONTRACT_VERSION,
  IMAGE_DIMENSIONS,
  customerDesignSchema,
  type SetSnapshot,
  type ImageDescriptor,
} from '../render-library/contracts'
import { computeSetIdentity } from '../render-library/identity'
import { CUSTOMER_CAMERA_REFS, viewDesign } from '../render-library/views'

export const jobId = '11111111-1111-4111-8111-111111111111'
export const storageOrigin = 'https://storage.example.test'
export const designFixture = () => defaultDesign()
export async function snapshotFixture(
  design: DesignEnvelope = designFixture(),
  count = 0,
): Promise<SetSnapshot> {
  const identity = await computeSetIdentity(design)
  return {
    contractVersion: CONTRACT_VERSION,
    status: 'ok',
    identity,
    coverage: count === 5 ? 'complete' : count ? 'partial' : 'missing',
    job: null,
    rendering: { status: 'enabled' },
    views: CUSTOMER_CAMERA_REFS.map((cameraRef, index) => {
      const imageKey = identity.imageKeys[cameraRef]
      const base = { cameraRef, imageKey }
      if (index >= count) return { ...base, status: 'missing' }
      const sha256 = 'a'.repeat(64)
      const image: ImageDescriptor = {
        contractVersion: CONTRACT_VERSION,
        setKey: identity.setKey,
        imageKey,
        design: customerDesignSchema.parse(viewDesign(design, cameraRef)),
        recipeRelease: identity.recipeRelease,
        url: `${storageOrigin}/render-library/${identity.setKey}/${imageKey}/${sha256}.webp`,
        sha256,
        bytes: 100,
        ...IMAGE_DIMENSIONS[design.presentation.aspect],
        mime: 'image/webp',
        samples: 1024,
        adaptiveSampling: false,
        quality: 95,
        provenance: {
          kind: 'native-worker',
          jobId,
          attemptId: jobId,
          workerBuildSha256: sha256,
          recipeBundleSha256: sha256,
          receiptSha256: sha256,
        },
        productionAllowed: false,
        visuallyQualified: false,
        strictReference: false,
        engineeringApproved: false,
      }
      return { ...base, status: 'ready', image }
    }),
  }
}
export function queued(snapshot: SetSnapshot): SetSnapshot {
  return {
    ...snapshot,
    job: {
      id: jobId,
      stage: 'queued',
      completedImages: snapshot.views.filter((view) => view.status === 'ready').length,
      totalImages: 5,
      currentCamera: null,
      retrySafe: false,
      error: null,
      updatedAt: new Date().toISOString(),
    },
  }
}
