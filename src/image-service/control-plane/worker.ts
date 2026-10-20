import {
  ControlError,
  errorSchema,
  isSettledReceipt,
  opaqueIdSchema,
  providerReceiptSchema,
  sameExecution,
  signWorkerContext,
  unavailable,
  verifyDiagnosticArtifact,
  workerClaimsForLease,
  type JobFailure,
  type Lease,
  type ProviderReceipt,
  type StagedObject,
  type StopReason,
  type Worker,
  type WorkerOptions,
} from './contracts'
import { providerCalls, providerCallTimeout } from './providerCalls'

const failure = (code: JobFailure['code'], retryable = false): JobFailure => ({
  code,
  retryable,
  message:
    'Local diagnostic execution could not be safely published; durable evidence is retained.',
})
type Active = {
  lease: Lease
  invalid: boolean
  receipt?: ProviderReceipt
  staged?: StagedObject
  interrupt: () => void
  stopping?: Promise<void>
}

/** Private CPU-only coordinator. Receipt authentication belongs to the transactional ledger;
 * the worker deliberately has neither the provider-receipt key nor the object-verification key.
 * No real renderer, subprocess, public worker endpoint or paid execution path exists here.
 */
export class ControlWorker implements Worker {
  readonly #options: WorkerOptions
  readonly #now: () => number
  readonly #timeout: number
  readonly #active = new Map<string, Active>()
  #stopped = false
  #running = false

  constructor(options: WorkerOptions) {
    opaqueIdSchema.parse(options.workerId)
    if (
      Buffer.byteLength(options.contextSecret) < 32 ||
      options.provider.provider !== 'fake-local' ||
      options.provider.paidExecutionAllowed !== false
    )
      throw unavailable()
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#timeout = providerCallTimeout(options.providerCallTimeoutMs)
  }

  #accept(active: Active, input: ProviderReceipt): boolean {
    const receipt = providerReceiptSchema.parse(input)
    if (
      !sameExecution(receipt.claims.execution, active.lease.execution) ||
      !this.#options.ledger.recordReceipt(receipt)
    )
      return false
    active.receipt = receipt // recordReceipt authenticates HMAC, caps and monotonic accounting first.
    return true
  }

  #fail(active: Active, cause: JobFailure): void {
    try {
      const accepted = this.#options.ledger.fail(active.lease, cause, active.receipt)
      if (!accepted && active.receipt && isSettledReceipt(active.receipt.claims))
        this.#options.ledger.reconcile(active.receipt)
    } catch {
      /* Store unavailable: never refund, retry, publish, or invent a receipt. Watchdog recovers. */
    }
  }

  #stop(active: Active, reason: StopReason): Promise<void> {
    if (active.stopping) return active.stopping
    active.invalid = true
    active.interrupt() // A hung/lost provider response cannot keep the worker loop alive indefinitely.
    this.#fail(active, failure('reconciliation-required'))
    active.stopping = (async () => {
      try {
        const receipt = await providerCalls(this.#options.provider).run(
          `stop:${active.lease.execution.executionId}`,
          this.#timeout,
          () => this.#options.provider.stop(active.lease.execution, reason),
        )
        if (this.#accept(active, receipt)) this.#options.ledger.reconcile(receipt)
      } catch {
        /* Stop request is not stopped proof; durable liability remains. */
      }
    })()
    return active.stopping
  }

  #heartbeat(active: Active): boolean {
    if (active.invalid || this.#stopped) return false
    try {
      const lease = this.#options.ledger.heartbeat(active.lease)
      if (lease) {
        active.lease = lease
        return true
      }
    } catch {
      /* Deny further execution/publication when control state is inaccessible. */
    }
    void this.#stop(active, this.#now() >= active.lease.deadline ? 'deadline' : 'lease-expired')
    return false
  }

  async #run(lease: Lease): Promise<void> {
    let interrupt!: () => void
    const interrupted = new Promise<null>((resolve) => {
      interrupt = () => resolve(null)
    })
    const active: Active = { lease, invalid: false, interrupt }
    this.#active.set(lease.execution.executionId, active)
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      if (this.#stopped || !this.#options.ledger.beginExecution(lease)) {
        await this.#stop(active, 'shutdown')
        return
      }
      // Renew during hashing and file I/O as well as provider work; timers never authorize publication.
      timer = setInterval(
        () => {
          this.#heartbeat(active)
        },
        Math.max(10, Math.min(1_000, Math.floor(lease.policy.leaseMs / 3))),
      )
      const context = signWorkerContext(
        workerClaimsForLease(lease, this.#now()),
        this.#options.contextSecret,
      )
      const result = await Promise.race([
        providerCalls(this.#options.provider).run(
          `execute:${lease.execution.executionId}`,
          Math.max(1, lease.deadline - this.#now()),
          () => this.#options.provider.execute(context),
        ),
        interrupted,
      ])
      if (result === null || active.invalid || this.#stopped) return
      if (result.receipt && !this.#accept(active, result.receipt)) {
        await this.#stop(active, 'shutdown')
        return
      }
      if (result.outcome === 'failure') {
        this.#fail(active, errorSchema.parse(result.failure))
        // Unknown failure remains fenced before any attempt to obtain stronger stop proof.
        if (!active.receipt || !isSettledReceipt(active.receipt.claims))
          await this.#stop(active, 'shutdown')
        return
      }
      if (
        !active.receipt ||
        active.receipt.claims.outcome !== 'completed' ||
        !isSettledReceipt(active.receipt.claims)
      ) {
        await this.#stop(active, 'shutdown')
        return
      }
      const artifact = await verifyDiagnosticArtifact(
        result.artifact,
        lease.design,
        lease.policy.maxOutputBytes,
      )
      if (!this.#heartbeat(active)) return
      active.staged = await this.#options.objects.stage(active.lease, artifact)
      if (
        !this.#heartbeat(active) ||
        !this.#options.ledger.beginPublishing(active.lease, active.staged)
      ) {
        await this.#stop(active, 'shutdown')
        return
      }
      const verified = await this.#options.objects.publish(active.staged)
      if (!this.#heartbeat(active) || !this.#options.ledger.publish(active.lease, verified)) {
        await this.#stop(active, 'shutdown')
        return
      }
    } catch (error) {
      // Never persist arbitrary provider/filesystem exception text (which may include keys or paths).
      const code =
        error instanceof ControlError && error.code === 'identity-mismatch'
          ? 'identity-mismatch'
          : 'publication-failed'
      this.#fail(active, failure(code))
      if (!active.receipt || !isSettledReceipt(active.receipt.claims))
        await this.#stop(active, 'shutdown')
    } finally {
      if (timer) clearInterval(timer)
      if (active.stopping) await active.stopping
      if (active.invalid && active.staged) {
        try {
          await this.#options.objects.removeStage(active.staged.stageId)
        } catch {
          /* Keep storage charged; recovery owns remnants. */
        }
      }
      this.#active.delete(lease.execution.executionId)
    }
  }

  async runOnce(): Promise<number> {
    if (this.#stopped || this.#running) return 0
    this.#running = true
    const pending: Promise<void>[] = []
    try {
      // No claim/launch when the separate resource journal cannot be inspected.
      const inventory = await providerCalls(this.#options.provider).run(
        'inspect',
        this.#timeout,
        () => this.#options.provider.inspect(),
      )
      const snapshot = this.#options.ledger.snapshot()
      if (this.#stopped || snapshot.killed) return 0
      // A provider-only resource is not a free concurrency slot or unbudgeted permission to run.
      // Preserve its independent liability for watchdog reconciliation rather than silently ignore it.
      if (
        inventory.some(
          (resource) =>
            !isSettledReceipt(resource.receipt.claims) &&
            (resource.receipt.claims.outcome === 'unknown' ||
              !snapshot.activeExecutions.some((record) =>
                sameExecution(record.execution, resource.execution),
              )),
        )
      )
        throw unavailable()
      for (let n = 0; n < this.#options.ledger.policy.maxConcurrency && !this.#stopped; n++) {
        const lease = this.#options.ledger.claim(this.#options.workerId)
        if (!lease) break
        pending.push(this.#run(lease))
      }
      await Promise.all(pending)
      return pending.length
    } catch {
      await Promise.all(pending)
      throw unavailable(
        'Local worker control or provider state is unavailable; new launches are denied.',
      )
    } finally {
      this.#running = false
    }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    await Promise.all([...this.#active.values()].map((active) => this.#stop(active, 'shutdown')))
    // Caller owns ledger/provider handles. This worker never closes another component's store.
  }
}
