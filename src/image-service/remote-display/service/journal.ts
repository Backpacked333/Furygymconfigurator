import { unlinkSync } from 'node:fs'
import { z } from 'zod'
import { cloudRecipeSchema, type CloudRecipe } from '../../../display/cloudContract'
import {
  DISPLAY_LIMITS,
  displayDigestSchema,
  displayIdSchema,
  stableDisplayJson,
} from '../../../display/contract'
import { designEnvelopeSchema, type DesignEnvelope } from '../../../domain/design'
import { DisplayDirectory, hash, opaqueId } from '../../display/files'
import { capacity, missing, quarantined } from './errors'

const interestSchema = z
  .object({
    id: displayIdSchema,
    ownerHash: displayDigestSchema,
    recipe: cloudRecipeSchema,
    design: designEnvelopeSchema,
    expiresAt: z.number().int().positive(),
    hit: z.boolean(),
    state: z.enum(['queued', 'rendering', 'ready', 'failed', 'cancelled']),
  })
  .strict()
const snapshotSchema = z
  .object({
    kind: z.literal('external-display-journal@1'),
    sequence: z.number().int().min(1).max(256),
    previous: displayDigestSchema.nullable(),
    interests: z.array(interestSchema).max(DISPLAY_LIMITS.interests),
    run: z
      .object({
        claimed: z.boolean(),
        poisoned: z.boolean(),
        sessionId: displayIdSchema.nullable(),
        startedAt: z.number().int().nonnegative(),
        attempts: z.number().int().min(0).max(DISPLAY_LIMITS.jobsPerSession),
        outputBytes: z.number().int().min(0).max(DISPLAY_LIMITS.sessionOutputBytes),
        terminationRequested: z.boolean(),
        terminationEvidence: displayDigestSchema.nullable(),
        billingEvidence: displayDigestSchema.nullable(),
      })
      .strict(),
  })
  .strict()
export type CloudInterest = z.infer<typeof interestSchema>
type Snapshot = z.infer<typeof snapshotSchema>
const MAX_BYTES = 128 * 1024

/** A bounded fsynced hash-chain and exclusive service writer. No reset, retry allowance or lock stealing.
 * Any previous claimed run is quarantined on restart, even if a terminate call returned successfully.
 * Clean bridge shutdown releases only its writer lock, never the permanent run claim/counters. */
export class CloudJournal {
  private state: Snapshot = {
    kind: 'external-display-journal@1',
    sequence: 1,
    previous: null,
    interests: [],
    run: {
      claimed: false,
      poisoned: false,
      sessionId: null,
      startedAt: 0,
      attempts: 0,
      outputBytes: 0,
      terminationRequested: false,
      terminationEvidence: null,
      billingEvidence: null,
    },
  }
  private sequence = 0
  private digest: string | null = null
  private readonly writer = opaqueId()
  private locked = false
  readonly restartedRun: boolean
  constructor(
    private readonly directory: DisplayDirectory,
    private readonly now = Date.now,
  ) {
    const names = directory.names(257)
    if (names.some((n) => n !== 'writer.json' && !/^state-[0-9]{3}\.json$/.test(n)))
      throw quarantined()
    const snapshots = names.filter((n) => n !== 'writer.json').sort()
    for (const name of snapshots) {
      if (name !== `state-${String(this.sequence + 1).padStart(3, '0')}.json`) throw quarantined()
      const next = snapshotSchema.parse(
        JSON.parse(directory.read(name, MAX_BYTES).toString('utf8')),
      )
      if (
        next.sequence !== this.sequence + 1 ||
        next.previous !== this.digest ||
        next.run.attempts < this.state.run.attempts ||
        next.run.outputBytes < this.state.run.outputBytes ||
        (this.state.run.claimed &&
          (!next.run.claimed || next.run.startedAt !== this.state.run.startedAt)) ||
        (this.state.run.poisoned && !next.run.poisoned) ||
        (this.state.run.sessionId !== null && next.run.sessionId !== this.state.run.sessionId)
      )
        throw quarantined()
      this.assertBounds(next)
      this.state = next
      this.sequence++
      this.digest = hash(stableDisplayJson(next))
    }
    this.restartedRun = this.state.run.claimed
    // O_EXCL fails rather than adopting another process's durable writer lock.
    directory.exclusive(
      'writer.json',
      Buffer.from(stableDisplayJson({ kind: 'external-display-writer@1', writer: this.writer })),
    )
    this.locked = true
  }
  private assertBounds(next: Snapshot) {
    const pending = next.interests.filter((i) => i.state === 'queued')
    if (
      new Set(pending.map((i) => i.recipe.recipeDigest)).size > DISPLAY_LIMITS.queuedJobs ||
      new Set(
        next.interests.filter((i) => i.state === 'rendering').map((i) => i.recipe.recipeDigest),
      ).size > 1 ||
      new Set(next.interests.map((i) => i.id)).size !== next.interests.length
    )
      throw capacity()
  }
  private commit(mutate: (next: Snapshot) => void) {
    if (!this.locked || this.sequence >= 256) throw quarantined()
    const next = structuredClone(this.state)
    mutate(next)
    next.sequence = this.sequence + 1
    next.previous = this.digest
    snapshotSchema.parse(next)
    this.assertBounds(next)
    const bytes = Buffer.from(stableDisplayJson(next))
    if (bytes.length > MAX_BYTES) throw capacity()
    // Exclusive final pathname: a crash during writing is detected as poison, not skipped or reset.
    this.directory.exclusive(`state-${String(next.sequence).padStart(3, '0')}.json`, bytes)
    this.state = next
    this.sequence = next.sequence
    this.digest = hash(bytes)
  }
  snapshot() {
    return structuredClone(this.state)
  }
  get(owner: string, id: string) {
    const value = this.state.interests.find((i) => i.id === id && i.ownerHash === hash(owner))
    if (!value) throw missing()
    return structuredClone(value)
  }
  add(owner: string, design: DesignEnvelope, recipe: CloudRecipe, hit: boolean) {
    const value: CloudInterest = {
      id: opaqueId(),
      ownerHash: hash(owner),
      design: designEnvelopeSchema.parse(design),
      recipe,
      hit,
      expiresAt: this.now() + DISPLAY_LIMITS.interestMs,
      state: hit ? 'ready' : 'queued',
    }
    this.commit((next) => {
      next.interests = next.interests.filter((i) => i.expiresAt > this.now())
      if (!hit && (next.run.poisoned || this.restartedRun)) throw quarantined()
      const work = next.interests.find(
        (i) =>
          i.recipe.recipeDigest === recipe.recipeDigest &&
          (i.state === 'queued' || i.state === 'rendering'),
      )
      if (!hit && work) value.state = work.state
      next.interests.push(value)
    })
    return structuredClone(value)
  }
  cancel(owner: string, id: string) {
    this.get(owner, id)
    this.commit((next) => {
      next.interests.find((i) => i.id === id)!.state = 'cancelled'
    })
    return this.get(owner, id)
  }
  interested(key: string) {
    return this.state.interests.some(
      (i) =>
        i.recipe.recipeDigest === key &&
        i.expiresAt > this.now() &&
        (i.state === 'queued' || i.state === 'rendering'),
    )
  }
  next() {
    return structuredClone(
      this.state.interests.find((i) => i.state === 'queued' && i.expiresAt > this.now()),
    )
  }
  reserve(key: string) {
    this.commit((next) => {
      if (
        this.restartedRun ||
        next.run.poisoned ||
        next.run.terminationRequested ||
        (next.run.claimed && this.now() - next.run.startedAt >= DISPLAY_LIMITS.lifetimeMs) ||
        next.interests.some((i) => i.state === 'rendering') ||
        !this.interested(key)
      )
        throw quarantined()
      if (!next.run.claimed) {
        next.run.claimed = true
        next.run.startedAt = this.now()
      }
      next.run.attempts++
      for (const i of next.interests)
        if (i.recipe.recipeDigest === key && i.state === 'queued') i.state = 'rendering'
    })
    return this.state.run.attempts
  }
  attach(sessionId: string) {
    displayIdSchema.parse(sessionId)
    this.commit((next) => {
      if (!next.run.claimed || next.run.sessionId !== null) throw quarantined()
      next.run.sessionId = sessionId
    })
  }
  output(bytes: number) {
    this.commit((next) => {
      if (
        !Number.isInteger(bytes) ||
        bytes < 44 ||
        bytes > DISPLAY_LIMITS.pngBytes ||
        !next.run.claimed ||
        next.run.poisoned
      )
        throw quarantined()
      next.run.outputBytes += bytes
    })
  }
  complete(key: string) {
    this.commit((next) => {
      for (const i of next.interests)
        if (i.recipe.recipeDigest === key && i.state === 'rendering') i.state = 'ready'
    })
  }
  poison() {
    this.commit((next) => {
      next.run.poisoned = true
      next.run.terminationRequested = next.run.claimed
      for (const i of next.interests)
        if (i.state === 'queued' || i.state === 'rendering') i.state = 'failed'
      // A close/terminate request proves neither independent termination nor final billing.
    })
  }
  close() {
    if (!this.locked) return
    const owner = JSON.parse(this.directory.read('writer.json', 1024).toString('utf8')) as {
      writer?: string
    }
    if (owner.writer !== this.writer) throw quarantined()
    unlinkSync(this.directory.file('writer.json'))
    this.directory.sync()
    this.locked = false
  }
}
