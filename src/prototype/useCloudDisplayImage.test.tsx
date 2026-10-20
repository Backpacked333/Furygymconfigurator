// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, type DesignEnvelope } from '../domain/design'
import { displayHolds } from '../display/contract'
import {
  bindCloudRecipe,
  CLOUD_DISPLAY_LABEL,
  CLOUD_DISPLAY_MODE,
  CLOUD_DISPLAY_PROTOCOL,
  cloudDisplayImagePath,
  type CloudDisplayReadyReply,
} from '../display/cloudContract'
import type { CloudDisplayProgress } from './cloudDisplayClient'
import { useCloudDisplayImage } from './useCloudDisplayImage'

const calls = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('./cloudDisplayClient', async (original) => {
  const actual = await original<typeof import('./cloudDisplayClient')>()
  return {
    ...actual,
    createCloudDisplaySelectionQueue: () => actual.createCloudDisplaySelectionQueue(calls.start),
  }
})
const hash = `sha256:${'a'.repeat(64)}`
async function reply(design: DesignEnvelope): Promise<CloudDisplayReadyReply> {
  const interestId = 'synthetic-cloud-hook-interest-01'
  const recipe = await bindCloudRecipe(
    design,
    {
      sourceManifestDigest: hash,
      assetManifestDigest: hash,
      bundleDigest: hash,
      lockfileDigest: hash,
      runtimePolicyDigest: hash,
      threeRevision: '186',
    },
    hash,
    hash,
  )
  return {
    protocol: CLOUD_DISPLAY_PROTOCOL,
    mode: CLOUD_DISPLAY_MODE,
    interestId,
    recipe,
    state: 'ready',
    artifact: {
      checksum: hash,
      receiptDigest: hash,
      byteLength: 44,
      mediaType: 'image/png',
      src: cloudDisplayImagePath(interestId, hash),
      width: recipe.binding.profile.width,
      height: recipe.binding.profile.height,
      exactMatch: true,
      approvedCurrentImage: false,
      cacheStatus: 'verified-exact-hit',
      provenance: {
        kind: 'external-private-three-display',
        label: CLOUD_DISPLAY_LABEL,
        sessionId: 'synthetic-cloud-hook-session-01',
        revision: 1,
        proofDigest: hash,
        qualified: false,
        productionAllowed: false,
        strictReference: false,
        visualParityClaimed: false,
        holds: displayHolds(design),
      },
    },
  }
}

describe('cloud selection generations, inert request double only', () => {
  let root: Root, host: HTMLDivElement
  const requests: {
    design: DesignEnvelope
    notify: (event: CloudDisplayProgress) => void
    stop: ReturnType<typeof vi.fn>
  }[] = []
  let latest: ReturnType<typeof useCloudDisplayImage>
  function Probe({ design }: { design: DesignEnvelope }) {
    latest = useCloudDisplayImage(design)
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
  it('bounds active work and latest-pending Obsidian→Bronze→Obsidian; fences stale responses', async () => {
    const a = defaultDesign(),
      b = parseDesign({
        ...a,
        config: { ...a.config, appearance: { ...a.config.appearance, finish: 'bronze' } },
      })
    const receipt = await reply(a)
    await mount(a)
    expect(requests).toHaveLength(1) // StrictMode did not submit its probe.
    await mount(b)
    await mount(a)
    expect(requests).toHaveLength(1)
    expect(requests[0].stop).not.toHaveBeenCalled()
    await act(async () =>
      requests[0].notify({ state: 'ready', reply: receipt, src: 'blob:obsolete-A' }),
    )
    expect(latest.current).toBe(false)
    expect(latest.shown).toBeNull()
    expect(requests).toHaveLength(2)
    expect(requests[0].stop).toHaveBeenCalledOnce()
    expect(requests[1].design).toEqual(a)
    act(() => requests[1].notify({ state: 'ready', reply: receipt, src: 'blob:current-A' }))
    expect(latest.current).toBe(true)
    expect(latest.shown?.reply.artifact.provenance.kind).toBe('external-private-three-display')
    expect(latest.shown?.reply.recipe.recipeDigest).toBe(receipt.recipe.recipeDigest)
    act(() => requests[0].notify({ state: 'ready', reply: receipt, src: 'blob:late-A' }))
    expect(latest.shown?.src).toBe('blob:current-A')
  })
  it('invalidates full design/look/camera/aspect changes and retains only previous provenance on denial', async () => {
    const designs = [
      defaultDesign(),
      defaultDesign({ family: 'container', lengthFt: 20 }),
      defaultDesign({ family: 'container', lengthFt: 40 }),
    ]
    const d = designs.at(-1)!
    designs.push(
      parseDesign({
        ...d,
        presentation: {
          ...d.presentation,
          lookRef: 'campus-night-draft@1',
          cameraRef: 'centre-draft@1',
          aspect: 'tall',
          doorPose: 'open',
        },
      }),
    )
    await mount(designs[0])
    for (const design of designs.slice(1)) {
      const previous = requests.at(-1)!,
        receipt = await reply(previous.design)
      act(() => previous.notify({ state: 'ready', reply: receipt, src: 'blob:previous' }))
      expect(latest.current).toBe(true)
      await mount(design)
      expect(latest.current).toBe(false)
      expect(latest.progress.state).toBe('pending')
      expect(previous.stop).toHaveBeenCalledOnce()
      expect(requests.at(-1)!.design).toEqual(design)
    }
    act(() =>
      requests
        .at(-1)!
        .notify({ state: 'unavailable', message: 'Approval required', retryable: false }),
    )
    expect(latest.current).toBe(false)
    expect(latest.shown?.src).toBe('blob:previous')
    const count = requests.length
    act(() => latest.retry())
    expect(requests).toHaveLength(count)
  })
  it('disposes active work without submitting pending selections or publishing after unmount', async () => {
    await mount(defaultDesign())
    await mount(defaultDesign({ family: 'container', lengthFt: 40 }))
    const active = requests[0]
    act(() => root.render(null))
    expect(active.stop).toHaveBeenCalledOnce()
    await act(async () =>
      active.notify({ state: 'ready', reply: await reply(active.design), src: 'blob:late' }),
    )
    expect(requests).toHaveLength(1)
    expect(host.textContent).toBe('')
  })
})
