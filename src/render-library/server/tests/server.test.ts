// @vitest-environment node
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupSet, readJob, submitSet } from '../../../prototype/renderLibraryClient'
import { jobId, queued } from '../../../prototype/renderLibraryClient.fixtures'
import fixture from '../../fixtures/http-contract.json'
import workerFixture from '../../fixtures/worker-adapter.json'
import {
  createJobRequestSchema,
  customerDesignSchema,
  lookupRequestSchema,
  safeError,
  type SetSnapshot,
} from '../../contracts'
import { computeSetIdentity } from '../../identity'
import { artifactEventSchema, artifactReceiptSchema } from '../../workerProtocol'
import { checksum, StaticSeedSource, SupabaseArtifacts, verifyPixels } from '../artifacts'
import { seedImagesForSet, verifySeedManifest } from '../seedCache'
import {
  boundedBytes,
  boundedJson,
  requireBearer,
  ServiceError,
  SessionSecurity,
} from '../httpSafety'
import { createRuntime, route, type Route, type Runtime } from '../runtime'
import { LibraryService, WorkerService } from '../service'
import { SupabaseRepository, SupabaseTransport } from '../supabase'
import type { AdmissionPolicy } from '../ports'

const origin = 'https://fury.example'
const key = 'test-only-not-a-real-secret-'.repeat(2)
it('reports safe request timings without logging authentication or exception contents', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const response = await route(
      new Request(`${origin}/api/render-library/lookup`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sensitive-test-token' },
      }),
      'lookup',
      () => {
        throw new Error('sensitive-test-token')
      },
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('Server-Timing')).toMatch(/^render-library;dur=\d+$/)
    const record = JSON.parse(log.mock.calls[0][0])
    expect(record).toMatchObject({ event: 'render-library.request', route: 'lookup', status: 503 })
    expect(record.requestId).toBe(response.headers.get('X-Render-Request-Id'))
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-test-token')
  } finally {
    log.mockRestore()
  }
})
it('keeps partial cached sets readable with admissions disabled and protected seed URLs', async () => {
  const manifestBytes = await readFile('public/native-library/manifest.json')
  const manifest = verifySeedManifest(manifestBytes)
  const design = customerDesignSchema.parse(
    manifest.entries.find((entry) => entry.design.presentation.lookRef === 'studio-night-draft@1')!
      .design,
  )
  const identity = await computeSetIdentity(design)
  const images = await seedImagesForSet(manifestBytes, design)
  expect(images).toHaveLength(1)
  const snapshot: SetSnapshot = {
    contractVersion: 'fury.render-library@1',
    status: 'ok',
    identity,
    coverage: 'partial',
    job: null,
    views: Object.entries(identity.imageKeys).map(([cameraRef, imageKey]) => {
      const image = images.find((image) => image.imageKey === imageKey)
      return image
        ? { cameraRef, imageKey, status: 'ready', image }
        : { cameraRef, imageKey, status: 'missing' }
    }) as SetSnapshot['views'],
    rendering: { status: 'unavailable', reason: safeError('budget-unavailable') },
  }
  const database = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toContain('/rpc/render_library_snapshot')
    return Response.json(snapshot)
  })
  const protectedFiles = vi.fn(async () => new Response('Authentication required', { status: 401 }))
  const service = new LibraryService(
    new SupabaseRepository(new SupabaseTransport('https://test.supabase.co', key, database)),
    new StaticSeedSource(origin, protectedFiles),
    async () => {
      throw new ServiceError('budget-unavailable', 503)
    },
    [],
  )
  expect(await service.lookup({ contractVersion: 'fury.render-library@1', design })).toEqual(
    snapshot,
  )
  expect(protectedFiles).not.toHaveBeenCalled()
  expect(database).toHaveBeenCalledTimes(1)
  expect(database.mock.calls[0]?.[0]).toBe(
    'https://test.supabase.co/rest/v1/rpc/render_library_snapshot',
  )
})
const design = lookupRequestSchema.parse(fixture.lookup).design
const input = createJobRequestSchema.parse(fixture.create)
const policy = {
  enabled: true,
  approvalId: '00000000-0000-4000-8000-000000000099',
  expiresAt: '2099-01-01T00:00:00.000Z',
  globalBudgetMicroUsd: 100000,
  maxJobLiabilityMicroUsd: 6000,
  maxImageLiabilityMicroUsd: 1000,
  startupLiabilityMicroUsd: 500,
  recipe: {
    releaseId: 'fury-native-five@2',
    workerBuildSha256: workerFixture.claim.workerBuildSha256,
    recipeBundleSha256: workerFixture.claim.recipeBundleSha256,
    geometrySha256: '3'.repeat(64),
    materialsSha256: '4'.repeat(64),
    camerasSha256: '5'.repeat(64),
    rendererSha256: '6'.repeat(64),
  },
} as const satisfies AdmissionPolicy
const seeds = { images: vi.fn(async () => []) }
it('loads the registered recipe for the active immutable release', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toContain('release_id=eq.fury-native-five%402&select=registration')
    return Response.json([{ registration: policy.recipe }])
  })
  const repository = new SupabaseRepository(
    new SupabaseTransport('https://test.supabase.co', key, fetcher),
  )
  expect(await repository.registration()).toEqual(policy.recipe)
})
it('claims only a registered execution build without replacing the customer image recipe', async () => {
  const upgraded = {
    ...policy.recipe,
    workerBuildSha256: '8'.repeat(64),
    recipeBundleSha256: '9'.repeat(64),
  }
  const claim = {
    ...workerFixture.claim,
    workerBuildSha256: upgraded.workerBuildSha256,
    recipeBundleSha256: upgraded.recipeBundleSha256,
  }
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes('/render_library_worker_builds?'))
      return Response.json([{ registration: upgraded }])
    if (String(url).includes('/render_library_recipes?'))
      return Response.json([{ registration: policy.recipe }])
    return Response.json(claim)
  })
  const repository = new SupabaseRepository(
    new SupabaseTransport('https://test.supabase.co', key, fetcher),
  )
  expect(await repository.registration()).toEqual(policy.recipe)
  const worker = testRuntime(fetcher).worker
  expect(
    (
      await worker.claim({
        ...workerFixture.dispatch,
        contractVersion: 'fury.render-library@1',
        workerBuildSha256: upgraded.workerBuildSha256,
      })
    ).claim,
  ).toEqual(claim)
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).includes(`worker_build_sha256=eq.${upgraded.workerBuildSha256}`),
    ),
  ).toBe(true)
  await expect(repository.registration('7'.repeat(64))).rejects.toThrow()
  await expect(repository.registration('invalid&select=*')).rejects.toThrow()
})
let snapshot: SetSnapshot
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  vi.restoreAllMocks()
  seeds.images.mockClear()
  const identity = await computeSetIdentity(design)
  snapshot = {
    contractVersion: 'fury.render-library@1',
    status: 'ok',
    identity,
    coverage: 'missing',
    job: null,
    views: Object.entries(identity.imageKeys).map(([cameraRef, imageKey]) => ({
      cameraRef,
      imageKey,
      status: 'missing',
    })) as SetSnapshot['views'],
    rendering: { status: 'unavailable', reason: safeError('rendering-disabled') },
  }
})
const request = (endpoint: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${origin}/api/render-library/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
function testRuntime(fetcher: typeof fetch) {
  const transport = new SupabaseTransport('https://test.supabase.co', key, fetcher)
  const repository = new SupabaseRepository(transport)
  return {
    repository,
    security: new SessionSecurity(origin, key),
    workerToken: key,
    worker: new WorkerService(repository, new SupabaseArtifacts(transport), async () => policy),
    service: new LibraryService(repository, seeds, async () => policy, [
      'https://test.supabase.co',
    ]),
  } satisfies Runtime
}
function credentials(runtime: Runtime) {
  const issued = runtime.security!.issue(request('session'))
  return { cookie: issued.cookie.split(';')[0], 'x-csrf-token': issued.response.csrfToken }
}

describe('bounded request and session security', () => {
  it('connects the real browser client, session cookie, API routes and durable adapter without implicit admission', async () => {
    // PostgREST double only; the real ledger's concurrency/budget semantics have separate SQL tests.
    let durable = snapshot
    const database = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      const name = new URL(String(url)).pathname.split('/').at(-1)
      const args = JSON.parse(String(options?.body))
      if (name === 'render_library_touch_session') return new Response(null, { status: 204 })
      if (name === 'render_library_snapshot') {
        expect(args.identity).toEqual(snapshot.identity)
        return Response.json(durable)
      }
      if (name === 'render_library_reserve_set') {
        expect(args.command.request.design).toEqual(input.design)
        expect(args.command.identity).toEqual(snapshot.identity)
        expect(args.command.context).toMatchObject({ csrfVerified: true, sameOriginVerified: true })
        durable = queued(snapshot)
        return Response.json({ status: 'admitted', snapshot: durable })
      }
      if (name === 'render_library_get_job') {
        expect(args.jobId).toBe(jobId)
        expect(args.sessionHash).toMatch(/^[a-f0-9]{64}$/)
        return Response.json(durable)
      }
      throw new Error(`Unexpected test RPC: ${name}`)
    })
    const runtime = testRuntime(database)
    let cookie = ''
    const paths: string[] = []
    vi.stubGlobal('fetch', async (path: RequestInfo | URL, options?: RequestInit) => {
      const url = String(path)
      paths.push(url)
      const endpoint: Route = url.endsWith('/session')
        ? 'session'
        : url.endsWith('/lookup')
          ? 'lookup'
          : url.endsWith('/jobs')
            ? 'jobs'
            : 'status'
      const headers = new Headers(options?.headers)
      headers.set('origin', origin)
      headers.set('sec-fetch-site', 'same-origin')
      if (cookie) headers.set('cookie', cookie)
      const response = await route(
        new Request(`${origin}${url}`, { ...options, headers }),
        endpoint,
        () => runtime,
      )
      const issued = response.headers.get('set-cookie')
      if (issued) cookie = issued.split(';')[0]
      return response
    })
    const signal = new AbortController().signal
    expect((await lookupSet(design, signal)).coverage).toBe('missing')
    expect(paths).toEqual(['/api/render-library/lookup'])
    expect((await submitSet(design, input.idempotencyKey, signal)).job?.id).toBe(jobId)
    expect(paths.slice(1)).toEqual(['/api/render-library/session', '/api/render-library/jobs'])
    expect((await readJob(jobId, design, signal)).job?.stage).toBe('queued')
    // A remount/another observer uses the shared set lookup, not a second create request.
    expect((await lookupSet(design, signal)).job?.id).toBe(jobId)
    expect(
      database.mock.calls.filter(([url]) => String(url).endsWith('/render_library_reserve_set')),
    ).toHaveLength(1)
  })
  it('signs strict cookie and CSRF, rejects cross-origin, expired, wrong-session and tampered tokens', () => {
    let now = Date.now()
    const security = new SessionSecurity(origin, key, () => now)
    const issued = security.issue(request('session'))
    expect(issued.cookie).toContain('HttpOnly; Secure; SameSite=Strict')
    const auth = { cookie: issued.cookie.split(';')[0], 'x-csrf-token': issued.response.csrfToken }
    expect(security.context(request('jobs', input, auth)).csrfVerified).toBe(true)
    expect(() =>
      security.context(request('jobs', input, { ...auth, origin: 'https://evil.example' })),
    ).toThrow('origin-denied')
    expect(() =>
      security.context(request('jobs', input, { ...auth, 'sec-fetch-site': 'cross-site' })),
    ).toThrow('origin-denied')
    expect(() =>
      security.context(
        request('jobs', input, { ...auth, 'x-csrf-token': `${auth['x-csrf-token']}0` }),
      ),
    ).toThrow('csrf-invalid')
    const second = security.issue(request('session'))
    expect(() =>
      security.context(request('jobs', input, { ...auth, cookie: second.cookie.split(';')[0] })),
    ).toThrow('csrf-invalid')
    now += 16 * 60_000
    expect(() => security.context(request('jobs', input, auth))).toThrow('csrf-invalid')
    expect(security.issue(request('session', undefined, { cookie: auth.cookie })).sessionHash).toBe(
      issued.sessionHash,
    )
  })
  it('does not trust X-Forwarded-For and bounds JSON, streams and declared lengths', async () => {
    const security = new SessionSecurity(origin, key)
    expect(
      security.issue(request('session', undefined, { 'x-forwarded-for': '1.1.1.1' })).networkHash,
    ).toBe(
      security.issue(request('session', undefined, { 'x-forwarded-for': '9.9.9.9' })).networkHash,
    )
    await expect(boundedJson(request('lookup', { value: 'a'.repeat(40_000) }))).rejects.toThrow(
      'invalid-request',
    )
    await expect(
      boundedJson(request('lookup', fixture.lookup, { 'content-type': 'text/plain' })),
    ).rejects.toThrow('invalid-request')
    await expect(
      boundedBytes(new Response('abcd', { headers: { 'content-length': '3' } }), 10),
    ).rejects.toThrow('invalid-request')
    await expect(boundedBytes(new Response('abcd'), 3)).rejects.toThrow('invalid-request')
  })
  it('reads fetch-decoded gzip responses without comparing wire and decoded lengths', async () => {
    const body = JSON.stringify({ views: 'saved-image'.repeat(100) })
    const compressed = gzipSync(body)
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length,
      })
      response.end(compressed)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw Error('Expected local server port')
      const url = `http://127.0.0.1:${address.port}`
      const response = await fetch(url)
      expect(response.headers.get('content-length')).toBe(String(compressed.length))
      expect(new TextDecoder().decode(await boundedBytes(response, 2048))).toBe(body)
      await expect(boundedBytes(await fetch(url), 512)).rejects.toThrow('invalid-request')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
  it('keeps raw request and response limits strict with content-encoding headers', async () => {
    for (const encoding of ['gzip', 'deflate', 'br']) {
      const headers = { 'content-encoding': encoding, 'content-length': '3' }
      expect(await boundedBytes(new Response('abcd', { headers }), 10)).toHaveLength(4)
      await expect(
        boundedBytes(new Request(origin, { method: 'POST', body: 'abcd', headers }), 10),
      ).rejects.toThrow('invalid-request')
      await expect(boundedBytes(new Response('abcd', { headers }), 3)).rejects.toThrow(
        'invalid-request',
      )
      await expect(
        boundedBytes(new Response('abcd', { headers: { ...headers, 'content-length': 'x' } }), 10),
      ).rejects.toThrow('invalid-request')
    }
    await expect(
      boundedBytes(
        new Response('abcd', {
          headers: { 'content-encoding': 'identity', 'content-length': '3' },
        }),
        10,
      ),
    ).rejects.toThrow('invalid-request')
  })
  it('requires a separately configured worker bearer token', () => {
    expect(() => requireBearer(request('worker/events', {}), key)).toThrow('origin-denied')
    expect(() =>
      requireBearer(request('worker/events', {}, { authorization: `Bearer ${key}` }), undefined),
    ).toThrow('origin-denied')
    expect(() =>
      requireBearer(request('worker/events', {}, { authorization: `Bearer ${key}` }), key),
    ).not.toThrow()
  })
})

describe('same-origin API and durable repository wiring', () => {
  it('persists session bootstrap through a real PostgREST-style 204 void result', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const result = await route(request('session'), 'session', () => testRuntime(fetcher))
    expect(result.status).toBe(200)
    expect(result.headers.get('set-cookie')).toContain('__Host-fury-render-session=')
    expect((await result.json()).csrfToken).toBeTruthy()
    expect(fetcher.mock.calls[0][0]).toContain('/rpc/render_library_touch_session')
  })
  it('exposes eight explicit Node API entrypoints', async () => {
    const routes = await Promise.all([
      import('../../../../api/render-library/lookup'),
      import('../../../../api/render-library/session'),
      import('../../../../api/render-library/jobs/index'),
      import('../../../../api/render-library/jobs/[jobId]/index'),
      import('../../../../api/render-library/jobs/[jobId]/retry'),
      import('../../../../api/render-library/worker/claim'),
      import('../../../../api/render-library/worker/uploads'),
      import('../../../../api/render-library/worker/events'),
    ])
    for (const endpoint of routes)
      expect(Object.values(endpoint).some((value) => typeof value === 'function')).toBe(true)
  })
  it('performs authoritative lookup only, never reserve or dispatcher work', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(snapshot))
    const runtime = testRuntime(fetcher)
    const result = await route(request('lookup', fixture.lookup), 'lookup', () => runtime)
    expect(result.status).toBe(200)
    expect((await result.json()).coverage).toBe('missing')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toContain('/rpc/render_library_snapshot')
  })
  it('returns unavailable, never authoritative missing, when the ledger is inaccessible', async () => {
    const runtime = testRuntime(
      vi.fn(async () => {
        throw new Error('provider-private-api-key')
      }),
    )
    const result = await route(request('lookup', fixture.lookup), 'lookup', () => runtime)
    expect(result.status).toBe(503)
    expect(await result.text()).not.toContain('provider-private-api-key')
  })
  it('rejects client identity/cost/URL fields and invalid CSRF before any mutation', async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot))
    const runtime = testRuntime(fetcher)
    expect((await route(request('jobs', input), 'jobs', () => runtime)).status).toBe(403)
    expect(
      (
        await route(
          request(
            'jobs',
            { ...input, setKey: snapshot.identity.setKey, price: 0 },
            credentials(runtime),
          ),
          'jobs',
          () => runtime,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await route(
          request('lookup', { ...fixture.lookup, callbackUrl: 'https://evil.example' }),
          'lookup',
          () => runtime,
        )
      ).status,
    ).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('admits explicit click through one SQL reservation RPC with server-computed identity and policy', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'admitted', snapshot }))
    fetcher.mockResolvedValueOnce(Response.json(snapshot))
    const runtime = testRuntime(fetcher)
    const result = await route(request('jobs', input, credentials(runtime)), 'jobs', () => runtime)
    expect(result.status).toBe(202)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, options] = fetcher.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toContain('/rpc/render_library_reserve_set')
    const command = JSON.parse(options.body as string).command
    expect(command.identity).toEqual(await computeSetIdentity(input.design))
    expect(command.policy).toEqual(policy)
    expect(command.context.csrfVerified).toBe(true)
    expect(command.context.sameOriginVerified).toBe(true)
  })
  it('keeps safe budget/capacity errors and binds polling to session membership', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ status: 'denied', error: safeError('capacity-full') }),
    )
    fetcher.mockResolvedValueOnce(Response.json(snapshot))
    const runtime = testRuntime(fetcher)
    expect(
      (await route(request('jobs', input, credentials(runtime)), 'jobs', () => runtime)).status,
    ).toBe(429)
    fetcher.mockImplementation(async () => Response.json(null))
    const auth = credentials(runtime)
    const result = await route(
      request(`jobs/${workerFixture.claim.jobId}`, undefined, auth),
      'status',
      () => runtime,
    )
    expect(result.status).toBe(404)
    const call = fetcher.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(call[1].body as string).sessionHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('fails closed without server settings and denies worker auth before reading provider state', async () => {
    const runtime = createRuntime({})
    expect((await route(request('jobs', input), 'jobs', () => runtime)).status).toBe(503)
    const fetcher = vi.fn(async () => Response.json(null))
    expect(
      (
        await route(
          request('worker/claim', {
            ...workerFixture.dispatch,
            workerBuildSha256: workerFixture.claim.workerBuildSha256,
          }),
          'worker/claim',
          () => testRuntime(fetcher),
        )
      ).status,
    ).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('independent artifact decoding and immutable storage', () => {
  it.each(['original', 'queue'])(
    'publishes %s build receipts against their own immutable registration',
    async (build) => {
      const bytes = await sharp({
        create: { width: 1920, height: 1200, channels: 3, background: '#334455' },
      })
        .webp({ quality: 95 })
        .toBuffer()
      const event = artifactEventSchema.parse(workerFixture.uploadRequest)
      const claim = structuredClone(workerFixture.claim)
      const registered =
        build === 'original'
          ? policy.recipe
          : {
              ...policy.recipe,
              workerBuildSha256: '8'.repeat(64),
              recipeBundleSha256: '9'.repeat(64),
            }
      claim.workerBuildSha256 = event.receipt.workerBuildSha256 = registered.workerBuildSha256
      claim.recipeBundleSha256 = event.receipt.recipeBundleSha256 = registered.recipeBundleSha256
      claim.limits.maxActiveJobsPerSession = build === 'original' ? 1 : 2
      event.receipt.bytes = bytes.length
      event.receipt.sha256 = checksum(bytes)
      let invalidBytes = false
      let replay = false
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const path = String(url)
        if (path.includes('/render_library_jobs?'))
          return Response.json([
            {
              worker_claim: claim,
              fence: 1,
              attempt_id: workerFixture.claim.attemptId,
            },
          ])
        if (path.includes('/render_library_recipes?'))
          return Response.json([{ registration: policy.recipe }])
        if (path.includes('/render_library_worker_builds?'))
          return Response.json([{ registration: registered }])
        if (path.includes('/render_library_events?'))
          return Response.json(replay ? [{ payload: event }] : [])
        if (path.includes('/rpc/render_library_prepare_artifact'))
          return Response.json({ accepted: true })
        if (path.includes('/object/authenticated/render-library-staging/'))
          return new Response(invalidBytes ? 'not-a-webp' : new Uint8Array(bytes))
        if (path.includes('/object/render-library/')) return Response.json({ Key: 'stored' })
        if (path.includes('/rpc/render_library_publish_asset'))
          return Response.json({ published: true })
        if (path.includes('/rpc/render_library_record_event'))
          return Response.json({ accepted: true })
        throw new Error('Unexpected provider request in explicit test double')
      })
      const worker = testRuntime(fetcher).worker
      expect(await worker.recordEvent(event)).toEqual({ accepted: true })
      const paths = fetcher.mock.calls.map(([url]) => String(url))
      expect(paths.findIndex((path) => path.includes('/object/authenticated/'))).toBeLessThan(
        paths.findIndex((path) => path.includes('/object/render-library/')),
      )
      const publication = fetcher.mock.calls.find(([url]) =>
        String(url).includes('/rpc/render_library_publish_asset'),
      )!
      const artifact = JSON.parse(publication[1]!.body as string).artifact
      expect(artifact.image.sha256).toBe(checksum(bytes))
      expect(artifact.image.provenance.kind).toBe('native-worker')
      expect(artifact.image.provenance.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
      fetcher.mockClear()
      replay = true
      vi.useFakeTimers()
      vi.setSystemTime(new Date(workerFixture.claim.deadlineAt).getTime() + 1000)
      try {
        await expect(worker.prepareUpload(event)).rejects.toThrow()
        expect(await worker.recordEvent(event)).toEqual({ accepted: true })
      } finally {
        vi.useRealTimers()
      }
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('/storage/'))).toBe(false)
      replay = false
      fetcher.mockClear()
      invalidBytes = true
      await expect(worker.recordEvent(event)).rejects.toThrow()
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            String(url).includes('/publish_asset') ||
            String(url).includes('/object/render-library/'),
        ),
      ).toBe(false)
    },
  )
  it('fully decodes valid WebP and rejects wrong dimensions, bytes, hash, and truncated pixel payload', async () => {
    const bytes = await sharp({
      create: { width: 1920, height: 1200, channels: 3, background: '#334455' },
    })
      .webp({ quality: 95 })
      .toBuffer()
    const expected = { bytes: bytes.length, sha256: checksum(bytes), width: 1920, height: 1200 }
    await expect(verifyPixels(bytes, expected)).resolves.toBeUndefined()
    await expect(verifyPixels(bytes, { ...expected, width: 1200 })).rejects.toThrow()
    await expect(verifyPixels(bytes, { ...expected, bytes: bytes.length + 1 })).rejects.toThrow()
    await expect(verifyPixels(bytes, { ...expected, sha256: '0'.repeat(64) })).rejects.toThrow()
    const truncated = bytes.subarray(0, Math.floor(bytes.length * 0.7))
    await expect(
      verifyPixels(truncated, {
        ...expected,
        bytes: truncated.length,
        sha256: checksum(truncated),
      }),
    ).rejects.toThrow()
  })
  it('never overwrites; an existing content-addressed object must match independently read bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]),
      sha256 = checksum(bytes)
    const objectKey = `${snapshot.identity.setKey}/${Object.values(snapshot.identity.imageKeys)[0]}/${sha256}.webp`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('exists', { status: 400 }))
      .mockResolvedValueOnce(new Response(bytes))
    const store = new SupabaseArtifacts(
      new SupabaseTransport('https://test.supabase.co', key, fetcher),
    )
    expect((await store.putIfAbsent(objectKey, bytes, sha256)).url).toContain(objectKey)
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ 'x-upsert': 'false' })
    fetcher
      .mockResolvedValueOnce(new Response('exists', { status: 400 }))
      .mockResolvedValueOnce(new Response('different'))
    await expect(store.putIfAbsent(objectKey, bytes, sha256)).rejects.toThrow('verification-failed')
    await expect(store.putIfAbsent('../escape', bytes, sha256)).rejects.toThrow()
  })
  it('only issues an exact staging capability, never a public-write or arbitrary URL capability', async () => {
    const receipt = artifactReceiptSchema.parse(workerFixture.receipt)
    const path = `/object/upload/sign/render-library-staging/${receipt.jobId}/${receipt.attemptId}/${receipt.imageKey}/${receipt.sha256}.webp?token=test-only`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url: path }))
      .mockResolvedValueOnce(Response.json({ url: '//evil.example/' }))
    const store = new SupabaseArtifacts(
      new SupabaseTransport('https://test.supabase.co', key, fetcher),
    )
    const ticket = await store.uploadTicket(receipt)
    expect(ticket.overwrite).toBe(false)
    expect(ticket.maxBytes).toBe(receipt.bytes)
    expect(ticket.uploadUrl).toBe(`https://test.supabase.co/storage/v1${path}`)
    await expect(store.uploadTicket(receipt)).rejects.toThrow('verification-failed')
  })
  it('refuses mismatched receipt bindings before obtaining upload capability', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/render_library_jobs?'))
        return Response.json([
          {
            worker_claim: workerFixture.claim,
            fence: 1,
            attempt_id: workerFixture.claim.attemptId,
          },
        ])
      if (String(url).includes('/render_library_recipes?'))
        return Response.json([{ registration: policy.recipe }])
      throw new ServiceError('verification-failed', 400)
    })
    const runtime = testRuntime(fetcher)
    const event = artifactEventSchema.parse(workerFixture.uploadRequest)
    const changed = { ...event, receipt: { ...event.receipt, workerBuildSha256: '0'.repeat(64) } }
    await expect(runtime.worker.prepareUpload(changed)).rejects.toThrow()
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/storage/'))).toBe(false)
  })
})
