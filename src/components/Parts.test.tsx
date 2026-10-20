// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, createRoot, extend, type ReconcilerRoot } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { MeshStandardMaterial, type BufferGeometry, type Mesh, type Scene } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, FINISHES, FLOORS, type Config } from '../lib/config'
import { box, cylinder } from '../render/geometry'
import { GeometryReuse } from '../render/geometryReuse'
import { part, type Part } from '../render/parts'
import { sceneParts } from '../render/pathtrace'
import { Parts } from './Parts'
import { StudioModel } from './StudioModel'

/**
 * Parts through React Three Fiber's own reconciler, on a renderer that draws nothing: what an
 * edit keeps or remounts is the scene graph three.js objects, as the tracer and the raster see it.
 */
const fakeRenderer = () => ({
  render() {},
  setPixelRatio() {},
  setSize() {},
  getPixelRatio: () => 1,
  shadowMap: { enabled: false, type: 0 },
  domElement: document.createElement('canvas'),
  outputColorSpace: 'srgb',
  toneMapping: 0,
  dispose() {},
})

/** The cache sweeps on a later task. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

let root: ReconcilerRoot<HTMLCanvasElement> | null = null
let scene: () => Scene
async function render(element: ReactNode) {
  if (!root) {
    root = createRoot(document.createElement('canvas'))
    await root.configure({
      gl: fakeRenderer() as never,
      frameloop: 'never',
      size: { width: 64, height: 64, top: 0, left: 0 },
      events: undefined,
    })
  }
  const current = root
  await act(async () => {
    const store = current.render(element)
    scene = () => store.getState().scene as unknown as Scene
  })
}
async function unmount() {
  const current = root
  root = null
  if (current) await act(async () => current.unmount())
}

function meshes() {
  const found: Mesh[] = []
  scene().traverse((object) => {
    if ((object as Mesh).isMesh) found.push(object as Mesh)
  })
  return found
}
/** Counts each geometry's disposals from here on. */
function watch(geometries: BufferGeometry[]) {
  const counts = new Map<BufferGeometry, number>()
  for (const geometry of geometries) {
    counts.set(geometry, 0)
    geometry.addEventListener('dispose', () => counts.set(geometry, counts.get(geometry)! + 1))
  }
  return () => [...counts.values()]
}

let lift = 0
/** A list of its own shape, in two batches: the cache is shared by every test in the file. */
function shape() {
  const y = 50 + lift++
  return (finish: MeshStandardMaterial, trim: MeshStandardMaterial): Part[] => [
    part(box(2, 1, 1), finish, [0, y, 0]),
    part(cylinder(0.2, 0.2, 1), finish, [1, y, 0], [0, 0, 1]),
    part(box(1, 1, 1), trim, [0, y, 2]),
  ]
}

describe('a part list on screen', () => {
  let quiet: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    extend(THREE as never)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    quiet = vi.spyOn(console, 'error')
  })
  afterEach(async () => {
    await unmount()
    quiet.mockRestore()
    vi.unstubAllGlobals()
  })

  it('keeps its meshes and their geometry through a finish edit where geometry is reused', async () => {
    const build = shape()
    const trim = new MeshStandardMaterial()
    const [paint, bronze] = [new MeshStandardMaterial(), new MeshStandardMaterial()]
    const list = (finish: MeshStandardMaterial) => (
      <GeometryReuse.Provider value={true}>
        <Parts name="shell" parts={build(finish, trim)} />
      </GeometryReuse.Provider>
    )
    await render(list(paint))
    const before = meshes()
    expect(before).toHaveLength(2)
    const geometries = before.map((m) => m.geometry)
    const disposed = watch(geometries)
    await render(list(bronze))
    await nextTask()
    await nextTask()
    const after = meshes()
    // The same meshes, the same geometry: only the finish's material was swapped.
    expect(after).toEqual(before)
    expect(after.map((m) => m.geometry)).toEqual(geometries)
    expect(after.map((m) => m.material)).toEqual([bronze, trim])
    expect(after.every((m) => m.userData.parts === 'shell')).toBe(true)
    expect(disposed()).toEqual([0, 0])
    // Gone with the list, on a later task.
    await unmount()
    await nextTask()
    await nextTask()
    expect(disposed()).toEqual([1, 1])
  })

  it('remounts and merges afresh where geometry is not reused, as the stills always have', async () => {
    const build = shape()
    const trim = new MeshStandardMaterial()
    const [paint, bronze] = [new MeshStandardMaterial(), new MeshStandardMaterial()]
    await render(<Parts name="shell" parts={build(paint, trim)} />)
    const before = meshes()
    const geometries = before.map((m) => m.geometry)
    const disposed = watch(geometries)
    await render(<Parts name="shell" parts={build(bronze, trim)} />)
    const after = meshes()
    // Keyed by material: the repainted mesh is a new one, the trim's is kept; every geometry is
    // merged again, and the old ones disposed with the list they belonged to, at once.
    expect(after[0]).not.toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after.map((m) => m.material)).toEqual([bronze, trim])
    expect(after[0].geometry).not.toBe(geometries[0])
    expect(after[1].geometry).not.toBe(geometries[1])
    expect(disposed()).toEqual([1, 1])
  })

  it('gives one shape in two materials two meshes, never one key twice', async () => {
    const y = 80 + lift++
    const [red, blue, green] = [
      new MeshStandardMaterial(),
      new MeshStandardMaterial(),
      new MeshStandardMaterial(),
    ]
    const twice = (a: MeshStandardMaterial, b: MeshStandardMaterial) => (
      <GeometryReuse.Provider value={true}>
        <Parts parts={[part(box(1, 2, 1), a, [0, y, 0]), part(box(1, 2, 1), b, [0, y, 0])]} />
      </GeometryReuse.Provider>
    )
    await render(twice(red, blue))
    const before = meshes()
    expect(before.map((m) => m.material)).toEqual([red, blue])
    // One merged geometry for both: the same content.
    expect(before[0].geometry).toBe(before[1].geometry)
    await render(twice(green, blue))
    expect(meshes().map((m) => m.material)).toEqual([green, blue])
    expect(meshes()[0]).toBe(before[0])
    const duplicates = quiet.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('same key'),
    )
    expect(duplicates).toEqual([])
  })
})

describe('the unit through finish and floor edits, where geometry is reused', () => {
  let quiet: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    extend(THREE as never)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // The scene's signature plate draws on a 2D canvas, which jsdom lacks: anything will do.
    const context: object = new Proxy(function () {}, {
      get: (_, key) =>
        key === Symbol.toPrimitive ? () => 0 : key === 'then' ? undefined : context,
      apply: () => context,
      set: () => true,
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as never)
    quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await unmount()
    quiet.mockRestore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const unit = (config: Config) => (
    <GeometryReuse.Provider value={true}>
      <StudioModel config={config} quality="lite" />
    </GeometryReuse.Provider>
  )
  const snapshot = () => {
    scene().updateMatrixWorld(true)
    const ids: number[] = []
    scene().traverse((object) => ids.push(object.id))
    return { parts: sceneParts(scene()), ids }
  }

  it('swaps materials on the meshes it has: the tracer sees no new structure', async () => {
    let config: Config = {
      ...DEFAULT_CONFIG,
      accent: true,
      addons: { deck: true, gazebo: true, roof: true, stairs: true, canopy: false },
    }
    await render(unit(config))
    let before = snapshot()
    // The unit's part lists (their meshes carry the list's name); equipment keeps its own.
    const lists = meshes().filter((m) => typeof m.userData.parts === 'string')
    expect(new Set(lists.map((m) => m.userData.parts)).size).toBeGreaterThan(4)
    const disposed = watch(meshes().map((m) => m.geometry))
    const listDisposed = watch(lists.map((m) => m.geometry))
    const edits: Partial<Config>[] = [
      ...FINISHES.filter((f) => f.id !== config.finish).map((f) => ({ finish: f.id })),
      ...FLOORS.filter((f) => f.id !== config.flooring).map((f) => ({ flooring: f.id })),
    ]
    for (const edit of edits) {
      config = { ...config, ...edit }
      await render(unit(config))
      await nextTask()
      await nextTask()
      const after = snapshot()
      expect(after.ids, JSON.stringify(edit)).toEqual(before.ids)
      expect(after.parts.structure, JSON.stringify(edit)).toBe(before.parts.structure)
      expect(after.parts.transforms).toBe(before.parts.transforms)
      expect(after.parts.lights).toBe(before.parts.lights)
      expect(after.parts.materials, JSON.stringify(edit)).not.toBe(before.parts.materials)
      before = after
    }
    expect(disposed().every((count) => count === 0)).toBe(true)
    // An edit that reshapes the room still reads as a new structure.
    await render(unit({ ...config, interiorStyle: 'slatted' }))
    expect(snapshot().parts.structure).not.toBe(before.parts.structure)
    await unmount()
    await nextTask()
    await nextTask()
    expect(listDisposed().every((count) => count === 1)).toBe(true)
  }, 30_000)
})
