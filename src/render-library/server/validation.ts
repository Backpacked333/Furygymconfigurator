import { serializeDesign } from '../../domain/design.js'
import { canonicalJson, computeSetIdentity } from '../identity.js'
import {
  artifactReceiptSchema,
  workerClaimSchema,
  type ArtifactReceipt,
  type WorkerClaim,
} from '../workerProtocol.js'
import type { RecipeRegistration } from './ports.js'

/** Trusted registration is loaded from the immutable DB row, never from the worker/request. */
export async function verifyWorkerClaim(
  input: unknown,
  recipe: RecipeRegistration,
): Promise<WorkerClaim> {
  const claim = workerClaimSchema.parse(input)
  if (canonicalJson(claim.identity) !== canonicalJson(await computeSetIdentity(claim.design)))
    throw new Error('Worker claim identity mismatch.')
  if (
    claim.identity.recipeRelease.id !== recipe.releaseId ||
    claim.workerBuildSha256 !== recipe.workerBuildSha256 ||
    claim.recipeBundleSha256 !== recipe.recipeBundleSha256
  )
    throw new Error('Worker claim release mismatch.')
  return claim
}

/** Metadata binding only. Publication additionally requires independent byte/decode validation. */
export async function verifyArtifactReceipt(
  input: unknown,
  claim: WorkerClaim,
): Promise<ArtifactReceipt> {
  const receipt = artifactReceiptSchema.parse(input)
  const camera = receipt.design.presentation.cameraRef
  const requested = claim.views.find((view) => view.cameraRef === camera)
  const expectedDesign = {
    ...claim.design,
    presentation: { ...claim.design.presentation, cameraRef: camera },
  }
  if (
    !requested ||
    canonicalJson(receipt.recipeRelease) !== canonicalJson(claim.identity.recipeRelease) ||
    requested.imageKey !== receipt.imageKey ||
    receipt.jobId !== claim.jobId ||
    receipt.attemptId !== claim.attemptId ||
    serializeDesign(receipt.design) !== serializeDesign(expectedDesign) ||
    receipt.workerBuildSha256 !== claim.workerBuildSha256 ||
    receipt.recipeBundleSha256 !== claim.recipeBundleSha256 ||
    receipt.renderSeconds > claim.limits.imageSeconds
  )
    throw new Error('Artifact does not match the claimed work.')
  const identity = await computeSetIdentity(receipt.design)
  if (
    identity.setKey !== claim.identity.setKey ||
    receipt.imageKey !== identity.imageKeys[requested.cameraRef]
  )
    throw new Error('Artifact canonical identity mismatch.')
  return receipt
}
