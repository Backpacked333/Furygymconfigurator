import { z } from 'zod'
import type { DesignEnvelope } from '../../domain/design.js'
import {
  RECIPE_RELEASE,
  setSnapshotSchema,
  sha256Schema,
  uuidSchema,
  type SetIdentity,
} from '../contracts.js'
import {
  artifactEventSchema,
  eventResponseSchema,
  workerClaimSchema,
  type ArtifactEvent,
} from '../workerProtocol.js'
import { canonicalJson } from '../identity.js'
import type {
  AdmissionPolicy,
  RecipeRegistration,
  RenderLibraryRepository,
  RenderLibraryRpc,
} from './ports.js'
import { boundedBytes, httpsOrigin, ServiceError } from './httpSafety.js'

export const registrationSchema = z
  .object({
    releaseId: z.literal(RECIPE_RELEASE.id),
    workerBuildSha256: sha256Schema,
    recipeBundleSha256: sha256Schema,
    geometrySha256: sha256Schema,
    materialsSha256: sha256Schema,
    camerasSha256: sha256Schema,
    rendererSha256: sha256Schema,
  })
  .strict()
export const policySchema = z
  .object({
    enabled: z.literal(true),
    approvalId: uuidSchema,
    expiresAt: z.iso.datetime(),
    globalBudgetMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxJobLiabilityMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxImageLiabilityMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startupLiabilityMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    recipe: registrationSchema,
  })
  .strict()

export class SupabaseTransport {
  readonly origin: string
  constructor(
    origin: string,
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = httpsOrigin(origin)
    if (key.length < 32) throw new ServiceError('rendering-disabled', 503)
  }
  async request(path: string, init: RequestInit = {}) {
    if (!path.startsWith('/rest/v1/') && !path.startsWith('/storage/v1/'))
      throw new Error('Untrusted service path')
    return this.fetcher(`${this.origin}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, ...init.headers },
    })
  }
  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init)
    if (!response.ok) {
      await response.body?.cancel()
      throw new ServiceError('lookup-unavailable', 503)
    }
    if (response.status === 204) return null
    const bytes = await boundedBytes(response, 256 * 1024)
    return bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null
  }
  call(name: string, args: unknown) {
    if (!/^render_library_[a-z_]+$/.test(name)) throw new Error('Invalid RPC')
    return this.json(`/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
  }
}

export class SupabaseRepository implements RenderLibraryRepository {
  constructor(readonly transport: SupabaseTransport) {}
  async lookup(_design: DesignEnvelope, identity: SetIdentity) {
    return setSnapshotSchema.parse(
      await this.transport.call('render_library_snapshot', { identity }),
    )
  }
  async getJob(jobId: string, sessionHash?: string) {
    const result = await this.transport.call('render_library_get_job', {
      jobId,
      sessionHash: sessionHash ?? null,
    })
    return result === null ? null : setSnapshotSchema.parse(result)
  }
  async rpc<K extends keyof RenderLibraryRpc>(
    name: K,
    args: RenderLibraryRpc[K]['args'],
  ): Promise<RenderLibraryRpc[K]['result']> {
    return (await this.transport.call(name, args)) as RenderLibraryRpc[K]['result']
  }
  async touchSession(sessionHash: string, networkHash: string, expiresAt: string) {
    await this.transport.call('render_library_touch_session', {
      sessionHash,
      networkHash,
      expiresAt,
    })
  }
  async prepareArtifact(event: ArtifactEvent) {
    return eventResponseSchema.parse(
      await this.transport.call('render_library_prepare_artifact', { event }),
    )
  }
  async acceptedArtifact(event: ArtifactEvent) {
    const rows = z
      .array(z.object({ payload: artifactEventSchema }))
      .max(1)
      .parse(
        await this.transport.json(
          `/rest/v1/render_library_events?event_id=eq.${event.eventId}&select=payload`,
        ),
      )
    if (!rows.length) return false
    if (canonicalJson(rows[0].payload) !== canonicalJson(event))
      throw new ServiceError('invalid-request', 400)
    return true
  }
  async registration(workerBuildSha256?: string): Promise<RecipeRegistration> {
    if (workerBuildSha256 !== undefined) sha256Schema.parse(workerBuildSha256)
    const rows = z
      .array(z.object({ registration: registrationSchema }))
      .length(1)
      .parse(
        await this.transport.json(
          `/rest/v1/render_library_recipes?release_id=eq.${encodeURIComponent(RECIPE_RELEASE.id)}&select=registration`,
        ),
      )
    const original = rows[0].registration
    if (workerBuildSha256 === undefined || original.workerBuildSha256 === workerBuildSha256)
      return original
    const builds = z
      .array(z.object({ registration: registrationSchema }))
      .length(1)
      .parse(
        await this.transport.json(
          `/rest/v1/render_library_worker_builds?release_id=eq.${encodeURIComponent(RECIPE_RELEASE.id)}&worker_build_sha256=eq.${workerBuildSha256}&select=registration`,
        ),
      )
    if (builds[0].registration.workerBuildSha256 !== workerBuildSha256)
      throw new ServiceError('invalid-request', 400)
    return builds[0].registration
  }
  async policy(approvalId: string): Promise<AdmissionPolicy> {
    uuidSchema.parse(approvalId)
    const rows = z
      .array(z.object({ enabled: z.boolean(), expires_at: z.string(), policy: policySchema }))
      .length(1)
      .parse(
        await this.transport.json(
          `/rest/v1/render_library_approvals?id=eq.${approvalId}&select=enabled,expires_at,policy`,
        ),
      )
    if (!rows[0].enabled || new Date(rows[0].expires_at).getTime() <= Date.now())
      throw new ServiceError('budget-unavailable', 503)
    return rows[0].policy
  }
  async workerClaim(jobId: string, attemptId: string, fence: number) {
    uuidSchema.parse(jobId)
    uuidSchema.parse(attemptId)
    if (!Number.isSafeInteger(fence) || fence < 1) throw new ServiceError('invalid-request', 400)
    const rows = z
      .array(
        z.object({ worker_claim: workerClaimSchema, fence: z.number(), attempt_id: uuidSchema }),
      )
      .length(1)
      .parse(
        await this.transport.json(
          `/rest/v1/render_library_jobs?id=eq.${jobId}&attempt_id=eq.${attemptId}&fence=eq.${fence}&select=worker_claim,fence,attempt_id`,
        ),
      )
    return rows[0].worker_claim
  }
}
