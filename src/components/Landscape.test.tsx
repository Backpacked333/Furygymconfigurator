// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../lib/config'

// Plants' instances and their canvas-painted leaves need a GPU scene and a 2D canvas, which jsdom
// lacks; neither asks for a scan.
vi.mock('./useInstances', () => ({ useInstances: () => ({ current: null }) }))
vi.mock('../render/vegetation', async (actual) => {
  const vegetation = await actual<typeof import('../render/vegetation')>()
  const { MeshStandardNodeMaterial } = await import('three/webgpu')
  const plain = () => new MeshStandardNodeMaterial()
  return { ...vegetation, leafMaterial: plain, grassMaterial: plain }
})

/** The scan sets a setting downloads as it mounts, and what it mounts. */
async function render(config: Config) {
  // A fresh material library, which downloads (decoded off the main thread) as in a browser.
  vi.resetModules()
  const urls: string[] = []
  vi.stubGlobal('createImageBitmap', vi.fn())
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url)
      return new Promise(() => {})
    }),
  )
  const { Landscape } = await import('./Landscape')
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(<Landscape config={config} quality="lite" />))
  const mounted = [...container.children].map((child) => child.tagName.toLowerCase())
  act(() => root.unmount())
  const sets = new Set(urls.map((url) => url.split('/textures/')[1].split('/')[0]))
  return { sets, mounted }
}

/** What the garden's paving, wall, coping, steps, gravel and steel edging are made of. */
const HARDSCAPE = [
  'concrete_pavement',
  'concrete_wall_001',
  'concrete_slab_wall',
  'clean_pebbles',
  'powder_coat',
]

describe('the garden settings', () => {
  let quiet: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // The scene's elements are not HTML, which React DOM says of each: not the point here.
    quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    quiet.mockRestore()
    vi.unstubAllGlobals()
  })

  it('download no scan on the Studio look, which shows its backdrop floor alone', async () => {
    const { sets, mounted } = await render({ ...DEFAULT_CONFIG, environment: 'studio' })
    expect(mounted).toEqual(['mesh'])
    // The hardscape it never shows held the live view's trace until its 7.8 MB had arrived.
    expect([...sets]).toEqual([])
  })

  it('still build their hardscape, with its scans, wherever it is shown', async () => {
    for (const environment of ['courtyard', 'desert'] as const) {
      const { sets, mounted } = await render({ ...DEFAULT_CONFIG, environment })
      expect(mounted, environment).toEqual(['group'])
      expect([...sets], environment).toEqual(expect.arrayContaining(HARDSCAPE))
    }
  })
})
