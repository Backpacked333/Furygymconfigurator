import { z } from 'zod'
import {
  designEnvelopeSchema,
  designReviewHolds,
  freezeDesignValue,
  parseDesign,
} from '../../../domain/design'
import { createSceneDesignFixtures } from '../../../domain/designFixtures'
import { designIdentity, sha256Text } from '../../../domain/designIdentity'
import { LOCAL_RENDER_SAMPLES } from '../../../domain/localRenderSlice'
import { resolvePrivateThreeCamera } from '../privateScene'

/** Private worker protocol only. Never import into the configurator or mock image service. */
export const CAPTURE_PROTOCOL = 'fury.local-three-capture@1' as const
export const CAPTURE_FLAGS = Object.freeze({
  productionAllowed: false,
  paidExecutionAllowed: false,
  strictReference: false,
  g1Qualified: false,
  visualParityClaimed: false,
} as const)
export const CAPTURE_LIMITS = Object.freeze({
  requestBytes: 20 * 1024,
  metadataBytes: 64 * 1024,
  pngBytes: 2 * 1024 * 1024,
  assetBytes: 16 * 1024 * 1024,
  totalAssetBytes: 128 * 1024 * 1024,
  resourceRequests: 512,
  progressEvents: 128,
  successfulSamples: 6,
  diagnosticRetries: 3,
  attempts: 8,
  concurrency: 1,
  startupMs: 30_000,
  jobMs: 180_000,
  cleanupMs: 5_000,
  runMs: 1_530_000,
} as const)

const flagsSchema = z
  .object({
    productionAllowed: z.literal(false),
    paidExecutionAllowed: z.literal(false),
    strictReference: z.literal(false),
    g1Qualified: z.literal(false),
    visualParityClaimed: z.literal(false),
  })
  .strict()
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const idSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
const noteSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (text) =>
      Array.from(text).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    'Control characters are not allowed.',
  )
const count = z.number().int().nonnegative()
const elapsed = z.number().finite().nonnegative().max(CAPTURE_LIMITS.jobMs)

const profileSettings = {
  version: 1,
  purpose: 'draft-local-integration-review',
  quality: 'lite',
  pipeline: 'three-tsl-raster-lite',
  pixelRatio: 1,
  msaaSamples: 4,
  minFrames: 8,
  maxFrames: 64,
  quietMs: 500,
  postReadyFrames: 2,
  format: 'image/png',
  colorSpace: 'srgb',
  toneMapping: 'AgX',
  maxPngBytes: CAPTURE_LIMITS.pngBytes,
  deadlineMs: CAPTURE_LIMITS.jobMs,
} as const
export const LOCAL_REVIEW_PROFILES = freezeDesignValue({
  wide: { ...profileSettings, id: 'local-review-wide@1', aspect: 'wide', width: 640, height: 400 },
  tall: { ...profileSettings, id: 'local-review-tall@1', aspect: 'tall', width: 400, height: 500 },
} as const)
const profileIdSchema = z.enum(['local-review-wide@1', 'local-review-tall@1'])
const profileShape = z
  .object({
    version: z.literal(1),
    purpose: z.literal('draft-local-integration-review'),
    quality: z.literal('lite'),
    pipeline: z.literal('three-tsl-raster-lite'),
    pixelRatio: z.literal(1),
    msaaSamples: z.literal(4),
    minFrames: z.literal(8),
    maxFrames: z.literal(64),
    quietMs: z.literal(500),
    postReadyFrames: z.literal(2),
    format: z.literal('image/png'),
    colorSpace: z.literal('srgb'),
    toneMapping: z.literal('AgX'),
    maxPngBytes: z.literal(CAPTURE_LIMITS.pngBytes),
    deadlineMs: z.literal(CAPTURE_LIMITS.jobMs),
  })
  .strict()
export const captureProfileSchema = z.discriminatedUnion('aspect', [
  profileShape.extend({
    id: z.literal('local-review-wide@1'),
    aspect: z.literal('wide'),
    width: z.literal(640),
    height: z.literal(400),
  }),
  profileShape.extend({
    id: z.literal('local-review-tall@1'),
    aspect: z.literal('tall'),
    width: z.literal(400),
    height: z.literal(500),
  }),
])
export type CaptureProfile = z.infer<typeof captureProfileSchema>

export const captureRequestSchema = z
  .object({
    protocol: z.literal(CAPTURE_PROTOCOL),
    design: designEnvelopeSchema,
    profileId: profileIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profileId !== LOCAL_REVIEW_PROFILES[value.design.presentation.aspect].id)
      context.addIssue({ code: 'custom', message: 'Profile and selected aspect must agree.' })
  })
export type CaptureRequest = ReturnType<typeof parseCaptureRequest>
export function parseCaptureRequest(input: unknown) {
  return freezeDesignValue(captureRequestSchema.parse(input))
}
export function parseCaptureRequestText(text: string): CaptureRequest {
  if (new TextEncoder().encode(text).byteLength > CAPTURE_LIMITS.requestBytes)
    throw new CaptureContractError('invalid-input', 'Request exceeds byte cap.')
  return parseCaptureRequest(JSON.parse(text))
}

/** Hashes of runner-owned manifests/compiled closure; never caller paths or fetch instructions. */
export const captureBuildSchema = z
  .object({
    sourceManifestDigest: digestSchema,
    assetManifestDigest: digestSchema,
    bundleDigest: digestSchema,
    lockfileDigest: digestSchema,
    threeRevision: z.string().regex(/^\d{1,4}$/),
  })
  .strict()
export type CaptureBuild = Readonly<z.infer<typeof captureBuildSchema>>
const identitySchema = z
  .object({
    designDigest: digestSchema,
    presentationDigest: digestSchema,
    requestDigest: digestSchema,
    captureDigest: digestSchema,
  })
  .strict()

export const SAMPLE_IDS = [
  'studio-20-front-left-wide',
  'studio-40-entry-tall',
  'container-20-front-left-wide',
  'container-40-front-left-tall',
  'studio-40-night-centre-wide',
  'container-40-roof-top-wide',
  'studio-20-bronze-front-left-wide',
] as const
export const captureSampleIdSchema = z.enum(SAMPLE_IDS)
export type CaptureSampleId = z.infer<typeof captureSampleIdSchema>

/** Prior six unchanged plus one finish comparison; the SAME six-success/eight-attempt caps apply. */
export function createCaptureSamples() {
  const candidates = createSceneDesignFixtures()
  const selections = [
    { cameraRef: 'front-left-draft@1', aspect: 'wide' },
    { cameraRef: 'entry-draft@1', aspect: 'tall' },
    { cameraRef: 'front-left-draft@1', aspect: 'wide' },
    { cameraRef: 'front-left-draft@1', aspect: 'tall' },
    { cameraRef: 'centre-draft@1', aspect: 'wide' },
    { cameraRef: 'top-draft@1', aspect: 'wide', lookRef: 'courtyard-day-draft@1' },
  ] as const
  const reviewSamples = candidates.map(({ design }, index) => {
    // Same difficult-interior selection as the CPU fixtures, without importing that Node graph.
    const config =
      index === 4
        ? { ...design.config, structure: { ...design.config.structure, addons: [] } }
        : design.config
    const selected = parseDesign({
      ...design,
      config,
      presentation: { ...design.presentation, ...selections[index] },
    })
    return {
      id: SAMPLE_IDS[index],
      role:
        index < 4
          ? 'family-size-baseline'
          : index === 4
            ? 'difficult-interior'
            : 'structural-stress',
      request: parseCaptureRequest({
        protocol: CAPTURE_PROTOCOL,
        design: selected,
        profileId: LOCAL_REVIEW_PROFILES[selected.presentation.aspect].id,
      }),
    }
  })
  // Obsidian already is the first review sample. Reuse its ID; never add a rerender-budget alias.
  const bronze = LOCAL_RENDER_SAMPLES[1]
  return freezeDesignValue([
    ...reviewSamples,
    {
      id: bronze.id,
      role: 'local-finish-comparison',
      request: parseCaptureRequest({
        protocol: CAPTURE_PROTOCOL,
        design: bronze.design,
        profileId: LOCAL_REVIEW_PROFILES.wide.id,
      }),
    },
  ])
}

/** Canonical protocol metadata only; product equality is delegated to designIdentity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
export async function captureIdentity(input: unknown, buildInput: unknown) {
  const request = parseCaptureRequest(input)
  const build = captureBuildSchema.parse(buildInput)
  const logical = await designIdentity(request.design)
  const profile = LOCAL_REVIEW_PROFILES[request.design.presentation.aspect]
  return Object.freeze({
    ...logical,
    captureDigest: await sha256Text(
      canonical({
        protocol: CAPTURE_PROTOCOL,
        logical,
        selected: request.design.presentation,
        camera: resolveCaptureCamera(request.design),
        profile,
        build,
      }),
    ),
  })
}

/** Shape checks alone are insufficient: use validateCaptureJob at both ends of the page bridge. */
export const captureJobSchema = z
  .object({
    protocol: z.literal(CAPTURE_PROTOCOL),
    jobId: idSchema,
    sampleId: captureSampleIdSchema,
    request: captureRequestSchema,
    profile: captureProfileSchema,
    build: captureBuildSchema,
    identity: identitySchema,
    flags: flagsSchema,
  })
  .strict()
export type CaptureJob = ReturnType<typeof freezeJob>
function freezeJob(input: z.infer<typeof captureJobSchema>) {
  return freezeDesignValue(input)
}
export async function createCaptureJob(
  jobId: string,
  sampleId: CaptureSampleId,
  input: unknown,
  buildInput: unknown,
): Promise<CaptureJob> {
  const request = parseCaptureRequest(input)
  const build = captureBuildSchema.parse(buildInput)
  return validateCaptureJob({
    protocol: CAPTURE_PROTOCOL,
    jobId,
    sampleId,
    request,
    build,
    profile: LOCAL_REVIEW_PROFILES[request.design.presentation.aspect],
    identity: await captureIdentity(request, build),
    flags: CAPTURE_FLAGS,
  })
}
export async function validateCaptureJob(
  input: unknown,
  expectedBuild?: CaptureBuild,
): Promise<CaptureJob> {
  const job = captureJobSchema.parse(input)
  const sample = createCaptureSamples().find((entry) => entry.id === job.sampleId)!
  if (canonical(job.request) !== canonical(sample.request))
    throw new CaptureContractError(
      'invalid-input',
      'Only the pinned review and local finish-comparison compositions are admitted.',
    )
  if (
    canonical(job.profile) !==
    canonical(LOCAL_REVIEW_PROFILES[job.request.design.presentation.aspect])
  )
    throw new CaptureContractError(
      'identity-mismatch',
      'Output profile does not match the request.',
    )
  if (expectedBuild && canonical(job.build) !== canonical(captureBuildSchema.parse(expectedBuild)))
    throw new CaptureContractError('identity-mismatch', 'Page and runner build differ.')
  if (canonical(job.identity) !== canonical(await captureIdentity(job.request, job.build)))
    throw new CaptureContractError('identity-mismatch', 'Recomputed capture identity differs.')
  return freezeJob(job)
}

export const CAPTURE_FAILURE_CODES = [
  'invalid-input',
  'identity-mismatch',
  'unsupported-renderer',
  'asset-failed',
  'network-denied',
  'scene-failed',
  'bad-pixels',
  'invalid-artifact',
  'cancelled',
  'timeout',
  'limit-exceeded',
  'publication-failed',
] as const
export type CaptureFailureCode = (typeof CAPTURE_FAILURE_CODES)[number]
export class CaptureContractError extends Error {
  constructor(
    readonly code: CaptureFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'CaptureContractError'
  }
}
/** Call before work, after every await, before/after byte validation and just before publication. */
export function assertCaptureActive(signal: AbortSignal, nowMs: number, deadlineMs: number): void {
  if (signal.aborted) throw new CaptureContractError('cancelled', 'Capture was cancelled.')
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs) || nowMs >= deadlineMs)
    throw new CaptureContractError('timeout', 'Capture deadline elapsed.')
}

export const CAPTURE_PHASES = [
  'loading',
  'assembling',
  'warming',
  'settling',
  'encoding',
  'validating',
  'publishing',
] as const
export const captureProgressSchema = z
  .object({
    protocol: z.literal(CAPTURE_PROTOCOL),
    jobId: idSchema,
    captureDigest: digestSchema,
    sequence: count.max(CAPTURE_LIMITS.progressEvents - 1),
    phase: z.enum(CAPTURE_PHASES),
    elapsedMs: elapsed,
    renderedFrames: count.max(64),
  })
  .strict()
export type CaptureProgress = Readonly<z.infer<typeof captureProgressSchema>>
export function validateCaptureProgress(
  input: unknown,
  job: CaptureJob,
  previous?: CaptureProgress,
): CaptureProgress {
  const progress = captureProgressSchema.parse(input)
  if (progress.jobId !== job.jobId || progress.captureDigest !== job.identity.captureDigest)
    throw new CaptureContractError('identity-mismatch', 'Progress belongs to another job.')
  if (
    previous &&
    (progress.sequence <= previous.sequence ||
      progress.elapsedMs < previous.elapsedMs ||
      progress.renderedFrames < previous.renderedFrames ||
      CAPTURE_PHASES.indexOf(progress.phase) < CAPTURE_PHASES.indexOf(previous.phase))
  )
    throw new CaptureContractError('invalid-input', 'Progress must be monotonic.')
  return Object.freeze(progress)
}

export const CAPTURE_EFFECTS = [
  'architecture',
  'fixed-equipment',
  'material-textures',
  'console-canvas',
  'signature-canvas',
  'environment',
  'fixture-lighting',
  'interior-probe',
  'site-probe',
  'site-light-field',
  'thin-glass',
  'mirror',
  'msaa',
  'ambient-occlusion',
  'screen-space-gi',
  'screen-space-reflections',
  'bloom',
  'path-tracing',
] as const
const omittedInLite = [
  'ambient-occlusion',
  'screen-space-gi',
  'screen-space-reflections',
  'bloom',
  'path-tracing',
] as const
export const captureRuntimeSchema = z
  .object({
    backend: z.enum(['webgpu', 'webgl2']),
    acceleration: z.enum(['software', 'hardware', 'unknown']),
    adapter: noteSchema,
    browserVersion: noteSchema,
    userAgent: noteSchema,
    effects: z
      .array(
        z
          .object({
            id: z.enum(CAPTURE_EFFECTS),
            state: z.enum(['enabled', 'approximate', 'omitted', 'not-applicable']),
            detail: noteSchema,
          })
          .strict(),
      )
      .length(CAPTURE_EFFECTS.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.effects.map((effect) => effect.id)).size !== CAPTURE_EFFECTS.length)
      context.addIssue({ code: 'custom', message: 'Report every effect exactly once.' })
    for (const id of omittedInLite)
      if (value.effects.find((effect) => effect.id === id)?.state !== 'omitted')
        context.addIssue({ code: 'custom', message: `${id} is not in the fixed lite profile.` })
    if (value.effects.find((effect) => effect.id === 'mirror')?.state === 'enabled')
      context.addIssue({
        code: 'custom',
        message: 'Lite mirror is probe-lit metal, not planar reflection.',
      })
  })
export type CaptureRuntime = ReturnType<typeof parseCaptureRuntime>
export function parseCaptureRuntime(input: unknown) {
  return freezeDesignValue(captureRuntimeSchema.parse(input))
}

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
export const captureCameraSchema = z
  .object({
    position: vec3,
    target: vec3,
    up: z.tuple([z.literal(0), z.literal(1), z.literal(0)]),
    fov: z.number().positive().max(120),
    near: z.literal(0.1),
    far: z.literal(2000),
    units: z.literal('feet'),
  })
  .strict()
export type CaptureCamera = z.infer<typeof captureCameraSchema>
export function resolveCaptureCamera(input: unknown): CaptureCamera {
  return captureCameraSchema.parse(resolvePrivateThreeCamera(input))
}

const resultBinding = {
  protocol: z.literal(CAPTURE_PROTOCOL),
  jobId: idSchema,
  captureDigest: digestSchema,
}
export const captureFailureSchema = z
  .object({
    ...resultBinding,
    state: z.literal('failed'),
    code: z.enum(CAPTURE_FAILURE_CODES),
    message: noteSchema,
    elapsedMs: z
      .number()
      .finite()
      .nonnegative()
      .max(CAPTURE_LIMITS.runMs + CAPTURE_LIMITS.cleanupMs),
    flags: flagsSchema,
  })
  .strict()
const capturedSchema = z
  .object({
    ...resultBinding,
    state: z.literal('captured'),
    pngBase64: z
      .string()
      .min(44)
      .max(4 * Math.ceil(CAPTURE_LIMITS.pngBytes / 3))
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    camera: captureCameraSchema,
    runtime: captureRuntimeSchema,
    renderedFrames: count.min(8).max(64),
    elapsedMs: elapsed,
    flags: flagsSchema,
  })
  .strict()
export const workerResultSchema = z.discriminatedUnion('state', [
  capturedSchema,
  captureFailureSchema,
])
export type WorkerResult = z.infer<typeof workerResultSchema>
export const workerReadySchema = z
  .object({
    protocol: z.literal(CAPTURE_PROTOCOL),
    state: z.literal('ready'),
    build: captureBuildSchema,
    flags: flagsSchema,
  })
  .strict()
export type WorkerReady = z.infer<typeof workerReadySchema>
export function validateWorkerReady(input: unknown, expectedBuild: CaptureBuild): WorkerReady {
  const ready = workerReadySchema.parse(input)
  if (canonical(ready.build) !== canonical(captureBuildSchema.parse(expectedBuild)))
    throw new CaptureContractError('identity-mismatch', 'Unexpected worker build.')
  return ready
}
export function validateWorkerResult(input: unknown, job: CaptureJob): WorkerResult {
  const result = workerResultSchema.parse(input)
  if (result.jobId !== job.jobId || result.captureDigest !== job.identity.captureDigest)
    throw new CaptureContractError('identity-mismatch', 'Worker result belongs to another job.')
  if (
    result.state === 'captured' &&
    canonical(result.camera) !== canonical(resolveCaptureCamera(job.request.design))
  )
    throw new CaptureContractError(
      'identity-mismatch',
      'Worker camera differs from the bound gallery camera.',
    )
  return result
}
/** One render per fresh page. ready is protocol readiness, NOT a graphics capability assertion. */
export interface CaptureWorkerPage {
  ready(): Promise<WorkerReady>
  render(job: CaptureJob): Promise<WorkerResult>
  progress(): CaptureProgress | null
  dispose(): Promise<void>
}
export const WORKER_GLOBAL = '__FURY_LOCAL_CAPTURE__' as const

export const pixelEvidenceSchema = z
  .object({
    width: count.positive().max(640),
    height: count.positive().max(500),
    rgbaBytes: count.positive().max(640 * 500 * 4),
    opaquePixels: count.positive().max(640 * 500),
    distinctRgbAtLeast: count.min(16).max(256),
    channelRange: count.min(8).max(255),
    lumaVariance: z.number().finite().min(1).max(65_025),
  })
  .strict()
export type PixelEvidence = Readonly<z.infer<typeof pixelEvidenceSchema>>
/** Decoded RGBA8 only. These gross corruption checks are not an aesthetic/subject/parity test. */
export function inspectDecodedPixels(
  profileInput: unknown,
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
): PixelEvidence {
  const profile = captureProfileSchema.parse(profileInput)
  if (
    width !== profile.width ||
    height !== profile.height ||
    rgba.byteLength !== width * height * 4
  )
    throw new CaptureContractError('invalid-artifact', 'Decoded size/profile mismatch.')
  let opaquePixels = 0,
    low = 255,
    high = 0,
    sum = 0,
    square = 0
  const colors = new Set<number>()
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i],
      g = rgba[i + 1],
      b = rgba[i + 2]
    if (rgba[i + 3] === 255) opaquePixels++
    low = Math.min(low, r, g, b)
    high = Math.max(high, r, g, b)
    if (colors.size < 256) colors.add((r << 16) | (g << 8) | b)
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    sum += luma
    square += luma * luma
  }
  const pixels = width * height
  const lumaVariance = Math.max(0, square / pixels - (sum / pixels) ** 2)
  if (opaquePixels !== pixels || colors.size < 16 || high - low < 8 || lumaVariance < 1)
    throw new CaptureContractError(
      'bad-pixels',
      'Transparent, uniform or near-empty decoded image.',
    )
  return Object.freeze(
    pixelEvidenceSchema.parse({
      width,
      height,
      rgbaBytes: rgba.byteLength,
      opaquePixels,
      distinctRgbAtLeast: colors.size,
      channelRange: high - low,
      lumaVariance,
    }),
  )
}
export const captureArtifactSchema = z
  .object({
    filename: z.literal('image.png'),
    mediaType: z.literal('image/png'),
    bytes: count.min(44).max(CAPTURE_LIMITS.pngBytes),
    digest: digestSchema,
    pixels: pixelEvidenceSchema,
  })
  .strict()
export type CaptureArtifact = z.infer<typeof captureArtifactSchema>
/** Runner supplies independently decoded pixels from these exact PNG bytes, never page statistics. */
export async function validateDecodedArtifact(
  profile: CaptureProfile,
  bytes: Uint8Array,
  decoded: { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray },
): Promise<CaptureArtifact> {
  if (
    bytes.byteLength < 44 ||
    bytes.byteLength > CAPTURE_LIMITS.pngBytes ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    throw new CaptureContractError(
      'invalid-artifact',
      'Expected bounded PNG bytes; no stub/fallback accepted.',
    )
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452 ||
    header.getUint32(16) !== decoded.width ||
    header.getUint32(20) !== decoded.height
  )
    throw new CaptureContractError('invalid-artifact', 'PNG header and decoded dimensions differ.')
  const pixels = inspectDecodedPixels(profile, decoded.width, decoded.height, decoded.rgba)
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  const digest = `sha256:${Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('')}`
  return captureArtifactSchema.parse({
    filename: 'image.png',
    mediaType: 'image/png',
    bytes: bytes.byteLength,
    digest,
    pixels,
  })
}

export const captureReceiptSchema = z
  .object({
    protocol: z.literal(CAPTURE_PROTOCOL),
    state: z.literal('validated-draft-capture'),
    job: captureJobSchema,
    artifact: captureArtifactSchema,
    camera: captureCameraSchema,
    runtime: captureRuntimeSchema,
    renderedFrames: count.min(8).max(64),
    elapsedMs: elapsed,
    holds: z.array(noteSchema).min(1).max(32),
    flags: flagsSchema,
  })
  .strict()
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>
/** Rechecks binding, camera and profile; actual decoded bytes remain the runner's responsibility. */
export async function validateCaptureReceipt(input: unknown, expectedJob: CaptureJob) {
  const receipt = captureReceiptSchema.parse(input)
  const job = await validateCaptureJob(receipt.job, expectedJob.build)
  if (canonical(job) !== canonical(expectedJob))
    throw new CaptureContractError('identity-mismatch', 'Receipt belongs to another job.')
  if (canonical(receipt.camera) !== canonical(resolveCaptureCamera(job.request.design)))
    throw new CaptureContractError(
      'identity-mismatch',
      'Receipt camera differs from the bound gallery camera.',
    )
  const pixels = receipt.artifact.pixels
  if (
    pixels.width !== job.profile.width ||
    pixels.height !== job.profile.height ||
    pixels.rgbaBytes !== pixels.width * pixels.height * 4 ||
    pixels.opaquePixels !== pixels.width * pixels.height
  )
    throw new CaptureContractError('invalid-artifact', 'Receipt decoded size/profile mismatch.')
  if (canonical(receipt.holds) !== canonical(designReviewHolds(job.request.design)))
    throw new CaptureContractError('invalid-input', 'Keep all domain review holds verbatim.')
  for (const id of [
    'architecture',
    'fixed-equipment',
    'material-textures',
    'environment',
    'fixture-lighting',
    'interior-probe',
    'site-probe',
    'msaa',
  ])
    if (receipt.runtime.effects.find((effect) => effect.id === id)?.state !== 'enabled')
      throw new CaptureContractError('scene-failed', `Required scene capability missing: ${id}.`)
  return freezeDesignValue(receipt)
}

/** Written exclusively LAST after bytes + receipt readback; no marker on any failure. */
export const captureCompleteSchema = z
  .object({
    protocol: z.literal(CAPTURE_PROTOCOL),
    state: z.literal('complete-draft-capture'),
    jobId: idSchema,
    captureDigest: digestSchema,
    image: captureArtifactSchema,
    receipt: z
      .object({
        filename: z.literal('receipt.json'),
        bytes: count.positive().max(CAPTURE_LIMITS.metadataBytes),
        digest: digestSchema,
      })
      .strict(),
    flags: flagsSchema,
  })
  .strict()
export type CaptureComplete = z.infer<typeof captureCompleteSchema>
export const captureTerminalSchema = z.discriminatedUnion('state', [
  captureFailureSchema,
  z
    .object({
      ...resultBinding,
      state: z.literal('complete'),
      marker: captureCompleteSchema,
      flags: flagsSchema,
    })
    .strict(),
])
export type CaptureTerminal = z.infer<typeof captureTerminalSchema>
export function validateCaptureTerminal(input: unknown, job: CaptureJob): CaptureTerminal {
  const terminal = captureTerminalSchema.parse(input)
  if (
    terminal.jobId !== job.jobId ||
    terminal.captureDigest !== job.identity.captureDigest ||
    (terminal.state === 'complete' &&
      (terminal.marker.jobId !== job.jobId ||
        terminal.marker.captureDigest !== job.identity.captureDigest ||
        terminal.marker.image.pixels.width !== job.profile.width ||
        terminal.marker.image.pixels.height !== job.profile.height))
  )
    throw new CaptureContractError(
      'identity-mismatch',
      'Terminal/marker belongs to another job/profile.',
    )
  return terminal
}

export const captureAttemptSchema = z
  .object({
    jobId: idSchema,
    sampleId: captureSampleIdSchema,
    kind: z.enum(['sample', 'diagnostic-retry']),
    state: z.enum(['running', 'failed', 'cancelled', 'timed-out', 'succeeded']),
  })
  .strict()
export type CaptureAttempt = Readonly<z.infer<typeof captureAttemptSchema>>
/** Runner retains one append-only run history; no budget reset by changing directories. */
export function assertCanStartAttempt(
  historyInput: unknown,
  sampleId: CaptureSampleId,
  kind: CaptureAttempt['kind'],
): void {
  const history = z.array(captureAttemptSchema).max(CAPTURE_LIMITS.attempts).parse(historyInput)
  captureSampleIdSchema.parse(sampleId)
  captureAttemptSchema.shape.kind.parse(kind)
  const seen = new Set<string>()
  const initial = new Set<string>()
  const successful = new Set<string>()
  let retries = 0
  for (const attempt of history) {
    if (
      seen.has(attempt.jobId) ||
      successful.has(attempt.sampleId) ||
      (attempt.kind === 'sample' ? initial.has(attempt.sampleId) : !initial.has(attempt.sampleId))
    )
      throw new CaptureContractError('invalid-input', 'Invalid attempt accounting history.')
    seen.add(attempt.jobId)
    if (attempt.kind === 'sample') initial.add(attempt.sampleId)
    else retries++
    if (attempt.state === 'succeeded') successful.add(attempt.sampleId)
  }
  if (
    history.some((entry) => entry.state === 'running') ||
    history.length >= CAPTURE_LIMITS.attempts ||
    successful.size >= CAPTURE_LIMITS.successfulSamples ||
    successful.has(sampleId) ||
    retries > CAPTURE_LIMITS.diagnosticRetries ||
    (kind === 'sample'
      ? initial.has(sampleId)
      : !initial.has(sampleId) || retries >= CAPTURE_LIMITS.diagnosticRetries)
  )
    throw new CaptureContractError(
      'limit-exceeded',
      `One owned attempt at a time; ${CAPTURE_LIMITS.successfulSamples} successes and ${CAPTURE_LIMITS.diagnosticRetries} diagnostic retries maximum.`,
    )
}
