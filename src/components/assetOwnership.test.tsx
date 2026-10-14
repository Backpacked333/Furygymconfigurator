// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, extend, type RootState } from '@react-three/fiber'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, setFamily, type Config } from '../lib/config'
import * as addons from '../render/addons'
import { materialInventory, textureProgress } from '../render/materials'
import { StudioModel } from './StudioModel'
import { Landscape } from './Landscape'

vi.mock('../render/addons', { spy: true })
extend({
  Group: THREE.Group,
  Mesh: THREE.Mesh,
  InstancedMesh: THREE.InstancedMesh,
  PlaneGeometry: THREE.PlaneGeometry,
  CircleGeometry: THREE.CircleGeometry,
  MeshStandardMaterial: THREE.MeshStandardMaterial,
  SpotLight: THREE.SpotLight,
  PointLight: THREE.PointLight,
  RectAreaLight: THREE.RectAreaLight,
})

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
const noAddons = { deck: false, gazebo: false, roof: false, stairs: false }
const simple = (): Config => ({
  ...structuredClone(DEFAULT_CONFIG),
  addons: noAddons,
  accent: false,
  items: [],
  lights: false,
  mirror: false,
})
let root: ReturnType<typeof createRoot>
let renderer: { render: ReturnType<typeof vi.fn> }
let state: RootState

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob() })),
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 16, height: 16, close: vi.fn() })),
  )
  const context = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'canvas'
          ? canvas
          : key === 'createLinearGradient'
            ? vi.fn(() => ({ addColorStop: vi.fn() }))
            : vi.fn(),
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as CanvasRenderingContext2D,
  )
  const canvas = document.createElement('canvas')
  renderer = { render: vi.fn() }
  const gl = {
    ...renderer,
    domElement: canvas,
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    xr: { isPresenting: false, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  }
  root = createRoot(canvas)
  await root.configure({
    gl: gl as unknown as THREE.WebGLRenderer,
    frameloop: 'never',
    size: { width: 800, height: 600, top: 0, left: 0 },
  })
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
    await vi.runAllTimersAsync()
    await flush()
  })
  expect(materialInventory()).toMatchObject({ activeSets: 0, owners: 0 })
  expect(renderer.render).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function render(config: Config, landscape = false, strict = false) {
  const model = landscape ? (
    <Landscape config={config} quality="lite" />
  ) : (
    <StudioModel config={config} quality="lite" />
  )
  await act(async () => {
    state = root.render(strict ? <StrictMode>{model}</StrictMode> : model).getState()
    await flush()
  })
}
function sets(scope = 'scene') {
  return new Set(textureProgress.snapshot(scope).maps.map((map) => map.set))
}

describe('committed scene asset request budgets (R3F, no GPU renderer)', () => {
  it('never executes absent Studio addon builders or requests their exclusive maps', async () => {
    await render(simple())
    for (const builder of [
      addons.deck,
      addons.roofDeck,
      addons.stairs,
      addons.pergola,
      addons.timberAccent,
    ])
      expect(builder).not.toHaveBeenCalled()
    expect(sets()).not.toContain('teak_veneer')
    expect(textureProgress.snapshot('scene:model')).toMatchObject({ settled: true, degraded: 0 })
    expect(sets().size).toBeLessThanOrEqual(6)
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(18)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('teak_veneer'))).toBe(
      false,
    )
  })
  it('executes selected builders only and drops their ownership when disabled', async () => {
    const config = simple()
    await render({ ...config, addons: { ...noAddons, deck: true } })
    expect(addons.deck).toHaveBeenCalledOnce()
    expect(addons.roofDeck).not.toHaveBeenCalled()
    expect(addons.stairs).not.toHaveBeenCalled()
    expect(addons.pergola).not.toHaveBeenCalled()
    expect(sets()).toContain('teak_veneer')
    await render(config)
    expect(sets()).not.toContain('teak_veneer')
    expect(addons.deck).toHaveBeenCalledOnce()
    await render({ ...config, addons: { ...noAddons, roof: true, stairs: true } })
    expect(addons.roofDeck).toHaveBeenCalledOnce()
    expect(addons.stairs).toHaveBeenCalledOnce()
    expect(addons.deck).toHaveBeenCalledOnce()
    expect(textureProgress.snapshot().pending).toBe(0)
  })
  it('does not prepare outdoor assets for a studio backdrop', async () => {
    await render({ ...simple(), environment: 'studio' }, true)
    expect(fetch).not.toHaveBeenCalled()
    expect(textureProgress.snapshot().requested).toBe(0)
    await render({ ...simple(), environment: 'desert' }, true)
    expect(sets('scene:landscape')).toContain('dry_ground_01')
    expect(sets('scene:landscape')).not.toContain('leafy_grass')
    expect(sets('scene:landscape').size).toBeLessThanOrEqual(8)
    await render({ ...simple(), environment: 'studio' }, true)
    expect(textureProgress.snapshot().requested).toBe(0)
  })
  it('keeps shared materials alive through StrictMode and releases the current scene on family change', async () => {
    await render({ ...simple(), addons: { ...noAddons, deck: true } }, false, true)
    expect(textureProgress.snapshot()).toMatchObject({ settled: true, failed: 0 })
    expect(sets()).toContain('teak_veneer')
    await render(setFamily(simple(), 'container'), false, true)
    expect(sets()).not.toContain('teak_veneer')
    expect(textureProgress.snapshot()).toMatchObject({ settled: true, failed: 0 })
    expect(state.scene.children.length).toBeGreaterThan(0)
  })
})
