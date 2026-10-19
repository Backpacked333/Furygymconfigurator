import { ZodError } from 'zod'
import {
  CAPTURE_FLAGS,
  CAPTURE_LIMITS,
  CAPTURE_PROTOCOL,
  CaptureContractError,
  captureBuildSchema,
  validateCaptureJob,
  validateCaptureProgress,
  validateWorkerResult,
  type CaptureBuild,
  type CaptureJob,
  type CaptureProgress,
  type CaptureRuntime,
  type CaptureWorkerPage,
  type WorkerResult,
} from '../contract'

/** Private single-attempt lifetime. The runner must independently kill a blocked child. */
export class CaptureScope {
  readonly controller = new AbortController()
  readonly started = performance.now()
  readonly deadline = this.started + CAPTURE_LIMITS.jobMs
  private cancelled = false
  private timedOut = false
  private closed = false
  private cleanups: (() => void | Promise<void>)[] = []
  private closing: Promise<void> | undefined
  private timer = setTimeout(() => {
    this.timedOut = true
    this.controller.abort()
  }, CAPTURE_LIMITS.jobMs)

  get signal() {
    return this.controller.signal
  }
  get elapsedMs() {
    return Math.max(0, performance.now() - this.started)
  }
  check() {
    if (this.cancelled) throw new CaptureContractError('cancelled', 'Capture was cancelled.')
    if (this.timedOut || performance.now() >= this.deadline)
      throw new CaptureContractError('timeout', 'Private scene deadline elapsed.')
    if (this.closed) throw new CaptureContractError('cancelled', 'Capture scope is closed.')
  }
  cancel() {
    this.cancelled = true
    this.controller.abort()
  }
  own(cleanup: () => void | Promise<void>) {
    // Async construction can finish after cancellation; never leave its new resource alive.
    if (this.closed)
      void Promise.resolve()
        .then(cleanup)
        .catch(() => {})
    else this.cleanups.push(cleanup)
  }
  async wait<T>(pending: Promise<T>): Promise<T> {
    this.check()
    let abort!: () => void
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => {
        try {
          this.check()
        } catch (error) {
          reject(error)
        }
      }
      this.signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const value = await Promise.race([pending, interrupted])
      this.check()
      return value
    } finally {
      this.signal.removeEventListener('abort', abort)
    }
  }
  async pause(ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.wait(new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))))
    } finally {
      clearTimeout(timer)
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.controller.abort() // terminate native fetch/read operations as well as our promise waits
    clearTimeout(this.timer)
    const cleanups = this.cleanups.splice(0).reverse()
    this.closing = (async () => {
      let exhausted = false
      let failed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          exhausted = true
          resolve()
        }, CAPTURE_LIMITS.cleanupMs)
      })
      try {
        // Invoke every release, even after a throw or a hung cleanup. The outer runner still
        // owns process termination: a browser cannot interrupt synchronous GPU/native work.
        for (const cleanup of cleanups) {
          await Promise.race([
            Promise.resolve()
              .then(cleanup)
              .catch(() => {
                failed = true
              }),
            expired,
          ])
        }
      } finally {
        clearTimeout(timer)
      }
      if (exhausted) throw new CaptureContractError('timeout', 'Private cleanup deadline elapsed.')
      if (failed)
        throw new CaptureContractError('scene-failed', 'Private resource disposal failed.')
    })()
    return this.closing
  }
}

export type SceneCapture = Omit<
  Extract<WorkerResult, { state: 'captured' }>,
  'protocol' | 'state' | 'jobId' | 'captureDigest' | 'elapsedMs' | 'flags' | 'runtime'
> & { runtime: CaptureRuntime }
export type SceneDriver = (
  job: CaptureJob,
  scope: CaptureScope,
  progress: (
    phase: 'loading' | 'assembling' | 'warming' | 'settling' | 'encoding',
    frames: number,
  ) => void,
) => Promise<SceneCapture>

/** Fixed private diagnostic vocabulary only; never forward caught text, paths or URLs. */
export function workerFailureDiagnostic(error: unknown): string {
  const messages: Record<string, string> = {
    'Private scene/device failed.': 'scene-device-failed',
    'Private graphics API reported an error.': 'graphics-api-error',
    'Architecture did not mount.': 'architecture-not-mounted',
    'Authored exposure was not applied.': 'exposure-mismatch',
    'Private resource readiness failed.': 'resource-readiness-failed',
    'Private resource disposal failed.': 'resource-disposal-failed',
    'Private root unmount failed.': 'root-unmount-failed',
    'Private graphics device was lost.': 'device-lost',
    'Private shader compilation failed.': 'shader-compilation-failed',
    'Private React assembly failed.': 'react-assembly-failed',
    'Private timer callback failed.': 'timer-callback-failed',
    'Private site worker failed.': 'site-worker-failed',
    'Private site worker message failed.': 'site-worker-message-failed',
    'Private site field was invalid.': 'site-field-invalid',
  }
  if (error instanceof CaptureContractError && Object.hasOwn(messages, error.message))
    return messages[error.message]
  if (error instanceof TypeError) return 'javascript-type-error'
  if (error instanceof ReferenceError) return 'javascript-reference-error'
  return 'unclassified-scene-failure'
}

/** No renderer is imported/created before strict admission. One use, including failed admission. */
export function createCaptureWorker(buildInput: unknown, driver: SceneDriver): CaptureWorkerPage {
  const build: CaptureBuild = Object.freeze(captureBuildSchema.parse(buildInput))
  let used = false
  let disposed = false
  let scope: CaptureScope | undefined
  let latest: CaptureProgress | null = null
  return Object.freeze({
    async ready() {
      if (disposed) throw new CaptureContractError('cancelled', 'Worker was disposed.')
      return { protocol: CAPTURE_PROTOCOL, state: 'ready' as const, build, flags: CAPTURE_FLAGS }
    },
    async render(input: CaptureJob): Promise<WorkerResult> {
      if (disposed) throw new CaptureContractError('cancelled', 'Worker was disposed.')
      if (used) throw new CaptureContractError('limit-exceeded', 'One render per fresh page.')
      used = true
      scope = new CaptureScope()
      const active = scope
      let job: CaptureJob | undefined
      let result: WorkerResult
      try {
        try {
          job = await active.wait(validateCaptureJob(input, build))
        } catch (error) {
          if (error instanceof ZodError)
            throw new CaptureContractError('invalid-input', 'Strict capture admission failed.')
          throw error
        }
        const admitted = job
        const progress: Parameters<SceneDriver>[2] = (phase, renderedFrames) => {
          active.check()
          latest = validateCaptureProgress(
            {
              protocol: CAPTURE_PROTOCOL,
              jobId: admitted.jobId,
              captureDigest: admitted.identity.captureDigest,
              sequence: latest ? latest.sequence + 1 : 0,
              phase,
              elapsedMs: active.elapsedMs,
              renderedFrames,
            },
            admitted,
            latest ?? undefined,
          )
        }
        progress('loading', 0)
        const captured = await active.wait(driver(admitted, active, progress))
        active.check()
        result = validateWorkerResult(
          {
            ...captured,
            protocol: CAPTURE_PROTOCOL,
            state: 'captured',
            jobId: admitted.jobId,
            captureDigest: admitted.identity.captureDigest,
            elapsedMs: active.elapsedMs,
            flags: CAPTURE_FLAGS,
          },
          admitted,
        )
        active.check()
      } catch (error) {
        // There is no trustworthy binding to echo for malformed input: reject admission.
        if (!job) throw error
        console.error(`[fury-capture-failure:${workerFailureDiagnostic(error)}]`)
        const failure = error instanceof CaptureContractError ? error : null
        result = validateWorkerResult(
          {
            protocol: CAPTURE_PROTOCOL,
            state: 'failed',
            jobId: job.jobId,
            captureDigest: job.identity.captureDigest,
            code: failure?.code ?? 'scene-failed',
            // Never forward browser exception text, paths, URLs or environment values.
            message: failure ? `Private capture failed: ${failure.code}.` : 'Private scene failed.',
            elapsedMs: active.elapsedMs,
            flags: CAPTURE_FLAGS,
          },
          job,
        )
      } finally {
        await active.close().catch((error) => {
          console.error(`[fury-capture-failure:${workerFailureDiagnostic(error)}]`)
          throw error
        })
      }
      // dispose() may race the async unmount after the PNG was encoded. Never deliver that
      // now-cancelled success; runner additionally fences late child messages.
      if (disposed) throw new CaptureContractError('cancelled', 'Worker was disposed.')
      return result
    },
    progress: () => latest,
    async dispose() {
      disposed = true
      scope?.cancel()
      await scope?.close()
    },
  })
}

/** Readiness is based on observed work, not a loading percentage or eight arbitrary frames. */
export class SettleGate {
  private counts = { sky: 0, environment: 0, interior: 0, site: 0 }
  private lastChange = 0
  private postReady = 0
  private wasReady = false
  materials = false
  siteField = false
  constructor(private readonly quietMs: number) {}
  changed(now: number, textures = false) {
    this.lastChange = now
    this.postReady = 0
    this.wasReady = false
    if (textures) this.counts = { ...this.counts, environment: 0, interior: 0, site: 0 }
  }
  capture(kind: keyof SettleGate['counts'], now: number) {
    this.counts[kind]++
    this.changed(now)
  }
  private readyAt(now: number) {
    return (
      this.materials &&
      this.siteField &&
      this.counts.sky >= 1 &&
      this.counts.environment >= 2 &&
      this.counts.interior >= 4 &&
      this.counts.site >= 1 &&
      now - this.lastChange >= this.quietMs
    )
  }
  frame(now: number): boolean {
    const ready = this.readyAt(now)
    this.postReady = ready ? (this.wasReady ? this.postReady + 1 : 0) : 0
    this.wasReady = ready
    return this.settled(now)
  }
  settled(now: number) {
    // A non-frame check must not itself count as a rendered post-ready frame.
    return this.readyAt(now) && this.postReady >= 2
  }
}
