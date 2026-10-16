// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from './config'
import { useStagedScene } from './useStagedScene'
import { sceneProgress } from '../render/progress'
import type { Quality } from '../render/quality'

let seen: ReturnType<typeof useStagedScene>
function Probe({ config, quality }: { config: Config; quality: Quality }) {
  seen = useStagedScene(config, quality)
  return null
}

describe('changes on their way to the scene', () => {
  let root: Root
  let frames: FrameRequestCallback[]
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })
  const render = (config: Config, quality: Quality = 'high') =>
    act(() => root.render(<Probe config={config} quality={quality} />))
  const nextFrame = () =>
    act(() => {
      const pending = frames
      frames = []
      pending.forEach((cb) => cb(0))
    })

  it('passes light changes straight through', () => {
    render(DEFAULT_CONFIG)
    const next = { ...DEFAULT_CONFIG, time: 18 }
    render(next)
    expect(seen.config).toBe(next)
    expect(seen.updating).toBe(false)
  })

  it('shows "updating" a painted frame before a rebuild, until the scene draws it', () => {
    render(DEFAULT_CONFIG)
    const next = { ...DEFAULT_CONFIG, length: DEFAULT_CONFIG.length === 20 ? 40 : 20 } as Config
    render(next)
    expect(seen.updating).toBe(true)
    expect(seen.config).toBe(DEFAULT_CONFIG)
    nextFrame()
    nextFrame()
    expect(seen.config).toBe(next)
    expect(seen.updating).toBe(true)
    act(() => sceneProgress.drawn())
    expect(seen.updating).toBe(false)
  })

  it('stages a quality change the same way', () => {
    render(DEFAULT_CONFIG, 'high')
    render(DEFAULT_CONFIG, 'lite')
    expect(seen.quality).toBe('high')
    nextFrame()
    nextFrame()
    expect(seen.quality).toBe('lite')
  })
})
