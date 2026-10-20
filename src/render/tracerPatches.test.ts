// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  Scene,
  StructTypeNode,
  Vector3,
  type Texture,
} from 'three/webgpu'
import { MeshBVH, SAH } from 'three-mesh-bvh'
import { setCommonAttributes } from 'three-gpu-pathtracer/src/core/utils/GeometryPreparationUtils.js'
import { PathtracerBVHComputeData } from 'three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js'
import { describe, expect, it, vi } from 'vitest'
import { skyLook } from '../lib/visuals'
import { preparePathTraceScene } from './pathtrace'

/**
 * patches/three-gpu-pathtracer+0.0.27.patch, applied by patch-package on install. A node_modules
 * installed before a hunk was added, or a regenerated patch that lost one, traces without it, and
 * nothing else would say so.
 */
const PATCH = 'patches/three-gpu-pathtracer+0.0.27.patch'
const PACKAGE = 'node_modules/three-gpu-pathtracer/'

/** One line of each hunk, by the file it patches. */
const MARKERS: [file: string, marker: string][] = [
  // A slot whose path ended looks a few queue entries ahead for a pixel that still needs samples.
  [
    'src/webgpu/compute/wavefront/MaterialKernel.js',
    'for ( var attempt = 0u; attempt < 8u; attempt ++ ) {',
  ],
  // The transform and material struct lengths are computed once, not per packed object.
  ['src/webgpu/nodes/PathtracerBVHComputeData.js', 'struct.getLength = () => length;'],
]

/** Each hunk of the patch: the file it patches and its lines as they read once applied. */
function hunks(patch: string) {
  const found: { file: string; header: string; lines: string[] }[] = []
  let file = ''
  let hunk: (typeof found)[number] | null = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) hunk = null
    else if (!hunk && line.startsWith(`+++ b/${PACKAGE}`)) file = line.slice(6 + PACKAGE.length)
    else if (line.startsWith('@@ ')) found.push((hunk = { file, header: line, lines: [] }))
    else if (hunk && (line.startsWith(' ') || line.startsWith('+'))) hunk.lines.push(line.slice(1))
  }
  return found
}

describe("the tracer's patches", () => {
  const patch = readFileSync(PATCH, 'utf8')

  it.each(MARKERS)('patches %s, and the installed package has the change', (file, marker) => {
    const added = patch.split('\n').filter((line) => line.startsWith('+'))
    expect(added.map((line) => line.slice(1).trim())).toContain(marker)
    expect(readFileSync(PACKAGE + file, 'utf8')).toContain(marker)
  })

  it('applies every hunk of the patch file to the installed package', () => {
    const all = hunks(patch)
    expect(all.length).toBeGreaterThanOrEqual(MARKERS.length)
    for (const { file, header, lines } of all) {
      const source = readFileSync(PACKAGE + file, 'utf8')
      expect(source.includes(lines.join('\n')), `${file} ${header} is not applied`).toBe(true)
    }
  })
})

const INSTANCES = 240
const BUFFERS = ['transforms', 'nodes', 'index', 'attributes', 'materials'] as const
type Packed = Record<(typeof BUFFERS)[number], Uint8Array>
const STEPS = ['update', 'updateMaterials', 'updateTransforms'] as const

/**
 * A small scene of the kinds of object a design's capture hands the tracer: plain meshes, one whose
 * geometry groups take different finishes, a coloured InstancedMesh like the plants, glass, a
 * nested group, and the parts preparePathTraceScene hides but the tracer still packs.
 */
function fixture() {
  const scene = new Scene()
  const stone = new MeshStandardNodeMaterial({ color: '#8a8378', roughness: 0.85 })
  const steel = new MeshStandardNodeMaterial({ color: '#c0c4c8', metalness: 1, roughness: 0.3 })
  const glass = new MeshPhysicalNodeMaterial({
    transmission: 1,
    thickness: 0.03,
    attenuationColor: new Color(0.5, 0.8, 0.6),
    attenuationDistance: 0.3,
  })
  const leaf = new MeshStandardNodeMaterial()
  leaf.userData.pathTrace = { color: new Color('#5f7a3c'), roughness: 0.7 }
  // The tracer orders materials by uuid, so two captures pack alike only with the same uuids.
  for (const [i, material] of [stone, steel, glass, leaf].entries())
    Object.assign(material, { uuid: `fixture-${i}` })

  const wall = new Mesh(new BoxGeometry(4, 3, 0.2, 6, 4, 1), stone)
  const frame = new Mesh(new BoxGeometry(1, 2, 0.1, 2, 3, 1), [steel, glass, steel, stone, glass])
  frame.position.set(1, 1, 0.3)
  const pane = new Mesh(new BoxGeometry(0.8, 1.6, 0.02), glass)
  pane.position.set(-1, 1, 0.3)
  const opening = new Group()
  opening.add(frame, pane)
  opening.rotation.y = 0.4

  const plants = new InstancedMesh(new BoxGeometry(0.1, 0.3, 0.1, 1, 2, 1), leaf, INSTANCES)
  const matrix = new Matrix4()
  const turn = new Quaternion()
  const tint = new Color()
  for (let i = 0; i < INSTANCES; i++) {
    turn.setFromAxisAngle(new Vector3(0, 1, 0), i * 0.7)
    const at = new Vector3((i % 20) * 0.3 - 3, 0, Math.floor(i / 20) * 0.3 + 1)
    plants.setMatrixAt(i, matrix.compose(at, turn, new Vector3(1, 1 + (i % 5) * 0.2, 1)))
    plants.setColorAt(i, tint.setHSL((i / INSTANCES) * 0.3, 0.5, 0.4))
  }

  const sky = new Mesh(new BoxGeometry(50, 50, 50), new MeshBasicMaterial())
  sky.userData.pathTrace = false
  const helper = new Mesh(new BoxGeometry(), new MeshBasicMaterial())

  scene.add(wall, opening, plants, sky, helper)
  return { scene, stone, steel, opening, plants, wall }
}

const environment = { isTexture: true } as unknown as Texture

/** A copy of each packed buffer, as the GPU would be sent it. */
function packed(data: PathtracerBVHComputeData): Packed {
  const copy = (key: (typeof BUFFERS)[number]) => {
    const { array } = data.storage[key].proxyNode.value
    return new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice()
  }
  return Object.fromEntries(BUFFERS.map((key) => [key, copy(key)])) as Packed
}

/**
 * Captures the fixture as WebGPUPathTracer.setScene does (attributes, then a BVH per geometry, then
 * the packing), then changes finishes and moves things as PathTraceSession's in-place updates do,
 * packing after each step.
 */
function capture() {
  const f = fixture()
  preparePathTraceScene(f.scene, skyLook('residences', 16.5), environment)
  f.scene.updateMatrixWorld(true)
  f.scene.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    setCommonAttributes(mesh.geometry, ['normal', 'tangent'])
    // drei's nested three-mesh-bvh 0.8 types BufferGeometry.boundsTree as its own MeshBVH class.
    const boundsTree = new MeshBVH(mesh.geometry, { strategy: SAH, targetLeafSize: 5 })
    Object.assign(mesh.geometry, { boundsTree })
  })
  const data = new PathtracerBVHComputeData(f.scene)
  data.update()
  const update = packed(data)

  f.stone.color.set('#6d675e')
  f.steel.roughness = 0.45
  data.updateMaterials()
  const updateMaterials = packed(data)

  f.opening.rotation.y = -0.2
  f.plants.setMatrixAt(7, new Matrix4().makeTranslation(2, 0, 3))
  f.wall.visible = false
  f.scene.updateMatrixWorld(true)
  data.updateTransforms()
  const updateTransforms = packed(data)

  return { data, steps: { update, updateMaterials, updateTransforms } }
}

/** The struct nodes behind the packing's proxies, as the patch's module holds them. */
function structNodes(data: PathtracerBVHComputeData) {
  return [data.structs.transform.proxyNode, data.structs.material.proxyNode]
}

/** Runs `fn` with both structs laid out again on every getLength call, as before the patch. */
function uncached<T>(fn: () => T): T {
  const nodes = structNodes(new PathtracerBVHComputeData(new Scene()))
  const cached = nodes.map((node) => Object.getOwnPropertyDescriptor(node, 'getLength'))
  try {
    for (const node of nodes) delete (node as Partial<StructTypeNode>).getLength
    return fn()
  } finally {
    nodes.forEach((node, i) => {
      const descriptor = cached[i]
      if (descriptor) Object.defineProperty(node, 'getLength', descriptor)
    })
  }
}

/** The first byte at which two copies differ, or -1 when they are identical. */
function firstDifference(a: Uint8Array, b: Uint8Array) {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : shared
}

describe("the tracer's scene packing with struct lengths computed once", () => {
  it('keeps the lengths the layouts compute: 40 words per transform', () => {
    const [transform, material] = structNodes(new PathtracerBVHComputeData(new Scene()))
    for (const node of [transform, material]) {
      expect(Object.hasOwn(node, 'getLength')).toBe(true)
      expect(node.getLength()).toBe(StructTypeNode.prototype.getLength.call(node))
    }
    expect(transform.getLength()).toBe(40)
    expect(material.getLength()).toBeGreaterThan(0)
  })

  it('packs byte-identical buffers to the uncached layout, on capture and in-place updates', () => {
    const cached = capture().steps
    const original = uncached(capture).steps
    // Each in-place update rewrote what it is for, so none compares a copy left as it was.
    const { update, updateMaterials, updateTransforms } = cached
    expect(firstDifference(update.materials, updateMaterials.materials)).not.toBe(-1)
    expect(firstDifference(updateMaterials.transforms, updateTransforms.transforms)).not.toBe(-1)
    expect(firstDifference(updateMaterials.nodes, updateTransforms.nodes)).not.toBe(-1)

    const identical = Object.fromEntries(BUFFERS.map((key) => [key, -1]))
    for (const step of STEPS) {
      for (const key of BUFFERS)
        expect(cached[step][key].length, `${step} ${key}`).toBeGreaterThan(0)
      const differences = Object.fromEntries(
        BUFFERS.map((key) => [key, firstDifference(cached[step][key], original[step][key])]),
      )
      expect(differences, step).toEqual(identical)
    }
  })

  it('never lays either struct out again while packing', () => {
    const layout = vi.spyOn(StructTypeNode.prototype, 'getLength')
    try {
      const nodes = structNodes(capture().data)
      const layouts = () =>
        layout.mock.contexts.filter((node) => nodes.includes(node as StructTypeNode)).length
      expect(layouts()).toBe(0)
      // The same spy sees the work the cache saves: several layouts per packed instance.
      layout.mockClear()
      uncached(capture)
      expect(layouts()).toBeGreaterThan(3 * INSTANCES)
    } finally {
      layout.mockRestore()
    }
  })
})
