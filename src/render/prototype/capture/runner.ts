import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  CAPTURE_FLAGS,
  CAPTURE_LIMITS,
  CAPTURE_PROTOCOL,
  CaptureContractError,
  assertCanStartAttempt,
  assertCaptureActive,
  captureAttemptSchema,
  captureSampleIdSchema,
  createCaptureJob,
  createCaptureSamples,
  validateCaptureProgress,
  validateCaptureTerminal,
  validateWorkerReady,
  validateWorkerResult,
  type CaptureAttempt,
  type CaptureComplete,
  type CaptureFailureCode,
  type CaptureJob,
  type CaptureProgress,
  type CaptureSampleId,
} from './contract'
import {
  ExclusiveDirectory,
  jsonBytes,
  matchesObservedBrowserRuntime,
  publishCapture,
} from './artifacts'
import {
  SOURCE_ROOT,
  assertOutsideSource,
  prepareCaptureBuild,
  readTrustedFile,
  saveBuildManifests,
  startCaptureHost,
  type CaptureHost,
  type PreparedCapture,
} from './host'
import { launchOwnedBrowser, type BrowserObservation, type OwnedBrowser } from './runner-browser'

// Fixed batch-wide history. Neither an output path nor a new process grants a fresh budget.
export const HISTORY_DIRECTORY =
  '/home/ubuntu/Documents/fury-capture-handoff/local-three-capture-history'
const startedSchema = z
  .object({
    attempt: captureAttemptSchema,
    startedAt: z.number().int().positive(),
    outputDirectory: z.string().min(1).max(4096),
  })
  .strict()
const finishedSchema = z
  .object({
    attempt: captureAttemptSchema,
    elapsedMs: z
      .number()
      .finite()
      .nonnegative()
      .max(CAPTURE_LIMITS.runMs + CAPTURE_LIMITS.cleanupMs),
    code: z.string().max(40).nullable(),
  })
  .strict()
export type RunnerOptions = {
  sampleId: CaptureSampleId
  outputDirectory: string
  kind: CaptureAttempt['kind']
}
export function parseCaptureCli(args: readonly string[]): RunnerOptions {
  if (
    (args.length !== 4 && args.length !== 5) ||
    args[0] !== '--sample' ||
    args[2] !== '--out' ||
    (args.length === 5 && args[4] !== '--diagnostic-retry')
  )
    throw new CaptureContractError(
      'invalid-input',
      'Usage: --sample <pinned-id> --out <new-absolute-directory> [--diagnostic-retry]',
    )
  const sampleId = captureSampleIdSchema.parse(args[1])
  assertOutsideSource(args[3])
  return {
    sampleId,
    outputDirectory: args[3],
    kind: args.length === 5 ? 'diagnostic-retry' : 'sample',
  }
}

/** Exclusive immutable start/finish events. A stale lock or unfinished reservation blocks, never resets. */
export async function openAttemptHistory(path = HISTORY_DIRECTORY) {
  if ((await realpath(dirname(path))) !== dirname(path))
    throw new CaptureContractError('invalid-input', 'History parent must be real.')
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
    throw new CaptureContractError('invalid-input', 'History must be a real directory.')
  const lockPath = join(path, 'runner.lock')
  const lock = await open(
    lockPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  const lockIdentity = await lock.stat()
  await lock.writeFile(
    jsonBytes({
      pid: process.pid,
      note: 'Owned local capture lock. Never delete while owner or child is alive.',
    }),
  )
  await lock.sync()
  let releasing: Promise<void> | undefined, closingLock: Promise<void> | undefined
  const retain = () => (closingLock ??= lock.close())
  const release = () =>
    (releasing ??= (async () => {
      await retain()
      const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      // Missing means already released; never unlink a replacement or a symbolic link.
      if (!current) return
      if (
        current.dev !== lockIdentity.dev ||
        current.ino !== lockIdentity.ino ||
        !current.isFile() ||
        current.isSymbolicLink()
      )
        throw new CaptureContractError('publication-failed', 'History lock identity changed.')
      await unlink(lockPath)
    })())
  const write = async (name: string, value: unknown) => {
    const bytes = jsonBytes(value)
    const handle = await open(
      join(path, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const actual = await readTrustedFile(join(path, name), path, CAPTURE_LIMITS.metadataBytes)
    if (!actual.equals(bytes))
      throw new CaptureContractError('publication-failed', 'History event readback mismatch.')
  }
  try {
    const names = await readdir(path)
    if (
      names.some(
        (name) =>
          name !== 'runner.lock' && !/^attempt-0[1-8]\.(?:started|finished)\.json$/.test(name),
      )
    )
      throw new CaptureContractError(
        'invalid-input',
        'Unexpected history file; operator review required.',
      )
    const history: CaptureAttempt[] = []
    let consumedMs = 0
    for (let index = 1; index <= CAPTURE_LIMITS.attempts; index++) {
      const prefix = `attempt-${String(index).padStart(2, '0')}`
      const startName = `${prefix}.started.json`,
        finishName = `${prefix}.finished.json`
      if (!names.includes(startName)) {
        if (
          names.includes(finishName) ||
          names.some((name) => name.startsWith('attempt-') && Number(name.slice(8, 10)) > index)
        )
          throw new CaptureContractError(
            'invalid-input',
            'History event gap; operator review required.',
          )
        break
      }
      const start = startedSchema.parse(
        JSON.parse(
          (
            await readTrustedFile(join(path, startName), path, CAPTURE_LIMITS.metadataBytes)
          ).toString(),
        ),
      )
      if (start.attempt.state !== 'running')
        throw new CaptureContractError('invalid-input', 'Invalid history reservation.')
      assertCanStartAttempt(history, start.attempt.sampleId, start.attempt.kind)
      let attempt = start.attempt
      if (names.includes(finishName)) {
        const finish = finishedSchema.parse(
          JSON.parse(
            (
              await readTrustedFile(join(path, finishName), path, CAPTURE_LIMITS.metadataBytes)
            ).toString(),
          ),
        )
        if (
          finish.attempt.state === 'running' ||
          finish.attempt.jobId !== attempt.jobId ||
          finish.attempt.sampleId !== attempt.sampleId ||
          finish.attempt.kind !== attempt.kind
        )
          throw new CaptureContractError('invalid-input', 'History finish binding differs.')
        attempt = finish.attempt
        consumedMs += finish.elapsedMs
      }
      history.push(attempt)
    }
    return {
      history,
      consumedMs,
      release,
      retain,
      reserve: async (attempt: CaptureAttempt, outputDirectory: string) => {
        assertCanStartAttempt(history, attempt.sampleId, attempt.kind)
        const prefix = `attempt-${String(history.length + 1).padStart(2, '0')}`
        await write(
          `${prefix}.started.json`,
          startedSchema.parse({ attempt, startedAt: Date.now(), outputDirectory }),
        )
        history.push(attempt)
        return async (state: CaptureAttempt['state'], elapsedMs: number, code: string | null) => {
          if (state === 'running') throw new Error('Cannot finish as running.')
          await write(
            `${prefix}.finished.json`,
            finishedSchema.parse({ attempt: { ...attempt, state }, elapsedMs, code }),
          )
        }
      },
    }
  } catch (error) {
    await release()
    throw error
  }
}

export type RunnerSeams = {
  prepare?: (fence: () => void) => Promise<PreparedCapture>
  host?: typeof startCaptureHost
  browser?: typeof launchOwnedBrowser
  historyPath?: string // Explicit unit-test seam only; CLI has no history override.
}
function safeFailure(error: unknown): { code: CaptureFailureCode; message: string } {
  if (error instanceof CaptureContractError)
    return {
      code: error.code,
      message: `Private capture failed: ${error.code}. See bounded local diagnostic receipts.`,
    }
  return {
    code: error instanceof z.ZodError ? 'invalid-input' : 'scene-failed',
    message: 'Private capture failed validation or execution; no image was published.',
  }
}

/** Exactly one pinned attempt per invocation. No automatic retries, UI wiring or fallback renderer. */
export async function runCapture(
  options: RunnerOptions,
  externalSignal: AbortSignal,
  seams: RunnerSeams = {},
) {
  const admitted = parseCaptureCli([
    '--sample',
    options.sampleId,
    '--out',
    options.outputDirectory,
    ...(options.kind === 'diagnostic-retry' ? ['--diagnostic-retry'] : []),
  ])
  captureAttemptSchema.shape.kind.parse(options.kind)
  const request = createCaptureSamples().find((sample) => sample.id === admitted.sampleId)!.request
  const start = performance.now(),
    internal = new AbortController()
  let failure: Error | undefined,
    deadline = start + CAPTURE_LIMITS.jobMs
  const fence = () => {
    if (externalSignal.aborted) throw new CaptureContractError('cancelled', 'Capture cancelled.')
    if (failure) throw failure
    assertCaptureActive(internal.signal, performance.now(), deadline)
  }
  let rejectAbort: ((error: Error) => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  void interrupted.catch(() => {})
  const fail = (error: Error) => {
    if (!failure) failure = error
    internal.abort()
    rejectAbort?.(failure)
  }
  const cancel = () => fail(new CaptureContractError('cancelled', 'Capture cancelled.'))
  externalSignal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(
    () => fail(new CaptureContractError('timeout', 'Job deadline elapsed.')),
    CAPTURE_LIMITS.jobMs,
  )
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    fence()
    const value = await Promise.race([work, interrupted])
    fence()
    return value
  }
  let browser: OwnedBrowser | undefined,
    host: CaptureHost | undefined,
    output: ExclusiveDirectory | undefined
  let job: CaptureJob | undefined,
    history: Awaited<ReturnType<typeof openAttemptHistory>> | undefined
  let finish:
    | ((state: CaptureAttempt['state'], elapsedMs: number, code: string | null) => Promise<void>)
    | undefined
  let committedMarker: CaptureComplete | undefined,
    finalizingHistory = false
  let progressTimer: ReturnType<typeof setInterval> | undefined
  const events: CaptureProgress[] = []
  let lastObservation: BrowserObservation | undefined
  let cleanupStarted = false,
    browserDisposed = false,
    browserStopped = false,
    hostClosed = false
  const acquire = async <T>(
    work: Promise<T>,
    cleanup: (value: T) => Promise<void>,
    assign: (value: T) => void,
  ) =>
    bounded(
      work.then(async (value) => {
        if (internal.signal.aborted || cleanupStarted) {
          await cleanup(value)
          fence()
          throw new CaptureContractError('cancelled', 'Late resource acquisition fenced.')
        }
        assign(value)
        return value
      }),
    )
  const cleanupDeadline = async (work: Promise<unknown>, ms: number) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new CaptureContractError('timeout', 'Owned cleanup deadline elapsed.')),
            ms,
          )
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  const stopBrowser = async () => {
    if (browser && !browserStopped) {
      await cleanupDeadline(browser.stop(), CAPTURE_LIMITS.cleanupMs - 1000)
      browserStopped = true
    } else if (!browser && lastObservation?.ownedPid && !lastObservation.cleanupConfirmed) {
      throw new CaptureContractError(
        'publication-failed',
        'Owned startup cleanup was not confirmed.',
      )
    }
  }
  const elapsed = () =>
    Math.min(CAPTURE_LIMITS.runMs + CAPTURE_LIMITS.cleanupMs, performance.now() - start)
  try {
    fence()
    history = await acquire(
      openAttemptHistory(seams.historyPath),
      (value) => value.release(),
      (value) => {
        history = value
      },
    )
    assertCanStartAttempt(history.history, admitted.sampleId, admitted.kind)
    if (history.consumedMs >= CAPTURE_LIMITS.runMs - CAPTURE_LIMITS.jobMs)
      throw new CaptureContractError('limit-exceeded', 'Batch execution-time budget exhausted.')
    deadline = Math.min(deadline, start + CAPTURE_LIMITS.runMs - history.consumedMs)
    output = await bounded(ExclusiveDirectory.create(admitted.outputDirectory, SOURCE_ROOT))
    const attempt: CaptureAttempt = {
      jobId: `capture-${randomUUID()}`,
      sampleId: admitted.sampleId,
      kind: admitted.kind,
      state: 'running',
    }
    finish = await bounded(history.reserve(attempt, output.path))
    await bounded(output.write('request.json', jsonBytes(request)))
    const prepared = await bounded((seams.prepare ?? prepareCaptureBuild)(fence))
    await bounded(saveBuildManifests(output, prepared, fence))
    job = await bounded(createCaptureJob(attempt.jobId, attempt.sampleId, request, prepared.build))
    await bounded(output.write('job.json', jsonBytes(job)))
    host = await acquire(
      (seams.host ?? startCaptureHost)(prepared.resources, () =>
        fail(new CaptureContractError('network-denied', 'Host denied a resource request.')),
      ),
      (value) => value.close(),
      (value) => {
        host = value
      },
    )
    const startupTimer = setTimeout(
      () => fail(new CaptureContractError('timeout', 'Browser startup deadline elapsed.')),
      CAPTURE_LIMITS.startupMs,
    )
    try {
      browser = await acquire(
        (seams.browser ?? launchOwnedBrowser)({
          stateDirectory: output.path,
          host,
          signal: internal.signal,
          fence,
          onFailure: fail,
          onObservation: (value) => {
            lastObservation = value
          },
          remainingMs: () => Math.max(1, deadline - performance.now()),
        }),
        (value) => value.stop(),
        (value) => {
          browser = value
        },
      )
      validateWorkerReady(await bounded(browser.ready()), prepared.build)
    } finally {
      clearTimeout(startupTimer)
    }
    let previous: CaptureProgress | undefined,
      progressBusy = false
    progressTimer = setInterval(() => {
      if (progressBusy) return
      progressBusy = true
      void bounded(browser!.progress())
        .then((value) => {
          if (
            !progressTimer ||
            value === null ||
            JSON.stringify(previous) === JSON.stringify(value)
          )
            return
          const progress = validateCaptureProgress(value, job!, previous)
          if (progress.phase === 'validating' || progress.phase === 'publishing')
            throw new CaptureContractError('invalid-input', 'Page cannot publish progress.')
          previous = progress
          events.push(progress)
        })
        .catch((error: unknown) => {
          if (progressTimer) fail(error instanceof Error ? error : new Error('Progress failed.'))
        })
        .finally(() => {
          progressBusy = false
        })
    }, 500)
    const result = validateWorkerResult(await bounded(browser.render(job)), job)
    clearInterval(progressTimer)
    progressTimer = undefined
    if (result.state === 'failed')
      throw new CaptureContractError(result.code, 'Private scene reported failure.')
    host.assertHealthy()
    fence()
    const observed = browser.observations()
    if (
      result.runtime.backend !== 'webgl2' ||
      result.runtime.acceleration !== 'software' ||
      !/swiftshader|software/i.test(result.runtime.adapter) ||
      !matchesObservedBrowserRuntime(result.runtime, observed)
    )
      throw new CaptureContractError(
        'identity-mismatch',
        'Page runtime differs from measured software browser.',
      )
    // Pixels are in Node now. Confirm owned shutdown BEFORE publication; a cleanup failure
    // must not produce COMPLETE or permit another graphics owner to acquire the history lock.
    await bounded(cleanupDeadline(browser.dispose(), 2000))
    browserDisposed = true
    await bounded(stopBrowser())
    await bounded(cleanupDeadline(host.close(), 500))
    hostClosed = true
    await bounded(output.write('progress.json', jsonBytes(events)))
    await bounded(
      output.write('browser.json', jsonBytes({ ...browser.observations(), host: host.stats() })),
    )
    const marker = await bounded(
      publishCapture({
        directory: output,
        job,
        result,
        elapsedMs: elapsed,
        fence: () => {
          fence()
          host!.assertHealthy()
        },
        revalidateSources: prepared.revalidate,
        onCommitted: (value) => {
          committedMarker = value
        },
      }),
    )
    // COMPLETE is the commit point. Late cancellation cannot rewrite a published receipt.
    finalizingHistory = true
    await finish('succeeded', elapsed(), null)
    return validateCaptureTerminal(
      {
        protocol: CAPTURE_PROTOCOL,
        jobId: job.jobId,
        captureDigest: job.identity.captureDigest,
        state: 'complete',
        marker,
        flags: CAPTURE_FLAGS,
      },
      job,
    )
  } catch (error) {
    if (committedMarker && job) {
      if (finalizingHistory)
        throw new CaptureContractError(
          'publication-failed',
          'Capture committed but history finalization failed; reconcile before another run.',
        )
      await finish?.('succeeded', elapsed(), null)
      return validateCaptureTerminal(
        {
          protocol: CAPTURE_PROTOCOL,
          jobId: job.jobId,
          captureDigest: job.identity.captureDigest,
          state: 'complete',
          marker: committedMarker,
          flags: CAPTURE_FLAGS,
        },
        job,
      )
    }
    const failed = safeFailure(
      externalSignal.aborted
        ? new CaptureContractError('cancelled', 'Cancelled.')
        : (failure ?? error),
    )
    const report = job
      ? validateCaptureTerminal(
          {
            protocol: CAPTURE_PROTOCOL,
            jobId: job.jobId,
            captureDigest: job.identity.captureDigest,
            state: 'failed',
            ...failed,
            elapsedMs: elapsed(),
            flags: CAPTURE_FLAGS,
          },
          job,
        )
      : {
          protocol: CAPTURE_PROTOCOL,
          state: 'failed-before-build',
          sampleId: admitted.sampleId,
          ...failed,
          elapsedMs: elapsed(),
          flags: CAPTURE_FLAGS,
        }
    if (output)
      await output.write(
        'failure.json',
        jsonBytes({
          report,
          progress: events,
          browser: browser?.observations() ?? lastObservation ?? null,
          host: host?.stats() ?? null,
        }),
      )
    if (finish)
      await finish(
        failed.code === 'cancelled'
          ? 'cancelled'
          : failed.code === 'timeout'
            ? 'timed-out'
            : 'failed',
        elapsed(),
        failed.code,
      )
    return report
  } finally {
    cleanupStarted = true
    clearTimeout(timer)
    if (progressTimer) clearInterval(progressTimer)
    externalSignal.removeEventListener('abort', cancel)
    // No unbounded disposal await can keep the owned browser alive.
    try {
      if (browser && !browserDisposed && !browserStopped)
        await cleanupDeadline(
          browser.dispose().catch(() => {}),
          500,
        ).catch(() => {})
    } finally {
      internal.abort()
      let cleanupConfirmed = false
      try {
        await stopBrowser()
        cleanupConfirmed = true
      } finally {
        try {
          if (host && !hostClosed) await cleanupDeadline(host.close(), 500)
        } finally {
          // Never admit a second job when the previous process may still own graphics work.
          // Retained lock plus immutable cleanup evidence requires explicit operator reconciliation.
          if (cleanupConfirmed) {
            await history?.release()
            if (output && !committedMarker)
              await output.write(
                'cleanup.json',
                jsonBytes({
                  cleanupConfirmed: true,
                  browser: browser?.observations() ?? lastObservation ?? null,
                }),
              )
          } else {
            await history?.retain()
            if (output)
              await output.write(
                'cleanup-failure.json',
                jsonBytes({
                  code: 'publication-failed',
                  historyLockRetained: true,
                  browser: browser?.observations() ?? lastObservation ?? null,
                }),
              )
          }
        }
      }
    }
  }
}
