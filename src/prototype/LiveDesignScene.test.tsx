// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Scene from '../components/Scene'
import { defaultDesign } from '../domain/design'
import { DEFAULT_CONFIG } from '../lib/config'
import { resolveNativeCamera } from '../render/nativeCamera'
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
    ['active', 'look', 'onReady', 'onStatus', 'place', 'quality', 'revision'].sort(),
  )
  act(() => root.render(<LiveDesignScene {...props} active={false} />))
  expect(seen.watch).toMatchObject({ active: false, onLeave: undefined })
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
