import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { DISPLAY_LIMITS } from '../../display/contract'
import { DisplayTeardownUncertain, openDisplayProcess } from './process'
import type { DisplayHost } from './host'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}))
const host: DisplayHost = {
  origin: 'http://127.0.0.1:1',
  token: 'test-only',
  pageUrl: 'http://127.0.0.1:1/test',
  allow: () => true,
  close: async () => {},
}
function childDouble(mode: 'observed' | 'uncertain' | 'hang') {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough(),
    commands = new PassThrough(),
    replies = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, commands, replies],
  })
  const received: string[] = []
  commands.on('data', (bytes) => {
    const message = JSON.parse(bytes.toString().replace(/\0$/, '')) as {
      id: number
      method: string
    }
    received.push(message.method)
    // Deliberately stall the next command: cancellation must close the pending CDP request.
    if (message.method === 'Browser.setDownloadBehavior')
      replies.write(Buffer.from(JSON.stringify({ id: message.id, result: {} }) + '\0'))
  })
  stdin.on('data', (bytes) => {
    expect(JSON.parse(bytes.toString())).toEqual({ phase: 'shutdown' })
    if (mode === 'hang') return
    queueMicrotask(() => {
      if (mode === 'observed') stdout.write('{"event":"exit-observed","pid":12346}\n')
      child.exitCode = 0
      child.emit('exit', 0)
      child.emit('close', 0)
    })
  })
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => stdout.write('{"event":"owned","pid":12346}\n'))
    return child as unknown as ChildProcess
  })
  return { child, received }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(mkdtemp).mockImplementation(async (prefix) => `${prefix}test-only`)
  vi.mocked(rm).mockResolvedValue()
})
afterEach(() => vi.useRealTimers())
describe('owned process startup/teardown with inert stream doubles (zero real spawn)', () => {
  it('pre-aborted admission creates no directory or child', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(openDisplayProcess(host, 1000, vi.fn(), controller.signal)).rejects.toThrow()
    expect(mkdtemp).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
  it('startup cancellation closes pipe and observes supervisor/group exit before deleting owned directories', async () => {
    const child = childDouble('observed'),
      controller = new AbortController(),
      failure = vi.fn()
    const pending = openDisplayProcess(host, 1000, failure, controller.signal)
    const rejected = expect(pending).rejects.toThrow('CDP closed')
    await vi.waitFor(() => expect(child.received).toContain('Browser.getVersion'))
    expect(rm).not.toHaveBeenCalled()
    controller.abort()
    await rejected
    expect(failure).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenCalledOnce()
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
  })
  it('an exit code without owned-group observation cannot release ownership', async () => {
    const child = childDouble('uncertain'),
      controller = new AbortController()
    const pending = openDisplayProcess(host, 1000, vi.fn(), controller.signal)
    const rejected = expect(pending).rejects.toBeInstanceOf(DisplayTeardownUncertain)
    await vi.waitFor(() => expect(child.received).toContain('Browser.getVersion'))
    controller.abort()
    await rejected
    expect(rm).not.toHaveBeenCalled()
  })
  it('unresponsive supervisor hits cleanup bound without killing the independent reaper or claiming exit', async () => {
    vi.useFakeTimers()
    const child = childDouble('hang'),
      controller = new AbortController()
    const pending = openDisplayProcess(host, 1000, vi.fn(), controller.signal)
    const rejected = expect(pending).rejects.toBeInstanceOf(DisplayTeardownUncertain)
    await vi.waitFor(() => expect(child.received).toContain('Browser.getVersion'))
    controller.abort()
    await vi.advanceTimersByTimeAsync(DISPLAY_LIMITS.cleanupMs + 1)
    await rejected
    expect(rm).not.toHaveBeenCalled()
  })
})
