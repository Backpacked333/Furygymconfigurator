import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { artifactEventSchema, claimRequestSchema, workerEventSchema } from '../workerProtocol.js'
import {
  createJobRequestSchema,
  lookupRequestSchema,
  retryJobRequestSchema,
  uuidSchema,
} from '../contracts.js'
import { canonicalJson } from '../identity.js'
import { StaticSeedSource, SupabaseArtifacts } from './artifacts.js'
import {
  boundedJson,
  errorResponse,
  httpsOrigin,
  json,
  requireBearer,
  ServiceError,
  SessionSecurity,
  unavailable,
} from './httpSafety.js'
import { LibraryService, WorkerService } from './service.js'
import { SupabaseRepository, SupabaseTransport } from './supabase.js'

export function createRuntime(env: Record<string, string | undefined> = process.env) {
  const origin = env.RENDER_LIBRARY_PUBLIC_ORIGIN && httpsOrigin(env.RENDER_LIBRARY_PUBLIC_ORIGIN)
  const storageOrigin =
    env.RENDER_LIBRARY_SUPABASE_URL && httpsOrigin(env.RENDER_LIBRARY_SUPABASE_URL)
  const transport =
    storageOrigin && env.RENDER_LIBRARY_SERVICE_ROLE_KEY
      ? new SupabaseTransport(storageOrigin, env.RENDER_LIBRARY_SERVICE_ROLE_KEY)
      : null
  const repository = transport && new SupabaseRepository(transport)
  const security =
    origin && env.RENDER_LIBRARY_SESSION_SECRET
      ? new SessionSecurity(origin, env.RENDER_LIBRARY_SESSION_SECRET)
      : null
  const policy = async () => {
    if (
      env.RENDER_LIBRARY_ENABLED !== 'true' ||
      env.RENDER_LIBRARY_DISPATCH_MODE !== 'private-poller' ||
      !repository ||
      !security ||
      (env.RENDER_LIBRARY_WORKER_TOKEN?.length ?? 0) < 32
    )
      throw unavailable()
    if (!env.RENDER_LIBRARY_APPROVAL_ID) throw new ServiceError('budget-unavailable', 503)
    const [approved, registered] = await Promise.all([
      repository.policy(env.RENDER_LIBRARY_APPROVAL_ID),
      repository.registration(),
    ])
    if (canonicalJson(registered) !== canonicalJson(approved.recipe)) throw unavailable()
    return approved
  }
  return {
    repository,
    security,
    workerToken: env.RENDER_LIBRARY_WORKER_TOKEN,
    service: new LibraryService(
      repository,
      new StaticSeedSource(origin),
      policy,
      storageOrigin ? [storageOrigin] : [],
    ),
    worker:
      repository && transport
        ? new WorkerService(repository, new SupabaseArtifacts(transport), policy)
        : null,
  }
}
export type Runtime = ReturnType<typeof createRuntime>
export type Route =
  | 'lookup'
  | 'session'
  | 'jobs'
  | 'status'
  | 'retry'
  | 'worker/claim'
  | 'worker/uploads'
  | 'worker/events'

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ServiceError('invalid-request', 400)
  return result.data
}

export async function route(
  request: Request,
  endpoint: Route,
  factory: () => Runtime = createRuntime,
) {
  const requestId = randomUUID()
  const start = performance.now()
  const response = await handleRoute(request, endpoint, factory)
  const elapsedMs = Math.round(performance.now() - start)
  response.headers.set('X-Render-Request-Id', requestId)
  response.headers.set('Server-Timing', `render-library;dur=${elapsedMs}`)
  console.info(
    JSON.stringify({
      event: 'render-library.request',
      requestId,
      route: endpoint,
      status: response.status,
      elapsedMs,
    }),
  )
  return response
}

async function handleRoute(request: Request, endpoint: Route, factory: () => Runtime) {
  try {
    const expected = ['session', 'status'].includes(endpoint) ? 'GET' : 'POST'
    if (request.method !== expected) throw new ServiceError('invalid-request', 400)
    const runtime = factory()
    if (endpoint.startsWith('worker/')) {
      requireBearer(request, runtime.workerToken)
      if (!runtime.worker) throw unavailable()
      const body = await boundedJson(request)
      if (endpoint === 'worker/claim')
        return json(await runtime.worker.claim(input(claimRequestSchema, body)))
      if (endpoint === 'worker/uploads')
        return json(await runtime.worker.prepareUpload(input(artifactEventSchema, body)))
      return json(await runtime.worker.recordEvent(input(workerEventSchema, body)))
    }
    if (endpoint === 'lookup')
      return json(
        await runtime.service.lookup(input(lookupRequestSchema, await boundedJson(request))),
      )
    if (!runtime.security || !runtime.repository) throw unavailable()
    if (endpoint === 'session') {
      const issued = runtime.security.issue(request)
      await runtime.repository.touchSession(
        issued.sessionHash,
        issued.networkHash,
        issued.expiresAt,
      )
      return json(issued.response, 200, { 'Set-Cookie': issued.cookie, Vary: 'Cookie, Origin' })
    }
    if (endpoint === 'jobs') {
      const context = runtime.security.context(request)
      const body = input(createJobRequestSchema, await boundedJson(request))
      const result = await runtime.service.create(body, context)
      return json(result, runtime.service.lastAdmission === 'admitted' ? 202 : 200)
    }
    const match = new URL(request.url).pathname.match(
      /^\/api\/render-library\/jobs\/([a-f0-9-]+)(?:\/retry)?$/,
    )
    const jobId = input(uuidSchema, match?.[1])
    if (endpoint === 'status')
      return json(
        await runtime.service.authorizedStatus(jobId, runtime.security.authorizeRead(request)),
      )
    const context = runtime.security.context(request)
    const result = await runtime.service.retry(
      jobId,
      input(retryJobRequestSchema, await boundedJson(request)),
      context,
    )
    return json(result, runtime.service.lastAdmission === 'admitted' ? 202 : 200)
  } catch (error) {
    // Never log database bodies, headers, signed URLs, worker receipts or raw provider errors.
    return errorResponse(error)
  }
}
