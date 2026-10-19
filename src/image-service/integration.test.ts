// @vitest-environment node
// Ephemeral shell HTTP contract tests only: no Vite, browser, UI, GPU or external network.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign } from '../domain/design'
import { createSceneDesignFixtures } from '../domain/designFixtures'
import { startImageRequest, type ImageProgress } from '../prototype/imageClient'
import { createMockImageMiddleware } from './http'
import { MockJobStore } from './store'
import { MockImageService } from './service'
import {
  IMAGE_REQUEST_PATH,
  createImageRequest,
  createImageCancelRequest,
  imageStatusPath,
  imageCancelPath,
  parseImageSubmissionReply,
  parseImageStatusReply,
  parseImageCancelReply,
} from './protocol'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'fury-next-http-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const store = new MockJobStore({ path: join(directory, 'jobs.sqlite') })
  const service = new MockImageService({ store })
  cleanup.push(() => service.close())
  const middleware = createMockImageMiddleware({
    service,
    principalSecret: store.principalSecret(),
  })
  const server = createServer((request, response) =>
    middleware(request, response, () => {
      response.statusCode = 404
      response.end()
    }),
  )
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected ephemeral loopback port')
  const origin = `http://127.0.0.1:${address.port}`
  function client() {
    let cookie = ''
    const request: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input), origin)
      if (url.origin !== origin)
        throw new Error('External network forbidden by integration harness')
      const headers = new Headers(init.headers)
      // Node fetch has no browser cookie jar or automatic Origin: emulate those transport fields only.
      if (!headers.has('Origin')) headers.set('Origin', origin)
      if (cookie) headers.set('Cookie', cookie)
      const response = await fetch(url, { ...init, headers })
      const issued = response.headers.get('Set-Cookie')
      if (issued) cookie = issued.split(';')[0]
      return response
    }
    return request
  }
  return { store, service, origin, client }
}
const json = (input: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(input),
})

describe('real loopback HTTP + durable service + browser-safe client integration', () => {
  it('round-trips all six full stress fixtures through HTTP and verifies bytes, ownership and interest-only cancellation', async () => {
    const f = await fixture()
    const alice = f.client(),
      bob = f.client()
    for (const { design } of createSceneDesignFixtures()) {
      const one = await alice(IMAGE_REQUEST_PATH, json(createImageRequest(design)))
      expect(one.status).toBe(202)
      expect(one.headers.get('cache-control')).toBe('private, no-store')
      const a = await parseImageSubmissionReply(one.status, await one.json(), design)
      const two = await bob(IMAGE_REQUEST_PATH, json(createImageRequest(design)))
      const b = await parseImageSubmissionReply(two.status, await two.json(), design)
      expect(a.body.interestId).not.toBe(b.body.interestId)
      const forbidden = await bob(imageStatusPath(a.body.interestId))
      expect(forbidden.status).toBe(404)
      await forbidden.json()
      const cancelled = await alice(
        imageCancelPath(a.body.interestId),
        json(createImageCancelRequest(a.body.interestId)),
      )
      expect(
        await parseImageCancelReply(await cancelled.json(), design, a.body.interestId),
      ).toMatchObject({ sharedWorkCancelled: false })
      expect(await f.service.runOnce()).toBe(1)
      const status = await bob(imageStatusPath(b.body.interestId))
      const ready = await parseImageStatusReply(await status.json(), design, b.body.interestId)
      expect(ready).toMatchObject({
        state: 'ready',
        productionAllowed: false,
        artifact: { exactMatch: false, approvedCurrentImage: false },
      })
    }
    expect(f.store.inspect()).toMatchObject({ jobs: 6, interests: 12, spent: 6, reserved: 0 })
  }, 15_000)

  it('runs the actual client submit/poll/detach lifecycle without a renderer or browser decode claim', async () => {
    const f = await fixture()
    const request = f.client()
    const updates: ImageProgress[] = []
    const decode = vi.fn().mockResolvedValue(undefined) // Deliberately NOT physical image decode evidence.
    const stop = startImageRequest(defaultDesign(), (progress) => updates.push(progress), {
      fetch: request,
      decode,
    })
    cleanup.push(stop)
    await vi.waitFor(() => expect(f.store.inspect().jobs).toBe(1), { timeout: 5000 })
    await f.service.runOnce()
    await vi.waitFor(() => expect(updates.at(-1)?.state).toBe('ready'), { timeout: 5000 })
    expect(decode).toHaveBeenCalledOnce()
    const ready = updates.at(-1)
    if (ready?.state !== 'ready') throw new Error('No verified diagnostic')
    stop()
    await vi.waitFor(
      async () => {
        const status = await request(imageStatusPath(ready.reply.interestId))
        expect(
          await parseImageStatusReply(await status.json(), defaultDesign(), ready.reply.interestId),
        ).toMatchObject({ state: 'cancelled', sharedWorkCancelled: false })
      },
      { timeout: 5000 },
    )
    expect(f.store.inspect()).toMatchObject({ spent: 1, reserved: 0 })
  }, 15_000)

  it('rejects real cross-origin, oversized, future and arbitrary-equipment requests without reservations', async () => {
    const f = await fixture()
    const request = f.client()
    const valid = createImageRequest(defaultDesign())
    const crossOrigin = await request(IMAGE_REQUEST_PATH, {
      ...json(valid),
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' },
    })
    expect(crossOrigin.status).toBe(403)
    await crossOrigin.json()
    const oversized = await request(IMAGE_REQUEST_PATH, {
      ...json(valid),
      body: ' '.repeat(16 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)
    await oversized.json()
    for (const config of [
      { ...valid.design.config, schemaVersion: 5 },
      { ...valid.design.config, items: [{ sku: 'rack', x: 1, z: 1, rotation: 0 }] },
    ]) {
      const invalid = await request(
        IMAGE_REQUEST_PATH,
        json({ ...valid, design: { ...valid.design, config } }),
      )
      expect(invalid.status).toBe(422)
      await invalid.json()
    }
    expect(f.store.inspect()).toMatchObject({ jobs: 0, interests: 0, spent: 0, reserved: 0 })
  })
})
