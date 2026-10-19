import { parseDesign, designProductionGate } from '../domain/design'
import { designIdentity } from '../domain/designIdentity'
import {
  imageReplyBase,
  parseImageReply,
  parseImageRequest,
  imageErrorSchema,
  requestIdentitySchema,
  type ImageReply,
  type ImageSubmissionReply,
} from './protocol'
import { ImageServiceError, unavailable } from './errors'
import { FakeRenderer, FakeRenderFailure } from './fakeRenderer'
import { MockJobStore, type MockLease } from './store'

export type MockImageServiceOptions = {
  store: MockJobStore
  renderer?: FakeRenderer
  now?: () => number
  /** Trusted local operator signal only; a failed check denies admission. No request-supplied path. */
  stopRequested?: () => boolean
}

export class MockImageService {
  private stopped = false
  private readonly store: MockJobStore
  private readonly renderer: FakeRenderer
  private readonly now: () => number
  private readonly stopRequested: () => boolean

  constructor(options: MockImageServiceOptions) {
    this.store = options.store
    this.renderer = options.renderer ?? new FakeRenderer()
    this.now = options.now ?? Date.now
    this.stopRequested = options.stopRequested ?? (() => false)
  }

  private checkRunning(): void {
    if (this.stopped) throw unavailable()
    let kill: boolean
    try {
      kill = this.stopRequested()
    } catch {
      throw unavailable()
    }
    if (kill) {
      this.store.kill()
      throw unavailable()
    }
  }

  /** Strict server-side validation and hashing; neither caller digests nor rendering settings accepted. */
  async submit(principal: string, input: unknown): Promise<ImageSubmissionReply> {
    this.checkRunning()
    const parsed = (() => {
      try {
        return parseImageRequest(input)
      } catch {
        throw new ImageServiceError(
          422,
          'invalid-request',
          'Expected a strict v1 mock image request containing a supported provisional v4 design.',
        )
      }
    })()
    // Explicitly retain the unconditional production gate. This service never requests an exception.
    const gate = designProductionGate(parsed.design)
    if (gate.allowed || gate.paidExecutionAllowed)
      throw new ImageServiceError(
        403,
        'production-denied',
        'Only unapproved, unpaid diagnostic generation is permitted.',
      )
    const identity = await designIdentity(parsed.design)
    this.checkRunning() // Shutdown/kill can race asynchronous digest computation.
    const interestId = this.store.submit(principal, parsed, identity)
    const body = await this.status(principal, interestId)
    if (body.state === 'ready') return { status: 200, body }
    if (body.state === 'queued' || body.state === 'rendering') return { status: 202, body }
    throw new ImageServiceError(
      503,
      'unavailable',
      'Mock interest is no longer available for submission.',
      false,
    )
  }

  async status(principal: string, interestId: string): Promise<ImageReply> {
    if (this.stopped) throw unavailable()
    const interest = this.store.readInterest(principal, interestId)
    const design = parseDesign(JSON.parse(interest.job.design))
    const base = imageReplyBase(
      interestId,
      requestIdentitySchema.parse(JSON.parse(interest.job.identity)),
    )
    let reply: ImageReply
    if (interest.cancelled)
      reply = {
        ...base,
        state: 'cancelled',
        cancellationScope: 'interest-only',
        sharedWorkCancelled: false,
      }
    else if (interest.expiresAt <= this.now()) reply = { ...base, state: 'expired' }
    else if (interest.job.state === 'ready')
      reply = { ...base, state: 'ready', artifact: JSON.parse(interest.job.artifact ?? 'null') }
    else if (interest.job.state === 'failed' || interest.job.state === 'uncertain')
      reply = {
        ...base,
        state: 'failed',
        error: imageErrorSchema.parse(JSON.parse(interest.job.error ?? 'null')),
      }
    else if (interest.job.state === 'expired') reply = { ...base, state: 'expired' }
    else reply = { ...base, state: interest.job.state, retryAfterMs: 250 }
    try {
      return await parseImageReply(reply, design, interestId)
    } catch {
      throw new ImageServiceError(
        503,
        'identity-mismatch',
        'Stored diagnostic identity or artifact failed verification.',
        false,
      )
    }
  }

  async detach(
    principal: string,
    interestId: string,
  ): Promise<Extract<ImageReply, { state: 'cancelled' }>> {
    if (this.stopped) throw unavailable()
    this.store.detach(principal, interestId)
    const reply = await this.status(principal, interestId)
    if (reply.state !== 'cancelled') throw unavailable()
    return reply
  }

  private async execute(lease: MockLease): Promise<void> {
    try {
      const artifact = await this.renderer.render(lease)
      try {
        await parseImageReply(
          { ...imageReplyBase(lease.jobId, lease.identity), state: 'ready', artifact },
          lease.design,
          lease.jobId,
        )
      } catch {
        this.store.fail(
          lease,
          {
            code: 'identity-mismatch',
            message:
              'Mock artifact identity, bytes or provenance did not match; nothing was published.',
            retryable: false,
          },
          'known',
        )
        return
      }
      this.checkRunning()
      this.store.publishVerified(lease, artifact)
    } catch (error) {
      // A closed/failed store cannot accept a completion. Its existing durable reservation remains held.
      if (this.stopped) return
      try {
        this.store.fail(
          lease,
          { code: 'unavailable', message: 'Local diagnostic attempt failed.', retryable: true },
          error instanceof FakeRenderFailure ? error.outcome : 'unknown',
        )
      } catch {
        /* Fail closed; reconcile persisted liabilities after the store is available. */
      }
    }
  }

  /** Claims at most the persisted global concurrency limit. Timer-free; caller owns scheduling. */
  async runOnce(): Promise<number> {
    this.checkRunning()
    const work: Promise<void>[] = []
    for (let i = 0; i < this.store.policy.maxConcurrency; i++) {
      this.checkRunning()
      const lease = this.store.claim()
      if (!lease) break
      work.push(this.execute(lease))
    }
    await Promise.all(work)
    return work.length
  }

  /** Process shutdown does not certify in-flight cancellation or refund an uncertain reservation. */
  shutdown(): void {
    this.stopped = true
  }
  close(): void {
    this.shutdown()
    this.store.close()
  }
}
