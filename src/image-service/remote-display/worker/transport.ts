import { z } from 'zod'
import { cloudRecipeSchema, type CloudRecipe } from '../../../display/cloudContract'
import type { CloudRenderOutput, RemoteDisplaySession } from '../../../display/cloudSession'
import { displayJobSchema, validateDisplayJob, type DisplayJob } from '../../../display/session'
import {
  DISPLAY_LIMITS,
  displayIdSchema,
  displayDigestSchema,
  stableDisplayJson,
} from '../../../display/contract'
import { bindCloudRecipe } from '../../../display/cloudContract'
import { displayCameraDigest } from '../../../render/display/input'
import { requireCloudDispatch } from './backend'

const requestSchema = z
  .object({
    kind: z.literal('cloud-private-worker-job@1'),
    job: displayJobSchema,
    recipe: cloudRecipeSchema,
  })
  .strict()
/** Fixed protocol, no provider selector, URL, script, camera override or command field. */
export async function decodeWorkerRequest(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > DISPLAY_LIMITS.replyBytes)
    throw new Error('Worker request byte bound.')
  const request = requestSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  )
  await validateDisplayJob(request.job, request.recipe.binding.build)
  const expected = await bindCloudRecipe(
    request.job.design,
    request.recipe.binding.build,
    request.recipe.workerPackageDigest,
    await displayCameraDigest(request.job.design),
  )
  if (
    stableDisplayJson(expected) !== stableDisplayJson(request.recipe) ||
    stableDisplayJson(request.job.binding) !== stableDisplayJson(request.recipe.binding)
  )
    throw new Error('Worker recipe mismatch.')
  return request
}
export type CloseReason = Parameters<RemoteDisplaySession['close']>[0]
/** Driver is a PRIVATE seam for a future reviewed host. No network/provider implementation is supplied. */
export type CandidateDriver = {
  render(job: DisplayJob, recipe: CloudRecipe, signal: AbortSignal): Promise<CloudRenderOutput>
  requestTermination(reason: CloseReason): Promise<void>
  observeTerminal(): Promise<{
    processExited: boolean
    providerTerminated: boolean
    billingFinal: boolean
  }>
}
export type CandidateJournal = {
  reserve(job: DisplayJob, recipe: CloudRecipe): Promise<void>
  output(bytes: number): Promise<void>
  quarantine(): Promise<void>
  closed(observation: {
    processExited: boolean
    providerTerminated: boolean
    billingFinal: boolean
  }): Promise<void>
}
export type CandidateSessionOptions = {
  sessionId: string
  packageDigest: string
  runtimePolicyDigest: string
  expiresAt: number
  maxJobs: number
  maxOutputBytes: number
  now(): number
  driver: CandidateDriver
  journal: CandidateJournal
  revalidate(recipe: CloudRecipe): Promise<void>
  verify(job: DisplayJob, recipe: CloudRecipe, output: CloudRenderOutput): Promise<void>
}
/** Protocol/state core, not an authorization factory. Used only by inert tests until reviewed activation.
 * Owner must reserve exclusive durable ownership and persist immutable approval budgets before constructing.
 */
export function candidateSessionState(options: CandidateSessionOptions): RemoteDisplaySession {
  const o = options
  displayIdSchema.parse(o.sessionId)
  displayDigestSchema.parse(o.packageDigest)
  displayDigestSchema.parse(o.runtimePolicyDigest)
  if (!Number.isSafeInteger(o.expiresAt) || !Number.isSafeInteger(o.now()))
    throw new Error('Candidate clock bound.')
  if (
    !Number.isSafeInteger(o.maxJobs) ||
    o.maxJobs < 1 ||
    o.maxJobs > DISPLAY_LIMITS.jobsPerSession ||
    !Number.isSafeInteger(o.maxOutputBytes) ||
    o.maxOutputBytes < 44 ||
    o.maxOutputBytes > DISPLAY_LIMITS.sessionOutputBytes ||
    o.expiresAt <= o.now() ||
    o.expiresAt - o.now() > DISPLAY_LIMITS.lifetimeMs
  )
    throw new Error('Candidate session bounds.')
  let active = false,
    poisoned = false,
    ended = false,
    attempts = 0,
    revision = 0,
    outputBytes = 0
  let closing: Promise<void> | undefined
  let activeAbort: AbortController | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const close = (reason: CloseReason) =>
    (closing ??= (async () => {
      ended = true
      clearTimeout(idleTimer)
      clearTimeout(lifetimeTimer)
      activeAbort?.abort()
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            // Persistence failure must not prevent an independent termination attempt.
            const [quarantine, termination] = await Promise.allSettled([
              Promise.resolve().then(() => o.journal.quarantine()),
              Promise.resolve().then(async () => {
                await o.driver.requestTermination(reason)
                return o.driver.observeTerminal()
              }),
            ])
            if (quarantine.status === 'rejected') throw quarantine.reason
            if (termination.status === 'rejected') throw termination.reason
            const result = termination.value
            if (!result.processExited || !result.providerTerminated)
              throw new Error('External termination unproven; ownership quarantined.')
            // A false billing flag must retain the durable reconciliation hold.
            await o.journal.closed(result)
          })(),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('External termination deadline; ownership quarantined.')),
              DISPLAY_LIMITS.cleanupMs,
            )
          }),
        ])
      } finally {
        clearTimeout(deadline)
      }
    })())
  const idle = () => {
    clearTimeout(idleTimer)
    if (!ended && !active) {
      idleTimer = setTimeout(
        () => {
          void close('idle').catch(() => {})
        },
        Math.max(1, Math.min(DISPLAY_LIMITS.idleMs, o.expiresAt - o.now())),
      )
      idleTimer.unref?.()
    }
  }
  const lifetimeTimer = setTimeout(
    () => {
      void close('limit').catch(() => {})
    },
    Math.max(1, o.expiresAt - o.now()),
  )
  lifetimeTimer.unref?.()
  idle()
  return {
    sessionId: o.sessionId,
    async render(job, recipe, signal) {
      if (active || poisoned || ended) throw new Error('Candidate session unavailable.')
      active = true
      clearTimeout(idleTimer)
      const controller = new AbortController()
      activeAbort = controller
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        signal.throwIfAborted()
        if (o.now() >= o.expiresAt || attempts >= o.maxJobs)
          throw new Error('Candidate budget exhausted.')
        await validateDisplayJob(job, recipe.binding.build)
        if (
          job.sessionId !== o.sessionId ||
          job.revision !== revision + 1 ||
          recipe.workerPackageDigest !== o.packageDigest ||
          recipe.binding.build.runtimePolicyDigest !== o.runtimePolicyDigest
        )
          throw new Error('Candidate job identity mismatch.')
        const checked = await decodeWorkerRequest(
          Buffer.from(JSON.stringify({ kind: 'cloud-private-worker-job@1', job, recipe })),
        )
        await o.revalidate(checked.recipe)
        controller.signal.throwIfAborted()
        if (ended || o.now() >= o.expiresAt) throw new Error('Candidate session expired.')
        await o.journal.reserve(job, recipe)
        attempts++
        revision = job.revision
        controller.signal.throwIfAborted()
        if (ended) throw new Error('Candidate session closed during reservation.')
        const operation = (async () => {
          const result = await o.driver.render(job, recipe, controller.signal)
          controller.signal.throwIfAborted()
          if (
            ended ||
            o.now() >= o.expiresAt ||
            result.png.length > DISPLAY_LIMITS.pngBytes ||
            outputBytes + result.png.length > o.maxOutputBytes
          )
            throw new Error('Candidate output budget/expiry.')
          await o.verify(job, recipe, result)
          controller.signal.throwIfAborted()
          await o.journal.output(result.png.length)
          outputBytes += result.png.length
          controller.signal.throwIfAborted()
          return result
        })()
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              controller.abort()
              reject(new Error('Candidate job deadline.'))
            },
            Math.max(1, Math.min(DISPLAY_LIMITS.jobMs, o.expiresAt - o.now())),
          )
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('Candidate job cancelled.')),
            { once: true },
          )
        })
        return await Promise.race([operation, deadline])
      } catch {
        poisoned = true
        controller.abort()
        try {
          await close(signal.aborted ? 'cancelled' : 'poisoned')
        } catch {
          /* durable quarantine is deliberately retained */
        }
        throw new Error('Candidate job failed; session poisoned.')
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        active = false
        activeAbort = undefined
        idle()
      }
    },
    close,
  }
}
/** Executable transport admission stays hard-denied before a decoder/driver/journal is touched. */
export async function remoteWorkerEntrypoint(request: Uint8Array): Promise<never> {
  void request
  return requireCloudDispatch()
}
