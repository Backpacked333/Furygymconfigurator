import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  DISPLAY_LIMITS,
  displayBuildSchema,
  stableDisplayJson,
  type DisplayBuild,
} from '../../display/contract'
import {
  displayReceiptSchema,
  localDisplayPermitSchema,
  parseDisplayReceipt,
  validateDisplayJob,
  type DisplayJob,
  type DisplayReceipt,
  type PrivateDisplayBackend,
  type PrivateDisplaySession,
} from '../../display/session'
import { decodeBoundedPng } from '../prototype/capture/artifacts'
import { prepareDisplayBuild, sha, type PreparedDisplay } from './build'
import { displayCameraDigest } from './input'
import { checkOperatorPermit, ownDisplayRun, type DisplayRunJournal } from './permit'
import { startDisplayHost } from './host'
import {
  DisplayTeardownUncertain,
  openDisplayProcess,
  validateHostHardware,
  validateObservedBrowserVersion,
  type OwnedDisplayProcess,
} from './process'

export interface DisplayDriver {
  render(job: DisplayJob): Promise<unknown>
  phase(phase: 'job' | 'idle'): void
  close(): Promise<void>
}
const resultSchema = z
  .object({
    receipt: displayReceiptSchema,
    base64: z
      .string()
      .min(1)
      .max(4 * Math.ceil(DISPLAY_LIMITS.pngBytes / 3))
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()

/** Host independently decodes exact bytes; neither page booleans nor PNG headers suffice. */
export async function verifyDisplayResult(
  input: unknown,
  job: DisplayJob,
  runtime: DisplayReceipt['runtime'],
) {
  const value = resultSchema.parse(input),
    receipt = parseDisplayReceipt(value.receipt, job)
  if (
    stableDisplayJson(receipt.runtime) !== stableDisplayJson(runtime) ||
    receipt.cameraDigest !== (await displayCameraDigest(job.design))
  )
    throw new Error('Observed runtime/camera mismatch.')
  const png = Buffer.from(value.base64, 'base64')
  if (
    png.length !== receipt.byteLength ||
    sha(png) !== receipt.checksum ||
    png.toString('base64') !== value.base64
  )
    throw new Error('Display PNG identity mismatch.')
  const decoded = decodeBoundedPng(png, {
    width: receipt.width,
    height: receipt.height,
    maxBytes: DISPLAY_LIMITS.pngBytes,
    maxPixels: 1_800_000,
  })
  // Reject empty/transparent output without inventing an aesthetic quality judgement.
  let varied = false
  for (let i = 0; i < decoded.rgba.length; i += 4) {
    if (decoded.rgba[i + 3] !== 255) throw new Error('Display output not opaque.')
    if (
      decoded.rgba[i] !== decoded.rgba[0] ||
      decoded.rgba[i + 1] !== decoded.rgba[1] ||
      decoded.rgba[i + 2] !== decoded.rgba[2]
    )
      varied = true
  }
  if (!varied) throw new Error('Uniform display output rejected.')
  return { receipt, png }
}

/** Pure orchestration seam takes a real driver in production; test doubles live only in tests. */
export class SupervisedDisplaySession implements PrivateDisplaySession {
  private busy = false
  private lastRevision = 0
  private failure: Error | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private idle: ReturnType<typeof setTimeout> | undefined
  private readonly lifetime: ReturnType<typeof setTimeout>
  private abortCurrent: (() => void) | undefined
  constructor(
    readonly sessionId: string,
    readonly build: DisplayBuild,
    private readonly driver: DisplayDriver,
    private readonly journal: DisplayRunJournal,
    private readonly revalidate: () => Promise<void>,
    private readonly runtime: DisplayReceipt['runtime'],
  ) {
    this.lifetime = setTimeout(
      () => this.poison(new Error('Display total lifetime elapsed.')),
      Math.max(
        1,
        Math.min(
          DISPLAY_LIMITS.lifetimeMs - (Date.now() - journal.started),
          journal.permit.expiresAt - Date.now(),
        ),
      ),
    )
    this.lifetime.unref()
    this.armIdle()
  }
  private armIdle() {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      void this.close('idle').catch(() => {})
    }, DISPLAY_LIMITS.idleMs)
    this.idle.unref()
  }
  poison(error: Error) {
    this.failure ??= error
    this.abortCurrent?.()
    void this.close('poisoned').catch(() => {})
  }
  private check(signal: AbortSignal) {
    if (
      signal.aborted ||
      this.failure ||
      this.closed ||
      Date.now() >= this.journal.permit.expiresAt ||
      Date.now() - this.journal.started >= DISPLAY_LIMITS.lifetimeMs
    )
      throw this.failure ?? new Error('Display session closed/cancelled/expired.')
  }
  async render(input: DisplayJob, signal: AbortSignal) {
    this.check(signal)
    if (this.busy) throw new Error('Single-flight scene mutation required.')
    this.busy = true
    clearTimeout(this.idle)
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort: ((e: Error) => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const abort = () => rejectAbort?.(new Error('Display job cancelled/poisoned.'))
    this.abortCurrent = abort
    signal.addEventListener('abort', abort, { once: true })
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Display job deadline.')), DISPLAY_LIMITS.jobMs)
    })
    // Every continuation is fenced; Promise.race cannot let a late completion mutate a closed session.
    const step = async <T>(promise: Promise<T>) => {
      const value = await Promise.race([promise, cancelled, deadline])
      this.check(signal)
      return value
    }
    try {
      const job = await step(validateDisplayJob(input, this.build))
      if (job.sessionId !== this.sessionId || job.revision !== this.lastRevision + 1)
        throw new Error('Stale private session/revision.')
      await step(this.revalidate())
      await step(this.journal.attempt()) // failures consume durable attempts before mutation
      this.lastRevision = job.revision
      this.driver.phase('job')
      const result = await step(this.driver.render(job))
      const verified = await step(verifyDisplayResult(result, job, this.runtime))
      await step(this.revalidate())
      await step(checkOperatorPermit(this.journal.permit))
      await step(this.journal.output(verified.png.length))
      this.check(signal)
      this.driver.phase('idle')
      this.armIdle()
      return verified
    } catch (error) {
      this.failure ??= error instanceof Error ? error : new Error('Private render failed.')
      await this.close(signal.aborted ? 'cancelled' : 'poisoned')
      throw this.failure
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.abortCurrent = undefined
      this.busy = false
    }
  }
  close(reason: 'idle' | 'limit' | 'cancelled' | 'poisoned' | 'shutdown') {
    void reason // All reasons require the same observed owned-group teardown, never financial settlement.
    if (this.closing) return this.closing
    this.closed = true
    clearTimeout(this.idle)
    clearTimeout(this.lifetime)
    this.abortCurrent?.()
    this.closing = (async () => {
      try {
        await this.driver.close()
      } catch (error) {
        await this.journal.finish(false)
        throw error
      }
      await this.journal.finish(true)
    })()
    return this.closing
  }
}

/** Source-root-pinned production factory. No renderer at module load or prepare; no options
 * accepting test pixels, provider URLs, browser commands, production or paid flags. */
export function createPrivateDisplayBackend(): PrivateDisplayBackend {
  let prepared: Promise<PreparedDisplay> | undefined, session: SupervisedDisplaySession | undefined
  let opening = false,
    closed = false,
    used = false
  let openingDone: Promise<void> | undefined,
    startupAbort: AbortController | undefined,
    ownershipFailure: Error | undefined
  const current = () => {
    if (closed) throw new Error('Private display backend closed.')
    return (prepared ??= prepareDisplayBuild())
  }
  const revalidate = async (build: DisplayBuild) => {
    const value = await current()
    if (stableDisplayJson(displayBuildSchema.parse(build)) !== stableDisplayJson(value.build))
      throw new Error('Prepared display identity mismatch.')
    await value.revalidate()
  }
  return {
    prepare: async () => (await current()).build,
    revalidate,
    async open(input) {
      if (opening || session || used || closed)
        throw new Error('Only one owned local display run is allowed.')
      opening = true
      startupAbort = new AbortController()
      const cancellation = startupAbort
      let resolveOpening: (() => void) | undefined
      openingDone = new Promise<void>((resolve) => {
        resolveOpening = resolve
      })
      let process: OwnedDisplayProcess | undefined,
        host: Awaited<ReturnType<typeof startDisplayHost>> | undefined
      let journal: DisplayRunJournal | undefined, startupFailure: Error | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // File provisioning check before compilation, journals, sockets or process launch.
        const permit = await checkOperatorPermit(localDisplayPermitSchema.parse(input))
        const value = await current()
        await value.revalidate()
        if (closed) throw new Error('Backend closed during admission.')
        const sessionId = randomBytes(24).toString('base64url')
        journal = await ownDisplayRun(permit, sessionId)
        used = true
        const fatal = (error: Error) => {
          startupFailure ??= error
          cancellation.abort()
          session?.poison(error)
        }
        const resources = new Map(value.resources)
        resources.set('/bootstrap.json', {
          bytes: Buffer.from(JSON.stringify({ build: value.build, sessionId })),
          mediaType: 'application/json',
        })
        timer = setTimeout(
          () => fatal(new Error('Display startup deadline.')),
          DISPLAY_LIMITS.startupMs,
        )
        const startup = async () => {
          if (closed || cancellation.signal.aborted) throw new Error('Startup cancelled.')
          host = await startDisplayHost(resources, fatal)
          if (startupFailure || closed) throw startupFailure ?? new Error('Startup cancelled.')
          process = await openDisplayProcess(
            host,
            Math.max(
              1,
              Math.min(
                DISPLAY_LIMITS.lifetimeMs - (Date.now() - journal!.started),
                permit.expiresAt - Date.now(),
              ),
            ),
            fatal,
            cancellation.signal,
          )
          if (startupFailure || closed) {
            await process.close()
            throw startupFailure ?? new Error('Startup cancelled.')
          }
          const ready = z
            .object({
              build: displayBuildSchema,
              sessionId: z.literal(sessionId),
              runtime: displayReceiptSchema.shape.runtime,
            })
            .strict()
            .parse(await process.ready())
          if (startupFailure || stableDisplayJson(ready.build) !== stableDisplayJson(value.build))
            throw startupFailure ?? new Error('Private bootstrap build mismatch.')
          validateObservedBrowserVersion(
            ready.runtime.browserVersion,
            process.version,
            process.userAgent,
          )
          validateHostHardware(process.hardware, ready.runtime.adapter)
          await value.revalidate()
          if (startupFailure || closed) throw startupFailure ?? new Error('Startup cancelled.')
          process.phase('idle')
          const owned = process,
            privateHost = host
          session = new SupervisedDisplaySession(
            sessionId,
            value.build,
            {
              render: (job) => owned.render(job),
              phase: (phase) => owned.phase(phase),
              close: async () => {
                try {
                  await owned.close()
                } finally {
                  await privateHost.close()
                }
              },
            },
            journal!,
            () => revalidate(value.build),
            ready.runtime,
          )
          return session
        }
        // Never detach startup with Promise.race: an abort closes the supervised process and
        // admission retains its ownership lock until that startup/cleanup has actually settled.
        return await startup()
      } catch (error) {
        startupFailure ??= error instanceof Error ? error : new Error('Display open failed.')
        cancellation.abort()
        let observed = !process && !(error instanceof DisplayTeardownUncertain)
        try {
          if (process) {
            await process.close()
            observed = true
          }
        } finally {
          if (!observed)
            ownershipFailure = new Error('Startup ownership uncertain; quarantine retained.')
          await host?.close()
          if (journal) await journal.finish(observed)
        }
        throw error
      } finally {
        opening = false
        clearTimeout(timer)
        resolveOpening?.()
      }
    },
    async close() {
      closed = true
      startupAbort?.abort()
      await openingDone
      if (ownershipFailure) throw ownershipFailure
      await session?.close('shutdown')
    },
  }
}
