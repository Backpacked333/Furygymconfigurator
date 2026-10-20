// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { API_PATHS, CONTRACT_VERSION, safeError } from '../render-library/contracts'
import {
  decodeLibraryImage,
  lookupSet,
  readJob,
  storageOrigins,
  submitSet,
  verifySnapshot,
} from './renderLibraryClient'
import {
  designFixture,
  jobId,
  snapshotFixture,
  storageOrigin,
} from './renderLibraryClient.fixtures'

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubEnv('VITE_RENDER_LIBRARY_STORAGE_ORIGIN', storageOrigin)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
it('looks up exact sets read-only and reads job status without a session or job POST', async () => {
  const design = designFixture(),
    snapshot = await snapshotFixture(design)
  const fetch = vi.fn().mockImplementation(async () => response(snapshot))
  vi.stubGlobal('fetch', fetch)
  expect(await lookupSet(design, new AbortController().signal)).toEqual(snapshot)
  await readJob(jobId, design, new AbortController().signal)
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    API_PATHS.lookup,
    `${API_PATHS.jobs}/${jobId}`,
  ])
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    contractVersion: CONTRACT_VERSION,
    design,
  })
  expect(fetch.mock.calls[1][1].method).toBe('GET')
})
it('enqueues only with a same-origin session and CSRF token, preserving selected camera and design', async () => {
  const design = designFixture(),
    snapshot = await snapshotFixture(design)
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({
        contractVersion: CONTRACT_VERSION,
        csrfToken: 'c'.repeat(32),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    )
    .mockResolvedValueOnce(response(snapshot))
  vi.stubGlobal('fetch', fetch)
  await submitSet(design, jobId, new AbortController().signal)
  expect(fetch.mock.calls[0][0]).toBe(API_PATHS.session)
  expect(fetch.mock.calls[1][0]).toBe(API_PATHS.jobs)
  expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('c'.repeat(32))
  expect(fetch.mock.calls[1][1].credentials).toBe('same-origin')
  expect(fetch.mock.calls[1][1].keepalive).toBe(true)
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    contractVersion: CONTRACT_VERSION,
    design,
    intent: 'render-missing',
    idempotencyKey: jobId,
  })
})
it('freezes the clicked build before waiting for session admission', async () => {
  const design = structuredClone(designFixture())
  const clicked = structuredClone(design)
  const snapshot = await snapshotFixture(clicked)
  let sessionReady!: (value: Response) => void
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          sessionReady = resolve
        }),
    )
    .mockResolvedValueOnce(response(snapshot))
  vi.stubGlobal('fetch', fetch)
  const pending = submitSet(design, jobId, new AbortController().signal)
  Object.assign(design.presentation, { aspect: 'tall' })
  sessionReady(
    response({
      contractVersion: CONTRACT_VERSION,
      csrfToken: 'c'.repeat(32),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  )
  await expect(pending).resolves.toEqual(snapshot)
  expect(JSON.parse(fetch.mock.calls[1][1].body).design).toEqual(clicked)
})
it('distinguishes lookup errors from confirmed cache misses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      response(
        {
          contractVersion: CONTRACT_VERSION,
          status: 'error',
          error: safeError('lookup-unavailable'),
        },
        503,
      ),
    ),
  )
  await expect(lookupSet(designFixture(), new AbortController().signal)).rejects.toMatchObject({
    code: 'lookup-unavailable',
  })
})
it('fails closed on missing, non-HTTPS or non-origin storage configuration', () => {
  for (const invalid of [
    '',
    'http://storage.example.test',
    `${storageOrigin}/`,
    `${storageOrigin}/bucket`,
    `https://user:password@storage.example.test`,
  ]) {
    vi.stubEnv('VITE_RENDER_LIBRARY_STORAGE_ORIGIN', invalid)
    expect(storageOrigins()).toEqual([])
  }
})
it('rejects wrong identity, recipe, camera, dimensions and untrusted URLs before fetching an image', async () => {
  const design = designFixture(),
    good = await snapshotFixture(design, 1)
  expect(await verifySnapshot(good, design)).toEqual(good)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const ready = good.views[0]
  if (ready.status !== 'ready') throw new Error('fixture')
  for (const patch of [
    { imageKey: 'img_' + 'b'.repeat(64) },
    { setKey: 'set_' + 'b'.repeat(64) },
    { recipeRelease: { ...ready.image.recipeRelease, id: 'other' } },
    { url: ready.image.url.replace(storageOrigin, 'https://evil.example.test') },
    { url: `${ready.image.url}?token=untrusted` },
    { width: 1 },
    { design: { ...design, presentation: { ...design.presentation, cameraRef: 'entry-draft@1' } } },
  ])
    await expect(
      decodeLibraryImage(
        { ...ready.image, ...patch } as typeof ready.image,
        design,
        new AbortController().signal,
      ),
    ).rejects.toThrow()
  vi.stubEnv('VITE_RENDER_LIBRARY_STORAGE_ORIGIN', '')
  await expect(
    decodeLibraryImage(ready.image, design, new AbortController().signal),
  ).rejects.toThrow('Untrusted storage origin')
  expect(fetch).not.toHaveBeenCalled()
})
