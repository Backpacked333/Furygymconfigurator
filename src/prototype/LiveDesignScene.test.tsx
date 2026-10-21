// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Scene from '../components/Scene'
import { defaultDesign, parseDesign, type DesignEnvelope } from '../domain/design'
import { createSceneDesignFixtures } from '../domain/designFixtures'
import { DEFAULT_CONFIG } from '../lib/config'
import { resolveNativeCamera } from '../render/nativeCamera'
import { arcWindow } from '../viewer/arc'
import { liveLoading, sceneProgress, textureProgress, traceProgress } from '../render/progress'
import LiveDesignScene from './LiveDesignScene'

const seen = vi.hoisted(() => ({
  /** The props each surface was given: the live 360° view's and the stills' share one. */
  surfaces: [] as Record<string, unknown>[],
  renderer: null as Record<string, unknown> | null,
  watch: null as Record<string, unknown> | null,
}))
vi.mock('../render/pathtrace', () => ({ loadTracerModule: () => Promise.resolve() }))
// The canvas is out of reach in jsdom: the surface records its props and renders only the
// scene's effects.
vi.mock('../components/SceneSurface', () => ({
  SceneSurface: (props: Record<string, unknown> & { effects: ReactNode }) => {
    seen.surfaces.push(props)
    return <>{props.effects}</>
  },
}))
vi.mock('../components/RenderEffects', () => ({ RenderEffects: () => null }))
vi.mock('../viewer/ProgressiveRenderer', () => ({
  ProgressiveRenderer: (props: Record<string, unknown>) => {
    seen.renderer = props
    return null
  },
}))
vi.mock('../viewer/EntryWatch', () => ({
  EntryWatch: (props: Record<string, unknown>) => {
    seen.watch = props
    return null
  },
}))

const liveProps = () => ({
  design: defaultDesign(),
  active: true,
  unit: 'ft' as const,
  dimensions: false,
  autoRotate: false,
  reset: 0,
  onReady: vi.fn(),
  onStatus: vi.fn(),
  onUnavailable: vi.fn(),
})

let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seen.surfaces.length = 0
  seen.renderer = seen.watch = null
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it('watches the camera leave the saved image’s own pose beside the progressive renderer', () => {
  const props = liveProps()
  const onLeaveEntry = vi.fn()
  act(() => root.render(<LiveDesignScene {...props} onLeaveEntry={onLeaveEntry} />))
  expect(seen.watch).toEqual({
    active: true,
    pose: resolveNativeCamera(props.design),
    onLeave: onLeaveEntry,
  })
  expect(Object.keys(seen.renderer!).sort()).toEqual(
    ['active', 'entry', 'look', 'onReady', 'onStatus', 'place', 'quality', 'revision'].sort(),
  )
  // No image of this design on the stage: the first trace starts from nothing.
  expect(seen.renderer!.entry).toBeUndefined()
  act(() => root.render(<LiveDesignScene {...props} active={false} />))
  expect(seen.watch).toMatchObject({ active: false, onLeave: undefined })
})

it('hands the renderer the design’s own image with the camera it was rendered from', () => {
  const props = liveProps()
  act(() => root.render(<LiveDesignScene {...props} entryImage="/native-library/a.webp" />))
  expect(seen.renderer!.entry).toEqual({
    pose: resolveNativeCamera(props.design),
    image: '/native-library/a.webp',
  })
  const first = seen.renderer!.entry
  // The same image again: the same entry, so the renderer does not prepare it twice.
  act(() => root.render(<LiveDesignScene {...props} entryImage="/native-library/a.webp" />))
  expect(seen.renderer!.entry).toBe(first)
})

describe('reporting the view’s load and refinement to the gallery', () => {
  const last = (onProgress: ReturnType<typeof vi.fn>) => onProgress.mock.lastCall![0]

  it('starts a new view’s steps over and reports each as the stores move', () => {
    act(() => liveLoading.set('ready'))
    act(() => sceneProgress.set('engine'))
    act(() => traceProgress.set({ phase: 'idle' }))
    const onProgress = vi.fn()
    act(() => root.render(<LiveDesignScene {...liveProps()} onProgress={onProgress} />))
    expect(last(onProgress)).toEqual({ step: 'engine', fraction: null, refine: { phase: 'idle' } })
    // The renderer compiles: the scene is mounting.
    act(() => sceneProgress.set('shaders'))
    expect(last(onProgress).step).toBe('scene')
    act(() => liveLoading.set('materials'))
    // Only scans asked for since this view opened count.
    act(() => textureProgress.update(4, 0))
    act(() => textureProgress.update(0, 1))
    expect(last(onProgress)).toMatchObject({ step: 'materials', fraction: 0.25 })
    act(() => textureProgress.update(0, 3))
    act(() => liveLoading.set('ready'))
    expect(last(onProgress)).toMatchObject({ step: 'ready', fraction: null })
    act(() => traceProgress.set({ phase: 'refining', fill: 0.4, stage: 'reflections' }))
    expect(last(onProgress).refine).toEqual({ phase: 'refining', fill: 0.4, stage: 'reflections' })
    act(() => traceProgress.set({ phase: 'idle' }))
  })

  it('never re-renders the 3D scene for them: a refining view reports several times a second', () => {
    act(() => liveLoading.set('ready'))
    act(() => traceProgress.set({ phase: 'idle' }))
    const onProgress = vi.fn()
    act(() => root.render(<LiveDesignScene {...liveProps()} onProgress={onProgress} />))
    const renders = seen.surfaces.length
    const reports = onProgress.mock.calls.length
    for (let fill = 0.1; fill <= 1; fill += 0.1)
      act(() => traceProgress.set({ phase: 'refining', fill, stage: 'light' }))
    act(() => textureProgress.update(2, 2))
    act(() => sceneProgress.set('ready'))
    expect(seen.surfaces.length).toBe(renders)
    expect(onProgress.mock.calls.length).toBeGreaterThan(reports + 5)
    expect(last(onProgress).refine).toMatchObject({ phase: 'refining', stage: 'light' })
    act(() => traceProgress.set({ phase: 'idle' }))
  })
})

describe('fetching the tracer as the module loads, on intent', () => {
  afterEach(() => {
    vi.doUnmock('../render/pathtrace')
    vi.resetModules()
  })
  const load = async (gpu: boolean) => {
    vi.resetModules()
    const loadTracerModule = vi.fn(() => Promise.resolve())
    vi.doMock('../render/pathtrace', () => ({ loadTracerModule }))
    if (gpu) vi.stubGlobal('navigator', { ...navigator, gpu: {} })
    await import('./LiveDesignScene')
    return loadTracerModule
  }

  it('starts on browsers with WebGPU, so a resting view can refine as soon as it is open', async () => {
    expect(await load(true)).toHaveBeenCalledOnce()
  })

  it('leaves it alone where only WebGL runs, which never traces', async () => {
    expect(await load(false)).not.toHaveBeenCalled()
  })
})

describe('who shares part geometry across edits', () => {
  const show = (element: ReactElement) => {
    act(() => root.render(element))
    return seen.surfaces.at(-1)!
  }

  it('is the live 360° view: a finish or floor edit swaps materials on the meshes it has', () => {
    const props = show(<LiveDesignScene {...liveProps()} />)
    expect(props.mode).toBe('live')
    expect(props.reuseGeometry).toBe(true)
  })

  it('is not the stills and exports, which rebuild each edit as they always have', () => {
    const props = show(
      <Scene
        active
        config={DEFAULT_CONFIG}
        view="exterior"
        dimensions={false}
        unit="ft"
        reset={0}
        autoRotate={false}
        quality="high"
        mode="gallery"
        angle="front-left"
        trace
        covered={false}
        onCaptureReady={() => {}}
        onFallback={() => {}}
      />,
    )
    expect(props.reuseGeometry).toBeUndefined()
  })
})

describe('live 360° view under ?arc= (no GPU)', () => {
  let root: Root
  const base = createSceneDesignFixtures().find((f) => f.id === 'studio-20-baseline')!.design
  const courtyard = parseDesign({
    ...base,
    presentation: { ...base.presentation, lookRef: 'courtyard-day-draft@1', aspect: 'wide' },
  })
  const show = (design: DesignEnvelope) =>
    act(() =>
      root.render(
        <LiveDesignScene
          design={design}
          active
          unit="ft"
          dimensions={false}
          autoRotate={false}
          reset={0}
          onReady={() => {}}
          onStatus={() => {}}
          onUnavailable={() => {}}
        />,
      ),
    )
  const arc = () => seen.surfaces.at(-1)!.arc

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
  })

  it('hands the orbit the design’s window, the same one across a finish edit', () => {
    window.history.replaceState(null, '', '/?experience=library&arc=180')
    show(courtyard)
    expect(arc()).toEqual(arcWindow(courtyard, 180))
    const first = arc()
    show(
      parseDesign({
        ...courtyard,
        config: {
          ...courtyard.config,
          appearance: { ...courtyard.config.appearance, finish: 'chalk' },
        },
      }),
    )
    expect(arc()).toBe(first)
    // The address is read once, on opening.
    window.history.replaceState(null, '', '/?experience=library&arc=90')
    const studio = parseDesign({
      ...courtyard,
      presentation: { ...courtyard.presentation, lookRef: 'studio-day-draft@1' },
    })
    show(studio)
    expect(arc()).toEqual(arcWindow(studio, 180))
    expect(arc()).not.toEqual(first)
  })

  it('leaves the orbit free without ?arc=', () => {
    window.history.replaceState(null, '', '/?experience=library')
    show(courtyard)
    expect(arc()).toBeUndefined()
  })
})
