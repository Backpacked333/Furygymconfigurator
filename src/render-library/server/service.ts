import { z } from 'zod'
import type { DesignEnvelope } from '../../domain/design'
import { CUSTOMER_CAMERA_REFS } from '../../domain/presentation'
import {
  CONTRACT_VERSION,
  imageDescriptorSchema,
  safeError,
  safeErrorSchema,
  setSnapshotSchema,
  type CreateJobRequest,
  type ImageDescriptor,
  type LibraryResponse,
  type LookupRequest,
  type RetryJobRequest,
  type SetIdentity,
  type SetSnapshot,
} from '../contracts'
import { canonicalJson, computeSetIdentity, verifyImageDescriptor } from '../identity'
import {
  artifactEventSchema,
  claimRequestSchema,
  eventResponseSchema,
  workerEventSchema,
  type ArtifactEvent,
  type ClaimRequest,
  type WorkerEvent,
} from '../workerProtocol'
import type {
  AdmissionContext,
  AdmissionPolicy,
  RenderLibraryRepository,
  RenderLibraryService,
  WorkerServicePort,
} from './ports'
import { checksum, SupabaseArtifacts, verifyPixels } from './artifacts'
import { ServiceError } from './httpSafety'
import { SupabaseRepository } from './supabase'
import { verifyArtifactReceipt, verifyWorkerClaim } from './validation'

export interface SeedSource {
  images(design: DesignEnvelope): Promise<readonly ImageDescriptor[]>
}
const admissionSchema = z.union([
  z
    .object({ status: z.enum(['admitted', 'joined', 'cached']), snapshot: setSnapshotSchema })
    .strict(),
  z.object({ status: z.literal('denied'), error: safeErrorSchema }).strict(),
])
export function statusForError(code: string) {
  if (['budget-exhausted', 'rate-limited', 'capacity-full'].includes(code)) return 429
  if (['idempotency-conflict', 'unsafe-retry'].includes(code)) return 409
  if (['origin-denied', 'csrf-invalid'].includes(code)) return 403
  if (code === 'invalid-request') return 400
  if (code === 'job-not-found') return 404
  return 503
}
export class LibraryService implements RenderLibraryService {
  lastAdmission: 'admitted' | 'joined' | 'cached' | null = null
  constructor(
    private readonly repository: RenderLibraryRepository | null,
    private readonly seeds: SeedSource,
    private readonly policy: () => Promise<AdmissionPolicy>,
    private readonly storageOrigins: readonly string[],
  ) {}
  private async availability(): Promise<SetSnapshot['rendering']> {
    try {
      await this.policy()
      return { status: 'enabled' }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: safeError(error instanceof ServiceError ? error.code : 'rendering-disabled'),
      }
    }
  }
  private empty(identity: SetIdentity): SetSnapshot {
    return {
      contractVersion: CONTRACT_VERSION,
      status: 'ok',
      identity,
      coverage: 'missing',
      job: null,
      views: CUSTOMER_CAMERA_REFS.map((cameraRef) => ({
        cameraRef,
        imageKey: identity.imageKeys[cameraRef],
        status: 'missing',
      })),
      rendering: { status: 'unavailable', reason: safeError('rendering-disabled') },
    }
  }
  private async checked(snapshot: SetSnapshot, identity?: SetIdentity): Promise<SetSnapshot> {
    setSnapshotSchema.parse(snapshot)
    if (identity && canonicalJson(identity) !== canonicalJson(snapshot.identity))
      throw new ServiceError('verification-failed', 503)
    for (const view of snapshot.views)
      if (view.status === 'ready')
        await verifyImageDescriptor(view.image, view.image.design, this.storageOrigins)
    return setSnapshotSchema.parse({ ...snapshot, rendering: await this.availability() })
  }
  async lookup(request: LookupRequest): Promise<LibraryResponse> {
    const identity = await computeSetIdentity(request.design)
    let snapshot = this.empty(identity),
      databaseAvailable = false
    if (this.repository) {
      try {
        snapshot = await this.repository.lookup(request.design, identity)
        databaseAvailable = true
      } catch {
        /* A fully verified static set remains readable during a DB outage. */
      }
    }
    let seeds: readonly ImageDescriptor[] = []
    if (snapshot.coverage !== 'complete') seeds = await this.seeds.images(request.design)
    for (const image of seeds) await verifyImageDescriptor(image, image.design, this.storageOrigins)
    const views = snapshot.views.map((view) => {
      const seed = seeds.find((candidate) => candidate.imageKey === view.imageKey)
      if (!seed) return view
      if (view.status === 'ready' && canonicalJson(view.image) !== canonicalJson(seed))
        throw new ServiceError('verification-failed', 503)
      return {
        cameraRef: view.cameraRef,
        imageKey: view.imageKey,
        status: 'ready' as const,
        image: seed,
      }
    })
    const count = views.filter((view) => view.status === 'ready').length
    if (!databaseAvailable && count !== 5) throw new ServiceError('lookup-unavailable', 503)
    snapshot = {
      ...snapshot,
      views,
      coverage: count === 5 ? 'complete' : count ? 'partial' : 'missing',
      job: snapshot.job && { ...snapshot.job, completedImages: count },
    }
    return this.checked(snapshot, identity)
  }
  async create(request: CreateJobRequest, context: AdmissionContext): Promise<LibraryResponse> {
    if (!this.repository) throw new ServiceError('rendering-disabled', 503)
    const policy = await this.policy()
    const identity = await computeSetIdentity(request.design)
    const seedImages = await this.seeds.images(request.design)
    for (const image of seedImages)
      await verifyImageDescriptor(image, image.design, this.storageOrigins)
    const result = admissionSchema.parse(
      await this.repository.rpc('render_library_reserve_set', {
        command: { request, identity, context, policy, seedImages },
      }),
    )
    if (result.status === 'denied')
      throw new ServiceError(result.error.code, statusForError(result.error.code))
    this.lastAdmission = result.status
    return this.checked(result.snapshot, identity)
  }
  async status(jobId: string): Promise<LibraryResponse> {
    const snapshot = await this.repository?.getJob(jobId)
    if (!snapshot) throw new ServiceError('job-not-found', 404)
    return this.checked(snapshot)
  }
  async authorizedStatus(jobId: string, sessionHash: string): Promise<LibraryResponse> {
    if (!(this.repository instanceof SupabaseRepository))
      throw new ServiceError('rendering-disabled', 503)
    const snapshot = await this.repository.getJob(jobId, sessionHash)
    if (!snapshot) throw new ServiceError('job-not-found', 404)
    return this.checked(snapshot)
  }
  async retry(
    jobId: string,
    request: RetryJobRequest,
    context: AdmissionContext,
  ): Promise<LibraryResponse> {
    if (!this.repository) throw new ServiceError('rendering-disabled', 503)
    const result = admissionSchema.parse(
      await this.repository.rpc('render_library_retry_failed', {
        jobId,
        request,
        context,
        policy: await this.policy(),
      }),
    )
    if (result.status === 'denied')
      throw new ServiceError(result.error.code, statusForError(result.error.code))
    this.lastAdmission = result.status
    return this.checked(result.snapshot)
  }
}

export class WorkerService implements WorkerServicePort {
  constructor(
    private readonly repository: SupabaseRepository,
    private readonly artifacts: SupabaseArtifacts,
    private readonly admission: () => Promise<AdmissionPolicy>,
  ) {}
  async claim(request: ClaimRequest) {
    const parsed = claimRequestSchema.parse(request)
    await this.admission()
    const registration = await this.repository.registration()
    if (registration.workerBuildSha256 !== parsed.workerBuildSha256)
      throw new ServiceError('invalid-request', 400)
    const { workerBuildSha256, ...dispatch } = parsed
    const result = await this.repository.rpc('render_library_claim_worker', {
      dispatch,
      workerBuildSha256,
    })
    return { claim: result && (await verifyWorkerClaim(result, registration)) }
  }
  private async verifyEvent(event: WorkerEvent) {
    const claim = await this.repository.workerClaim(event.jobId, event.attemptId, event.fence)
    await verifyWorkerClaim(claim, await this.repository.registration())
    if (claim.fence !== event.fence) throw new ServiceError('invalid-request', 400)
    if (event.kind === 'artifact') await verifyArtifactReceipt(event.receipt, claim)
    return claim
  }
  async prepareUpload(input: ArtifactEvent) {
    const event = artifactEventSchema.parse(input)
    const claim = await this.verifyEvent(event)
    if (new Date(claim.deadlineAt).getTime() <= Date.now())
      throw new ServiceError('invalid-request', 400)
    if (!(await this.repository.prepareArtifact(event)).accepted)
      throw new ServiceError('invalid-request', 400)
    return this.artifacts.uploadTicket(event.receipt)
  }
  async recordEvent(input: WorkerEvent) {
    const event = workerEventSchema.parse(input)
    await this.verifyEvent(event)
    if (event.kind === 'artifact') {
      if (await this.repository.acceptedArtifact(event)) return { accepted: true }
      if (!(await this.repository.prepareArtifact(event)).accepted) return { accepted: false }
      const receipt = event.receipt
      const bytes = await this.artifacts.staging(receipt)
      await verifyPixels(bytes, receipt)
      const identity = await computeSetIdentity(receipt.design)
      const receiptSha256 = checksum(canonicalJson(receipt))
      const stored = await this.artifacts.putIfAbsent(
        `${identity.setKey}/${receipt.imageKey}/${receipt.sha256}.webp`,
        bytes,
        receipt.sha256,
      )
      const image = imageDescriptorSchema.parse({
        contractVersion: CONTRACT_VERSION,
        setKey: identity.setKey,
        imageKey: receipt.imageKey,
        design: receipt.design,
        recipeRelease: receipt.recipeRelease,
        url: stored.url,
        sha256: receipt.sha256,
        bytes: receipt.bytes,
        width: receipt.width,
        height: receipt.height,
        mime: receipt.mime,
        samples: receipt.samples,
        adaptiveSampling: receipt.adaptiveSampling,
        quality: receipt.quality,
        provenance: {
          kind: 'native-worker',
          jobId: receipt.jobId,
          attemptId: receipt.attemptId,
          workerBuildSha256: receipt.workerBuildSha256,
          recipeBundleSha256: receipt.recipeBundleSha256,
          receiptSha256,
        },
        productionAllowed: false,
        visuallyQualified: false,
        strictReference: false,
        engineeringApproved: false,
      })
      const result = z
        .object({ published: z.boolean() })
        .strict()
        .parse(
          await this.repository.rpc('render_library_publish_asset', {
            jobId: event.jobId,
            attemptId: event.attemptId,
            fence: event.fence,
            artifact: { receipt, receiptSha256, image },
          }),
        )
      if (!result.published) return { accepted: false }
    }
    return eventResponseSchema.parse(
      await this.repository.rpc('render_library_record_event', { event }),
    )
  }
}
