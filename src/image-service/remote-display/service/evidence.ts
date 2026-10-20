import type { CloudWorkerReceipt } from '../../../display/cloudSession'
import { DISPLAY_LIMITS } from '../../../display/contract'
import { DisplayDirectory } from '../../display/files'
import { validateCloudProof, type ReceiptTrust, type EvidenceStore } from '../worker/receipt'
import { verifyExternalApproval, type ApprovalTrust } from '../worker/admission'
import { invalid } from './errors'

export interface CloudEvidenceVerifier {
  /** Must validate persisted records and their trusted observer chain, not just digest syntax. */
  verify(receipt: CloudWorkerReceipt): Promise<void>
}
export const unconfiguredEvidence: CloudEvidenceVerifier = {
  async verify() {
    throw invalid()
  },
}
export type CloudEvidenceTrust = {
  receipt: Omit<ReceiptTrust, 'evidence'>
  observerKeys: EvidenceStore['observerKeys']
  /** Frozen admission-time identity/time, not a current browser request or a cache-read clock.
   * Actual admission is not implemented/authorized by this read-only evidence adapter. */
  approval: ApprovalTrust
}
/** Read-only adapter to the candidate worker's signed evidence format. No signer, launch permit
 * issuer, credential loading or provider calls. Production does not provision this trust.
 * This deliberately re-runs hardware/runtime/signature checks independently of the worker caller.
 * Per-observation trusted keys prevent process exit/terminate requests becoming billing proof. */
export function createCloudEvidenceVerifier(
  directory: DisplayDirectory,
  trust: CloudEvidenceTrust,
): CloudEvidenceVerifier {
  return {
    async verify(receipt) {
      if (
        receipt.approvalDigest !== trust.receipt.approvalDigest ||
        receipt.recipe.workerPackageDigest !== trust.approval.workerPackageDigest ||
        receipt.proof.runtimePolicyDigest !== trust.approval.runtimePolicyDigest
      )
        throw invalid()
      // Keep the signed approval envelope separate from observations. Digest is the canonical
      // approval payload, matching verifyExternalApproval, not the whole signed envelope.
      const approvalBytes = directory.read(
        `${receipt.approvalDigest.slice(7)}.approval.json`,
        DISPLAY_LIMITS.replyBytes,
      )
      const verified = verifyExternalApproval(
        JSON.parse(approvalBytes.toString('utf8')),
        trust.approval,
      )
      if (verified.approvalDigest !== receipt.approvalDigest) throw invalid()
      const observed = await validateCloudProof(receipt.proof, receipt.image.sessionId, {
        ...trust.receipt,
        evidence: {
          observerKeys: trust.observerKeys,
          async read(digest) {
            if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw invalid()
            return directory.read(`${digest.slice(7)}.json`, DISPLAY_LIMITS.replyBytes)
          },
        },
      })
      if (
        receipt.image.runtime.adapter !== observed.hardware.adapter ||
        receipt.image.runtime.browserVersion !== observed.runtime.pageVersion
      )
        throw invalid()
    },
  }
}
