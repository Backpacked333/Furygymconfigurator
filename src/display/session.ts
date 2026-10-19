import { z } from 'zod'
import { designEnvelopeSchema, freezeDesignValue } from '../domain/design'
import {
  bindDisplay,
  displayBindingSchema,
  displayBuildSchema,
  displayDigestSchema,
  displayIdSchema,
  DISPLAY_LIMITS,
  DISPLAY_PROTOCOL,
  stableDisplayJson,
  type DisplayBuild,
} from './contract'

/** Private process boundary only. Never re-export this file from the browser client. */
export const displayJobSchema = z
  .object({
    protocol: z.literal(DISPLAY_PROTOCOL),
    jobId: displayIdSchema,
    sessionId: displayIdSchema,
    revision: z.number().int().min(1).max(DISPLAY_LIMITS.jobsPerSession),
    design: designEnvelopeSchema,
    binding: displayBindingSchema,
  })
  .strict()
export type DisplayJob = z.infer<typeof displayJobSchema>
export async function validateDisplayJob(input: unknown, build: DisplayBuild): Promise<DisplayJob> {
  const job = displayJobSchema.parse(input)
  if (stableDisplayJson(job.binding) !== stableDisplayJson(await bindDisplay(job.design, build)))
    throw new Error('Private display job build/profile/design mismatch.')
  return job
}
export const DISPLAY_READY_PARTS = [
  'react-commit',
  'materials',
  'environment',
  'interior-probe',
  'site-probe',
  'site-field',
  'pipeline-warm',
] as const
export type DisplayReadyPart = (typeof DISPLAY_READY_PARTS)[number]
const readinessSchema = z
  .object({
    revision: z.number().int().positive(),
    resources: z.literal('all-current-revision'),
    temporalFrames: z.number().int().min(40).max(240),
    postReadyFrames: z.number().int().min(2).max(240),
  })
  .strict()
export const displayReceiptSchema = z
  .object({
    protocol: z.literal(DISPLAY_PROTOCOL),
    kind: z.literal('private-three-display'),
    jobId: displayIdSchema,
    sessionId: displayIdSchema,
    revision: z.number().int().positive(),
    binding: displayBindingSchema,
    cameraDigest: displayDigestSchema,
    checksum: displayDigestSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    byteLength: z.number().int().min(44).max(DISPLAY_LIMITS.pngBytes),
    readiness: readinessSchema,
    runtime: z
      .object({
        backend: z.literal('webgpu'),
        acceleration: z.literal('hardware'),
        adapter: z.string().min(1).max(512),
        browserVersion: z.string().min(1).max(128),
      })
      .strict(),
    elapsedMs: z.number().finite().min(0).max(DISPLAY_LIMITS.jobMs),
    // A completed image leaves a warm host alive. It proves neither stop nor billing settlement.
    hostShutdownProven: z.literal(false),
    billingFinal: z.literal(false),
  })
  .strict()
export type DisplayReceipt = z.infer<typeof displayReceiptSchema>
export function parseDisplayReceipt(input: unknown, job: DisplayJob): DisplayReceipt {
  const receipt = displayReceiptSchema.parse(input)
  if (
    receipt.jobId !== job.jobId ||
    receipt.sessionId !== job.sessionId ||
    receipt.revision !== job.revision ||
    receipt.readiness.revision !== job.revision ||
    stableDisplayJson(receipt.binding) !== stableDisplayJson(job.binding) ||
    receipt.width !== job.binding.profile.width ||
    receipt.height !== job.binding.profile.height
  )
    throw new Error('Display receipt does not belong to this job/revision/profile.')
  return receipt
}
/** Not an authorization issuer. The host must independently validate the operator-only permit,
 * its expiry and a durable, non-resettable run budget before starting any owned process.
 * No permit exists in this stage. Browser requests cannot carry or mint one. */
export const localDisplayPermitSchema = z
  .object({
    kind: z.literal('operator-local-only'),
    runId: displayIdSchema,
    approvalReference: z.string().min(1).max(256),
    expiresAt: z.number().int().positive(),
    maxJobs: z.number().int().min(1).max(DISPLAY_LIMITS.jobsPerSession),
    maxOutputBytes: z.number().int().min(1).max(DISPLAY_LIMITS.sessionOutputBytes),
    paidExecutionAllowed: z.literal(false),
    productionAllowed: z.literal(false),
  })
  .strict()
export type LocalDisplayPermit = z.infer<typeof localDisplayPermitSchema>
export interface PrivateDisplaySession {
  readonly sessionId: string
  readonly build: DisplayBuild
  /** Single-flight: reject overlap; increasing revision. Failure/abort poisons the session. */
  render(
    job: DisplayJob,
    signal: AbortSignal,
  ): Promise<{ receipt: DisplayReceipt; png: Uint8Array }>
  /** Idempotent; resolves only after owned child exit, or rejects with quarantine still held. */
  close(reason: 'idle' | 'limit' | 'cancelled' | 'poisoned' | 'shutdown'): Promise<void>
}
export interface PrivateDisplayBackend {
  /** Hash trusted closure, assets and private worker bundle; NEVER start a browser/GPU. */
  prepare(): Promise<DisplayBuild>
  revalidate(build: DisplayBuild): Promise<void>
  /** Actual owned host connection. No callback-fabricated pixels in the production factory. */
  open(permit: LocalDisplayPermit): Promise<PrivateDisplaySession>
  close(): Promise<void>
}
export function parsePreparedDisplayBuild(input: unknown): DisplayBuild {
  return freezeDesignValue(displayBuildSchema.parse(input))
}
