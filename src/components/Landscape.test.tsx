// @vitest-environment jsdom
import { act, StrictMode, useEffect } from 'react'
import { createRoot, extend, reconciler, type RootState } from '@react-three/fiber'
import * as THREE from 'three'
import { BufferGeometry, MeshStandardNodeMaterial } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../lib/config'
import type { Quality } from '../render/quality'
import * as vegetation from '../render/vegetation'
import { Landscape } from './Landscape'

vi.mock('../render/vegetation', { spy: true })
extend({
  Group: THREE.Group,
  Mesh: THREE.Mesh,
  InstancedMesh: THREE.InstancedMesh,
  PlaneGeometry: THREE.PlaneGeometry,
  CircleGeometry: THREE.CircleGeometry,
})

let root: ReturnType<typeof createRoot> | undefined
let canvas: HTMLCanvasElement
let state: RootState
let disposed: Map<object, number>
let renderGPU: ReturnType<typeof vi.fn>
let setups: number
let cleanups: number
function ReplayProbe() {
  useEffect(() => {
    setups++
    return () => {
      cleanups++
    }
  }, [])
  return null
}
const flush = async () => {
  for (let i = 0; i < 300; i++) await Promise.resolve()
}
const courtyard = (): Config => ({ ...structuredClone(DEFAULT_CONFIG), environment: 'courtyard' })
beforeEach(() => {
  root = undefined
  setups = 0
  cleanups = 0
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
  canvas = document.createElement('canvas')
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
  disposed = new Map()
  for (const prototype of new Set([
    BufferGeometry.prototype,
    THREE.BufferGeometry.prototype,
    MeshStandardNodeMaterial.prototype,
    THREE.InstancedMesh.prototype,
  ])) {
    const original = prototype.dispose
    vi.spyOn(prototype, 'dispose').mockImplementation(function (this: typeof prototype) {
      disposed.set(this, (disposed.get(this) ?? 0) + 1)
      original.call(this)
    })
  }
  renderGPU = vi.fn()
})
async function configure(strict: boolean) {
  const createContainer = reconciler.createContainer
  // R3F's createRoot hard-codes non-strict roots; enable the actual reconciler replay here.
  const spy = strict
    ? vi.spyOn(reconciler, 'createContainer').mockImplementation((...args) => {
        args[3] = true
        return createContainer(...args)
      })
    : undefined
  root = createRoot(canvas)
  spy?.mockRestore()
  await root.configure({
    gl: {
      render: renderGPU,
      domElement: canvas,
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
      xr: { isPresenting: false, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    } as unknown as THREE.WebGLRenderer,
    frameloop: 'never',
    size: { width: 800, height: 600, top: 0, left: 0 },
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    await vi.runAllTimersAsync()
    await flush()
  })
  expect(renderGPU).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function render(config: Config, quality: Quality = 'lite', strict = false) {
  if (!root) await configure(strict)
  const element = (
    <>
      <ReplayProbe />
      <Landscape config={config} quality={quality} />
    </>
  )
  await act(async () => {
    state = root!.render(strict ? <StrictMode>{element}</StrictMode> : element).getState()
    await flush()
  })
}
function meshes() {
  const result: THREE.InstancedMesh[] = []
  state.scene.traverse((object) => {
    if ((object as THREE.InstancedMesh).isInstancedMesh) result.push(object as THREE.InstancedMesh)
  })
  return result
}
function lawn() {
  return meshes().find((mesh) => mesh.instanceMatrix.count === 1300)!
}
function populated(mesh: THREE.InstancedMesh) {
  expect(mesh.count).toBeGreaterThan(0)
  expect(mesh.count).toBeLessThanOrEqual(mesh.instanceMatrix.count)
  expect(mesh.instanceMatrix.version).toBeGreaterThan(0)
  expect(mesh.boundingSphere).not.toBeNull()
  expect(Number.isFinite(mesh.boundingSphere!.radius)).toBe(true)
  expect(mesh.boundingSphere!.radius).toBeGreaterThan(0)
  for (const index of [0, Math.floor(mesh.count / 2), mesh.count - 1]) {
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(index, matrix)
    expect(matrix.elements.every(Number.isFinite)).toBe(true)
    expect(matrix.equals(new THREE.Matrix4())).toBe(false)
  }
}
function live(mesh: THREE.InstancedMesh) {
  expect(disposed.get(mesh)).toBeUndefined()
  expect(disposed.get(mesh.geometry)).toBeUndefined()
  expect(disposed.get(mesh.material)).toBeUndefined()
  populated(mesh)
}

describe('Landscape resource/instance lifecycle (real R3F reconciler, no GPU)', () => {
  it('retains lawn geometry, material and mesh across unrelated parent renders with fresh color arrays', async () => {
    await render(courtyard())
    const before = lawn()
    const materialCalls = vi.mocked(vegetation.grassMaterial).mock.calls.length
    await render(courtyard())
    expect(lawn().geometry).toBe(before.geometry)
    expect(lawn().material).toBe(before.material)
    expect(lawn()).toBe(before)
    expect(vegetation.grassMaterial).toHaveBeenCalledTimes(materialCalls)
    meshes().forEach(live)
  })
  it('preserves exact lawn transforms and bounds after a parent rerender', async () => {
    await render(courtyard())
    const before = lawn()
    const matrices = before.instanceMatrix.array.slice()
    const sphere = before.boundingSphere!.clone()
    await render({ ...courtyard(), lights: !DEFAULT_CONFIG.lights })
    expect(lawn().instanceMatrix.array).toEqual(matrices)
    expect(lawn().boundingSphere).toEqual(sphere)
    meshes().forEach(live)
  })
  it('rebinds a changed grass color without disposing geometry or losing unchanged placements', async () => {
    await render(courtyard())
    const before = meshes().find((mesh) => mesh.instanceMatrix.count === 95)!
    const matrices = before.instanceMatrix.array.slice()
    const colors = vegetation.grassPalette('courtyard').map((pair) => [...pair] as [string, string])
    colors[0][0] = '#48552a'
    vi.mocked(vegetation.grassPalette).mockReturnValueOnce(colors)
    await render(courtyard())
    const after = meshes().find((mesh) => mesh.instanceMatrix.count === 95)!
    expect(after.geometry).toBe(before.geometry)
    expect(after.material).not.toBe(before.material)
    expect(disposed.get(before.material)).toBe(1)
    expect(disposed.get(before)).toBe(1)
    expect(after.instanceMatrix.array).toEqual(matrices)
    live(after)
  })
  it('replaces a grass geometry independently of a retained material', async () => {
    await render(courtyard())
    const before = meshes().find((mesh) => mesh.instanceMatrix.count === 95)!
    vi.mocked(vegetation.grassPalette).mockReturnValueOnce(vegetation.grassPalette('courtyard'))
    await render({ ...courtyard(), environment: 'desert' })
    const after = meshes().find((mesh) => mesh.instanceMatrix.count === 60)!
    expect(after.geometry).not.toBe(before.geometry)
    expect(after.material).toBe(before.material)
    expect(disposed.get(before.geometry)).toBe(1)
    expect(disposed.get(before)).toBe(1)
    live(after)
  })
  it('keeps each tree card alive when the biome replaces only its leaf material', async () => {
    await render(courtyard())
    const trees = meshes().filter((mesh) => mesh.instanceMatrix.count === 675)
    expect(trees).toHaveLength(5)
    await render({ ...courtyard(), environment: 'desert' })
    const next = meshes().filter((mesh) => mesh.instanceMatrix.count === 725)
    expect(next).toHaveLength(5)
    for (const [i, mesh] of next.entries()) {
      expect(mesh.geometry).toBe(trees[i].geometry)
      expect(mesh.material).not.toBe(trees[i].material)
      expect(disposed.get(trees[i].material)).toBe(1)
      expect(disposed.get(trees[i])).toBe(1)
      live(mesh)
    }
  })
  it('reinitializes every instance replacement on quality changes and releases mesh-owned buffers', async () => {
    await render(courtyard())
    const before = meshes()
    await render(courtyard(), 'high')
    expect(meshes()).toHaveLength(10)
    for (const mesh of before) expect(disposed.get(mesh)).toBe(1)
    meshes().forEach(live)
    await render(courtyard())
    meshes().forEach(live)
  })
  it('does not reuse disposed grass/tree/hedge resources after StrictMode replay; disposes final resources once', async () => {
    await render(courtyard(), 'lite', true)
    expect(setups).toBe(2)
    expect(cleanups).toBe(1)
    const before = meshes()
    expect(before).toHaveLength(10)
    before.forEach(live)
    await render({ ...courtyard(), environment: 'studio' }, 'lite', true)
    expect(meshes()).toHaveLength(0)
    for (const mesh of before) {
      expect(disposed.get(mesh)).toBe(1)
      expect(disposed.get(mesh.geometry)).toBe(1)
      expect(disposed.get(mesh.material)).toBe(1)
    }
    for (const create of [vegetation.leafCard, vegetation.leafMaterial, vegetation.grassMaterial])
      for (const result of vi.mocked(create).mock.results)
        if (result.type === 'return') expect(disposed.get(result.value)).toBe(1)
  })
})
