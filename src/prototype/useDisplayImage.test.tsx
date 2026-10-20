// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, type DesignEnvelope } from '../domain/design'
import {
  bindDisplay,
  DISPLAY_FLAGS,
  DISPLAY_LABEL,
  DISPLAY_MODE,
  DISPLAY_PROTOCOL,
  displayHolds,
  displayImagePath,
  type DisplayReadyReply,
} from '../display/contract'
import type { DisplayProgress } from './displayClient'
import { useDisplayImage } from './useDisplayImage'

const calls = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('./displayClient', async (original) => {
  const actual = await original<typeof import('./displayClient')>()
  return {
    ...actual,
    createDisplaySelectionQueue: () => actual.createDisplaySelectionQueue(calls.start),
  }
})
const hash = `sha256:${'a'.repeat(64)}`
async function syntheticReply(design: DesignEnvelope): Promise<DisplayReadyReply> {
  const interestId = 'synthetic-hook-interest-00001'
  const binding = await bindDisplay(design, {
    sourceManifestDigest: hash,
    assetManifestDigest: hash,
    bundleDigest: hash,
    lockfileDigest: hash,
    runtimePolicyDigest: hash,
    threeRevision: '186',
  })
  return {
    protocol: DISPLAY_PROTOCOL,
    mode: DISPLAY_MODE,
    interestId,
    binding,
    state: 'ready',
    artifact: {
      checksum: hash,
      receiptDigest: hash,
      byteLength: 44,
      mediaType: 'image/png',
      src: displayImagePath(interestId, hash),
      width: binding.profile.width,
      height: binding.profile.height,
      exactMatch: true,
      approvedCurrentImage: false,
      cacheStatus: 'verified-exact-hit',
      provenance: {
        kind: 'private-three-display',
        label: DISPLAY_LABEL,
        sessionId: 'synthetic-hook-session-00001',
        revision: 1,
        flags: DISPLAY_FLAGS,
        holds: displayHolds(design),
      },
    },
  }
}

describe('display hook selection generations (request double, no image/network)', () => {
  let root: Root, host: HTMLDivElement
  const requests: {
    design: DesignEnvelope
    notify: (event: DisplayProgress) => void
    stop: ReturnType<typeof vi.fn>
  }[] = []
  let latest: ReturnType<typeof useDisplayImage>
  function Probe({ design }: { design: DesignEnvelope }) {
    latest = useDisplayImage(design)
    return <div data-current={String(latest.current)}>{latest.progress.state}</div>
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('crypto', webcrypto)
    requests.length = 0
    calls.start.mockReset().mockImplementation((design, notify) => {
      const stop = vi.fn()
      requests.push({ design, notify, stop })
      notify({ state: 'pending' })
      return stop
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })
  async function mount(design: DesignEnvelope) {
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe design={design} />
        </StrictMode>,
      ),
    )
  }
  it('does not submit StrictMode probes and rejects obsolete A→B→A generations', async () => {
    const a = defaultDesign(),
      b = defaultDesign({ family: 'container', lengthFt: 40 })
    const reply = await syntheticReply(a)
    await mount(a)
    expect(requests).toHaveLength(1)
    expect(requests[0].stop).not.toHaveBeenCalled()
    act(() => requests[0].notify({ state: 'ready', reply, src: 'blob:old-A' }))
    expect(latest.current).toBe(true)
    await mount(b)
    expect(latest.current).toBe(false)
    expect(latest.shown?.src).toBe('blob:old-A')
    expect(requests[0].stop).toHaveBeenCalledOnce()
    await mount(a)
    expect(latest.current).toBe(false)
    act(() => requests[0].notify({ state: 'ready', reply, src: 'blob:stale-A' }))
    expect(latest.current).toBe(false)
    expect(requests).toHaveLength(2)
    expect(requests[1].stop).not.toHaveBeenCalled()
    await act(async () =>
      requests[1].notify({ state: 'ready', reply: await syntheticReply(b), src: 'blob:stale-B' }),
    )
    expect(requests).toHaveLength(3)
    expect(latest.current).toBe(false)
    act(() => requests.at(-1)!.notify({ state: 'ready', reply, src: 'blob:new-A' }))
    expect(latest.current).toBe(true)
    expect(latest.shown?.src).toBe('blob:new-A')
  })
  it('immediately invalidates finish, door, family, size, look, camera and aspect revisions', async () => {
    let design = defaultDesign()
    const changes = [
      (d: DesignEnvelope) => ({
        ...d,
        config: { ...d.config, appearance: { ...d.config.appearance, finish: 'bronze' } },
      }),
      (d: DesignEnvelope) => ({ ...d, presentation: { ...d.presentation, doorPose: 'open' } }),
      () => defaultDesign({ family: 'container', lengthFt: 20 }),
      () => defaultDesign({ family: 'container', lengthFt: 40 }),
      (d: DesignEnvelope) => ({
        ...d,
        presentation: { ...d.presentation, lookRef: 'campus-night-draft@1' },
      }),
      (d: DesignEnvelope) => ({
        ...d,
        presentation: { ...d.presentation, cameraRef: 'centre-draft@1' },
      }),
      (d: DesignEnvelope) => ({ ...d, presentation: { ...d.presentation, aspect: 'tall' } }),
    ]
    await mount(design)
    for (const change of changes) {
      const reply = await syntheticReply(design),
        previous = requests.at(-1)!
      act(() => previous.notify({ state: 'ready', reply, src: 'blob:previous' }))
      expect(latest.current).toBe(true)
      design = parseDesign(change(design))
      await mount(design)
      expect(latest.current).toBe(false)
      expect(latest.progress.state).toBe('pending')
      expect(previous.stop).toHaveBeenCalledOnce()
      expect(requests.at(-1)!.design).toEqual(design)
      act(() => previous.notify({ state: 'ready', reply, src: 'blob:obsolete' }))
      expect(latest.current).toBe(false)
    }
  })
  it('retains only previous provenance on failure and ignores callbacks after unmount', async () => {
    const a = defaultDesign(),
      reply = await syntheticReply(a)
    await mount(a)
    act(() => requests.at(-1)!.notify({ state: 'ready', reply, src: 'blob:A' }))
    await mount(defaultDesign({ family: 'container', lengthFt: 20 }))
    act(() =>
      requests
        .at(-1)!
        .notify({ state: 'unavailable', message: 'No operator permit', retryable: false }),
    )
    expect(latest).toMatchObject({
      current: false,
      progress: { state: 'unavailable', retryable: false },
      shown: { src: 'blob:A' },
    })
    const count = requests.length
    act(() => latest.retry())
    expect(requests).toHaveLength(count)
    const current = requests.at(-1)!
    act(() => root.render(null))
    expect(current.stop).toHaveBeenCalledOnce()
    act(() => current.notify({ state: 'ready', reply, src: 'blob:late' }))
    expect(host.textContent).toBe('')
  })
  it('keeps active A bounded while replacing queued selections, including A→B→A', async () => {
    const a = defaultDesign(),
      b = defaultDesign({ family: 'container', lengthFt: 40 })
    const reply = await syntheticReply(a)
    await mount(a)
    const active = requests[0]
    await mount(b)
    await mount(a)
    expect(latest.progress.state).toBe('pending')
    expect(requests).toHaveLength(1)
    expect(active.stop).not.toHaveBeenCalled()
    await act(async () => active.notify({ state: 'ready', reply, src: 'blob:obsolete-A' }))
    expect(latest.current).toBe(false)
    expect(latest.shown).toBeNull()
    expect(requests).toHaveLength(2)
    expect(active.stop).toHaveBeenCalledOnce()
    expect(requests[1].design).toEqual(a)
    act(() => requests[1].notify({ state: 'ready', reply, src: 'blob:current-A' }))
    expect(latest.current).toBe(true)
    expect(latest.shown?.src).toBe('blob:current-A')
  })
  it('unmount cancels the active request and never submits the queued selection', async () => {
    await mount(defaultDesign())
    await mount(defaultDesign({ family: 'container', lengthFt: 40 }))
    const active = requests[0]
    act(() => root.render(null))
    expect(active.stop).toHaveBeenCalledOnce()
    await act(async () =>
      active.notify({ state: 'unavailable', message: 'Cancelled', retryable: false }),
    )
    expect(requests).toHaveLength(1)
  })
})
