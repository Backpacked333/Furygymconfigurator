// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Group, Mesh, MeshStandardMaterial, Scene, type Material } from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, FINISHES, FLOORS, type Config } from '../lib/config'
import { skyLook } from '../lib/visuals'
import { captureScene, stableJson } from './cloud'
import { box } from './geometry'
import { batch } from './parts'
import { captureSibling, deriveSibling, partKeys, siblingKeys } from './siblings'
import { UNIT_LISTS } from './unitParts'

// The sky map takes seconds to compute: a scene capture gets a tiny one.
vi.mock('./pathtrace', async (original) => {
  const actual = await original<typeof import('./pathtrace')>()
  const { DataTexture, FloatType, RGBAFormat } = await import('three/webgpu')
  const sky = new DataTexture(new Float32Array(8).fill(0.5), 2, 1, RGBAFormat, FloatType)
  return { ...actual, environmentTexture: () => sky }
})

const look = skyLook('residences', 16.5)
/** Something of the scene no option touches: the ground. */
const ground = new MeshStandardMaterial({ color: '#7a7466' })

/**
 * A design's scene as StudioModel builds it from the unit's part lists: the shell and glazing in
 * a group seen from both sides, the room in its own, the additions outside, each list's meshes
 * merged by material and named by the list.
 */
function sceneOf(config: Config) {
  const scene = new Scene()
  const unit = new Group()
  unit.userData = { unit: true }
  const shared = new Group()
  shared.userData = { shared: true }
  const interior = new Group()
  interior.userData = { interior: true }
  unit.add(shared, interior)
  scene.add(unit)
  const into = { shared, interior, outside: unit }
  for (const list of UNIT_LISTS) {
    if (!list.shown(config)) continue
    for (const b of batch(list.build(config))) {
      const mesh = new Mesh(b.geometry, b.material)
      mesh.userData = { parts: list.name }
      into[list.scope].add(mesh)
    }
  }
  scene.add(new Mesh(box(60, 0.1, 60), ground))
  scene.updateMatrixWorld()
  return scene
}

const materialsOf = (scene: Scene) => {
  const list: Material[] = []
  scene.traverse((object) => {
    if ((object as Mesh).isMesh) list.push((object as Mesh).material as Material)
  })
  return list
}

/** Designs to derive from: the default Studio, one dressed up with every addition, a Container. */
const BASES: Config[] = [
  DEFAULT_CONFIG,
  {
    ...DEFAULT_CONFIG,
    interiorStyle: 'slatted',
    accent: true,
    addons: { deck: true, gazebo: true, roof: true, stairs: true, canopy: false },
    flooring: 'oak',
  },
  {
    ...DEFAULT_CONFIG,
    family: 'container',
    studioDoor: 'hinged',
    doorsOpen: true,
    finish: 'olive',
    interiorStyle: 'timber',
    addons: { deck: true, gazebo: false, roof: false, stairs: false, canopy: true },
  },
]
const siblingsOf = (config: Config): Config[] => [
  ...FINISHES.filter((f) => f.id !== config.finish).map((f) => ({ ...config, finish: f.id })),
  ...FLOORS.filter((f) => f.id !== config.flooring).map((f) => ({ ...config, flooring: f.id })),
]

describe('a sibling design', () => {
  it('follows from the design by swapping surfaces only for a finish or a floor', () => {
    const finish = deriveSibling(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, finish: 'bronze' })
    expect(finish?.swaps.length).toBeGreaterThan(0)
    expect(new Set(finish!.swaps.map((swap) => swap.list))).toContain('shell')
    for (const swap of finish!.swaps) expect(swap.to).not.toBe(swap.from)
    const floor = deriveSibling(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, flooring: 'oak' })
    expect(floor?.swaps.map((swap) => swap.list)).toEqual(['interior'])
    // Anything else builds, places, or lights the scene differently: a click re-renders it.
    for (const other of [
      { interiorStyle: 'slatted' },
      { environment: 'desert' },
      { studioDoor: 'sliding' },
      { doorsOpen: true },
      { time: 9 },
      { finish: 'bronze', flooring: 'oak' },
      {},
    ] as Partial<Config>[])
      expect(deriveSibling(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, ...other })).toBeNull()
  })

  it('is signed exactly as the scene a click on it builds, for every finish and floor', () => {
    let derived = 0
    let total = 0
    for (const base of BASES) {
      const scene = sceneOf(base)
      const keys = partKeys(scene, look)
      for (const sibling of siblingsOf(base)) {
        total++
        const derivation = deriveSibling(base, sibling)
        // A swap that would merge the model differently is not derived (it would not be exact).
        if (!derivation) continue
        derived++
        const shot = captureSibling(scene, look, derivation, keys)
        expect(shot).not.toBeNull()
        expect(shot!.keys).toEqual(partKeys(sceneOf(sibling), look))
        // A finish is seen outside: the exterior's fingerprint changes. A floor only inside.
        if (sibling.flooring !== base.flooring) expect(shot!.keys.exterior).toBe(keys.exterior)
        else expect(shot!.keys.exterior).not.toBe(keys.exterior)
      }
      // Nothing of the live scene changed meanwhile.
      expect(partKeys(scene, look)).toEqual(keys)
    }
    // Every one is prefetched today (27 of 27): a change that stops one should be a choice.
    expect(derived).toBe(total)
    // Three designs, each rebuilt for each of its nine siblings: about two seconds on a fast
    // machine, so a loaded CI runner gets room.
  }, 30_000)

  it('is signed without a capture or its scans, as its capture signs it', () => {
    const base = BASES[1]
    const scene = sceneOf(base)
    const keys = partKeys(scene, look)
    const before = materialsOf(scene)
    for (const sibling of [
      { ...base, finish: 'bronze' as const },
      { ...base, flooring: 'rubber' as const },
    ]) {
      const derivation = deriveSibling(base, sibling)!
      const signed = siblingKeys(scene, look, derivation, keys)
      expect(signed).toEqual(captureSibling(scene, look, derivation, keys)!.keys)
      expect(signed).toEqual(partKeys(sceneOf(sibling), look))
      expect(materialsOf(scene)).toEqual(before)
      expect(siblingKeys(scene, look, derivation, { ...keys, interior: 'other' })).toBeNull()
    }
  }, 20_000)

  it('is captured as the cloud would capture the scene a click builds, with nothing left behind', async () => {
    const base = BASES[1]
    const scene = sceneOf(base)
    const keys = partKeys(scene, look)
    const before = materialsOf(scene)
    for (const sibling of [
      { ...base, finish: 'chalk' as const },
      { ...base, flooring: 'stone' as const },
    ]) {
      const derivation = deriveSibling(base, sibling)!
      const shot = captureSibling(scene, look, derivation, keys)!
      // The live scene has its own surfaces back the moment the call returns.
      expect(materialsOf(scene)).toEqual(before)
      const [derived, built] = await Promise.all([
        shot.captured,
        captureScene(sceneOf(sibling), look),
      ])
      expect(stableJson(derived.scene)).toBe(stableJson(built.scene))
      expect([...derived.blobs.keys()].sort()).toEqual([...built.blobs.keys()].sort())
      const own = await captureScene(scene, look)
      expect(stableJson(own.scene)).not.toBe(stableJson(derived.scene))
    }
  }, 20_000)

  it('is not captured from a scene that is not the design it was derived from', () => {
    const sibling = { ...DEFAULT_CONFIG, finish: 'chalk' as const }
    const derivation = deriveSibling(DEFAULT_CONFIG, sibling)!
    const scene = sceneOf(DEFAULT_CONFIG)
    const keys = partKeys(scene, look)
    const before = materialsOf(scene)
    // Signed otherwise than the session last saw it: on its way to another design.
    expect(captureSibling(scene, look, derivation, { ...keys, exterior: 'other' })).toBeNull()
    // Another design on screen, signed as such: the surfaces to swap are not there.
    const other = sceneOf({ ...DEFAULT_CONFIG, finish: 'olive' })
    expect(captureSibling(other, look, derivation, partKeys(other, look))).toBeNull()
    expect(materialsOf(scene)).toEqual(before)
  })

  it('changes surfaces only through the unit’s part lists, which the derivation rebuilds', () => {
    // The derivation proves a finish or a floor swaps surfaces in the unit's part lists alone. Any
    // other scene source reading those options would change the scene behind its back.
    const root = join(process.cwd(), 'src')
    const sources = [
      ...readdirSync(join(root, 'render'))
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => `render/${name}`),
      ...[
        'Scene',
        'StudioModel',
        'Landscape',
        'Surroundings',
        'Equipment',
        'InteriorLights',
        'InteriorProbe',
        'Mirror',
        'Atmosphere',
        'RenderEffects',
        'Parts',
      ].map((name) => `components/${name}.tsx`),
    ]
    const readers = sources.filter((path) =>
      /\b(c|config|x)\.(finish|flooring)\b|finishColor\(/.test(
        readFileSync(join(root, path), 'utf8'),
      ),
    )
    expect(readers.sort()).toEqual([
      'render/addons.ts',
      'render/architecture.ts',
      'render/unitParts.ts',
    ])
  })
})
