import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  defaultDesign,
  designEnvelopeSchema,
  parseDesign,
  type DesignEnvelope,
} from '../../domain/design'
import {
  canonicalDesign,
  canonicalPresentation,
  canonicalRequest,
  type DesignIdentity,
} from '../../domain/designIdentity'
import { outputProfileSchema } from '../../domain/presentation'
import {
  createMockArtifact,
  digestSchema,
  MOCK_ARTIFACT_LABEL,
  MOCK_GENERATOR_VERSION,
  mockArtifactDimensions,
  mockArtifactSchema,
  requestIdentitySchema,
  type MockArtifact,
} from '../protocol'

/** Private, unmounted, unpaid P04 control plane. No switch can authorize paid execution. */
export const CONTROL_PROTOCOL = 'fury.safe-images.local@1' as const
export const CONTROL_API_PREFIX = '/__fury-control/v1' as const
export const IMAGE_PATH = `${CONTROL_API_PREFIX}/images` as const
export const EXPORT_PATH = `${CONTROL_API_PREFIX}/exports` as const
export const MAX_REQUEST_BYTES = 16 * 1024
export const PAID_EXECUTION_ALLOWED = false as const
export const PUBLIC_STREAMS_ENABLED = false as const
export const EXECUTION_POLICY = Object.freeze({
  provider: 'fake-local' as const,
  paidExecutionAllowed: PAID_EXECUTION_ALLOWED,
  productionAllowed: false as const,
  publicStreamsEnabled: PUBLIC_STREAMS_ENABLED,
})
export { digestSchema, requestIdentitySchema, MOCK_ARTIFACT_LABEL, MOCK_GENERATOR_VERSION }
export type { DesignEnvelope, DesignIdentity, MockArtifact }

export const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
export const safeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const microcurrencySchema = safeIntegerSchema
export const timestampSchema = safeIntegerSchema
export const purposeSchema = z.enum(['image', 'export'])
export type Purpose = z.infer<typeof purposeSchema>

/** The envelope already contains the sole server-allowlisted profile; no second override exists. */
export const imageRequestSchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    design: designEnvelopeSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
export const exportRequestSchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    design: designEnvelopeSchema,
    idempotencyKey: idempotencyKeySchema,
    format: z.literal('diagnostic-svg'),
  })
  .strict()
export type ImageRequest = Readonly<z.infer<typeof imageRequestSchema>>
export type ExportRequest = Readonly<z.infer<typeof exportRequestSchema>>
export type ControlRequest = ImageRequest | ExportRequest
export function parseImageRequest(input: unknown): ImageRequest {
  return imageRequestSchema.parse(input)
}
export function parseExportRequest(input: unknown): ExportRequest {
  return exportRequestSchema.parse(input)
}
export const cancelRequestSchema = z.object({ protocol: z.literal(CONTROL_PROTOCOL) }).strict()

/** Constructed only by the authenticating adapter. Parsing this shape does NOT authenticate anyone. */
export const authContextSchema = z
  .object({
    principalId: opaqueIdSchema,
    experimentId: opaqueIdSchema,
    scopes: z
      .array(z.enum(['images:read', 'images:write', 'exports:write']))
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, 'Duplicate scopes.'),
  })
  .strict()
export type AuthContext = Readonly<z.infer<typeof authContextSchema>>
export type Scope = AuthContext['scopes'][number]

export const jobStateSchema = z.enum([
  'requested',
  'reserved',
  'queued',
  'leased',
  'rendering',
  'publishing',
  'ready',
  'failed',
  'cancelled',
  'expired',
])
export type JobState = z.infer<typeof jobStateSchema>
export const TERMINAL_STATES: readonly JobState[] = Object.freeze([
  'ready',
  'failed',
  'cancelled',
  'expired',
])
const transitions: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  requested: ['reserved', 'failed', 'cancelled', 'expired'],
  reserved: ['queued', 'failed', 'cancelled', 'expired'],
  queued: ['leased', 'failed', 'cancelled', 'expired'],
  leased: ['rendering', 'failed', 'cancelled', 'expired', 'queued'],
  rendering: ['publishing', 'failed', 'cancelled', 'expired', 'queued'],
  publishing: ['ready', 'failed', 'cancelled', 'expired', 'queued'],
  ready: ['expired'],
  failed: [],
  cancelled: [],
  expired: [],
})
/** Graph check only; receipt, lease, kill and accounting preconditions remain transactional checks. */
export function canTransition(from: JobState, to: JobState): boolean {
  return from === to || transitions[from].includes(to)
}
export function assertTransition(
  from: JobState,
  to: JobState,
  reconciliationRequired = false,
): void {
  if (
    !canTransition(from, to) ||
    (reconciliationRequired && (from !== to || ['ready', 'cancelled', 'expired'].includes(to)))
  )
    throw new ControlError(
      503,
      'reconciliation-required',
      'Transition lacks safe execution reconciliation.',
    )
}
export const eventKindSchema = z.enum([
  'requested',
  'reserved',
  'queued',
  'leased',
  'heartbeat',
  'rendering',
  'publishing',
  'ready',
  'failed',
  'cancelled',
  'expired',
  'interest-attached',
  'interest-cancelled',
  'receipt-recorded',
  'provider-quarantined',
  'reconciliation-required',
  'reconciled',
  'kill-enabled',
  'stream-opened',
  'stream-closed',
  'object-deleted',
  'delivery-recorded',
])
export type LifecycleEvent = Readonly<{
  sequence: number
  at: number
  jobId: string | null
  kind: z.infer<typeof eventKindSchema>
  fromState: JobState | null
  toState: JobState | null
  fence: number | null
  executionId: string | null
  detail: string
}>

export const errorCodeSchema = z.enum([
  'invalid-request',
  'invalid-json',
  'body-too-large',
  'unsupported-media-type',
  'unauthorized',
  'forbidden',
  'not-found',
  'method-not-allowed',
  'idempotency-conflict',
  'capacity-exceeded',
  'budget-exceeded',
  'killed',
  'store-unavailable',
  'unavailable',
  'expired',
  'stale-lease',
  'identity-mismatch',
  'publication-failed',
  'reconciliation-required',
  'paid-execution-disabled',
])
export type ErrorCode = z.infer<typeof errorCodeSchema>
export const errorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1).max(240),
    retryable: z.boolean(),
  })
  .strict()
export type JobFailure = z.infer<typeof errorSchema>
export type ErrorStatus =
  400 | 401 | 403 | 404 | 405 | 408 | 409 | 410 | 413 | 415 | 422 | 429 | 503
export class ControlError extends Error {
  readonly status: ErrorStatus
  readonly code: ErrorCode
  readonly retryable: boolean
  constructor(status: ErrorStatus, code: ErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ControlError'
    this.status = status
    this.code = errorCodeSchema.parse(code)
    this.retryable = retryable
  }
  get wireError(): JobFailure {
    return errorSchema.parse({ code: this.code, message: this.message, retryable: this.retryable })
  }
}
export function unavailable(
  message = 'Durable control state is unavailable; execution is denied.',
): ControlError {
  return new ControlError(503, 'store-unavailable', message)
}

/** Integer synthetic microcurrency ONLY; these are not provider prices or a spend authorization. */
export const policySchema = z
  .object({
    globalBudgetMicro: microcurrencySchema.default(1_000_000),
    experimentBudgetMicro: microcurrencySchema.default(250_000),
    principalBudgetMicro: microcurrencySchema.default(100_000),
    maxConcurrency: z.number().int().min(1).max(4).default(2),
    maxUniqueMisses: z.number().int().min(1).max(512).default(128),
    maxPrincipalUniqueMisses: z.number().int().min(1).max(128).default(32),
    maxAttempts: z.number().int().min(1).max(3).default(2),
    maxJobs: z.number().int().min(1).max(512).default(128),
    maxInterests: z.number().int().min(1).max(2048).default(512),
    maxPrincipalInterests: z.number().int().min(1).max(128).default(32),
    maxPrincipals: z.number().int().min(1).max(512).default(128),
    maxExperiments: z.number().int().min(1).max(32).default(8),
    maxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(12 * 1024)
      .default(12 * 1024),
    maxStorageBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .default(8 * 1024 * 1024),
    maxDeliveryBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    maxDeliveriesPerJob: z.number().int().min(1).max(128).default(16),
    maxRuntimeMs: z.number().int().min(1).max(30_000).default(1_000),
    maxStartupMs: z.number().int().min(1).max(10_000).default(100),
    maxIdleMs: z.number().int().min(1).max(10_000).default(100),
    maxShutdownMs: z.number().int().min(1).max(10_000).default(100),
    delayedMeterMarginMs: z.number().int().min(1).max(60_000).default(200),
    runtimeMicroPerMs: microcurrencySchema.default(1),
    deliveryMicroPerKiB: microcurrencySchema.default(1),
    storageMicroPerKiBHour: microcurrencySchema.default(1),
    leaseMs: z.number().int().min(100).max(60_000).default(10_000),
    contextTtlMs: z.number().int().min(100).max(60_000).default(10_000),
    jobTtlMs: z.number().int().min(100).max(3_600_000).default(60_000),
    interestTtlMs: z.number().int().min(100).max(3_600_000).default(300_000),
    retentionMs: z
      .number()
      .int()
      .min(100)
      .max(7 * 86_400_000)
      .default(86_400_000),
    retryDelayMs: z.number().int().min(0).max(30_000).default(100),
    maxStreams: z.number().int().min(1).max(4).default(2),
    streamTtlMs: z.number().int().min(100).max(60_000).default(5_000),
  })
  .strict()
export type Policy = Readonly<z.infer<typeof policySchema>>
export const DEFAULT_POLICY: Policy = Object.freeze(policySchema.parse({}))
export const quoteSchema = z
  .object({
    currency: z.literal('synthetic-micro'),
    startup: microcurrencySchema,
    runtime: microcurrencySchema,
    idle: microcurrencySchema,
    retries: microcurrencySchema,
    delivery: microcurrencySchema,
    storage: microcurrencySchema,
    shutdown: microcurrencySchema,
    delayedMeter: microcurrencySchema,
    total: microcurrencySchema,
    maxAttempts: z.number().int().min(1).max(3),
    reservedStorageBytes: safeIntegerSchema,
    reservedDeliveryBytes: safeIntegerSchema,
  })
  .strict()
  .superRefine((quote, context) => {
    const sum =
      quote.startup +
      quote.runtime +
      quote.idle +
      quote.retries +
      quote.delivery +
      quote.storage +
      quote.shutdown +
      quote.delayedMeter
    if (!Number.isSafeInteger(sum) || sum !== quote.total)
      context.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'Quote components must add exactly without overflow.',
      })
  })
export type CostQuote = Readonly<z.infer<typeof quoteSchema>>
export function checkedAdd(...values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    safeIntegerSchema.parse(value)
    total += value
    if (!Number.isSafeInteger(total)) throw new RangeError('Synthetic accounting overflow.')
  }
  return total
}
export function checkedMultiply(left: number, right: number): number {
  safeIntegerSchema.parse(left)
  safeIntegerSchema.parse(right)
  const result = left * right
  if (!Number.isSafeInteger(result)) throw new RangeError('Synthetic accounting overflow.')
  return result
}
export function worstCaseQuote(input: Policy = DEFAULT_POLICY): CostQuote {
  const p = policySchema.parse(input)
  const startup = checkedMultiply(p.maxStartupMs, p.runtimeMicroPerMs)
  const runtime = checkedMultiply(p.maxRuntimeMs, p.runtimeMicroPerMs)
  const idle = checkedMultiply(p.maxIdleMs, p.runtimeMicroPerMs)
  const shutdown = checkedMultiply(p.maxShutdownMs, p.runtimeMicroPerMs)
  const delayedMeter = checkedMultiply(p.delayedMeterMarginMs, p.runtimeMicroPerMs)
  const retries = checkedMultiply(
    p.maxAttempts - 1,
    checkedAdd(startup, runtime, idle, shutdown, delayedMeter),
  )
  // Every attempt may leave an orphan stage; reserve these bytes before any work starts.
  const reservedStorageBytes = checkedMultiply(p.maxOutputBytes, p.maxAttempts)
  const reservedDeliveryBytes = checkedMultiply(p.maxOutputBytes, p.maxDeliveriesPerJob)
  const delivery = checkedMultiply(Math.ceil(reservedDeliveryBytes / 1024), p.deliveryMicroPerKiB)
  const storageHours = Math.ceil(
    checkedAdd(p.retentionMs, p.jobTtlMs, p.maxShutdownMs, p.delayedMeterMarginMs) / 3_600_000,
  )
  const storage = checkedMultiply(
    checkedMultiply(Math.ceil(reservedStorageBytes / 1024), storageHours),
    p.storageMicroPerKiBHour,
  )
  return Object.freeze(
    quoteSchema.parse({
      currency: 'synthetic-micro',
      startup,
      runtime,
      idle,
      retries,
      delivery,
      storage,
      shutdown,
      delayedMeter,
      total: checkedAdd(startup, runtime, idle, retries, delivery, storage, shutdown, delayedMeter),
      maxAttempts: p.maxAttempts,
      reservedStorageBytes,
      reservedDeliveryBytes,
    }),
  )
}

export const requestBindingSchema = z
  .object({
    purpose: purposeSchema,
    identity: requestIdentitySchema,
    cacheKey: digestSchema,
    visibility: z.enum(['public', 'private']),
    revision: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.revision !== value.identity.requestDigest ||
      value.visibility !== (value.purpose === 'export' ? 'private' : 'public')
    )
      context.addIssue({
        code: 'custom',
        message: 'Revision or visibility contradicts request purpose.',
      })
  })
export type RequestBinding = Readonly<z.infer<typeof requestBindingSchema>>
export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
/** Stable internal serialization. Only call on values already parsed by a strict schema. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('Canonical JSON requires a JSON value.')
  return encoded
}
export function bindRequestSync(
  designInput: unknown,
  purpose: Purpose,
  authInput: AuthContext,
): RequestBinding {
  const design = parseDesign(designInput)
  const auth = authContextSchema.parse(authInput)
  purposeSchema.parse(purpose)
  const hash = (text: string) => sha256Bytes(new TextEncoder().encode(text))
  const identity: DesignIdentity = Object.freeze({
    designDigest: hash(canonicalDesign(design)),
    presentationDigest: hash(canonicalPresentation(design)),
    requestDigest: hash(canonicalRequest(design)),
  })
  const cacheKey = sha256Bytes(
    new TextEncoder().encode(
      canonicalJson({
        protocol: CONTROL_PROTOCOL,
        generator: MOCK_GENERATOR_VERSION,
        purpose,
        requestDigest: identity.requestDigest,
        // Public bytes are shared independently of principal/experiment. Private exports are not.
        isolation:
          purpose === 'export'
            ? { principalId: auth.principalId, experimentId: auth.experimentId }
            : null,
      }),
    ),
  )
  return Object.freeze(
    requestBindingSchema.parse({
      purpose,
      identity,
      cacheKey,
      visibility: purpose === 'export' ? 'private' : 'public',
      revision: identity.requestDigest,
    }),
  )
}
/** Async-compatible service facade; the sync authority also permits validation inside SQLite transactions. */
export async function bindRequest(
  designInput: unknown,
  purpose: Purpose,
  authInput: AuthContext,
): Promise<RequestBinding> {
  return bindRequestSync(designInput, purpose, authInput)
}

export const executionIdentitySchema = z
  .object({
    provider: z.literal('fake-local'),
    executionId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    fence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    attempt: z.number().int().min(1).max(3),
  })
  .strict()
export type ExecutionIdentity = Readonly<z.infer<typeof executionIdentitySchema>>
export type Lease = Readonly<{
  execution: ExecutionIdentity
  workerId: string
  design: DesignEnvelope
  binding: RequestBinding
  quote: CostQuote
  leaseUntil: number
  deadline: number
  policy: Policy
}>
export const workerClaimsSchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    audience: z.literal('fury-private-fake-worker'),
    execution: executionIdentitySchema,
    binding: requestBindingSchema,
    design: designEnvelopeSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    maxRuntimeMs: z.number().int().min(1).max(30_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(12 * 1024),
    maxCostMicro: microcurrencySchema,
    paidExecutionAllowed: z.literal(false),
  })
  .strict()
  .superRefine((claims, context) => {
    if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > 60_000)
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Worker context must expire within 60 seconds.',
      })
  })
export type WorkerClaims = Readonly<z.infer<typeof workerClaimsSchema>>
const signatureSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const signedWorkerContextSchema = z
  .object({ claims: workerClaimsSchema, signature: signatureSchema })
  .strict()
export type SignedWorkerContext = Readonly<z.infer<typeof signedWorkerContextSchema>>
function signature(value: unknown, secret: string, purpose: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32)
    throw new Error('An injected private signing key of at least 32 bytes is required.')
  return createHmac('sha256', secret)
    .update(`${purpose}\n${canonicalJson(value)}`)
    .digest('hex')
}
function checkSignature(value: unknown, supplied: string, secret: string, purpose: string): void {
  const expected = signature(value, secret, purpose)
  if (
    !signatureSchema.safeParse(supplied).success ||
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))
  )
    throw new ControlError(403, 'forbidden', 'Private control signature is invalid.')
}
export function signWorkerContext(input: WorkerClaims, secret: string): SignedWorkerContext {
  const claims = workerClaimsSchema.parse(input)
  return { claims, signature: signature(claims, secret, 'p04-worker') }
}
export function verifyWorkerContext(input: unknown, secret: string, now: number): WorkerClaims {
  const value = signedWorkerContextSchema.parse(input)
  checkSignature(value.claims, value.signature, secret, 'p04-worker')
  timestampSchema.parse(now)
  if (now < value.claims.issuedAt || now >= value.claims.expiresAt)
    throw new ControlError(403, 'expired', 'Private worker context is not currently valid.')
  return value.claims
}
export function workerClaimsForLease(lease: Lease, now: number): WorkerClaims {
  const expiresAt = Math.min(
    checkedAdd(now, lease.policy.contextTtlMs),
    lease.leaseUntil,
    lease.deadline,
  )
  return workerClaimsSchema.parse({
    protocol: CONTROL_PROTOCOL,
    audience: 'fury-private-fake-worker',
    execution: lease.execution,
    binding: lease.binding,
    design: lease.design,
    issuedAt: now,
    expiresAt,
    maxRuntimeMs: lease.policy.maxRuntimeMs,
    maxOutputBytes: lease.policy.maxOutputBytes,
    maxCostMicro: checkedAdd(
      lease.quote.startup,
      lease.quote.runtime,
      lease.quote.idle,
      lease.quote.shutdown,
      lease.quote.delayedMeter,
    ),
    paidExecutionAllowed: false,
  })
}

export const receiptClaimsSchema = z
  .object({
    execution: executionIdentitySchema,
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    observedAt: timestampSchema,
    outcome: z.enum(['running', 'stop-requested', 'stopped', 'completed', 'unknown']),
    cumulativeCostMicro: microcurrencySchema,
    runtimeMs: safeIntegerSchema,
    finalMeter: z.boolean(),
    // A durable tombstone prevents a delayed duplicate execute from resurrecting this identity.
    startForbidden: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.finalMeter && !['stopped', 'completed'].includes(value.outcome)) ||
      (['stopped', 'completed'].includes(value.outcome) && !value.startForbidden)
    )
      context.addIssue({
        code: 'custom',
        message: 'Final settlement requires terminal execution and durable start tombstone.',
      })
  })
export type ReceiptClaims = Readonly<z.infer<typeof receiptClaimsSchema>>
export const providerReceiptSchema = z
  .object({ claims: receiptClaimsSchema, signature: signatureSchema })
  .strict()
export type ProviderReceipt = Readonly<z.infer<typeof providerReceiptSchema>>
export function signProviderReceipt(input: ReceiptClaims, secret: string): ProviderReceipt {
  const claims = receiptClaimsSchema.parse(input)
  return { claims, signature: signature(claims, secret, 'p04-provider-receipt') }
}
export function verifyProviderReceipt(input: unknown, secret: string): ReceiptClaims {
  const receipt = providerReceiptSchema.parse(input)
  checkSignature(receipt.claims, receipt.signature, secret, 'p04-provider-receipt')
  return receipt.claims
}
/** Receipt signature, execution identity, sequence and monotonic meter still MUST be checked by ledger. */
export function isSettledReceipt(claims: ReceiptClaims): boolean {
  const parsed = receiptClaimsSchema.parse(claims)
  return (
    ['completed', 'stopped'].includes(parsed.outcome) && parsed.finalMeter && parsed.startForbidden
  )
}
export function sameExecution(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return (
    canonicalJson(executionIdentitySchema.parse(left)) ===
    canonicalJson(executionIdentitySchema.parse(right))
  )
}

export const objectKeySchema = z
  .string()
  .regex(/^p04\/(public|private)\/[a-f0-9]{64}\/[a-f0-9]{64}\.svg$/)
export const artifactDescriptorSchema = z
  .object({
    objectKey: objectKeySchema,
    artifactId: digestSchema,
    checksum: digestSchema,
    binding: requestBindingSchema,
    outputProfile: outputProfileSchema,
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(12 * 1024),
    mediaType: z.literal('image/svg+xml'),
    generatorVersion: z.literal(MOCK_GENERATOR_VERSION),
    label: z.literal(MOCK_ARTIFACT_LABEL),
    kind: z.literal('mock-diagnostic'),
    approvedCurrentImage: z.literal(false),
    strictExport: z.literal(false),
    productionAllowed: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.artifactId !== value.checksum ||
      value.objectKey !== immutableObjectKey(value.binding, value.checksum)
    )
      context.addIssue({
        code: 'custom',
        message: 'Immutable object key must bind scope, request and actual checksum.',
      })
  })
export type ArtifactDescriptor = Readonly<z.infer<typeof artifactDescriptorSchema>>
export function immutableObjectKey(bindingInput: RequestBinding, checksum: string): string {
  const binding = requestBindingSchema.parse(bindingInput)
  digestSchema.parse(checksum)
  return `p04/${binding.visibility}/${binding.cacheKey.slice(7)}/${checksum.slice(7)}.svg`
}
export type StagedObject = Readonly<{
  stageId: string
  execution: ExecutionIdentity
  object: ArtifactDescriptor
  stagedAt: number
}>
export const verifiedObjectClaimsSchema = z
  .object({
    stageId: opaqueIdSchema,
    execution: executionIdentitySchema,
    object: artifactDescriptorSchema,
    verifiedAt: timestampSchema,
  })
  .strict()
export type VerifiedObjectClaims = Readonly<z.infer<typeof verifiedObjectClaimsSchema>>
export const verifiedObjectSchema = z
  .object({ claims: verifiedObjectClaimsSchema, signature: signatureSchema })
  .strict()
export type VerifiedObject = Readonly<z.infer<typeof verifiedObjectSchema>>
export function signVerifiedObject(input: VerifiedObjectClaims, secret: string): VerifiedObject {
  const claims = verifiedObjectClaimsSchema.parse(input)
  return { claims, signature: signature(claims, secret, 'p04-object-verification') }
}
export function verifyObjectReceipt(input: unknown, secret: string): VerifiedObjectClaims {
  const value = verifiedObjectSchema.parse(input)
  checkSignature(value.claims, value.signature, secret, 'p04-object-verification')
  return value.claims
}
/** Pure, deterministic byte verification. It never renders or fetches any resource. */
export async function verifyDiagnosticArtifact(
  input: unknown,
  designInput: unknown,
  maxBytes = 12 * 1024,
): Promise<MockArtifact> {
  const artifact = mockArtifactSchema.parse(input)
  const design = parseDesign(designInput)
  const expected = await createMockArtifact(design)
  const bytes = diagnosticBytes(artifact)
  const dimensions = mockArtifactDimensions(design)
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 12 * 1024 ||
    bytes.byteLength > maxBytes ||
    bytes.byteLength !== artifact.byteLength ||
    sha256Bytes(bytes) !== artifact.checksum ||
    artifact.artifactId !== artifact.checksum ||
    artifact.width !== dimensions.width ||
    artifact.height !== dimensions.height ||
    canonicalJson(artifact) !== canonicalJson(expected)
  )
    throw new ControlError(
      503,
      'identity-mismatch',
      'Diagnostic bytes, profile or immutable revision failed verification.',
    )
  return artifact
}
export function diagnosticBytes(input: MockArtifact): Uint8Array {
  const artifact = mockArtifactSchema.parse(input)
  return new TextEncoder().encode(
    decodeURIComponent(artifact.src.slice('data:image/svg+xml;charset=utf-8,'.length)),
  )
}
export function describeArtifact(
  artifactInput: MockArtifact,
  designInput: unknown,
  bindingInput: RequestBinding,
): ArtifactDescriptor {
  const artifact = mockArtifactSchema.parse(artifactInput)
  const design = parseDesign(designInput)
  const binding = requestBindingSchema.parse(bindingInput)
  // This describes metadata only; ObjectStore.stage MUST call verifyDiagnosticArtifact first.
  return artifactDescriptorSchema.parse({
    objectKey: immutableObjectKey(binding, artifact.checksum),
    artifactId: artifact.artifactId,
    checksum: artifact.checksum,
    binding,
    outputProfile: design.outputProfile,
    width: artifact.width,
    height: artifact.height,
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    generatorVersion: MOCK_GENERATOR_VERSION,
    label: MOCK_ARTIFACT_LABEL,
    kind: 'mock-diagnostic',
    approvedCurrentImage: false,
    strictExport: false,
    productionAllowed: false,
  })
}

// Shared implementation boundaries. No interface below implements storage, authentication or a provider.
export type Admission = Readonly<{
  auth: AuthContext
  purpose: Purpose
  request: ControlRequest
  binding: RequestBinding
  quote: CostQuote
}>
export type InterestRecord = Readonly<{
  id: string
  jobId: string
  principalId: string
  experimentId: string
  idempotencyKey: string
  cancelled: boolean
  createdAt: number
  expiresAt: number
}>
export type JobRecord = Readonly<{
  id: string
  design: DesignEnvelope
  binding: RequestBinding
  state: JobState
  sponsorPrincipalId: string
  sponsorExperimentId: string
  quote: CostQuote
  fence: number
  attempts: number
  execution: ExecutionIdentity | null
  leaseUntil: number
  deadline: number
  availableAt: number
  createdAt: number
  finishedAt: number | null
  reconciliationRequired: boolean
  reservedMicro: number
  spentMicro: number
  artifact: ArtifactDescriptor | null
  error: JobFailure | null
}>
export type InterestView = Readonly<{ interest: InterestRecord; job: JobRecord }>
export type AdmissionResult = Readonly<{
  view: InterestView
  disposition: 'created' | 'coalesced' | 'cache-hit' | 'idempotent'
}>
export type AccountBalance = Readonly<{
  id: string
  spentMicro: number
  reservedMicro: number
  uniqueMisses: number
}>
export type ExecutionRecord = Readonly<{
  execution: ExecutionIdentity
  leaseUntil: number
  deadline: number
  reconciliationRequired: boolean
  lastReceipt: ProviderReceipt | null
}>
export type StreamLease = Readonly<{
  id: string
  jobId: string
  principalId: string
  openedAt: number
  expiresAt: number
  state: 'open' | 'stop-requested' | 'closed'
}>
export type LedgerSnapshot = Readonly<{
  killed: boolean
  killedAt: number | null
  killReason: string | null
  policy: Policy
  global: AccountBalance
  experiments: readonly AccountBalance[]
  principals: readonly AccountBalance[]
  jobs: number
  interests: number
  activeExecutions: readonly ExecutionRecord[]
  quarantinedExecutions: readonly Readonly<{
    execution: ExecutionIdentity
    settledReceipt: ProviderReceipt | null
    contradictoryReceipt: ProviderReceipt
    outstandingLiabilityUnknown: true
  }>[]
  streams: readonly StreamLease[]
  objects: readonly ArtifactDescriptor[]
  storageBytes: number
  deliveredBytes: number
  reservedDeliveryBytes: number
}>
export type KillResult = Readonly<{
  killedAt: number
  executions: readonly ExecutionIdentity[]
  streams: readonly StreamLease[]
}>
export type RecoveryReport = Readonly<{
  fenced: number
  expired: number
  reconciliationRequired: number
}>
export type LedgerOptions = Readonly<{
  path: string
  policy?: Partial<Policy>
  now?: () => number
  receiptSecret: string
  objectSecret: string
}>
export interface Ledger {
  readonly policy: Policy
  admit(input: Admission): AdmissionResult
  getInterest(auth: AuthContext, interestId: string): InterestView
  cancelInterest(auth: AuthContext, interestId: string): InterestView
  claim(workerId: string): Lease | null
  heartbeat(lease: Lease): Lease | null
  beginExecution(lease: Lease): boolean
  beginPublishing(lease: Lease, staged: StagedObject): boolean
  publish(lease: Lease, object: VerifiedObject): boolean
  recordReceipt(receipt: ProviderReceipt): boolean
  fail(lease: Lease, failure: JobFailure, receipt?: ProviderReceipt): boolean
  reconcile(receipt: ProviderReceipt): boolean
  kill(reason: string): KillResult
  recover(): RecoveryReport
  snapshot(): LedgerSnapshot
  events(jobId?: string): readonly LifecycleEvent[]
  openStream(auth: AuthContext, interestId: string): StreamLease
  closeStream(streamId: string): boolean
  recordDelivery(auth: AuthContext, interestId: string, byteLength: number): ArtifactDescriptor
  retentionCandidates(): readonly JobRecord[]
  confirmObjectDeleted(jobId: string, objectKey: string): boolean
  close(): void
}

export type ObjectRecoveryReport = Readonly<{
  removedStages: number
  orphanObjects: readonly string[]
}>
export type ObjectStoreOptions = Readonly<{
  root: string
  objectSecret: string
  now?: () => number
}>
export interface ObjectStore {
  stage(lease: Lease, artifact: MockArtifact): Promise<StagedObject>
  publish(staged: StagedObject): Promise<VerifiedObject>
  verify(object: ArtifactDescriptor, design: DesignEnvelope): Promise<boolean>
  read(object: ArtifactDescriptor): Promise<Uint8Array>
  delete(object: ArtifactDescriptor): Promise<boolean>
  removeStage(stageId: string): Promise<boolean>
  recover(
    referencedObjectKeys: readonly string[],
    activeExecutionIds: readonly string[],
    before: number,
  ): Promise<ObjectRecoveryReport>
}

export type ProviderResult = Readonly<
  | { outcome: 'success'; artifact: MockArtifact; receipt: ProviderReceipt }
  | { outcome: 'failure'; failure: JobFailure; receipt: ProviderReceipt | null }
>
export type StopReason = 'kill' | 'deadline' | 'lease-expired' | 'orphan' | 'shutdown'
export type ProviderExecution = Readonly<{
  execution: ExecutionIdentity
  startedAt: number | null
  receipt: ProviderReceipt
}>
export type FakeProviderOptions = Readonly<{
  path: string
  contextSecret: string
  receiptSecret: string
  now?: () => number
}>
export interface FakeProvider {
  readonly provider: 'fake-local'
  readonly paidExecutionAllowed: false
  execute(context: SignedWorkerContext): Promise<ProviderResult>
  stop(execution: ExecutionIdentity, reason: StopReason): Promise<ProviderReceipt>
  inspect(): Promise<readonly ProviderExecution[]>
  receipt(execution: ExecutionIdentity): Promise<ProviderReceipt>
  close(): Promise<void>
}
export type WorkerOptions = Readonly<{
  ledger: Ledger
  objects: ObjectStore
  provider: FakeProvider
  workerId: string
  contextSecret: string
  now?: () => number
  providerCallTimeoutMs?: number
}>
export interface Worker {
  runOnce(): Promise<number>
  shutdown(): Promise<void>
}
export type WatchdogOptions = Readonly<{
  ledger: Ledger
  provider: FakeProvider
  objects?: ObjectStore
  now?: () => number
  providerCallTimeoutMs?: number
}>
export type WatchdogReport = Readonly<{
  killed: boolean
  stopRequested: number
  reconciled: number
  retainedLiabilities: number
  closedStreams: number
  orphanExecutions: number
  errors: readonly string[]
}>
export interface Watchdog {
  tick(): Promise<WatchdogReport>
  kill(reason: string): Promise<WatchdogReport>
}

export const statusReplySchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    mode: z.literal('mock-diagnostic'),
    productionAllowed: z.literal(false),
    paidExecutionAllowed: z.literal(false),
    interestId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    purpose: purposeSchema,
    requested: requestIdentitySchema,
    state: jobStateSchema,
    interestState: z.enum(['active', 'cancelled', 'expired']),
    reconciliationRequired: z.boolean(),
    cancellationScope: z.literal('interest-only').nullable(),
    sharedWorkCancelled: z.literal(false),
    artifact: artifactDescriptorSchema.nullable(),
    error: errorSchema.nullable(),
    retryAfterMs: z.number().int().min(100).max(30_000).nullable(),
  })
  .strict()
  .superRefine((reply, context) => {
    if (
      (reply.state === 'ready' && reply.interestState === 'active') !== (reply.artifact !== null) ||
      (reply.reconciliationRequired && ['ready', 'cancelled', 'expired'].includes(reply.state)) ||
      (reply.cancellationScope !== null) !== (reply.interestState === 'cancelled') ||
      (reply.artifact !== null &&
        (canonicalJson(reply.artifact.binding.identity) !== canonicalJson(reply.requested) ||
          reply.artifact.binding.purpose !== reply.purpose))
    )
      context.addIssue({
        code: 'custom',
        message: 'Status contradicts readiness, revision or uncertain execution.',
      })
  })
export type StatusReply = Readonly<z.infer<typeof statusReplySchema>>
export type SubmissionReply = Readonly<{ status: 200 | 202; body: StatusReply }>
export function parseSubmissionReply(status: number, input: unknown): SubmissionReply {
  const body = statusReplySchema.parse(input)
  if (
    body.interestState === 'active' &&
    !body.reconciliationRequired &&
    ((status === 200 && body.state === 'ready') ||
      (status === 202 &&
        ['requested', 'reserved', 'queued', 'leased', 'rendering', 'publishing'].includes(
          body.state,
        )))
  )
    return { status: status as 200 | 202, body }
  throw new ControlError(503, 'unavailable', 'Submission status contradicts durable job state.')
}
export type DeliveredArtifact = Readonly<{ object: ArtifactDescriptor; bytes: Uint8Array }>
export type ControlServiceOptions = Readonly<{
  ledger: Ledger
  objects: ObjectStore
  now?: () => number
}>
export interface ControlService {
  submitImage(auth: AuthContext, input: unknown): Promise<SubmissionReply>
  submitExport(auth: AuthContext, input: unknown): Promise<SubmissionReply>
  status(auth: AuthContext, interestId: string): Promise<StatusReply>
  cancel(auth: AuthContext, interestId: string): Promise<StatusReply>
  artifact(auth: AuthContext, interestId: string): Promise<DeliveredArtifact>
}
export type Authenticate = (
  request: IncomingMessage,
) => AuthContext | null | Promise<AuthContext | null>
export type ControlMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void
export type ControlHttpOptions = Readonly<{
  service: ControlService
  authenticate: Authenticate
  bodyTimeoutMs?: number
  maxConcurrentRequests?: number
}>
export function interestPath(interestId: string): string {
  return `${CONTROL_API_PREFIX}/interests/${opaqueIdSchema.parse(interestId)}`
}
export function artifactPath(interestId: string): string {
  return `${interestPath(interestId)}/artifact`
}

/** Fixture data only: neither function grants authentication, rights, art approval or real rendering. */
export function imageRequestFixture(
  design: unknown = defaultDesign(),
  idempotencyKey = 'fixture-image-key-0001',
): ImageRequest {
  return parseImageRequest({ protocol: CONTROL_PROTOCOL, design, idempotencyKey })
}
export function exportRequestFixture(
  design: unknown = defaultDesign(),
  idempotencyKey = 'fixture-export-key-0001',
): ExportRequest {
  return parseExportRequest({
    protocol: CONTROL_PROTOCOL,
    design,
    idempotencyKey,
    format: 'diagnostic-svg',
  })
}
