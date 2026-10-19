// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, type DesignEnvelope } from '../domain/design'
import { safeError, type SetSnapshot } from '../render-library/contracts'
import { useLibrarySet } from './useLibrarySet'
import { LibraryRequestError } from './renderLibraryClient'
import { jobId, queued, snapshotFixture } from './renderLibraryClient.fixtures'

const api = vi.hoisted(() => ({ lookup: vi.fn(), read: vi.fn(), submit: vi.fn() }))
vi.mock('./renderLibraryClient', async (original) => ({
  ...(await original<typeof import('./renderLibraryClient')>()),
  lookupSet: api.lookup,
  readJob: api.read,
  submitSet: api.submit,
}))
let root: Root, latest: ReturnType<typeof useLibrarySet>
function Probe({ design }: { design: DesignEnvelope }) {
  latest = useLibrarySet(design)
  return null
}
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
const mount = async (design = defaultDesign()) => {
  await act(async () => root.render(<Probe design={design} />))
  await flush()
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  localStorage.clear()
  api.lookup.mockReset()
  api.read.mockReset()
  api.submit.mockReset()
  api.lookup.mockResolvedValue(await snapshotFixture())
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('only looks up on mount, option changes and status refresh; camera switches share the same set', async () => {
  const a = defaultDesign()
  await mount(a)
  expect(api.lookup).toHaveBeenCalledTimes(1)
  await mount(
    parseDesign({ ...a, presentation: { ...a.presentation, cameraRef: 'entry-draft@1' } }),
  )
  expect(api.lookup).toHaveBeenCalledTimes(1)
  await mount(defaultDesign({ family: 'container', lengthFt: 40 }))
  expect(api.lookup).toHaveBeenCalledTimes(2)
  await act(async () => latest.refresh())
  await flush()
  expect(api.lookup).toHaveBeenCalledTimes(3)
  expect(api.submit).not.toHaveBeenCalled()
})
it('requires authoritative availability and de-duplicates a burst of explicit requests', async () => {
  await mount()
  let resolve!: (value: SetSnapshot) => void
  api.submit.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  act(() => {
    void latest.request()
    void latest.request()
    void latest.request()
  })
  expect(api.submit).toHaveBeenCalledTimes(1)
  expect(api.submit.mock.calls[0][0]).toEqual(defaultDesign())
  const working = queued(await snapshotFixture())
  api.read.mockResolvedValue(working)
  await act(async () => resolve(working))
  await flush()
  await act(async () => latest.request())
  expect(api.submit).toHaveBeenCalledTimes(1)
  expect(latest.snapshot?.job?.stage).toBe('queued')
})
it('persists only a pointer and resumes server-authoritative status after remount', async () => {
  await mount()
  const working = queued(await snapshotFixture(defaultDesign(), 2))
  api.submit.mockResolvedValue(working)
  api.read.mockResolvedValue(working)
  await act(async () => latest.request())
  await flush()
  const stored = localStorage.getItem('fury-render-library-pointers-v1')!
  expect(stored).toContain(jobId)
  expect(stored).not.toContain('completedImages')
  expect(stored).not.toContain('url')
  act(() => root.unmount())
  root = createRoot(document.createElement('div'))
  api.read.mockClear()
  await mount()
  expect(api.read).toHaveBeenCalledTimes(1)
  expect(latest.snapshot?.job?.completedImages).toBe(2)
  expect(api.submit).toHaveBeenCalledTimes(1)
})
it('retrieves completed views on a fresh visit without local pointers or another request', async () => {
  const complete = await snapshotFixture(defaultDesign(), 5)
  api.lookup.mockResolvedValue(complete)
  await mount()
  expect(latest.snapshot?.coverage).toBe('complete')
  act(() => root.unmount())
  localStorage.clear()
  root = createRoot(document.createElement('div'))
  await mount()
  expect(latest.snapshot?.views).toEqual(complete.views)
  await act(async () => latest.request())
  expect(api.lookup).toHaveBeenCalledTimes(2)
  expect(api.read).not.toHaveBeenCalled()
  expect(api.submit).not.toHaveBeenCalled()
})
it('never automatically resubmits ambiguous delivery, including after reload', async () => {
  await mount()
  api.submit.mockRejectedValue(new Error('Disconnected after sending'))
  await act(async () => latest.request())
  expect(latest.uncertain).toBe(true)
  await act(async () => latest.request())
  act(() => root.unmount())
  root = createRoot(document.createElement('div'))
  await mount()
  await act(async () => latest.request())
  expect(api.submit).toHaveBeenCalledTimes(1)
  expect(latest.uncertain).toBe(true)
})
it('treats explicit dispatch-uncertain errors as ambiguous, never as permission to resubmit', async () => {
  await mount()
  api.submit.mockRejectedValue(new LibraryRequestError('dispatch-uncertain', 'Unconfirmed'))
  await act(async () => latest.request())
  await act(async () => latest.request())
  expect(latest.uncertain).toBe(true)
  expect(api.submit).toHaveBeenCalledTimes(1)
})
it('retries only server-confirmed retry-safe failed jobs and never retries old uncertain attempts', async () => {
  const failed: SetSnapshot = {
    ...queued(await snapshotFixture()),
    job: {
      ...queued(await snapshotFixture()).job!,
      stage: 'failed',
      error: safeError('worker-failed'),
      retrySafe: false,
    },
  }
  api.lookup.mockResolvedValue(failed)
  await mount()
  await act(async () => latest.request())
  expect(api.submit).not.toHaveBeenCalled()
  failed.job!.retrySafe = true
  api.submit.mockRejectedValue(new Error('Unknown retry outcome'))
  await act(async () => latest.request())
  expect(api.submit.mock.calls[0][3]).toBe(jobId)
  api.read.mockResolvedValue(failed)
  await act(async () => latest.refresh())
  await flush()
  await act(async () => latest.request())
  expect(latest.uncertain).toBe(true)
  expect(api.submit).toHaveBeenCalledTimes(1)
})
it('fences A→B→A lookup completion and does not cancel useful shared jobs on edits', async () => {
  const pending: ((value: SetSnapshot) => void)[] = []
  api.lookup.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const a = defaultDesign(),
    b = defaultDesign({ family: 'container', lengthFt: 40 })
  for (const design of [a, b, a]) await mount(design)
  const old = await snapshotFixture(a, 1),
    other = await snapshotFixture(b),
    current = await snapshotFixture(a, 2)
  await act(async () => pending[0](old))
  await act(async () => pending[1](other))
  expect(latest.snapshot).toBeNull()
  await act(async () => pending[2](current))
  expect(latest.snapshot).toEqual(current)
  expect(api.submit).not.toHaveBeenCalled()
})
it('preserves completed images on lookup disconnect and never treats it as a miss', async () => {
  const partial = await snapshotFixture(defaultDesign(), 2)
  api.lookup.mockResolvedValue(partial)
  await mount()
  api.lookup.mockRejectedValue(new Error('Offline'))
  vi.useFakeTimers()
  await act(async () => latest.refresh())
  await act(async () => vi.advanceTimersByTimeAsync(4_000))
  expect(latest.snapshot).toEqual(partial)
  expect(latest.paused).toBe(true)
  expect(api.submit).not.toHaveBeenCalled()
})
it('pauses hidden-tab polling and stops after bounded repeated failures', async () => {
  const working = queued(await snapshotFixture(defaultDesign(), 1))
  api.lookup.mockResolvedValueOnce(working).mockRejectedValue(new Error('Offline'))
  vi.useFakeTimers()
  await act(async () => root.render(<Probe design={defaultDesign()} />))
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve())
    expect(latest.snapshot).toEqual(working)
  })
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => vi.advanceTimersByTimeAsync(100_000))
  expect(api.read).not.toHaveBeenCalled()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => vi.advanceTimersByTimeAsync(300_000))
  // Returning to the tab starts a fresh bounded read-only recovery cycle.
  expect(api.lookup.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(api.read).not.toHaveBeenCalled()
  expect(latest.paused).toBe(true)
  expect(latest.snapshot).toEqual(working)
  expect(api.submit).not.toHaveBeenCalled()
})
it('lets a public observer watch a shared job complete entirely through read-only lookups', async () => {
  const working = queued(await snapshotFixture()),
    complete = await snapshotFixture(defaultDesign(), 5)
  api.lookup.mockResolvedValueOnce(working).mockResolvedValue(complete)
  await mount()
  expect(latest.snapshot?.job?.stage).toBe('queued')
  await act(async () => latest.request())
  // Remount as another visit: a public job pointer never grants session membership.
  act(() => root.unmount())
  root = createRoot(document.createElement('div'))
  api.lookup.mockReset().mockResolvedValueOnce(working).mockResolvedValue(complete)
  vi.useFakeTimers()
  await act(async () => root.render(<Probe design={defaultDesign()} />))
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve())
    expect(latest.snapshot?.job?.stage).toBe('queued')
  })
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(latest.snapshot?.coverage).toBe('complete')
  expect(api.lookup).toHaveBeenCalledTimes(2)
  expect(api.read).not.toHaveBeenCalled()
  expect(api.submit).not.toHaveBeenCalled()
})
it('recovers an expired member session using lookup, never automatic create or join', async () => {
  const working = queued(await snapshotFixture()),
    complete = await snapshotFixture(defaultDesign(), 5)
  localStorage.setItem(
    'fury-render-library-pointers-v1',
    JSON.stringify({ [working.identity.setKey]: { jobId, joined: true } }),
  )
  api.read.mockRejectedValue(new LibraryRequestError('session-invalid', 'Membership expired'))
  api.lookup.mockResolvedValueOnce(working).mockResolvedValue(complete)
  vi.useFakeTimers()
  await act(async () => root.render(<Probe design={defaultDesign()} />))
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve())
    expect(latest.snapshot?.job?.stage).toBe('queued')
  })
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(latest.snapshot?.coverage).toBe('complete')
  expect(api.read).toHaveBeenCalledOnce()
  expect(api.lookup).toHaveBeenCalledTimes(2)
  expect(api.submit).not.toHaveBeenCalled()
})

it('recovers an initial transient lookup failure without any admission', async () => {
  const complete = await snapshotFixture(defaultDesign(), 5)
  api.lookup.mockRejectedValueOnce(new Error('Temporary disconnect')).mockResolvedValue(complete)
  vi.useFakeTimers()
  await act(async () => root.render(<Probe design={defaultDesign()} />))
  await vi.waitFor(() => expect(api.lookup).toHaveBeenCalledTimes(1))
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(latest.snapshot?.coverage).toBe('complete')
  expect(latest.paused).toBe(false)
  expect(api.submit).not.toHaveBeenCalled()
})

it('rechecks a previously idle set on reconnect and discovers images saved by another visitor', async () => {
  const complete = await snapshotFixture(defaultDesign(), 5)
  await mount()
  api.lookup.mockResolvedValue(complete)
  await act(async () => window.dispatchEvent(new Event('online')))
  await flush()
  expect(latest.snapshot?.coverage).toBe('complete')
  expect(api.lookup).toHaveBeenCalledTimes(2)
  expect(api.submit).not.toHaveBeenCalled()
})
