// @vitest-environment jsdom
import { Scene, Texture, PerspectiveCamera, Vector3 } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSession } from './cloud'
import type { PathTraceSession, TraceView } from './pathtrace'
import { LOCAL_AFTER_MS, TraceSession } from './session'
import type { TraceState } from './traceStatus'

function fakeLocal() {
  const shown = new Texture()
  return {
    shown,
    tracer: { target: new Texture() },
    begin: vi.fn(),
    retarget: vi.fn(),
    halt: vi.fn(),
    invalidate: vi.fn(),
    step: vi.fn(() => true),
    ready: vi.fn(() => false),
    view: vi.fn((): TraceView => ({ from: null, to: shown, t: 1, gain: 1 })),
    state: 'tracing' as TraceState,
    samples: 12,
    target: 256,
  }
}

function fakeCloud(warm: boolean, cached = false) {
  const image = new Texture()
  const cloud = {
    client: { warm },
    hasCached: vi.fn(() => cached),
    onArrive: null as (() => Texture | null) | null,
    arrived: false,
    failed: false,
    state: 'tracing' as TraceState,
    from: null as Texture | null,
    begin: vi.fn(),
    halt: vi.fn(),
    dispose: vi.fn(),
    step: vi.fn(() => cloud.state !== 'converged'),
    view: vi.fn((): TraceView => ({
      from: cloud.from,
      to: image,
      t: cloud.arrived ? 1 : 0,
      gain: 1,
    })),
    arrive() {
      cloud.from = cloud.onArrive?.() ?? null
      cloud.arrived = true
      cloud.state = 'converged'
    },
  }
  return cloud
}

const args = () => [new Scene(), new PerspectiveCamera(), {} as never, new Texture()] as const

describe('TraceSession', () => {
  let now = 0
  beforeEach(() => {
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })
  afterEach(() => vi.restoreAllMocks())

  it('gives a warm cloud GPU a head start before tracing locally', () => {
    const local = fakeLocal()
    const cloud = fakeCloud(true)
    const session = new TraceSession(
      local as unknown as PathTraceSession,
      cloud as unknown as CloudSession,
    )
    session.begin(...args())
    expect(cloud.begin).toHaveBeenCalled()
    expect(local.begin).not.toHaveBeenCalled()
    expect(session.source).toBe('cloud')
    session.step()
    expect(local.begin).not.toHaveBeenCalled()
    now += LOCAL_AFTER_MS + 1
    session.step()
    expect(local.begin).toHaveBeenCalled()
    expect(session.source).toBe('local')
  })

  it('traces locally at once while a cold cloud GPU starts, then hands over', () => {
    const local = fakeLocal()
    const cloud = fakeCloud(false)
    const session = new TraceSession(
      local as unknown as PathTraceSession,
      cloud as unknown as CloudSession,
    )
    session.begin(...args())
    expect(local.begin).toHaveBeenCalled()
    expect(session.view().to).toBe(local.shown)
    cloud.arrive()
    // The cloud image fades from what the local tracer showed, which then stops.
    expect(cloud.from).toBe(local.shown)
    session.step()
    expect(local.halt).toHaveBeenCalledTimes(1)
    expect(session.view().to).not.toBe(local.shown)
    expect(session.state).toBe('converged')
    expect(session.ready(384)).toBe(true)
  })

  it('carries a view on to the export target when a capture asks, from the start if it waits already', () => {
    const local = fakeLocal()
    const cloud = fakeCloud(true)
    const session = new TraceSession(
      local as unknown as PathTraceSession,
      cloud as unknown as CloudSession,
    )
    // The cloud has its head start: the local tracer is not running yet. The export's target is
    // kept for when it starts.
    session.begin(...args(), 256)
    session.retarget(384)
    expect(local.retarget).not.toHaveBeenCalled()
    now += LOCAL_AFTER_MS + 1
    session.step()
    expect(local.begin).toHaveBeenLastCalledWith(...args().map(() => expect.anything()), 384)
    // Already at it: nothing to raise, and never back down.
    session.retarget(384)
    session.retarget(256)
    expect(local.retarget).not.toHaveBeenCalled()
    // Running at the resting target when the capture asks: carried on in place, once.
    const cold = fakeLocal()
    const direct = new TraceSession(cold as unknown as PathTraceSession, null)
    direct.begin(...args(), 256)
    expect(cold.begin).toHaveBeenCalledWith(...args().map(() => expect.anything()), 256)
    direct.retarget(384)
    direct.retarget(384)
    expect(cold.retarget).toHaveBeenCalledTimes(1)
    expect(cold.retarget).toHaveBeenCalledWith(384)
    expect(direct.target).toBe(cold.target)
  })

  it('shows a pre-rendered view without tracing locally, even once the GPU is off', () => {
    const local = fakeLocal()
    const cloud = fakeCloud(false, true)
    const session = new TraceSession(
      local as unknown as PathTraceSession,
      cloud as unknown as CloudSession,
    )
    const orbit = { target: new Vector3(0, 4, 0) }
    session.begin(...args(), 1024, orbit)
    expect(cloud.begin).toHaveBeenCalledWith(...args().map(() => expect.anything()), orbit)
    expect(local.begin).not.toHaveBeenCalled()
    cloud.arrive()
    session.step()
    expect(local.begin).not.toHaveBeenCalled()
    expect(session.source).toBe('cloud')
  })

  it('falls back to this device when the cloud render fails', () => {
    const local = fakeLocal()
    const cloud = fakeCloud(true)
    const session = new TraceSession(
      local as unknown as PathTraceSession,
      cloud as unknown as CloudSession,
    )
    session.begin(...args())
    cloud.failed = true
    cloud.state = 'off'
    session.step()
    expect(local.begin).toHaveBeenCalled()
    expect(session.state).toBe('tracing')
  })

  it('works with only one of the two', () => {
    const local = fakeLocal()
    const alone = new TraceSession(local as unknown as PathTraceSession, null)
    alone.begin(...args())
    expect(local.begin).toHaveBeenCalled()
    expect(alone.source).toBe('local')

    const cloud = fakeCloud(false)
    const remote = new TraceSession(null, cloud as unknown as CloudSession)
    remote.begin(...args())
    expect(remote.view().t).toBe(0)
    cloud.arrive()
    expect(cloud.from).toBeNull()
    expect(remote.view().t).toBe(1)
  })

  it('stops both when the view changes', () => {
    const local = fakeLocal()
    const cloud = fakeCloud(false)
    const session = new TraceSession(
      local as unknown as PathTraceSession,
      cloud as unknown as CloudSession,
    )
    session.begin(...args())
    session.halt()
    expect(cloud.halt).toHaveBeenCalled()
    expect(local.halt).toHaveBeenCalled()
  })
})
