import { z } from 'zod'
import { DISPLAY_LIMITS, stableDisplayJson } from '../../display/contract'
import { localDisplayPermitSchema, type LocalDisplayPermit } from '../../display/session'
import { DisplayDirectory, hash, opaqueId } from './files'
import { denied } from './errors'

const recordSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative().max(80),
    previous: z.string(),
    permitDigest: z.string(),
    owner: z.string(),
    state: z.enum(['owned', 'closed', 'quarantined']),
    startedAt: z.number().int().positive(),
    attempts: z.number().int().nonnegative().max(DISPLAY_LIMITS.jobsPerSession),
    outputBytes: z.number().int().nonnegative().max(DISPLAY_LIMITS.sessionOutputBytes),
    sessionId: z.string().nullable(),
  })
  .strict()
type RecordValue = z.infer<typeof recordSchema>

/** An append-only, exclusive local allowance journal. Not P04, a money ledger or a permit issuer.
 * A restarted process cannot adopt a warm host or manufacture stopped proof. No reset/retry API. */
export class DisplayRun {
  private record: RecordValue | undefined
  private readonly owner = opaqueId()
  readonly permit: LocalDisplayPermit | null
  private readonly permitDigest: string
  private readonly directory: DisplayDirectory | null
  constructor(
    permit: unknown,
    root: DisplayDirectory,
    private readonly now = Date.now,
  ) {
    this.permit = permit === null ? null : localDisplayPermitSchema.parse(permit)
    this.permitDigest = hash(stableDisplayJson(this.permit))
    if (!this.permit) {
      this.directory = null
      return
    }
    const runName = `run-${this.permit.runId}`
    // A different provisioned id must not bypass an older unresolved/exhausted run in this store.
    if (root.names(2).some((name) => name !== 'objects' && name !== runName)) throw denied()
    this.directory = new DisplayDirectory(root.file(runName))
    const names = this.directory.names(81).sort()
    let previous = ''
    for (const [i, name] of names.entries()) {
      if (name !== `${String(i).padStart(3, '0')}.json`) throw denied()
      const bytes = this.directory.read(name, 4096)
      const record = recordSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (
        record.sequence !== i ||
        record.previous !== previous ||
        record.permitDigest !== this.permitDigest ||
        (this.record &&
          (record.owner !== this.record.owner ||
            record.startedAt !== this.record.startedAt ||
            record.attempts < this.record.attempts ||
            record.outputBytes < this.record.outputBytes ||
            this.record.state !== 'owned'))
      )
        throw denied()
      this.record = record
      previous = hash(bytes)
    }
  }
  /** Admission is checked again immediately before open/mutation, never only at HTTP entry. */
  admit(queued = 0) {
    const p = this.permit,
      r = this.record
    if (
      !p ||
      !this.directory ||
      this.now() >= p.expiresAt ||
      (r &&
        (r.owner !== this.owner ||
          r.state !== 'owned' ||
          this.now() - r.startedAt >= DISPLAY_LIMITS.lifetimeMs)) ||
      (r?.attempts ?? 0) + queued >= p.maxJobs ||
      (r?.outputBytes ?? 0) + DISPLAY_LIMITS.pngBytes > p.maxOutputBytes
    )
      throw denied()
    return p
  }
  private append(
    next: Omit<RecordValue, 'sequence' | 'previous' | 'version' | 'permitDigest' | 'owner'>,
  ) {
    if (!this.directory) throw denied()
    const sequence = this.record ? this.record.sequence + 1 : 0
    const previous = this.record
      ? hash(this.directory.read(`${String(this.record.sequence).padStart(3, '0')}.json`, 4096))
      : ''
    const record = recordSchema.parse({
      ...next,
      version: 1,
      sequence,
      previous,
      permitDigest: this.permitDigest,
      owner: this.owner,
    })
    this.directory.exclusive(
      `${String(sequence).padStart(3, '0')}.json`,
      Buffer.from(stableDisplayJson(record)),
    )
    this.record = record
  }
  own() {
    this.admit()
    if (this.record) throw denied()
    this.append({
      state: 'owned',
      startedAt: this.now(),
      attempts: 1,
      outputBytes: 0,
      sessionId: null,
    })
  }
  attached(sessionId: string) {
    if (!this.record || this.record.sessionId || this.record.owner !== this.owner) throw denied()
    this.append({ ...this.record, sessionId })
  }
  attempt() {
    this.admit()
    if (!this.record?.sessionId) throw denied()
    this.append({ ...this.record, attempts: this.record.attempts + 1 })
    return this.record!.attempts
  }
  output(bytes: number) {
    if (
      !this.record ||
      this.record.state !== 'owned' ||
      !this.permit ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      this.record.outputBytes + bytes > this.permit.maxOutputBytes
    )
      throw denied()
    this.append({ ...this.record, outputBytes: this.record.outputBytes + bytes })
  }
  finish(observedExit: boolean) {
    if (!this.record || this.record.owner !== this.owner || this.record.state !== 'owned') return
    this.append({ ...this.record, state: observedExit ? 'closed' : 'quarantined' })
  }
  get remainingMs() {
    return Math.max(
      0,
      Math.min(
        (this.permit?.expiresAt ?? 0) - this.now(),
        this.record
          ? DISPLAY_LIMITS.lifetimeMs - (this.now() - this.record.startedAt)
          : DISPLAY_LIMITS.lifetimeMs,
      ),
    )
  }
  snapshot() {
    return this.record ? { ...this.record } : null
  }
}
