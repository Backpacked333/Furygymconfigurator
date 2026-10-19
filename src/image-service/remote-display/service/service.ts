import {
  CLOUD_DISPLAY_BUILD_GATE,
  CLOUD_DISPLAY_MODE,
  CLOUD_DISPLAY_PROTOCOL,
  cloudDisplayReplySchema,
  cloudDisplayRequestSchema,
  type CloudDisplayReply,
  type CloudRecipe,
} from '../../../display/cloudContract'
import {
  DISPLAY_LIMITS,
  DISPLAY_PROTOCOL,
  displayIdSchema,
  stableDisplayJson,
} from '../../../display/contract'
import { validateDisplayJob } from '../../../display/session'
import type { RemoteDisplayBackend, RemoteDisplaySession } from '../../../display/cloudSession'
import { DisplayDirectory, opaqueId } from '../../display/files'
import { CloudCache, cloudArtifact, validateCloudRecipe, verifyCloudOutput } from './cache'
import { CloudJournal, type CloudInterest } from './journal'
import type { CloudEvidenceVerifier } from './evidence'
import { capacity, CloudServiceError, denied, missing, quarantined, unavailable } from './errors'

export type CloudServiceOptions = {
  backend: RemoteDisplayBackend
  /** Existing operator-owned cloud directory only. Not the local cache or permit directory. */
  directory?: string
  evidence?: CloudEvidenceVerifier
  approval?: unknown
  now?: () => number
}
function bounded<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CloudServiceError(
              503,
              'timeout',
              'External display deadline elapsed; no retry is authorized.',
            ),
          ),
        Math.max(1, ms),
      )
      timer.unref()
    }),
  ]).finally(() => clearTimeout(timer))
}
/** A distinct cloud bridge. Its dispatch gate has no option, header, environment switch or permit adapter.
 * Cache reads do not reserve attempts or open a session. Candidate execution below remains unreachable
 * until a separately reviewed source change and an external signed/capped admission mechanism exist. */
export function createCloudDisplayService(options: CloudServiceOptions) {
  const { backend } = options,
    now = options.now ?? Date.now
  const directory = options.directory ? new DisplayDirectory(options.directory, false) : undefined
  const cache = directory
    ? new CloudCache(new DisplayDirectory(directory.file('cloud-objects')), options.evidence)
    : undefined
  const journal = directory
    ? new CloudJournal(new DisplayDirectory(directory.file('cloud-journal')), now)
    : undefined
  let closed = false,
    poisoned = false,
    pending = 0
  let serial: Promise<unknown> = Promise.resolve()
  let session: RemoteDisplaySession | undefined
  let controller: AbortController | undefined
  let running: Promise<void> | undefined, stopping: Promise<void> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined,
    lifetime: ReturnType<typeof setTimeout> | undefined
  const exclusive = <T>(op: () => Promise<T>): Promise<T> => {
    if (pending >= 8) return Promise.reject(capacity())
    pending++
    const result = serial.then(op, op).finally(() => {
      pending--
    })
    serial = result.catch(() => {})
    return result
  }
  function owner(value: string) {
    if (!displayIdSchema.safeParse(value).success)
      throw new CloudServiceError(403, 'forbidden', 'Private cloud owner authentication required.')
  }
  async function revalidate(recipe: CloudRecipe) {
    await bounded(backend.revalidate(recipe), DISPLAY_LIMITS.startupMs)
  }
  async function refresh(i: CloudInterest) {
    const current = await validateCloudRecipe(
      i.design,
      await bounded(backend.prepare(i.design), DISPLAY_LIMITS.startupMs),
    )
    if (stableDisplayJson(current) !== stableDisplayJson(i.recipe)) throw quarantined()
    await revalidate(i.recipe)
  }
  async function cached(recipe: CloudRecipe) {
    try {
      return await cache!.get(recipe)
    } catch (error) {
      await stop('poisoned').catch(() => {})
      throw error
    }
  }
  async function reply(i: CloudInterest): Promise<CloudDisplayReply> {
    const base = {
      protocol: CLOUD_DISPLAY_PROTOCOL,
      mode: CLOUD_DISPLAY_MODE,
      interestId: i.id,
      recipe: i.recipe,
    }
    if (i.expiresAt <= now()) return { ...base, state: 'expired' }
    if (i.state === 'cancelled')
      return { ...base, state: 'cancelled', cancellationScope: 'interest-only' }
    if (
      i.state === 'failed' ||
      ((i.state === 'queued' || i.state === 'rendering') && journal!.restartedRun)
    )
      return { ...base, state: 'failed', error: quarantined().wire }
    if (i.state !== 'ready') return { ...base, state: i.state, retryAfterMs: 500 }
    await refresh(i)
    const value = await cached(i.recipe)
    await revalidate(i.recipe)
    if (!value || i.expiresAt <= now() || closed) throw missing()
    return cloudDisplayReplySchema.parse({
      ...base,
      state: 'ready',
      artifact: cloudArtifact(value, i.id, i.hit),
    })
  }
  function remaining() {
    const run = journal!.snapshot().run
    return run.claimed
      ? Math.max(0, DISPLAY_LIMITS.lifetimeMs - (now() - run.startedAt))
      : DISPLAY_LIMITS.lifetimeMs
  }
  function fence(key: string, deadline: number) {
    if (
      closed ||
      poisoned ||
      controller?.signal.aborted ||
      !journal!.interested(key) ||
      now() >= deadline ||
      remaining() <= 0
    )
      throw quarantined()
  }
  async function stop(reason: Parameters<RemoteDisplaySession['close']>[0]) {
    if (stopping) return stopping
    poisoned = true
    controller?.abort()
    clearTimeout(idle)
    clearTimeout(lifetime)
    stopping = (async () => {
      // Persist poison before attempting teardown. Returned close is NOT termination/billing observation.
      try {
        journal?.poison()
      } finally {
        if (session) await bounded(session.close(reason), DISPLAY_LIMITS.cleanupMs)
      }
    })()
    return stopping
  }
  async function execute(i: CloudInterest) {
    // This check is duplicated at submit and at the last possible execution boundary.
    if (!CLOUD_DISPLAY_BUILD_GATE.dispatchAllowed) throw denied()
    const key = i.recipe.recipeDigest,
      deadline = now() + DISPLAY_LIMITS.jobMs
    controller = new AbortController()
    clearTimeout(idle)
    try {
      fence(key, deadline)
      await revalidate(i.recipe)
      fence(key, deadline)
      const revision = journal!.reserve(key) // durable attempt BEFORE open or render
      if (!session) {
        lifetime = setTimeout(() => {
          void stop('limit').catch(() => {})
        }, remaining())
        lifetime.unref()
        const opening = backend.open(options.approval).then(async (opened) => {
          if (closed || poisoned || controller?.signal.aborted) {
            await bounded(opened.close('poisoned'), DISPLAY_LIMITS.cleanupMs)
            throw quarantined()
          }
          return opened
        })
        session = await bounded(opening, Math.min(DISPLAY_LIMITS.startupMs, remaining()))
        journal!.attach(session.sessionId)
      }
      fence(key, deadline)
      const job = await validateDisplayJob(
        {
          protocol: DISPLAY_PROTOCOL,
          jobId: opaqueId(),
          sessionId: session.sessionId,
          revision,
          design: i.design,
          binding: i.recipe.binding,
        },
        i.recipe.binding.build,
      )
      const output = await bounded(
        session.render(job, i.recipe, controller.signal),
        Math.min(deadline - now(), remaining()),
      )
      fence(key, deadline)
      await verifyCloudOutput(job, i.recipe, output.receipt, output.png, options.evidence)
      journal!.output(output.png.byteLength) // accounting cannot be undone by publication failure
      await cache!.put(
        job,
        i.recipe,
        output.receipt,
        output.png,
        () => revalidate(i.recipe),
        () => fence(key, deadline),
      )
      fence(key, deadline)
      journal!.complete(key)
    } catch {
      await stop(controller.signal.aborted ? 'cancelled' : 'poisoned').catch(() => {})
    } finally {
      controller = undefined
    }
  }
  function kick() {
    if (!CLOUD_DISPLAY_BUILD_GATE.dispatchAllowed || running || poisoned || closed) return
    running = (async () => {
      for (let next = journal!.next(); next && !poisoned && !closed; next = journal!.next())
        await execute(next)
    })().finally(() => {
      running = undefined
      if (session && !poisoned && !closed) {
        idle = setTimeout(
          () => {
            void stop('idle').catch(() => {})
          },
          Math.min(DISPLAY_LIMITS.idleMs, remaining()),
        )
        idle.unref()
      }
    })
  }
  return {
    submit(ownerId: string, input: unknown, signal?: AbortSignal) {
      return exclusive(async () => {
        owner(ownerId)
        const parsed = cloudDisplayRequestSchema.safeParse(input)
        if (!parsed.success)
          throw new CloudServiceError(
            422,
            'invalid-request',
            'Expected only the cloud protocol and complete validated design.',
          )
        if (closed || signal?.aborted || !journal || !cache) throw unavailable()
        const recipe = await validateCloudRecipe(
          parsed.data.design,
          await bounded(backend.prepare(parsed.data.design), DISPLAY_LIMITS.startupMs),
        )
        await revalidate(recipe)
        const hit = await cached(recipe)
        if (signal?.aborted || closed) throw unavailable()
        // Misses never create interests, reserve attempts, open workers or call providers in this build.
        if (!hit && !CLOUD_DISPLAY_BUILD_GATE.dispatchAllowed) throw denied()
        if (!hit && (poisoned || journal.restartedRun)) throw quarantined()
        const interest = journal.add(ownerId, parsed.data.design, recipe, !!hit)
        const body = await reply(interest)
        queueMicrotask(kick)
        return { status: body.state === 'ready' ? 200 : 202, body }
      })
    },
    status(ownerId: string, id: string) {
      return exclusive(async () => {
        owner(ownerId)
        if (!journal || closed) throw unavailable()
        return reply(journal.get(ownerId, id))
      })
    },
    cancel(ownerId: string, id: string) {
      return exclusive(async () => {
        owner(ownerId)
        if (!journal || closed) throw unavailable()
        const interest = journal.cancel(ownerId, id)
        if (
          !journal.interested(interest.recipe.recipeDigest) &&
          controller &&
          interest.state === 'cancelled'
        ) {
          // Only abort the active recipe, not another owner's or another queued selection's job.
          const active = journal.snapshot().interests.find((i) => i.state === 'rendering')
          if (!active || active.recipe.recipeDigest === interest.recipe.recipeDigest)
            await stop('cancelled').catch(() => {})
        }
        return reply(interest)
      })
    },
    image(ownerId: string, id: string, checksum: string) {
      return exclusive(async () => {
        owner(ownerId)
        if (!journal || !cache || closed) throw unavailable()
        const i = journal.get(ownerId, id)
        if (i.state !== 'ready' || i.expiresAt <= now()) throw missing()
        await refresh(i)
        const value = await cached(i.recipe)
        await revalidate(i.recipe)
        if (!value || value.receipt.image.checksum !== checksum || i.expiresAt <= now() || closed)
          throw missing()
        return Buffer.from(value.png)
      })
    },
    async close() {
      if (closed) return
      closed = true
      await serial
      try {
        if (session || running) await stop('shutdown')
      } finally {
        try {
          await bounded(backend.close(), DISPLAY_LIMITS.cleanupMs)
        } finally {
          journal?.close()
        }
      }
    },
  }
}
export type CloudDisplayService = ReturnType<typeof createCloudDisplayService>
