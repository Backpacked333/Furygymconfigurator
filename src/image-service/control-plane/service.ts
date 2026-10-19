import { createMockArtifact } from '../protocol'
import {
  artifactDescriptorSchema,
  authContextSchema,
  bindRequestSync,
  canonicalJson,
  CONTROL_PROTOCOL,
  ControlError,
  describeArtifact,
  errorSchema,
  exportRequestSchema,
  imageRequestSchema,
  opaqueIdSchema,
  parseSubmissionReply,
  policySchema,
  requestBindingSchema,
  sha256Bytes,
  statusReplySchema,
  timestampSchema,
  unavailable,
  worstCaseQuote,
  type ArtifactDescriptor,
  type AuthContext,
  type ControlService,
  type ControlServiceOptions,
  type DeliveredArtifact,
  type InterestView,
  type Purpose,
  type Scope,
  type StatusReply,
  type SubmissionReply,
} from './contracts'

/** Unmounted local control service. It can admit work but has no worker/provider/renderer reference. */
export class SafeImageService implements ControlService {
  private readonly ledger: ControlServiceOptions['ledger']
  private readonly objects: ControlServiceOptions['objects']
  private readonly now: () => number

  constructor(options: ControlServiceOptions) {
    this.ledger = options.ledger
    this.objects = options.objects
    this.now = options.now ?? Date.now
  }

  submitImage(auth: AuthContext, input: unknown): Promise<SubmissionReply> {
    return this.submit(auth, input, 'image')
  }

  submitExport(auth: AuthContext, input: unknown): Promise<SubmissionReply> {
    return this.submit(auth, input, 'export')
  }

  private submit(
    authInput: AuthContext,
    input: unknown,
    purpose: Purpose,
  ): Promise<SubmissionReply> {
    return this.guard(async () => {
      const auth = this.authorize(authInput, purpose === 'image' ? 'images:write' : 'exports:write')
      const parsed = (purpose === 'image' ? imageRequestSchema : exportRequestSchema).safeParse(
        input,
      )
      if (!parsed.success)
        throw new ControlError(
          422,
          'invalid-request',
          'A strict v4 diagnostic request is required.',
        )
      const request = parsed.data
      const binding = bindRequestSync(request.design, purpose, auth)
      this.requireAvailable()
      const admitted = this.ledger.admit({
        auth,
        purpose,
        request,
        binding,
        quote: worstCaseQuote(this.ledger.policy),
      })
      this.validateView(auth, admitted.view)
      if (
        canonicalJson(admitted.view.job.binding) !== canonicalJson(binding) ||
        admitted.view.interest.idempotencyKey !== request.idempotencyKey
      )
        throw new ControlError(
          503,
          'identity-mismatch',
          'Admission did not preserve the exact requested revision.',
        )
      const body = await this.reply(auth, admitted.view)
      this.requireAvailable()
      if (body.interestState !== 'active' || body.state === 'expired' || body.state === 'cancelled')
        throw new ControlError(
          410,
          'expired',
          'This idempotent interest has ended; it cannot be resurrected.',
        )
      if (body.reconciliationRequired)
        throw new ControlError(
          503,
          'reconciliation-required',
          'Execution outcome remains unresolved.',
        )
      return parseSubmissionReply(body.state === 'ready' ? 200 : 202, body)
    })
  }

  status(authInput: AuthContext, interestId: string): Promise<StatusReply> {
    return this.guard(async () => {
      const auth = this.authorize(authInput, 'images:read')
      return this.reply(auth, this.view(auth, interestId))
    })
  }

  cancel(authInput: AuthContext, interestId: string): Promise<StatusReply> {
    return this.guard(async () => {
      const auth = this.authorize(authInput)
      const view = this.view(auth, interestId)
      this.authorize(auth, view.job.binding.purpose === 'export' ? 'exports:write' : 'images:write')
      const detached = this.ledger.cancelInterest(auth, view.interest.id)
      this.validateView(auth, detached)
      if (
        !detached.interest.cancelled ||
        detached.interest.id !== view.interest.id ||
        detached.job.id !== view.job.id
      )
        throw unavailable('Interest cancellation could not be confirmed.')
      // No job failure, refund, provider stop, or global cancellation is inferred here.
      return this.reply(auth, detached)
    })
  }

  artifact(authInput: AuthContext, interestId: string): Promise<DeliveredArtifact> {
    return this.guard(async () => {
      const auth = this.authorize(authInput, 'images:read')
      const view = this.view(auth, interestId)
      this.requireActiveReady(view)
      const delivered = await this.verified(view)
      this.recheckReady(auth, view, delivered.object)
      // Final synchronous ownership/kill/cap transaction happens after every object-store await.
      // A downstream write failure must retain this conservative delivery charge.
      const recorded = this.ledger.recordDelivery(
        auth,
        view.interest.id,
        delivered.bytes.byteLength,
      )
      if (
        canonicalJson(artifactDescriptorSchema.parse(recorded)) !== canonicalJson(delivered.object)
      )
        throw new ControlError(
          503,
          'identity-mismatch',
          'Delivery identity changed before admission.',
        )
      return delivered
    })
  }

  private async reply(auth: AuthContext, view: InterestView): Promise<StatusReply> {
    this.validateView(auth, view)
    let current = view
    let artifact: ArtifactDescriptor | null = null
    if (view.job.state === 'ready' && this.interestState(view) === 'active') {
      this.requireActiveReady(view)
      artifact = (await this.verified(view)).object
      current = this.recheckReady(auth, view, artifact)
    }
    const interestState = this.interestState(current)
    const pending = [
      'requested',
      'reserved',
      'queued',
      'leased',
      'rendering',
      'publishing',
    ].includes(current.job.state)
    const error = current.job.error === null ? null : errorSchema.parse(current.job.error)
    return statusReplySchema.parse({
      protocol: CONTROL_PROTOCOL,
      mode: 'mock-diagnostic',
      productionAllowed: false,
      paidExecutionAllowed: false,
      interestId: current.interest.id,
      jobId: current.job.id,
      purpose: current.job.binding.purpose,
      requested: current.job.binding.identity,
      state: current.job.state,
      interestState,
      reconciliationRequired: current.job.reconciliationRequired,
      cancellationScope: interestState === 'cancelled' ? 'interest-only' : null,
      sharedWorkCancelled: false,
      artifact,
      // Raw provider/database errors and arbitrary stored text never cross the API boundary.
      error: error
        ? {
            ...error,
            message: 'Diagnostic job did not complete; inspect the private control state.',
          }
        : null,
      retryAfterMs: pending && interestState === 'active' ? 1000 : null,
    })
  }

  private async verified(view: InterestView): Promise<DeliveredArtifact> {
    const object = artifactDescriptorSchema.parse(view.job.artifact)
    const policy = policySchema.parse(this.ledger.policy)
    const expected = describeArtifact(
      await createMockArtifact(view.job.design),
      view.job.design,
      view.job.binding,
    )
    if (
      object.byteLength > policy.maxOutputBytes ||
      canonicalJson(object) !== canonicalJson(expected)
    )
      throw new ControlError(
        503,
        'identity-mismatch',
        'Stored metadata does not match the immutable diagnostic revision.',
      )
    if (!(await this.objects.verify(object, view.job.design)))
      throw new ControlError(
        503,
        'publication-failed',
        'Immutable diagnostic object failed verification.',
      )
    const bytes = Uint8Array.from(await this.objects.read(object))
    if (bytes.byteLength !== object.byteLength || sha256Bytes(bytes) !== object.checksum)
      throw new ControlError(
        503,
        'publication-failed',
        'Immutable diagnostic bytes failed checksum verification.',
      )
    return { object, bytes }
  }

  private recheckReady(
    auth: AuthContext,
    original: InterestView,
    object: ArtifactDescriptor,
  ): InterestView {
    const current = this.view(auth, original.interest.id)
    this.requireActiveReady(current)
    if (
      current.job.id !== original.job.id ||
      canonicalJson(current.job.binding) !== canonicalJson(original.job.binding) ||
      canonicalJson(artifactDescriptorSchema.parse(current.job.artifact)) !== canonicalJson(object)
    )
      throw new ControlError(
        503,
        'identity-mismatch',
        'Immutable diagnostic identity changed during verification.',
      )
    return current
  }

  private requireActiveReady(view: InterestView): void {
    this.requireAvailable()
    if (this.interestState(view) !== 'active' || ['expired', 'cancelled'].includes(view.job.state))
      throw new ControlError(410, 'expired', 'This interest no longer permits artifact delivery.')
    if (view.job.reconciliationRequired)
      throw new ControlError(
        503,
        'reconciliation-required',
        'Execution outcome remains unresolved.',
      )
    if (view.job.state !== 'ready' || view.job.artifact === null)
      throw new ControlError(503, 'unavailable', 'No verified diagnostic artifact is ready.', true)
  }

  private requireAvailable(): void {
    if (this.ledger.snapshot().killed)
      throw new ControlError(503, 'killed', 'The persistent control kill switch is enabled.')
  }

  private interestState(view: InterestView): StatusReply['interestState'] {
    if (view.interest.cancelled) return 'cancelled'
    return timestampSchema.parse(this.now()) >= timestampSchema.parse(view.interest.expiresAt)
      ? 'expired'
      : 'active'
  }

  private view(auth: AuthContext, interestId: string): InterestView {
    if (!opaqueIdSchema.safeParse(interestId).success)
      throw new ControlError(404, 'not-found', 'Interest was not found.')
    const view = this.ledger.getInterest(auth, interestId)
    this.validateView(auth, view)
    if (view.interest.id !== interestId) throw unavailable()
    return view
  }

  private validateView(auth: AuthContext, view: InterestView): void {
    if (
      view.interest.principalId !== auth.principalId ||
      view.interest.experimentId !== auth.experimentId
    )
      throw new ControlError(404, 'not-found', 'Interest was not found.')
    opaqueIdSchema.parse(view.interest.id)
    opaqueIdSchema.parse(view.job.id)
    if (view.interest.jobId !== view.job.id) throw unavailable()
    const binding = requestBindingSchema.parse(view.job.binding)
    const expected = bindRequestSync(view.job.design, binding.purpose, auth)
    if (canonicalJson(binding) !== canonicalJson(expected))
      throw new ControlError(503, 'identity-mismatch', 'Stored job has an invalid scoped revision.')
  }

  private authorize(input: AuthContext, scope?: Scope): AuthContext {
    const parsed = authContextSchema.safeParse(input)
    if (!parsed.success)
      throw new ControlError(401, 'unauthorized', 'A verified authentication context is required.')
    if (scope && !parsed.data.scopes.includes(scope))
      throw new ControlError(403, 'forbidden', 'Required scope is not granted.')
    return parsed.data
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ControlError) throw error
      throw unavailable()
    }
  }
}
