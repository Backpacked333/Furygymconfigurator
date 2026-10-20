import { z } from 'zod'
import {
  bindCloudRecipe,
  cloudRecipeSchema,
  CLOUD_DISPLAY_LABEL,
  cloudArtifactSchema,
  cloudDisplayImagePath,
  type CloudRecipe,
} from '../../../display/cloudContract'
import { cloudWorkerReceiptSchema, type CloudWorkerReceipt } from '../../../display/cloudSession'
import { displayJobSchema, validateDisplayJob, type DisplayJob } from '../../../display/session'
import {
  DISPLAY_LIMITS,
  displayDigestSchema,
  displayHolds,
  stableDisplayJson,
} from '../../../display/contract'
import { displayCameraDigest } from '../../../render/display/input'
import { verifyDisplayPixels } from '../../display/cache'
import { DisplayDirectory, hash } from '../../display/files'
import { capacity, invalid } from './errors'
import { unconfiguredEvidence, type CloudEvidenceVerifier } from './evidence'

const metadataSchema = z
  .object({
    kind: z.literal('external-display-cache-object@1'),
    job: displayJobSchema,
    receipt: cloudWorkerReceiptSchema,
    receiptDigest: displayDigestSchema,
    proofDigest: displayDigestSchema,
  })
  .strict()
export type CachedCloudDisplay = {
  job: DisplayJob
  receipt: CloudWorkerReceipt
  receiptDigest: string
  proofDigest: string
  png: Buffer
}
export async function validateCloudRecipe(design: unknown, input: unknown): Promise<CloudRecipe> {
  const recipe = cloudRecipeSchema.parse(input)
  const expected = await bindCloudRecipe(
    design,
    recipe.binding.build,
    recipe.workerPackageDigest,
    await displayCameraDigest(design),
  )
  if (stableDisplayJson(expected) !== stableDisplayJson(recipe)) throw invalid()
  return expected
}
export async function verifyCloudOutput(
  job: DisplayJob,
  recipe: CloudRecipe,
  input: unknown,
  png: Uint8Array,
  evidence: CloudEvidenceVerifier = unconfiguredEvidence,
) {
  await validateDisplayJob(job, recipe.binding.build)
  await validateCloudRecipe(job.design, recipe)
  const receipt = cloudWorkerReceiptSchema.parse(input)
  if (
    stableDisplayJson(job.binding) !== stableDisplayJson(recipe.binding) ||
    stableDisplayJson(receipt.recipe) !== stableDisplayJson(recipe) ||
    receipt.image.cameraDigest !== recipe.cameraDigest ||
    receipt.proof.workerPackageDigest !== recipe.workerPackageDigest ||
    receipt.proof.runtimePolicyDigest !== recipe.binding.build.runtimePolicyDigest ||
    receipt.proof.observedRuntime.state !== 'observed' ||
    receipt.proof.observedHardware.state !== 'observed'
  )
    throw invalid()
  await evidence.verify(receipt)
  verifyDisplayPixels(job, receipt.image, png)
  return receipt
}
export function cloudArtifact(value: CachedCloudDisplay, interestId: string, hit: boolean) {
  const { receipt, job } = value
  const image = receipt.image
  return cloudArtifactSchema.parse({
    checksum: image.checksum,
    receiptDigest: value.receiptDigest,
    mediaType: 'image/png',
    byteLength: image.byteLength,
    width: image.width,
    height: image.height,
    src: cloudDisplayImagePath(interestId, image.checksum),
    exactMatch: true,
    approvedCurrentImage: false,
    cacheStatus: hit ? 'verified-exact-hit' : 'rendered-miss',
    provenance: {
      kind: 'external-private-three-display',
      label: CLOUD_DISPLAY_LABEL,
      sessionId: image.sessionId,
      revision: image.revision,
      proofDigest: value.proofDigest,
      qualified: false,
      productionAllowed: false,
      strictReference: false,
      visualParityClaimed: false,
      holds: displayHolds(job.design),
    },
  })
}

/** Distinct immutable namespace; never reads DisplayCache objects or strips the outer receipt.
 * The shared directory primitive provides no-follow/private/inode/bounds protection, not local authority. */
export class CloudCache {
  constructor(
    private readonly directory: DisplayDirectory,
    private readonly evidence: CloudEvidenceVerifier = unconfiguredEvidence,
  ) {}
  private inventory() {
    const names = this.directory.names(DISPLAY_LIMITS.cacheEntries * 2)
    if (names.some((n) => !/^[a-f0-9]{64}\.(?:png|json)$/.test(n))) throw invalid()
    const keys = new Set(names.map((n) => n.slice(0, 64)))
    for (const key of keys)
      if (!names.includes(`${key}.json`) || !names.includes(`${key}.png`)) throw invalid()
    let bytes = 0
    for (const name of names)
      bytes += this.directory.size(
        name,
        name.endsWith('.png') ? DISPLAY_LIMITS.pngBytes : DISPLAY_LIMITS.replyBytes,
      )
    if (bytes > DISPLAY_LIMITS.cacheBytes) throw invalid()
    return { entries: keys.size, bytes }
  }
  async get(recipe: CloudRecipe): Promise<CachedCloudDisplay | null> {
    try {
      cloudRecipeSchema.parse(recipe)
      this.inventory()
      const key = recipe.recipeDigest.slice(7)
      if (!this.directory.has(`${key}.json`)) return null
      const meta = metadataSchema.parse(
        JSON.parse(this.directory.read(`${key}.json`, DISPLAY_LIMITS.replyBytes).toString('utf8')),
      )
      if (
        hash(stableDisplayJson(meta.receipt)) !== meta.receiptDigest ||
        hash(stableDisplayJson(meta.receipt.proof)) !== meta.proofDigest
      )
        throw invalid()
      const png = this.directory.read(`${key}.png`, DISPLAY_LIMITS.pngBytes)
      const receipt = await verifyCloudOutput(meta.job, recipe, meta.receipt, png, this.evidence)
      return { ...meta, receipt, png }
    } catch {
      throw invalid()
    }
  }
  async put(
    job: DisplayJob,
    recipe: CloudRecipe,
    input: unknown,
    png: Uint8Array,
    revalidate: () => Promise<void>,
    fence: () => void,
  ): Promise<CachedCloudDisplay> {
    const receipt = await verifyCloudOutput(job, recipe, input, png, this.evidence)
    const receiptDigest = hash(stableDisplayJson(receipt)),
      proofDigest = hash(stableDisplayJson(receipt.proof))
    const metadata = Buffer.from(
      stableDisplayJson({
        kind: 'external-display-cache-object@1',
        job,
        receipt,
        receiptDigest,
        proofDigest,
      }),
    )
    if (metadata.length > DISPLAY_LIMITS.replyBytes) throw invalid()
    const inventory = this.inventory()
    if (
      inventory.entries >= DISPLAY_LIMITS.cacheEntries ||
      inventory.bytes + png.length + metadata.length > DISPLAY_LIMITS.cacheBytes
    )
      throw capacity()
    await revalidate()
    fence()
    const key = recipe.recipeDigest.slice(7)
    // Metadata is the commit marker. Any interrupted publication poisons the namespace on restart.
    this.directory.publish(`${key}.png`, png)
    fence()
    this.directory.publish(`${key}.json`, metadata)
    const result = await this.get(recipe)
    fence()
    if (!result) throw invalid()
    return result
  }
}
