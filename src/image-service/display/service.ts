import {
  bindDisplay,
  DISPLAY_LIMITS,
  DISPLAY_MODE,
  DISPLAY_PROTOCOL,
  displayReplySchema,
  displayRequestSchema,
  stableDisplayJson,
  type DisplayBinding,
  type DisplayBuild,
  type DisplayReply,
} from '../../display/contract'
import {
  parsePreparedDisplayBuild,
  validateDisplayJob,
  type DisplayJob,
  type PrivateDisplayBackend,
  type PrivateDisplaySession,
} from '../../display/session'
import type { DesignEnvelope } from '../../domain/design'
import { DisplayCache, displayArtifact, verifyDisplayPixels } from './cache'
import { DisplayDirectory, opaqueId } from './files'
import { DisplayRun } from './run'
import { DisplayServiceError, capacity, denied, notFound, unavailable } from './errors'

type Work = {
  key: string
  binding: DisplayBinding
  design: DesignEnvelope
  state: 'queued' | 'rendering' | 'ready' | 'failed'
  error?: DisplayServiceError
  controller: AbortController
  deadlineAt?: number
}
type Interest = {
  id: string
  owner: string
  binding: DisplayBinding
  expires: number
  work: Work
  hit: boolean
  cancelled: boolean
}
export type DisplayServiceOptions = {
  backend: PrivateDisplayBackend
  directory: string
  permit?: unknown
  now?: () => number
}

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new DisplayServiceError(
              503,
              'timeout',
              'Private display deadline elapsed; execution is quarantined until observed exit.',
            ),
          ),
        Math.max(1, ms),
      )
      timer.unref()
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Local executable connection only. Backend injection is private code, never an HTTP option. */
export function createDisplayService(options: DisplayServiceOptions) {
  const backend = options.backend,
    now = options.now ?? Date.now
  const directory = new DisplayDirectory(options.directory)
  const cache = new DisplayCache(new DisplayDirectory(directory.file('objects')))
  const run = new DisplayRun(options.permit ?? null, directory, now)
  const interests = new Map<string, Interest>(),
    work = new Map<string, Work>()
  let buildPromise: Promise<DisplayBuild> | undefined
  let session: PrivateDisplaySession | undefined
  let active: Work | undefined, running: Promise<void> | undefined
  let serial: Promise<unknown> = Promise.resolve(),
    closed = false,
    poisoned = false
  let idle: ReturnType<typeof setTimeout> | undefined,
    lifetime: ReturnType<typeof setTimeout> | undefined
  let teardown: Promise<void> | undefined
  let backendTeardown: Promise<void> | undefined
  let operations = 0
  const closeBackend = () =>
    (backendTeardown ??= deadline(backend.close(), DISPLAY_LIMITS.cleanupMs))

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (operations >= 16) return Promise.reject(capacity())
    operations++
    const next = serial.then(operation, operation).finally(() => {
      operations--
    })
    serial = next.catch(() => {})
    return next
  }
  async function prepare() {
    buildPromise ??= backend.prepare().then(parsePreparedDisplayBuild)
    return deadline(
      (async () => {
        const build = await buildPromise!
        await backend.revalidate(build)
        return build
      })(),
      DISPLAY_LIMITS.startupMs,
    )
  }
  function interested(item: Work) {
    return [...interests.values()].some((i) => i.work === item && !i.cancelled && i.expires > now())
  }
  function sweep() {
    for (const [id, i] of interests) if (i.expires <= now()) interests.delete(id)
    for (const [key, item] of work)
      if (!interested(item)) {
        if (item === active) item.controller.abort()
        else work.delete(key)
      }
  }
  function requireOwner(owner: string) {
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(owner))
      throw new DisplayServiceError(403, 'forbidden', 'Authenticated local owner required.')
  }
  function get(owner: string, id: string) {
    requireOwner(owner)
    sweep()
    const i = interests.get(id)
    if (!i || i.owner !== owner) throw notFound()
    return i
  }
  async function reply(i: Interest): Promise<DisplayReply> {
    const base = {
      protocol: DISPLAY_PROTOCOL,
      mode: DISPLAY_MODE,
      interestId: i.id,
      binding: i.binding,
    }
    if (i.cancelled) return { ...base, state: 'cancelled', cancellationScope: 'interest-only' }
    if (i.expires <= now()) return { ...base, state: 'expired' }
    if (i.work.state === 'ready') {
      await prepare()
      const value = await cache.get(i.binding)
      await deadline(backend.revalidate(i.binding.build), DISPLAY_LIMITS.startupMs)
      if (!value) throw unavailable()
      if (i.cancelled || i.expires <= now() || !interests.has(i.id)) throw notFound()
      return displayReplySchema.parse({
        ...base,
        state: 'ready',
        artifact: displayArtifact(value, i.id, i.hit),
      })
    }
    if (i.work.state === 'failed')
      return { ...base, state: 'failed', error: (i.work.error ?? unavailable()).wire }
    return { ...base, state: i.work.state, retryAfterMs: 500 }
  }
  async function stop(reason: Parameters<PrivateDisplaySession['close']>[0]) {
    if (teardown) return teardown
    clearTimeout(idle)
    clearTimeout(lifetime)
    poisoned = true
    active?.controller.abort()
    for (const item of work.values())
      if (item.state === 'queued') {
        item.state = 'failed'
        item.error = denied()
      }
    teardown = (async () => {
      let observed = false
      try {
        if (session) {
          await deadline(session.close(reason), DISPLAY_LIMITS.cleanupMs)
          observed = true
        }
        // A successfully closed session owns all render resources. Keep its backend
        // source-only revalidator alive for immutable cache hits after idle/limits.
        if (!session || reason === 'shutdown') await closeBackend()
      } catch {
        observed = false
        try {
          await closeBackend()
        } catch {
          /* Durable quarantine below. */
        }
      } finally {
        try {
          run.finish(observed)
        } catch {
          /* Prior durable ownership still denies replacement. */
        }
        session = undefined
      }
    })()
    return teardown
  }
  function fence(item: Work) {
    if (
      closed ||
      poisoned ||
      item.controller.signal.aborted ||
      active !== item ||
      !interested(item) ||
      run.remainingMs <= 0 ||
      (item.deadlineAt !== undefined && now() >= item.deadlineAt)
    )
      throw denied()
  }
  async function execute(item: Work) {
    active = item
    item.state = 'rendering'
    clearTimeout(idle)
    const began = now()
    item.deadlineAt = began + DISPLAY_LIMITS.jobMs
    try {
      fence(item)
      const build = await prepare()
      fence(item)
      let revision: number
      if (!session) {
        const permit = run.admit()
        run.own() // Durable ownership BEFORE any open; a crash here cannot mint another run.
        lifetime = setTimeout(() => {
          void stop('limit')
        }, run.remainingMs)
        lifetime.unref()
        const opening = backend.open(permit).then(async (opened) => {
          if (poisoned || closed || item.controller.signal.aborted) {
            try {
              await deadline(opened.close('poisoned'), DISPLAY_LIMITS.cleanupMs)
            } catch {
              /* Quarantine remains. */
            }
            throw denied()
          }
          return opened
        })
        session = await deadline(opening, Math.min(DISPLAY_LIMITS.startupMs, run.remainingMs))
        fence(item)
        if (stableDisplayJson(session.build) !== stableDisplayJson(build)) throw unavailable()
        run.attached(session.sessionId)
        revision = 1 // Startup itself consumed the first attempt, even if open failed.
      } else revision = run.attempt()
      fence(item)
      const job: DisplayJob = await validateDisplayJob(
        {
          protocol: DISPLAY_PROTOCOL,
          jobId: opaqueId(),
          sessionId: session.sessionId,
          revision,
          design: item.design,
          binding: item.binding,
        },
        build,
      )
      fence(item)
      const result = await deadline(
        session.render(job, item.controller.signal),
        Math.min(DISPLAY_LIMITS.jobMs - (now() - began), run.remainingMs),
      )
      fence(item)
      verifyDisplayPixels(job, result.receipt, result.png)
      run.output(result.png.byteLength) // Durable output charge before publication, even if publication fails.
      await deadline(
        backend.revalidate(build),
        Math.min(DISPLAY_LIMITS.jobMs - (now() - began), run.remainingMs),
      )
      fence(item)
      await cache.put(
        job,
        result.receipt,
        result.png,
        () => fence(item),
        () =>
          deadline(
            backend.revalidate(build),
            Math.min(DISPLAY_LIMITS.jobMs - (now() - began), run.remainingMs),
          ),
      )
      fence(item)
      item.state = 'ready'
    } catch (error) {
      item.state = 'failed'
      item.error =
        error instanceof DisplayServiceError
          ? error
          : new DisplayServiceError(
              503,
              'render-failed',
              'Private display failed verification; session cannot be reused.',
            )
      await stop(item.controller.signal.aborted ? 'cancelled' : 'poisoned')
    } finally {
      active = undefined
    }
  }
  function kick() {
    if (running || closed || poisoned) return
    running = (async () => {
      sweep()
      for (;;) {
        const next = [...work.values()].find((w) => w.state === 'queued' && interested(w))
        if (!next || closed || poisoned) break
        await execute(next)
        sweep()
      }
    })().finally(() => {
      running = undefined
      if (session && !poisoned && !closed) {
        idle = setTimeout(
          () => {
            void stop('idle')
          },
          Math.min(DISPLAY_LIMITS.idleMs, run.remainingMs),
        )
        idle.unref()
      }
    })
  }
  return {
    prepare,
    submit(owner: string, input: unknown, signal?: AbortSignal) {
      return exclusive(async () => {
        requireOwner(owner)
        if (closed || signal?.aborted) throw unavailable()
        const parsed = displayRequestSchema.safeParse(input)
        if (!parsed.success)
          throw new DisplayServiceError(
            422,
            'invalid-request',
            'Expected only the strict full v4 display design envelope.',
          )
        sweep()
        if (interests.size >= DISPLAY_LIMITS.interests) throw capacity()
        const build = await prepare()
        const binding = await bindDisplay(parsed.data.design, build)
        const cached = await cache.get(binding)
        if (signal?.aborted || closed) throw unavailable()
        let item = work.get(binding.displayDigest)
        if (!cached) {
          if (poisoned) throw denied()
          if (!item || item.state === 'failed') {
            const queued = [...work.values()].filter((w) => w.state === 'queued').length
            if (queued >= DISPLAY_LIMITS.queuedJobs) throw capacity()
            run.admit(queued + (active && !run.snapshot() ? 1 : 0))
            item = {
              key: binding.displayDigest,
              binding,
              design: parsed.data.design,
              state: 'queued',
              controller: new AbortController(),
            }
            work.set(item.key, item)
          } else if (run.remainingMs <= 0) throw denied()
        } else if (!item || item.state !== 'ready') {
          item = {
            key: binding.displayDigest,
            binding,
            design: parsed.data.design,
            state: 'ready',
            controller: new AbortController(),
          }
          work.set(item.key, item)
        }
        const i: Interest = {
          id: opaqueId(),
          owner,
          binding,
          expires: now() + DISPLAY_LIMITS.interestMs,
          work: item!,
          cancelled: false,
          hit: !!cached,
        }
        interests.set(i.id, i)
        const body = await reply(i)
        queueMicrotask(kick)
        return { status: body.state === 'ready' ? 200 : 202, body }
      })
    },
    status(owner: string, id: string) {
      return exclusive(() => reply(get(owner, id)))
    },
    cancel(owner: string, id: string) {
      return exclusive(async () => {
        const i = get(owner, id)
        i.cancelled = true
        if (!interested(i.work)) {
          if (i.work === active) {
            i.work.controller.abort()
            void stop('cancelled')
          } else if (i.work.state === 'queued') work.delete(i.work.key)
        }
        return reply(i)
      })
    },
    image(owner: string, id: string, checksum: string) {
      return exclusive(async () => {
        const i = get(owner, id)
        if (i.cancelled || i.work.state !== 'ready') throw notFound()
        await prepare()
        const value = await cache.get(i.binding)
        await deadline(backend.revalidate(i.binding.build), DISPLAY_LIMITS.startupMs)
        if (!value || value.receipt.checksum !== checksum || i.cancelled || i.expires <= now())
          throw notFound()
        return Buffer.from(value.png)
      })
    },
    async close() {
      closed = true
      await stop('shutdown')
      await closeBackend()
    },
  }
}
export type DisplayService = ReturnType<typeof createDisplayService>
