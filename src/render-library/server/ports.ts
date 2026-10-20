import type { DesignEnvelope } from '../../domain/design.js'
import type { SampleProgress } from '../sampleProgress.js'
import type {
  CreateJobRequest,
  ImageDescriptor,
  LibraryResponse,
  LookupRequest,
  RetryJobRequest,
  SafeError,
  SetIdentity,
  SetSnapshot,
} from '../contracts.js'
import type {
  ArtifactReceipt,
  ArtifactEvent,
  ClaimRequest,
  DispatchEnvelope,
  DispatchResult,
  TerminationEvidence,
  WorkerClaim,
  WorkerEvent,
  UploadTicket,
} from '../workerProtocol.js'

export type AdmissionContext = Readonly<{
  sessionHash: string
  networkHash: string
  sameOriginVerified: true
  csrfVerified: true
}>
export type RecipeRegistration = Readonly<{
  releaseId: 'fury-native-five@2'
  workerBuildSha256: string
  recipeBundleSha256: string
  geometrySha256: string
  materialsSha256: string
  camerasSha256: string
  rendererSha256: string
  gpuDevice?: 'NVIDIA GeForce RTX 5090'
}>
export type AdmissionPolicy = Readonly<{
  enabled: true
  approvalId: string
  expiresAt: string
  globalBudgetMicroUsd: number
  /** All-in upper bound including GPU/CPU/startup/storage; not a guessed live spot quote. */
  maxJobLiabilityMicroUsd: number
  maxImageLiabilityMicroUsd: number
  startupLiabilityMicroUsd: number
  recipe: RecipeRegistration
}>
export type ReserveCommand = Readonly<{
  request: CreateJobRequest
  identity: SetIdentity
  context: AdmissionContext
  policy: AdmissionPolicy
  seedImages: readonly ImageDescriptor[]
}>
export type AdmissionResult =
  | { status: 'admitted' | 'joined' | 'cached'; snapshot: SetSnapshot }
  | { status: 'denied'; error: SafeError }
export type OutboxClaim = { dispatch: DispatchEnvelope; claimToken: string }
export type VerifiedArtifact = {
  receipt: ArtifactReceipt
  receiptSha256: string
  image: ImageDescriptor
}

/** Service-only SQL functions. Each command is ONE transaction, not a sequence of REST writes. */
export interface RenderLibraryRpc {
  render_library_get_samples: {
    args: { jobId: string; sessionHash: string }
    result: SampleProgress | null
  }
  render_library_reserve_set: { args: { command: ReserveCommand }; result: AdmissionResult }
  render_library_retry_failed: {
    args: {
      jobId: string
      request: RetryJobRequest
      context: AdmissionContext
      policy: AdmissionPolicy
    }
    result: AdmissionResult
  }
  render_library_claim_dispatch: {
    args: { dispatcherId: string; lane?: 'foreground' | 'background'; workerBuildSha256?: string }
    result: OutboxClaim | null
  }
  render_library_record_dispatch: {
    args: { dispatchId: string; claimToken: string; result: DispatchResult }
    result: null
  }
  render_library_claim_worker: {
    args: { dispatch: DispatchEnvelope; workerBuildSha256: string }
    result: WorkerClaim | null
  }
  render_library_record_event: { args: { event: WorkerEvent }; result: { accepted: boolean } }
  render_library_publish_asset: {
    args: { jobId: string; attemptId: string; fence: number; artifact: VerifiedArtifact }
    result: { published: boolean }
  }
  render_library_reconcile_terminal: {
    args: { jobId: string; evidence: TerminationEvidence; chargedMicroUsd: number }
    result: { retrySafe: boolean }
  }
}
export interface RenderLibraryRepository {
  lookup(design: DesignEnvelope, identity: SetIdentity): Promise<SetSnapshot>
  getJob(jobId: string): Promise<SetSnapshot | null>
  rpc<K extends keyof RenderLibraryRpc>(
    name: K,
    args: RenderLibraryRpc[K]['args'],
  ): Promise<RenderLibraryRpc[K]['result']>
}
export interface RenderLibraryService {
  lookup(request: LookupRequest): Promise<LibraryResponse>
  create(request: CreateJobRequest, context: AdmissionContext): Promise<LibraryResponse>
  status(jobId: string): Promise<LibraryResponse>
  retry(
    jobId: string,
    request: RetryJobRequest,
    context: AdmissionContext,
  ): Promise<LibraryResponse>
}
export interface RenderDispatcher {
  /** One attempt after durable claim. A network timeout is uncertain, NEVER a safe retry. */
  dispatch(envelope: DispatchEnvelope): Promise<DispatchResult>
}
/** Private authenticated HTTP adapter. The renderer child receives none of its credentials. */
export interface WorkerServicePort {
  claim(request: ClaimRequest): Promise<{ claim: WorkerClaim | null }>
  prepareUpload(event: ArtifactEvent): Promise<UploadTicket>
  recordEvent(event: WorkerEvent): Promise<{ accepted: boolean }>
}
export interface ImmutableArtifactStore {
  /** Must verify existing bytes on conflict; no upsert/overwrite. */
  putIfAbsent(objectKey: string, bytes: Uint8Array, sha256: string): Promise<{ url: string }>
  read(objectKey: string, maxBytes: number): Promise<Uint8Array>
}

export const DATABASE_TABLES = Object.freeze({
  recipes: 'render_library_recipes',
  workerBuilds: 'render_library_worker_builds',
  approvals: 'render_library_approvals',
  sets: 'render_library_sets',
  images: 'render_library_images',
  jobs: 'render_library_jobs',
  jobImages: 'render_library_job_images',
  reservations: 'render_library_reservations',
  outbox: 'render_library_outbox',
  events: 'render_library_events',
  sessions: 'render_library_sessions',
  idempotency: 'render_library_idempotency',
})
