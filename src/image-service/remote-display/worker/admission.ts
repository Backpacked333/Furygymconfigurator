import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import {
  displayDigestSchema,
  displayIdSchema,
  DISPLAY_LIMITS,
  stableDisplayJson,
} from '../../../display/contract'
import { sha } from '../../../render/display/build'

const positiveCap = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/** Proposed private launch envelope, NOT an issuer. No accepted production signer is configured. */
export const externalApprovalSchema = z
  .object({
    kind: z.literal('external-display-launch-approval@1'),
    approvalId: displayIdSchema,
    ownerDigest: displayDigestSchema,
    workerPackageDigest: displayDigestSchema,
    runtimePolicyDigest: displayDigestSchema,
    imageDigest: displayDigestSchema,
    runtimeFilesDigest: displayDigestSchema,
    fontFilesDigest: displayDigestSchema,
    sdkVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    sdkWheelDigest: displayDigestSchema,
    issuedAt: positiveCap,
    expiresAt: positiveCap,
    paidExecutionAllowed: z.literal(true),
    productionAllowed: z.literal(false),
    resources: z
      .object({
        provider: z.literal('modal-candidate'),
        runtime: z.literal('vm'),
        gpu: z.enum(['T4', 'L4', 'A10']),
        gpuCount: z.literal(1),
        cpuMillis: positiveCap,
        memoryMiB: positiveCap,
        lifetimeMs: z.number().int().min(1).max(DISPLAY_LIMITS.lifetimeMs),
        idleMs: z.number().int().min(1).max(DISPLAY_LIMITS.idleMs),
        maxJobs: z.number().int().min(1).max(DISPLAY_LIMITS.jobsPerSession),
        maxImages: z.number().int().min(1).max(DISPLAY_LIMITS.jobsPerSession),
        maxOutputBytes: z.number().int().min(44).max(DISPLAY_LIMITS.sessionOutputBytes),
        maxProviderCalls: positiveCap,
        maxNetworkAttempts: positiveCap,
        maxStorageBytes: positiveCap,
        maxEgressBytes: positiveCap,
        maxWarmMs: z.number().int().min(0).max(DISPLAY_LIMITS.lifetimeMs),
        maxChargeMicrousd: positiveCap,
        pricingPlanDigest: displayDigestSchema,
        liabilityCalculationDigest: displayDigestSchema,
        guaranteedTerminationPolicyDigest: displayDigestSchema,
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.expiresAt > v.issuedAt &&
      v.expiresAt - v.issuedAt <= DISPLAY_LIMITS.lifetimeMs &&
      v.resources.maxImages <= v.resources.maxJobs &&
      v.resources.maxNetworkAttempts >= v.resources.maxProviderCalls,
    'Invalid nonresettable approval bounds.',
  )
export const signedExternalApprovalSchema = z
  .object({
    approval: externalApprovalSchema,
    signerId: displayIdSchema,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict()
export type ExternalApproval = z.infer<typeof externalApprovalSchema>
export type ApprovalTrust = {
  publicKeys: ReadonlyMap<string, string>
  ownerDigest: string
  workerPackageDigest: string
  runtimePolicyDigest: string
  imageDigest: string
  runtimeFilesDigest: string
  fontFilesDigest: string
  sdkVersion: string
  sdkWheelDigest: string
  now: number
}
/** Verifies identity/signature only. Returning from this function NEVER grants dispatch. */
export function verifyExternalApproval(input: unknown, trust: ApprovalTrust) {
  const envelope = signedExternalApprovalSchema.parse(input)
  const a = envelope.approval
  for (const key of [
    'ownerDigest',
    'workerPackageDigest',
    'runtimePolicyDigest',
    'imageDigest',
    'runtimeFilesDigest',
    'fontFilesDigest',
    'sdkVersion',
    'sdkWheelDigest',
  ] as const)
    if (a[key] !== trust[key]) throw new Error('External approval identity mismatch.')
  if (!Number.isSafeInteger(trust.now) || trust.now < a.issuedAt || trust.now >= a.expiresAt)
    throw new Error('External approval expired/not current.')
  const pem = trust.publicKeys.get(envelope.signerId)
  if (!pem) throw new Error('External approval signer unconfigured.')
  const key = createPublicKey(pem)
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(stableDisplayJson(a)), key, Buffer.from(envelope.signature, 'base64'))
  )
    throw new Error('External approval signature invalid.')
  return { approval: a, approvalDigest: sha(stableDisplayJson(a)) }
}
