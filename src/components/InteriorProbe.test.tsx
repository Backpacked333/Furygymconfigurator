// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Scene, Texture } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import { setProbeEnvironment } from '../render/materials'
import { DEBOUNCE_MS, InteriorProbe } from './InteriorProbe'

/** The frame loop as the probe subscribes to it: the latest callback, run by hand. */
const { frame, invalidate, three } = vi.hoisted(() => ({
  frame: { current: null as (() => void) | null },
  invalidate: vi.fn(),
  three: { gl: {}, scene: null as unknown },
}))
vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ gl: three.gl, scene: three.scene, invalidate }),
  useFrame: (callback: () => void) => {
    frame.current = callback
  },
}))
vi.mock('../render/materials', () => ({
  onMaterialsChanged: vi.fn(() => () => {}),
  setProbeEnvironment: vi.fn(),
}))
// The radiance cube is captured without a GPU.
vi.mock('three/webgpu', async (original) => ({
  ...(await original<typeof import('three/webgpu')>()),
  PMREMGenerator: class {
    fromScene(...args: [unknown, number, number, number, { size: number }]) {
      return { texture: new Texture(), height: 4 * args[4].size, dispose() {} }
    }
    dispose() {}
  },
}))

describe('the interior probe', () => {
  let root: Root
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    three.scene = new Scene()
    vi.mocked(setProbeEnvironment).mockClear()
    invalidate.mockClear()
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const draw = () => act(() => frame.current!())
  const captures = () => vi.mocked(setProbeEnvironment).mock.calls.length

  it('captures in its first frame, before the spin signs the scene, and later edits after a pause', () => {
    act(() => root.render(<InteriorProbe config={DEFAULT_CONFIG} quality="lite" />))
    // The first frame, at once: the materials it lights change shader for a probe that first
    // exists, which the spin's fingerprint would otherwise read as an edit a frame later.
    draw()
    expect(captures()).toBe(1)
    expect(setProbeEnvironment).toHaveBeenLastCalledWith('interior', expect.any(Texture))
    // Three more passes (each a diffuse bounce of the one before), a frame apart, then nothing.
    for (let pass = 2; pass <= 4; pass++) {
      draw()
      expect(captures()).toBe(pass)
    }
    draw()
    expect(captures()).toBe(4)
    // An edit is captured once it has held still: a slider drag is many.
    act(() =>
      root.render(
        <InteriorProbe
          config={{ ...DEFAULT_CONFIG, mirror: !DEFAULT_CONFIG.mirror }}
          quality="lite"
        />,
      ),
    )
    draw()
    expect(captures()).toBe(4)
    vi.advanceTimersByTime(DEBOUNCE_MS)
    draw()
    expect(captures()).toBe(5)
    // Unmounted, the probe takes its environment away.
    act(() => root.unmount())
    expect(setProbeEnvironment).toHaveBeenLastCalledWith('interior', null)
  })
})
