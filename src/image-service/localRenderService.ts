// Private Node service, not a renderer in the customer's image route.
import { randomBytes, randomUUID } from 'node:crypto'
import {
  CAPTURE_LIMITS,
  createCaptureJob,
  createCaptureSamples,
  type CaptureJob,
} from '../render/prototype/capture/contract'
import {
  LOCAL_RENDER_FLAGS,
  LOCAL_RENDER_LABEL,
  localRenderImagePath,
  localRenderReplyBase,
  localRenderReplySchema,
  parseLocalRenderRequest,
  matchLocalRenderSample,
  UnsupportedLocalRenderDesignError,
  type LocalRenderReply,
  type LocalRenderSubmissionReply,
} from './localRenderProtocol'
import { LocalRenderCache, type VerifiedLocalCapture } from './localRenderCache'
import type { LocalRenderBackend, LocalRenderPrepared } from './localRenderPrivate'
import {
  LocalRenderServiceError,
  localCapacity,
  localIdentityMismatch,
  localUnavailable,
} from './localRenderErrors'

type Work = {
  job: CaptureJob
  state: 'queued' | 'rendering' | 'ready' | 'failed'
  error?: LocalRenderServiceError
  verified?: VerifiedLocalCapture
  output?: string
  captured: boolean
}
type Interest = { id: string; work: Work; expiresAt: number; cancelled: boolean; cacheHit: boolean }
const INTEREST_MS = 10 * 60_000
const MAX_INTERESTS = 64

function safeError(error: unknown): LocalRenderServiceError {
  if (error instanceof LocalRenderServiceError) return error
  const code = (error as { code?: unknown })?.code
  if (code === 'identity-mismatch') return localIdentityMismatch()
  if (code === 'limit-exceeded') return localCapacity()
  if (code === 'invalid-artifact' || code === 'bad-pixels')
    return new LocalRenderServiceError(
      503,
      'invalid-artifact',
      'Local PNG or provenance failed verification; no image was delivered.',
    )
  return localUnavailable()
}

export class LocalRenderService {
  private interests = new Map<string, Interest>()
  private works = new Map<string, Work>()
  private queue: Work[] = []
  private active = false
  private closed = false
  private captureController?: AbortController
  private metadataController?: AbortController
  private metadataTail: Promise<unknown> = Promise.resolve()
  private metadataCount = 0
  private prepared?: LocalRenderPrepared
  private preparationFence: () => void = () => {
    throw localUnavailable()
  }
  constructor(
    private readonly backend: LocalRenderBackend,
    private readonly cache = new LocalRenderCache(),
  ) {}

  // Serializes current-build verification/admission, not capture; memory is independently bounded.
  private serial<T>(fn: (fence: () => void) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(localUnavailable())
    if (this.metadataCount >= 16) return Promise.reject(localCapacity())
    this.metadataCount++
    let expired = false
    const timeoutError = () =>
      new LocalRenderServiceError(
        504,
        'timeout',
        'Local metadata/admission deadline elapsed; no automatic retry.',
      )
    const fence = () => {
      if (this.closed) throw localUnavailable()
      if (expired) throw timeoutError()
    }
    let timer: ReturnType<typeof setTimeout>
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true
        reject(timeoutError())
      }, CAPTURE_LIMITS.jobMs)
      timer.unref()
    })
    const result = this.metadataTail.then(async () => {
      fence()
      const value = await fn(fence)
      fence()
      return value
    })
    // A timed-out operation retains its slot until it actually settles. No overlapping builds.
    this.metadataTail = result
      .catch(() => {})
      .finally(() => {
        this.metadataCount--
        clearTimeout(timer)
      })
    return Promise.race([result, timedOut])
  }
  private async prepare() {
    const controller = new AbortController()
    this.metadataController = controller
    const deadline = performance.now() + CAPTURE_LIMITS.jobMs
    const fence = () => {
      if (this.closed || controller.signal.aborted || performance.now() >= deadline)
        throw new LocalRenderServiceError(
          504,
          'timeout',
          'Current build validation exceeded its finite deadline; no capture was admitted.',
        )
    }
    // prepareCaptureBuild fences every await; no renderer is invoked here.
    const timer = setTimeout(() => controller.abort(), CAPTURE_LIMITS.jobMs)
    timer.unref()
    try {
      fence()
      this.preparationFence = fence
      if (this.prepared) {
        try {
          await this.prepared.revalidate()
          fence()
          return this.prepared
        } catch {
          this.prepared = undefined
          fence()
        }
      }
      // Revalidation keeps hashing the original closure; only changed inputs require a rebuild.
      // The closure's fence follows the serialized operation, not its first request's deadline.
      const prepared = await this.backend.prepare(() => this.preparationFence())
      fence()
      this.prepared = prepared
      return prepared
    } finally {
      clearTimeout(timer)
      if (this.metadataController === controller) this.metadataController = undefined
    }
  }
  async submit(input: unknown, signal?: AbortSignal): Promise<LocalRenderSubmissionReply> {
    let request
    try {
      request = parseLocalRenderRequest(input)
    } catch (error) {
      if (error instanceof UnsupportedLocalRenderDesignError)
        throw new LocalRenderServiceError(422, 'unsupported-design', error.message)
      throw new LocalRenderServiceError(
        400,
        'invalid-request',
        'Expected the strict full-v4 local-real request; caller digests, paths and overrides are not accepted.',
      )
    }
    return this.serial(async (deadlineFence) => {
      const fence = () => {
        deadlineFence()
        if (signal?.aborted) throw localUnavailable()
      }
      try {
        fence()
        for (const [id, entry] of this.interests)
          if (entry.expiresAt <= Date.now()) this.interests.delete(id)
        if (this.interests.size >= MAX_INTERESTS) throw localCapacity()
        const prepared = await this.prepare()
        fence()
        const sample = createCaptureSamples().find(
          (entry) => entry.id === matchLocalRenderSample(request.design)!.id,
        )!
        const job = await createCaptureJob(
          `local-request-${randomUUID()}`,
          sample.id,
          sample.request,
          prepared.build,
        )
        fence()
        let work = this.works.get(job.identity.captureDigest)
        let cacheHit = false
        if (work?.state === 'failed') throw work.error ?? localUnavailable()
        if (!work || work.state === 'ready') {
          const found = await this.cache.lookup(job, prepared)
          fence()
          if (found.verified) {
            work = { job, state: 'ready', verified: found.verified, captured: false }
            this.works.set(job.identity.captureDigest, work)
            cacheHit = true
          } else {
            this.cache.assertAdmission(found.history, job.sampleId)
            // Two supported samples only. Changed source revisions cannot grow an unbounded queue.
            if (
              this.queue.length + Number(this.active) >= 2 ||
              this.works.size >= CAPTURE_LIMITS.attempts
            )
              throw localCapacity()
            work = { job, state: 'queued', captured: false }
            this.works.set(job.identity.captureDigest, work)
            this.queue.push(work)
          }
        }
        const interest: Interest = {
          id: randomBytes(24).toString('base64url'),
          work,
          expiresAt: Date.now() + INTEREST_MS,
          cancelled: false,
          cacheHit,
        }
        this.interests.set(interest.id, interest)
        const body = this.reply(interest)
        // No capture in the submission critical section; HTTP receives 202 before bounded work starts.
        setImmediate(() => {
          void this.pump()
        })
        if (body.state === 'ready') return { status: 200, body }
        if (body.state === 'queued' || body.state === 'rendering') return { status: 202, body }
        throw localUnavailable()
      } catch (error) {
        throw safeError(error)
      }
    })
  }
  private interest(id: string) {
    const interest = this.interests.get(id)
    if (!interest)
      throw new LocalRenderServiceError(
        404,
        'not-found',
        'No local render interest exists for this capability.',
      )
    return interest
  }
  private reply(interest: Interest): LocalRenderReply {
    const work = interest.work,
      job = work.job
    const base = localRenderReplyBase(interest.id, job.identity, {
      captureDigest: job.identity.captureDigest,
      build: job.build,
      profile: job.profile,
    })
    if (interest.cancelled)
      return {
        ...base,
        state: 'cancelled',
        cancellationScope: 'interest-only',
        sharedWorkCancelled: false,
      }
    if (interest.expiresAt <= Date.now()) return { ...base, state: 'expired' }
    if (work.state === 'ready') {
      const value = work.verified!
      return localRenderReplySchema.parse({
        ...base,
        state: 'ready',
        artifact: {
          checksum: value.marker.image.digest,
          mediaType: 'image/png',
          src: localRenderImagePath(interest.id, value.marker.image.digest),
          width: job.profile.width,
          height: job.profile.height,
          byteLength: value.bytes.length,
          exactMatch: true,
          approvedCurrentImage: false,
          cacheStatus: interest.cacheHit || !work.captured ? 'verified-exact-hit' : 'captured-miss',
          provenance: {
            kind: 'local-three-capture',
            label: LOCAL_RENDER_LABEL,
            captureProtocol: value.job.protocol,
            jobId: value.job.jobId,
            sampleId: value.job.sampleId,
            receiptDigest: value.marker.receipt.digest,
            runtime: value.runtime,
            holds: value.receipt.holds,
            flags: LOCAL_RENDER_FLAGS,
          },
        },
      })
    }
    if (work.state === 'failed')
      return { ...base, state: 'failed', error: (work.error ?? localUnavailable()).wireError }
    return { ...base, state: work.state, retryAfterMs: 1000 }
  }
  async status(id: string): Promise<LocalRenderReply> {
    return this.serial(async (fence) => {
      const interest = this.interest(id)
      if (
        !interest.cancelled &&
        interest.expiresAt > Date.now() &&
        interest.work.state === 'ready'
      ) {
        try {
          const prepared = await this.prepare()
          const found = await this.cache.lookup(interest.work.job, prepared)
          fence()
          if (!found.verified) throw localUnavailable()
          interest.work.verified = found.verified
        } catch (error) {
          interest.work.state = 'failed'
          interest.work.error = safeError(error)
        }
      }
      return this.reply(interest)
    })
  }
  async detach(id: string): Promise<LocalRenderReply> {
    const interest = this.interest(id)
    interest.cancelled = true
    return this.reply(interest)
  }
  async image(id: string, checksum: string): Promise<Buffer> {
    const reply = await this.status(id)
    if (reply.state !== 'ready') {
      if (reply.state === 'failed')
        throw new LocalRenderServiceError(503, reply.error.code, reply.error.message)
      throw new LocalRenderServiceError(
        404,
        'not-found',
        'No verified image is available for this interest.',
      )
    }
    const interest = this.interest(id)
    if (
      interest.cancelled ||
      interest.expiresAt <= Date.now() ||
      checksum !== reply.artifact.checksum
    )
      throw new LocalRenderServiceError(
        404,
        'not-found',
        'Image checksum or interest does not match.',
      )
    // Return the independently decoded snapshot, never a new unverified filename read or redirect.
    return Buffer.from(interest.work.verified!.bytes)
  }
  private async pump() {
    if (this.active || this.closed) return
    const work = this.queue.shift()
    if (!work) return
    this.active = true
    const controller = new AbortController()
    this.captureController = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.serial(async (fence) => {
        const prepared = await this.prepare()
        fence()
        if (JSON.stringify(prepared.build) !== JSON.stringify(work.job.build))
          throw localIdentityMismatch()
        await prepared.revalidate()
        this.cache.assertAdmission(await this.cache.history(), work.job.sampleId)
        fence()
      })
      if (this.closed) throw localUnavailable()
      work.state = 'rendering'
      work.output = this.cache.newOutputPath()
      timer = setTimeout(() => {
        controller.abort()
        work.state = 'failed'
        work.error = new LocalRenderServiceError(
          504,
          'timeout',
          'Local capture deadline elapsed; preserve evidence and history. No automatic retry.',
        )
      }, CAPTURE_LIMITS.jobMs)
      timer.unref()
      const result = await this.backend.capture(
        work.job.sampleId as Parameters<LocalRenderBackend['capture']>[0],
        work.output,
        controller.signal,
      )
      if (controller.signal.aborted || this.closed) throw work.error ?? localUnavailable()
      clearTimeout(timer)
      if ((result as { state?: unknown })?.state !== 'complete') {
        const code = (result as { code?: unknown })?.code
        if (code === 'limit-exceeded') throw localCapacity()
        if (code === 'identity-mismatch') throw localIdentityMismatch()
        if (code === 'timeout')
          throw new LocalRenderServiceError(
            504,
            'timeout',
            'Local capture deadline elapsed. Preserve private diagnostics; no automatic retry.',
          )
        throw new LocalRenderServiceError(
          503,
          'capture-failed',
          'Local software capture did not complete. Preserve private diagnostics; no automatic retry or fallback.',
        )
      }
      await this.serial(async (fence) => {
        const prepared = await this.prepare()
        const found = await this.cache.lookup(work.job, prepared)
        fence()
        if (!found.verified) throw localUnavailable()
        work.verified = found.verified
        work.captured = true
        work.state = 'ready'
      })
    } catch (error) {
      work.state = 'failed'
      work.error ??= safeError(error)
    } finally {
      clearTimeout(timer)
      this.active = false
      if (this.captureController === controller) this.captureController = undefined
      // Even a timeout cannot release the next job until the original runner has settled/cleaned up.
      if (!this.closed)
        setImmediate(() => {
          void this.pump()
        })
    }
  }
  close() {
    this.closed = true
    this.prepared = undefined
    this.captureController?.abort()
    this.metadataController?.abort()
    this.backend.close?.()
    for (const work of this.queue) {
      work.state = 'failed'
      work.error = localUnavailable()
    }
    this.queue = []
  }
}
