import {
  ControlError,
  isSettledReceipt,
  providerReceiptSchema,
  sameExecution,
  timestampSchema,
  unavailable,
  type ExecutionRecord,
  type LedgerSnapshot,
  type ProviderExecution,
  type ProviderReceipt,
  type StopReason,
  type Watchdog,
  type WatchdogOptions,
  type WatchdogReport,
} from './contracts'
import { providerCalls, providerCallTimeout } from './providerCalls'

type MutableReport = {
  -readonly [K in keyof WatchdogReport]: K extends 'errors' ? string[] : WatchdogReport[K]
}
const emptyReport = (): MutableReport => ({
  killed: false,
  stopRequested: 0,
  reconciled: 0,
  retainedLiabilities: 0,
  closedStreams: 0,
  orphanExecutions: 0,
  errors: [],
})

/** Timer-free independent control loop: reopen the durable ledger/provider in a separate process.
 * No dispatcher process, browser, network service, renderer or external host is controlled here.
 * Local stream leases ARE the simulated resource; closing them proves no remote stream shutdown.
 */
export class IndependentWatchdog implements Watchdog {
  readonly #options: WatchdogOptions
  readonly #now: () => number
  readonly #timeout: number
  #running: Promise<WatchdogReport> | null = null

  constructor(options: WatchdogOptions) {
    if (
      options.provider.provider !== 'fake-local' ||
      options.provider.paidExecutionAllowed !== false
    )
      throw unavailable()
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#timeout = providerCallTimeout(options.providerCallTimeoutMs)
  }

  #error(report: MutableReport, code: string): void {
    if (report.errors.length < 16 && !report.errors.includes(code)) report.errors.push(code)
  }

  async #stop(
    execution: ProviderExecution['execution'],
    reason: StopReason,
    report: MutableReport,
  ): Promise<ProviderReceipt | null> {
    report.stopRequested++ // Attempts, explicitly NOT a count of terminated or billing-final workers.
    try {
      const receipt = providerReceiptSchema.parse(
        await providerCalls(this.#options.provider).run(
          `stop:${execution.executionId}`,
          this.#timeout,
          () => this.#options.provider.stop(execution, reason),
        ),
      )
      if (!sameExecution(receipt.claims.execution, execution)) throw unavailable()
      return receipt
    } catch {
      this.#error(report, 'provider-stop-unconfirmed')
      return null
    }
  }

  #reason(record: ExecutionRecord, snapshot: LedgerSnapshot, now: number): StopReason | null {
    if (snapshot.killed) return 'kill'
    if (record.deadline <= now) return 'deadline'
    if (record.leaseUntil <= now || record.reconciliationRequired) return 'lease-expired'
    return null
  }

  async #pass(killReason?: string): Promise<WatchdogReport> {
    const report = emptyReport()
    const unresolved = new Set<string>()
    let snapshot: LedgerSnapshot | null = null
    try {
      if (killReason !== undefined) this.#options.ledger.kill(killReason) // Irreversible control mutation FIRST.
      this.#options.ledger.recover()
      snapshot = this.#options.ledger.snapshot()
      report.killed = snapshot.killed
      this.#closeStreams(snapshot, report)
    } catch {
      this.#error(report, 'ledger-unavailable-liability-count-incomplete')
    }

    let inventory: readonly ProviderExecution[] = []
    let inventoryAvailable = false
    try {
      inventory = await providerCalls(this.#options.provider).run('inspect', this.#timeout, () =>
        this.#options.provider.inspect(),
      )
      inventoryAvailable = true
    } catch {
      this.#error(report, 'provider-inventory-unavailable')
    }

    if (!snapshot) {
      // We cannot honestly know killed/accounting state. Best-effort tombstones, never reconciliation.
      for (const resource of inventory) {
        if (isSettledReceipt(resource.receipt.claims)) continue
        const receipt = await this.#stop(resource.execution, 'shutdown', report)
        if (!receipt || !isSettledReceipt(receipt.claims)) report.retainedLiabilities++
      }
      return report
    }

    // Fresh views after every await protect live heartbeat extensions and newly claimed executions.
    const seen = new Set<string>()
    for (const original of snapshot.activeExecutions) {
      seen.add(original.execution.executionId)
      try {
        this.#options.ledger.recover()
        const current = this.#options.ledger.snapshot()
        report.killed ||= current.killed
        const record = current.activeExecutions.find((entry) =>
          sameExecution(entry.execution, original.execution),
        )
        if (!record) continue
        const reason = this.#reason(record, current, timestampSchema.parse(this.#now()))
        let receipt: ProviderReceipt | null
        if (reason) receipt = await this.#stop(record.execution, reason, report)
        else {
          // In particular, do NOT invent an unknown receipt for a leased-but-not-started identity:
          // that is a normal dispatch window, and no inspection result is not proof of failure.
          const resource = inventory.find((entry) =>
            sameExecution(entry.execution, record.execution),
          )
          if (!resource || !inventoryAvailable) continue
          receipt = await providerCalls(this.#options.provider).run(
            `receipt:${record.execution.executionId}`,
            this.#timeout,
            () => this.#options.provider.receipt(record.execution),
          )
        }
        if (!receipt) continue
        if (reason || record.reconciliationRequired) {
          if (this.#options.ledger.reconcile(receipt) && isSettledReceipt(receipt.claims))
            report.reconciled++
        } else if (!this.#options.ledger.recordReceipt(receipt))
          this.#error(report, 'provider-receipt-rejected')
      } catch {
        this.#error(report, 'execution-reconciliation-unconfirmed')
      }
    }

    // Audit execution IDs distinguish old settled history from true provider-only orphans. This
    // read happens AFTER inventory, so a concurrently admitted/started execution is not an orphan.
    let known: Set<string> | null = null
    try {
      known = new Set(
        this.#options.ledger
          .events()
          .flatMap((event) => (event.executionId ? [event.executionId] : [])),
      )
    } catch {
      this.#error(report, 'ledger-audit-unavailable-liability-count-incomplete')
    }
    for (const resource of inventory) {
      if (seen.has(resource.execution.executionId)) continue
      let historical = known?.has(resource.execution.executionId) ?? false
      if (known) {
        try {
          // The global event reader is bounded. A busy unrelated job must not turn old, already
          // settled executions into fictitious orphan hosts. Consult the bounded job-specific log.
          const history = this.#options.ledger.events(resource.execution.jobId)
          historical ||= history.some(
            (event) => event.executionId === resource.execution.executionId,
          )
          // Even a job-specific history can omit its oldest attempt. A signed final tombstone
          // needs no further stop; skipping it does NOT book or refund any historical cost.
          historical ||= history.length > 0 && isSettledReceipt(resource.receipt.claims)
        } catch {
          this.#error(report, 'historical-execution-lookup-unavailable')
        }
      }
      if (historical) {
        // Authenticate and quarantine contradictions even after settlement. An old ID is not
        // evidence that the current provider inventory is stopped or billing-final.
        try {
          this.#options.ledger.recordReceipt(resource.receipt)
        } catch {
          this.#error(report, 'historical-execution-reconciliation-unconfirmed')
        }
        if (!isSettledReceipt(resource.receipt.claims)) {
          const receipt = await this.#stop(resource.execution, 'shutdown', report)
          if (!receipt || !isSettledReceipt(receipt.claims))
            unresolved.add(resource.execution.executionId)
          if (receipt) {
            try {
              this.#options.ledger.reconcile(receipt)
            } catch {
              this.#error(report, 'historical-execution-reconciliation-unconfirmed')
            }
          }
        }
        continue
      }
      if (!known) {
        if (!isSettledReceipt(resource.receipt.claims))
          await this.#stop(resource.execution, 'shutdown', report)
        continue
      }
      report.orphanExecutions++
      const receipt = await this.#stop(resource.execution, 'orphan', report)
      // No ledger association means no budget refund. The provider journal retains the tombstone.
      if (!receipt || !isSettledReceipt(receipt.claims)) report.retainedLiabilities++
    }

    try {
      // Local processes share a nondecreasing clock. A stage created after this snapshot
      // boundary cannot be older than its cutoff. Remote/clock-rollback GC is not qualified.
      const recoveryBefore = timestampSchema.parse(this.#now())
      this.#options.ledger.recover()
      const latest = this.#options.ledger.snapshot()
      report.killed ||= latest.killed
      this.#closeStreams(latest, report)
      for (const record of latest.activeExecutions)
        if (
          record.reconciliationRequired ||
          !record.lastReceipt ||
          !isSettledReceipt(record.lastReceipt.claims)
        )
          unresolved.add(record.execution.executionId)
      for (const record of latest.quarantinedExecutions)
        unresolved.add(record.execution.executionId)
      if (latest.quarantinedExecutions.length) this.#error(report, 'provider-finality-quarantined')
      if (this.#options.objects) {
        // Never delete immutable orphans from a stale snapshot; ObjectStore.recover only reports them.
        await this.#options.objects.recover(
          latest.objects.map((object) => object.objectKey),
          latest.activeExecutions.map((record) => record.execution.executionId),
          recoveryBefore,
        )
        // This ledger call durably retires immutable keys and excludes live/shared/uncertain
        // references before filesystem deletion. Permanent tombstones prevent any subsequent
        // publication under the same key, including duplicate watchdog deletion after a crash.
        // Never infer deletion from elapsed time, an orphan listing, or a stop request.
        for (const job of this.#options.ledger.retentionCandidates()) {
          if (!job.artifact) continue
          try {
            if (
              !(await this.#options.objects.delete(job.artifact)) ||
              !this.#options.ledger.confirmObjectDeleted(job.id, job.artifact.objectKey)
            )
              this.#error(report, 'object-deletion-unconfirmed')
          } catch {
            this.#error(report, 'object-deletion-unconfirmed')
          }
        }
      }
    } catch {
      this.#error(report, 'ledger-or-object-recovery-unconfirmed-liability-count-incomplete')
    }
    report.retainedLiabilities += unresolved.size
    return report
  }

  #closeStreams(snapshot: LedgerSnapshot, report: MutableReport): void {
    for (const stream of snapshot.streams) {
      if (
        stream.state !== 'closed' &&
        (snapshot.killed || stream.state === 'stop-requested' || stream.expiresAt <= this.#now()) &&
        this.#options.ledger.closeStream(stream.id)
      )
        report.closedStreams++
    }
  }

  tick(): Promise<WatchdogReport> {
    if (this.#running) return this.#running
    const pass = this.#pass().finally(() => {
      if (this.#running === pass) this.#running = null
    })
    this.#running = pass
    return pass
  }

  async kill(reason: string): Promise<WatchdogReport> {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,119}$/.test(reason))
      throw new ControlError(
        422,
        'invalid-request',
        'A bounded private operator kill code is required.',
      )
    // Persist immediately, even when a concurrent tick is awaiting a provider response.
    try {
      this.#options.ledger.kill(reason)
    } catch {
      return this.#pass(reason)
    }
    if (this.#running) await this.#running
    const pass = this.#pass().finally(() => {
      if (this.#running === pass) this.#running = null
    })
    this.#running = pass
    return pass
  }
}
