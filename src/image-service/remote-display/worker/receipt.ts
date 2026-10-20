import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import {
  bindCloudRecipe,
  cloudProofSchema,
  type CloudRecipe,
  type CloudProof,
} from '../../../display/cloudContract'
import { cloudWorkerReceiptSchema, type CloudWorkerReceipt } from '../../../display/cloudSession'
import {
  DISPLAY_LIMITS,
  displayDigestSchema,
  displayIdSchema,
  stableDisplayJson,
} from '../../../display/contract'
import { validateDisplayJob, type DisplayJob } from '../../../display/session'
import { displayCameraDigest } from '../../../render/display/input'
import { sha } from '../../../render/display/build'
import {
  validateHostHardware,
  validateObservedBrowserVersion,
} from '../../../render/display/process'
import { verifyDisplayPixels } from '../../display/cache'

export const observationKinds = [
  'observedRuntime',
  'observedHardware',
  'observedProcessExit',
  'observedProviderTermination',
  'observedBillingFinal',
] as const
export type ObservationKind = (typeof observationKinds)[number]
const evidenceSchema = z
  .object({
    kind: z.enum(observationKinds),
    sessionId: displayIdSchema,
    workerPackageDigest: displayDigestSchema,
    runtimePolicyDigest: displayDigestSchema,
    approvalDigest: displayDigestSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
const signedEvidenceSchema = z
  .object({
    evidence: evidenceSchema,
    signerId: displayIdSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict()
/** Only the owner-side immutable evidence store supplies these records and trusted observer keys. */
export type EvidenceStore = {
  read(digest: string): Promise<Uint8Array>
  observerKeys: ReadonlyMap<ObservationKind, ReadonlyMap<string, string>>
}
const runtimePayload = z
  .object({
    product: z.literal('HeadlessChrome/137.0.7118.2').or(z.literal('Chrome/137.0.7118.2')),
    userAgent: z.string().max(1024),
    pageVersion: z.string().max(128),
    runtime: z.literal('vm'),
    uid: z.number().int().positive(),
    sandboxEnabled: z.literal(true),
    pidfd: z.literal(true),
    subreaper: z.literal(true),
    parentIdentityBound: z.literal(true),
    commandPolicyDigest: displayDigestSchema,
    runtimeFilesDigest: displayDigestSchema,
    fontFilesDigest: displayDigestSchema,
  })
  .strict()
const terminalPayload = z
  .object({
    providerObjectDigest: displayDigestSchema,
    independentlyObservedTerminal: z.literal(true),
    observer: z.literal('independent-provider-status'),
  })
  .strict()
export type ReceiptTrust = {
  approvalDigest: string
  runtimeFilesDigest: string
  fontFilesDigest: string
  commandPolicyDigest: string
  providerObjectDigest: string
  evidence: EvidenceStore
}
/** Shape-only proofs are insufficient. Every claimed observation resolves to signed persisted bytes. */
export async function validateCloudProof(
  proofInput: CloudProof,
  sessionId: string,
  trust: ReceiptTrust,
) {
  const proof = cloudProofSchema.parse(proofInput)
  const observations = new Map<ObservationKind, z.infer<typeof evidenceSchema>>()
  for (const kind of observationKinds) {
    const observation = proof[kind]
    if (observation.state === 'unobserved') continue
    const bytes = await trust.evidence.read(observation.evidenceDigest!)
    if (bytes.length > DISPLAY_LIMITS.replyBytes || sha(bytes) !== observation.evidenceDigest)
      throw new Error('Cloud evidence digest/bound mismatch.')
    const signed = signedEvidenceSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    const e = signed.evidence
    if (
      e.kind !== kind ||
      e.sessionId !== sessionId ||
      e.workerPackageDigest !== proof.workerPackageDigest ||
      e.runtimePolicyDigest !== proof.runtimePolicyDigest ||
      e.approvalDigest !== trust.approvalDigest
    )
      throw new Error('Cloud evidence binding mismatch.')
    const pem = trust.evidence.observerKeys.get(kind)?.get(signed.signerId)
    if (!pem) throw new Error('Cloud observer is not trusted for this observation.')
    const key = createPublicKey(pem)
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, Buffer.from(stableDisplayJson(e)), key, Buffer.from(signed.signature, 'base64'))
    )
      throw new Error('Cloud evidence signature invalid.')
    observations.set(kind, e)
  }
  const runtime = observations.get('observedRuntime')
  const hardware = observations.get('observedHardware')
  if (!runtime || !hardware) throw new Error('Cloud runtime/hardware remain unobserved.')
  const r = runtimePayload.parse(runtime.payload)
  if (
    r.runtimeFilesDigest !== trust.runtimeFilesDigest ||
    r.fontFilesDigest !== trust.fontFilesDigest ||
    r.commandPolicyDigest !== trust.commandPolicyDigest
  )
    throw new Error('Cloud runtime closure mismatch.')
  validateObservedBrowserVersion(r.pageVersion, r.product, r.userAgent)
  const h = z
    .object({ adapter: z.string().min(1).max(512), host: z.record(z.string(), z.unknown()) })
    .strict()
    .parse(hardware.payload)
  validateHostHardware(h.host, h.adapter)
  if (observations.has('observedProcessExit'))
    z.object({
      ownedDescendantsReaped: z.literal(true),
      parentIdentityBound: z.literal(true),
      exitCode: z.literal(0),
    })
      .strict()
      .parse(observations.get('observedProcessExit')!.payload)
  if (observations.has('observedProviderTermination')) {
    const p = terminalPayload.parse(observations.get('observedProviderTermination')!.payload)
    if (p.providerObjectDigest !== trust.providerObjectDigest)
      throw new Error('Cloud terminal object mismatch.')
  }
  if (observations.has('observedBillingFinal')) {
    const b = z
      .object({
        providerObjectDigest: displayDigestSchema,
        finalSettlement: z.literal(true),
        chargeMicrousd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        invoiceDigest: displayDigestSchema,
      })
      .strict()
      .parse(observations.get('observedBillingFinal')!.payload)
    if (
      b.providerObjectDigest !== trust.providerObjectDigest ||
      !observations.has('observedProviderTermination')
    )
      throw new Error('Cloud billing/termination binding mismatch.')
  }
  return { runtime: r, hardware: h }
}
export async function verifyCloudRenderOutput(
  jobInput: DisplayJob,
  recipe: CloudRecipe,
  receiptInput: unknown,
  png: Uint8Array,
  trust: ReceiptTrust,
): Promise<CloudWorkerReceipt> {
  if (
    Buffer.byteLength(JSON.stringify(receiptInput)) > DISPLAY_LIMITS.replyBytes ||
    png.length > DISPLAY_LIMITS.pngBytes
  )
    throw new Error('Cloud output bound.')
  const job = await validateDisplayJob(jobInput, recipe.binding.build)
  const expected = await bindCloudRecipe(
    job.design,
    recipe.binding.build,
    recipe.workerPackageDigest,
    await displayCameraDigest(job.design),
  )
  const receipt = cloudWorkerReceiptSchema.parse(receiptInput)
  if (
    stableDisplayJson(expected) !== stableDisplayJson(recipe) ||
    stableDisplayJson(receipt.recipe) !== stableDisplayJson(recipe) ||
    stableDisplayJson(job.binding) !== stableDisplayJson(recipe.binding) ||
    receipt.image.cameraDigest !== recipe.cameraDigest ||
    receipt.approvalDigest !== trust.approvalDigest ||
    receipt.proof.workerPackageDigest !== recipe.workerPackageDigest ||
    receipt.proof.runtimePolicyDigest !== recipe.binding.build.runtimePolicyDigest
  )
    throw new Error('Cloud output recipe/camera/package/approval mismatch.')
  const evidence = await validateCloudProof(receipt.proof, job.sessionId, trust)
  if (
    receipt.image.runtime.adapter !== evidence.hardware.adapter ||
    receipt.image.runtime.browserVersion !== evidence.runtime.pageVersion
  )
    throw new Error('Cloud receipt observation mismatch.')
  verifyDisplayPixels(job, receipt.image, png)
  return receipt
}
