import { z } from 'zod'
import { cloudProofSchema, cloudRecipeSchema, type CloudRecipe } from './cloudContract'
import { displayDigestSchema, displayIdSchema } from './contract'
import { displayReceiptSchema, type DisplayJob } from './session'
import type { DesignEnvelope } from '../domain/design'

/** Private worker/service seam, excluded from every browser graph. Never a local permit adapter. */
export const cloudWorkerReceiptSchema = z
  .object({
    kind: z.literal('external-private-three-display-receipt@1'),
    recipe: cloudRecipeSchema,
    image: displayReceiptSchema,
    proof: cloudProofSchema,
    approvalDigest: displayDigestSchema,
  })
  .strict()
export type CloudWorkerReceipt = z.infer<typeof cloudWorkerReceiptSchema>
export type CloudRenderOutput = { receipt: CloudWorkerReceipt; png: Uint8Array }
export interface RemoteDisplaySession {
  readonly sessionId: string
  render(job: DisplayJob, recipe: CloudRecipe, signal: AbortSignal): Promise<CloudRenderOutput>
  /** Close requests are not observed provider termination or final billing. */
  close(reason: 'idle' | 'limit' | 'cancelled' | 'poisoned' | 'shutdown'): Promise<void>
}
export interface RemoteDisplayBackend {
  /** Pure trusted packaging/identity preparation: no GPU, browser, network or provider. */
  prepare(design: DesignEnvelope): Promise<CloudRecipe>
  revalidate(recipe: CloudRecipe): Promise<void>
  /** Always denied by the production factory in this build. No approval issuer exists here. */
  open(approval: unknown): Promise<RemoteDisplaySession>
  close(): Promise<void>
}
export const cloudJobIdentitySchema = z
  .object({ jobId: displayIdSchema, sessionId: displayIdSchema })
  .strict()
