// @vitest-environment jsdom
import { act, useEffect, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StillsSnapshot } from '../render/stillStatus'
import { PILL_DELAY_MS, RenderStatus } from './RenderStatus'
import { LOADING_SHOWN_MS, StillLayers } from './StillStage'
import { EMPTY_STAGE, initialStage, showsWanted, stageReducer, type Layer } from './stillStageState'
import { useStillStage } from './useStillStage'

/** The stage as App.tsx wires it: the stills, and the status over them while one is awaited. */
function Stage({ design, snapshot }: { design: string; snapshot: StillsSnapshot }) {
  const stage = useStillStage({ design, angle: 'front-left', aspect: 'wide', snapshot })
  return (
    <>
      <StillLayers stage={stage} label="still" />
      <RenderStatus
        pending={snapshot.source !== null && !stage.current}
        swaps={stage.state.swaps}
        what="Graphite"
        progress={snapshot.design === design ? snapshot.progress : null}
      />
    </>
  )
}

/** What the 3D view publishes: a design's still at the stage's angle, or none yet. */
const snapshot = (design: string, url?: string): StillsSnapshot => ({
  source: 'cloud',
  design,
  aspect: 'wide',
  images: url ? { 'front-left': { still: { tier: 'still', url } } } : {},
  pending: { 'front-left': !url },
  progress: url ? null : { kind: 'estimate', startedAt: performance.now(), expectedMs: 6000 },
})

describe('an option clicked on the stage', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as never
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  const show = async (design: string, published: StillsSnapshot) => {
    await act(async () => root.render(<Stage design={design} snapshot={published} />))
  }
  const pill = () => (container.querySelector('.render-pill') as HTMLElement).dataset.phase
  const shown = () => container.querySelector('.still-layer.is-shown')?.getAttribute('src')
  /** Lets time pass, a frame at a time, the pill's phase at each. */
  const frames = async (ms: number) => {
    const phases = new Set<string>()
    for (let t = 0; t < ms; t += 16) {
      await act(async () => vi.advanceTimersByTime(16))
      phases.add(pill()!)
    }
    return phases
  }

  it('swaps a prefetched still in at once, with no status at all', async () => {
    await show('d1', snapshot('d1', 'blob:obsidian'))
    await frames(600)
    expect(shown()).toBe('blob:obsidian')
    // The click: the 3D view has not named the new design yet, for the two frames its scene
    // takes to settle; then it does, with the prefetched still (stills.ts names a prefetched
    // sibling the frame its scene is whole).
    await show('d2', snapshot('d1', 'blob:obsidian'))
    const waiting = await frames(32)
    await show('d2', snapshot('d2', 'blob:graphite'))
    const after = await frames(PILL_DELAY_MS + 600)
    expect(shown()).toBe('blob:graphite')
    expect(new Set([...waiting, ...after])).toEqual(new Set(['hidden']))
    expect(container.querySelector('[role=status]')!.textContent).toBe('')
  })

  it('shows the pill for a still that is still rendering, then one swap and "Updated"', async () => {
    await show('d1', snapshot('d1', 'blob:obsidian'))
    await frames(600)
    await show('d2', snapshot('d2'))
    const waiting = await frames(PILL_DELAY_MS + 100)
    expect(waiting).toContain('rendering')
    expect(shown()).toBe('blob:obsidian')
    await show('d2', snapshot('d2', 'blob:graphite'))
    expect(await frames(100)).toContain('done')
    expect(shown()).toBe('blob:graphite')
  })
})

/** The stage's layers alone, from a state of their own: `first` on it, then `offer` offered. */
function Layers({ first, loading, offer }: { first: Layer; loading: boolean; offer?: Layer }) {
  const [state, dispatch] = useReducer(stageReducer, null, () => {
    const want = { design: first.design, angle: first.angle }
    return loading ? initialStage(want, first) : { ...EMPTY_STAGE, want, shown: first }
  })
  useEffect(() => {
    if (offer) dispatch({ type: 'offer', layer: offer })
  }, [offer])
  const stage = {
    state,
    dispatch,
    current: showsWanted(state),
    covered: true,
    visible: !!state.shown && !state.loading,
  } as ReturnType<typeof useStillStage>
  return <StillLayers stage={stage} label="still" />
}

describe('the stage’s images', () => {
  let container: HTMLDivElement
  let root: Root
  const decode = vi.fn<() => Promise<void>>()
  let complete = false
  const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete')
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    complete = false
    HTMLImageElement.prototype.decode = decode
    Object.defineProperty(HTMLImageElement.prototype, 'complete', {
      configurable: true,
      get: () => complete,
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    decode.mockReset()
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode
    if (original) Object.defineProperty(HTMLImageElement.prototype, 'complete', original)
  })
  const baked: Layer = {
    design: 'd1|wide',
    angle: 'front-left',
    tier: 'export',
    url: '/stills/v1/d1/front-left-wide-2400.aaaa.webp',
    srcset: '/stills/v1/d1/front-left-wide-320.aaaa.webp 320w',
    sizes: '100vw',
    samples: 1024,
  }
  const rendered: Layer = { design: 'd1|wide', angle: 'front-left', tier: 'still', url: 'blob:a' }
  const loadingLine = () => container.querySelector('.still-loading')
  const shown = () => container.querySelector('.still-layer.is-shown')?.getAttribute('src')

  it('says the page’s first still is on its way when it is slow, and shows it whole once in', async () => {
    let decoded = () => {}
    decode.mockImplementation(() => new Promise<void>((resolve) => (decoded = resolve)))
    await act(async () => root.render(<Layers first={baked} loading />))
    expect(container.querySelector('.still-layer')!.className).toContain('is-loading')
    expect(loadingLine()).toBeNull()
    await act(async () => vi.advanceTimersByTime(LOADING_SHOWN_MS))
    expect(loadingLine()?.textContent).toBe('Loading the picture')
    await act(async () => decoded())
    expect(container.querySelector('.still-layer')!.className).not.toContain('is-loading')
    expect(loadingLine()).toBeNull()
  })

  it('waits for a still whose decode a resize cut short, rather than dropping it', async () => {
    decode.mockRejectedValue(new DOMException('cut short', 'EncodingError'))
    const offer: Layer = { ...rendered, tier: 'export', url: 'blob:export' }
    await act(async () => root.render(<Layers first={rendered} loading={false} offer={offer} />))
    const pending = container.querySelector('.still-layer.is-pending')!
    expect(pending.getAttribute('src')).toBe('blob:export')
    expect(shown()).toBe('blob:a')
    complete = true
    await act(async () => pending.dispatchEvent(new Event('load')))
    expect(shown()).toBe('blob:export')
  })

  it('drops a still that will not load, keeping the one shown', async () => {
    decode.mockRejectedValue(new DOMException('broken', 'EncodingError'))
    const offer: Layer = { ...rendered, tier: 'export', url: 'blob:broken' }
    await act(async () => root.render(<Layers first={rendered} loading={false} offer={offer} />))
    const pending = container.querySelector('.still-layer.is-pending')!
    await act(async () => pending.dispatchEvent(new Event('error')))
    expect(container.querySelector('.still-layer.is-pending')).toBeNull()
    expect(shown()).toBe('blob:a')
  })
})
