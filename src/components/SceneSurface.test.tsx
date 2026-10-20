// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import { SceneSurface } from './SceneSurface'

const { seen, reporting } = vi.hoisted(() => {
  /** What each scene component found the geometry-reuse flag to be. */
  const seen = new Map<string, boolean>()
  /** A stand-in for a scene component that only reports the flag. */
  const reporting = (name: string) => async () => {
    const { useContext } = await import('react')
    const { GeometryReuse } = await import('../render/geometryReuse')
    return {
      [name]: () => {
        seen.set(name, useContext(GeometryReuse))
        return null
      },
    }
  }
  return { seen, reporting }
})
// The canvas stands in for React Three Fiber's own root. Fiber carries the page's contexts across
// it, but the flag is provided inside the canvas so the scene never depends on that: this canvas
// drops whatever was provided outside, to hold it there.
vi.mock('@react-three/fiber', async () => {
  const { createElement } = await import('react')
  const { GeometryReuse } = await import('../render/geometryReuse')
  return {
    Canvas: ({ children }: { children: unknown }) =>
      createElement(GeometryReuse.Provider, { value: false }, children as never),
  }
})
vi.mock('@react-three/drei', () => ({ Html: () => null }))
vi.mock('./StudioModel', reporting('StudioModel'))
vi.mock('./Landscape', reporting('Landscape'))
vi.mock('./Atmosphere', reporting('Atmosphere'))
vi.mock('./CameraRig', reporting('CameraRig'))
vi.mock('./SceneRefresh', reporting('SceneRefresh'))
vi.mock('./InteriorProbe', async () => ({
  ...(await reporting('InteriorProbe')()),
  ...(await reporting('SiteProbe')()),
}))

describe('the scene surface', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    seen.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  const mount = (reuseGeometry?: boolean) => {
    const root = createRoot(document.createElement('div'))
    act(() =>
      root.render(
        <SceneSurface
          active
          config={DEFAULT_CONFIG}
          view="exterior"
          dimensions={false}
          unit="ft"
          reset={0}
          autoRotate={false}
          quality="lite"
          mode="live"
          angle="front-left"
          effects={null}
          onFallback={() => {}}
          {...(reuseGeometry === undefined ? {} : { reuseGeometry })}
        />,
      ),
    )
    act(() => root.unmount())
  }

  it('shares part geometry across edits in its scene only when asked (the live 360° view)', () => {
    mount(true)
    expect(seen.get('StudioModel')).toBe(true)
    expect(seen.get('Landscape')).toBe(true)
    expect([...seen.values()].every(Boolean)).toBe(true)
  })

  it('keeps each part list to its own geometry by default, as the stills need', () => {
    mount()
    expect(seen.get('StudioModel')).toBe(false)
    expect(seen.get('Landscape')).toBe(false)
    mount(false)
    expect(seen.get('StudioModel')).toBe(false)
  })
})
