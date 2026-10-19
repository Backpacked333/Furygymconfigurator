import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISPLAY_LIMITS, type DisplayBuild } from '../../display/contract'
import type { LocalDisplayPermit } from '../../display/session'
import { createPrivateDisplayBackend } from './backend'
import { prepareDisplayBuild } from './build'
import { checkOperatorPermit, ownDisplayRun } from './permit'
import { startDisplayHost } from './host'
import { DisplayTeardownUncertain, openDisplayProcess } from './process'

vi.mock('./build', () => ({ prepareDisplayBuild: vi.fn(), sha: vi.fn() }))
vi.mock('./permit', () => ({ checkOperatorPermit: vi.fn(), ownDisplayRun: vi.fn() }))
vi.mock('./host', () => ({ startDisplayHost: vi.fn() }))
vi.mock('./process', () => ({
  openDisplayProcess: vi.fn(),
  validateHostHardware: vi.fn(),
  DisplayTeardownUncertain: class extends Error {},
}))
const digest = `sha256:${'a'.repeat(64)}`
const build: DisplayBuild = {
  sourceManifestDigest: digest,
  assetManifestDigest: digest,
  bundleDigest: digest,
  lockfileDigest: digest,
  runtimePolicyDigest: digest,
  threeRevision: '186',
}
const permit: LocalDisplayPermit = {
  kind: 'operator-local-only',
  runId: 't'.repeat(32),
  approvalReference: 'TEST ONLY; NEVER WRITTEN',
  expiresAt: Date.now() + 600000,
  maxJobs: 1,
  maxOutputBytes: DISPLAY_LIMITS.pngBytes,
  paidExecutionAllowed: false,
  productionAllowed: false,
}
const finish = vi.fn(),
  hostClose = vi.fn(),
  revalidate = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(checkOperatorPermit).mockImplementation(async (value) => value)
  vi.mocked(prepareDisplayBuild).mockResolvedValue({
    build,
    resources: new Map(),
    manifests: { sources: [], assets: [], bundle: [], runtime: [] },
    revalidate,
  })
  vi.mocked(ownDisplayRun).mockResolvedValue({
    permit,
    started: Date.now(),
    finish,
    check: vi.fn(),
    attempt: vi.fn(),
    output: vi.fn(),
  })
  vi.mocked(startDisplayHost).mockResolvedValue({
    origin: 'http://127.0.0.1:1',
    token: 'test-only',
    pageUrl: 'http://127.0.0.1:1/test-only',
    allow: vi.fn(),
    close: hostClose,
  })
})
afterEach(() => vi.useRealTimers())
describe('factory admission and startup cancellation (all I/O mocked; no browser/permit created)', () => {
  it('prepare compiles once without any admission, server or process call', async () => {
    const backend = createPrivateDisplayBackend()
    expect(await backend.prepare()).toEqual(build)
    expect(await backend.prepare()).toEqual(build)
    await backend.revalidate(build)
    expect(prepareDisplayBuild).toHaveBeenCalledOnce()
    expect(revalidate).toHaveBeenCalledOnce()
    expect(checkOperatorPermit).not.toHaveBeenCalled()
    expect(startDisplayHost).not.toHaveBeenCalled()
    expect(openDisplayProcess).not.toHaveBeenCalled()
    await backend.close()
  })
  it('denies admission before compilation/journals/sockets/processes when no operator permit exists', async () => {
    vi.mocked(checkOperatorPermit).mockRejectedValue(new Error('No operator permit'))
    await expect(createPrivateDisplayBackend().open(permit)).rejects.toThrow('No operator permit')
    expect(prepareDisplayBuild).not.toHaveBeenCalled()
    expect(ownDisplayRun).not.toHaveBeenCalled()
    expect(startDisplayHost).not.toHaveBeenCalled()
    expect(openDisplayProcess).not.toHaveBeenCalled()
  })
  it('startup deadline aborts independently but never releases ownership ahead of pending cleanup', async () => {
    vi.useFakeTimers()
    let rejectStartup: ((e: Error) => void) | undefined, signal: AbortSignal | undefined
    vi.mocked(openDisplayProcess).mockImplementation((_host, _ms, _fail, value) => {
      signal = value
      return new Promise((_resolve, reject) => {
        rejectStartup = reject
      })
    })
    const backend = createPrivateDisplayBackend(),
      pending = backend.open(permit)
    const rejected = expect(pending).rejects.toThrow('Observed mock startup cancellation')
    await vi.waitFor(() => expect(openDisplayProcess).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(DISPLAY_LIMITS.startupMs + 1)
    expect(signal?.aborted).toBe(true)
    expect(finish).not.toHaveBeenCalled()
    rejectStartup?.(new Error('Observed mock startup cancellation'))
    await rejected
    expect(finish).toHaveBeenCalledWith(true)
    expect(hostClose).toHaveBeenCalledOnce()
    await backend.close()
  })
  it('uncertain startup teardown retains quarantine and backend close cannot claim success', async () => {
    vi.mocked(openDisplayProcess).mockRejectedValue(
      new DisplayTeardownUncertain('Mock uncertain teardown'),
    )
    const backend = createPrivateDisplayBackend()
    await expect(backend.open(permit)).rejects.toThrow('Mock uncertain teardown')
    expect(finish).toHaveBeenCalledWith(false)
    await expect(backend.close()).rejects.toThrow('quarantine')
  })
  it('backend close fences a late startup and waits for the abort cleanup', async () => {
    let rejectStartup: ((e: Error) => void) | undefined, signal: AbortSignal | undefined
    vi.mocked(openDisplayProcess).mockImplementation((_host, _ms, _fail, value) => {
      signal = value
      return new Promise((_resolve, reject) => {
        rejectStartup = reject
      })
    })
    const backend = createPrivateDisplayBackend(),
      pending = backend.open(permit)
    const rejected = expect(pending).rejects.toThrow('Mock closed')
    await vi.waitFor(() => expect(openDisplayProcess).toHaveBeenCalledOnce())
    let closed = false
    const closing = backend.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(closed).toBe(false)
    expect(finish).not.toHaveBeenCalled()
    rejectStartup?.(new Error('Mock closed'))
    await rejected
    await closing
    expect(closed).toBe(true)
    expect(finish).toHaveBeenCalledWith(true)
  })
})
