import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreparationHost } from './localRenderPreparation'

const mock = vi.hoisted(() => ({ construct: vi.fn() }))
vi.mock('node:worker_threads', () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      return mock.construct(...args)
    }
  },
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((close) => close())
  vi.useRealTimers()
  vi.clearAllMocks()
})
function setup() {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    terminate: vi.fn(async () => 0),
  })
  mock.construct.mockReturnValue(worker)
  const host = createPreparationHost(
    '/fixed/root',
    'file:///fixed/adapter.ts',
    'file:///fixed/host.ts',
    100,
  )
  cleanup.push(() => host.close())
  return { worker, host }
}
const snapshot = { build: {}, manifests: {}, generation: 1 }

describe('isolated private build preparation lifecycle', () => {
  it('uses a separate fixed production environment and revalidates the owned generation', async () => {
    const { worker, host } = setup(),
      original = process.env.NODE_ENV
    const prepared = host.prepare(() => {})
    expect(mock.construct.mock.calls[0][1]).toMatchObject({
      env: { NODE_ENV: 'production' },
      execArgv: [],
    })
    worker.emit('message', { ok: true, value: snapshot })
    const value = await prepared
    const check = value.revalidate()
    expect(worker.postMessage).toHaveBeenLastCalledWith({ operation: 'revalidate', generation: 1 })
    worker.emit('message', { ok: true })
    await check
    expect(mock.construct).toHaveBeenCalledTimes(1)
    expect(worker.unref).toHaveBeenCalledTimes(2)
    expect(process.env.NODE_ENV).toBe(original)
    host.close()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    await expect(host.prepare(() => {})).rejects.toThrow()
  })
  it('bounds stalled work and terminates the owned worker', async () => {
    vi.useFakeTimers()
    const { worker, host } = setup()
    const result = expect(host.prepare(() => {})).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(150)
    await result
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
  it('honors the current caller fence during validation and kills abandoned work', async () => {
    vi.useFakeTimers()
    const { worker, host } = setup()
    let cancelled = false
    const result = expect(
      host.prepare(() => {
        if (cancelled) throw new Error('Cancelled metadata')
      }),
    ).rejects.toThrow('Cancelled metadata')
    cancelled = true
    await vi.advanceTimersByTimeAsync(50)
    await result
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
  it('rejects concurrent work and discards replies after close', async () => {
    const { worker, host } = setup()
    const pending = expect(host.prepare(() => {})).rejects.toThrow()
    await expect(host.prepare(() => {})).rejects.toThrow()
    host.close()
    worker.emit('message', { ok: true, value: snapshot })
    await pending
    expect(mock.construct).toHaveBeenCalledTimes(1)
  })
  it.each(['error', 'exit'])('fails closed on worker %s', async (event) => {
    const { worker, host } = setup()
    const pending = expect(host.prepare(() => {})).rejects.toThrow(
      'Private metadata worker unavailable.',
    )
    worker.emit(event, new Error('Internal detail not forwarded'))
    await pending
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
