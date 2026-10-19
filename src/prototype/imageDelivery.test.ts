// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverImage, readBounded } from './imageDelivery'
import { sha256Hex } from '../render-library/identity'

const bytes = (id = 1) => {
  const data = new Uint8Array(128)
  data.set(new TextEncoder().encode('RIFF'), 0)
  data.set(new TextEncoder().encode('WEBP'), 8)
  data[12] = id
  return data
}
const descriptor = async (data = bytes()) => ({
  url: 'https://storage.example.test/a.webp',
  sha256: await sha256Hex(data),
  bytes: data.length,
  width: 1920,
  height: 1200,
})
const response = (data = bytes(), mime = 'image/webp') =>
  new Response(data, { headers: { 'Content-Type': mime } })
const create = vi.fn(),
  revoke = vi.fn(),
  decode = vi.fn()
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  create.mockReset().mockImplementation(() => `blob:verified-${create.mock.calls.length}`)
  revoke.mockReset()
  decode.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = 1920
      naturalHeight = 1200
      decode = decode
    },
  )
})
afterEach(() => vi.unstubAllGlobals())
it('preserves same-origin preview authentication without forwarding cookies cross-origin', async () => {
  const fetch = vi.fn(async (_url: string, options?: RequestInit) =>
    options?.credentials === 'same-origin'
      ? response()
      : new Response('Preview authentication required', { status: 401 }),
  )
  vi.stubGlobal('fetch', fetch)
  const image = await deliverImage(
    { ...(await descriptor()), url: '/native-library/test.webp' },
    new AbortController().signal,
  )
  image.release()
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', redirect: 'error' })
})
it('enforces the stream cap even without Content-Length and cancels an oversized stream', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024))
    },
    cancel,
  })
  await expect(readBounded(new Response(stream), 128)).rejects.toThrow('byte limit')
  expect(cancel).toHaveBeenCalled()
})
it('rejects wrong MIME, signatures, byte counts and checksums before display', async () => {
  const wanted = await descriptor()
  for (const bad of [
    response(bytes(), 'image/png'),
    response(new Uint8Array(128)),
    response(bytes(2)),
    response(new Uint8Array(129)),
    response(new Uint8Array(127)),
  ]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bad))
    await expect(deliverImage(wanted, new AbortController().signal)).rejects.toThrow()
  }
  expect(create).not.toHaveBeenCalled()
})
it('revokes object URLs for wrong dimensions and decode failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => response()),
  )
  const wanted = await descriptor()
  await expect(
    deliverImage({ ...wanted, height: 1500 }, new AbortController().signal),
  ).rejects.toThrow('dimensions')
  decode.mockRejectedValueOnce(new Error('Decode failed'))
  await expect(deliverImage(wanted, new AbortController().signal)).rejects.toThrow('Decode failed')
  expect(revoke).toHaveBeenCalledTimes(2)
})
it('revokes URLs after an aborted decoder settles, even when the decoder ignores abort', async () => {
  let resolve!: () => void
  decode.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
  const controller = new AbortController()
  const pending = deliverImage(await descriptor(), controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(decode).toHaveBeenCalled())
  controller.abort()
  resolve()
  await rejected
  expect(revoke).toHaveBeenCalledTimes(1)
})
it('bounds decoded images and revokes every remaining URL when consumers unmount', async () => {
  const held = []
  try {
    for (let i = 1; i <= 8; i++) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(bytes(i))))
      held.push(await deliverImage(await descriptor(bytes(i)), new AbortController().signal))
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(bytes(9))))
    await expect(
      deliverImage(await descriptor(bytes(9)), new AbortController().signal),
    ).rejects.toThrow('memory is full')
    expect(revoke).toHaveBeenCalledTimes(1)
  } finally {
    held.forEach((image) => image.release())
  }
  expect(revoke).toHaveBeenCalledTimes(9)
})
