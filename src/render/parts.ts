import {
  BufferAttribute,
  BufferGeometry,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { cylinder } from './geometry'
import { fingerprint } from './hash'

const cylinderGeometry = (radius: number, length: number, radial: number) =>
  cylinder(radius, radius, length, radial)

export type V3 = [number, number, number]

/** One placed piece of a model: shared geometry + shared material + transform. */
export type Part = {
  geometry: BufferGeometry
  material: Material
  matrix: Matrix4
  shadow: boolean
}

const _q = new Quaternion(),
  _e = new Euler(),
  _p = new Vector3(),
  _s = new Vector3()

export function compose(position: V3 = [0, 0, 0], rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) {
  return new Matrix4().compose(
    _p.set(...position),
    _q.setFromEuler(_e.set(...rotation)),
    _s.set(...scale),
  )
}

export function part(
  geometry: BufferGeometry,
  material: Material,
  position?: V3,
  rotation?: V3,
  scale?: V3,
  shadow = true,
): Part {
  return { geometry, material, matrix: compose(position, rotation, scale), shadow }
}

/** Moves a sub-assembly: every part is premultiplied by the assembly transform. */
export function place(parts: Part[], position?: V3, rotation?: V3, scale?: V3): Part[] {
  const m = compose(position, rotation, scale)
  return parts.map((p) => ({ ...p, matrix: m.clone().multiply(p.matrix) }))
}

export type Batch = { geometry: BufferGeometry; material: Material; shadow: boolean }
/** A batch as `batch` would make it, without its merged geometry: its key and its material. */
export type BatchKey = { key: string; material: Material; shadow: boolean }

/** Parts by the batch they merge into: one per material and shadow flag, in order met. */
function groupParts(parts: Part[]) {
  const groups = new Map<string, { material: Material; shadow: boolean; parts: Part[] }>()
  for (const p of parts) {
    const key = `${p.material.uuid}:${p.shadow}`
    let group = groups.get(key)
    if (!group) {
      group = { material: p.material, shadow: p.shadow, parts: [] }
      groups.set(key, group)
    }
    group.parts.push(p)
  }
  return [...groups.values()]
}

/** A batch's geometry key: its parts' geometry keys and placements, so not its material. */
function batchKey(parts: Part[]) {
  const keys = parts.map((p) => {
    const source = (p.geometry.userData as { key?: unknown }).key
    return `${typeof source === 'string' ? source : p.geometry.uuid}@${p.matrix.elements.map((e) => e.toFixed(4)).join(',')}`
  })
  return `batch:${fingerprint(keys.join(';'))}`
}

/**
 * The batches `batch` makes of a part list, named as it names their geometry, without merging
 * anything: cheap enough to compare two builds of a model (siblings.ts).
 */
export function batchKeys(parts: Part[]): BatchKey[] {
  return groupParts(parts).map(({ material, shadow, parts: grouped }) => ({
    key: batchKey(grouped),
    material,
    shadow,
  }))
}

/**
 * Static batching: parts sharing a material (and shadow flag) are baked into one geometry, so a
 * detailed model costs a handful of draw calls. Mirrored transforms flip winding, which is
 * corrected per part so faces stay front-facing. Each merged geometry is named by its content
 * (`userData.key`: the parts' geometry keys and placements), so a model rebuilt from the same
 * parts reads as the same shape to the scene fingerprints (pathtrace.ts sceneParts).
 */
export function batch(parts: Part[]): Batch[] {
  return groupParts(parts).map(({ material, shadow, parts: grouped }) => {
    const items = grouped.map((p) => {
      const g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry.clone()
      for (const name of Object.keys(g.attributes))
        if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
      if (!g.getAttribute('uv'))
        g.setAttribute(
          'uv',
          new BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2),
        )
      g.applyMatrix4(p.matrix)
      if (p.matrix.determinant() < 0) flipWinding(g)
      g.clearGroups()
      return g
    })
    const geometry = mergeGeometries(items, false)
    items.forEach((g) => g.dispose())
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()
    geometry.userData.key = batchKey(grouped)
    return { geometry, material, shadow }
  })
}

function flipWinding(g: BufferGeometry) {
  const attrs = ['position', 'normal', 'uv'] as const
  for (const name of attrs) {
    const a = g.getAttribute(name)
    if (!a) continue
    const size = a.itemSize
    const arr = a.array as Float32Array
    for (let i = 0; i < a.count; i += 3) {
      for (let c = 0; c < size; c++) {
        const t = arr[(i + 1) * size + c]
        arr[(i + 1) * size + c] = arr[(i + 2) * size + c]
        arr[(i + 2) * size + c] = t
      }
    }
    a.needsUpdate = true
  }
}

/** Places geometry using explicit local axes (for cyclic re-orientations Euler angles obscure). */
export function oriented(
  geometry: BufferGeometry,
  material: Material,
  axes: [V3, V3, V3],
  position: V3,
  shadow = true,
): Part {
  const matrix = new Matrix4().makeBasis(
    new Vector3(...axes[0]),
    new Vector3(...axes[1]),
    new Vector3(...axes[2]),
  )
  matrix.setPosition(...position)
  return { geometry, material, matrix, shadow }
}

const _a = new Vector3(),
  _b = new Vector3(),
  _up = new Vector3(0, 1, 0)

/** A straight cylinder from one point to another (struts, cables, rails, tie rods). */
export function rod(
  from: V3,
  to: V3,
  radius: number,
  material: Material,
  radial = 10,
  shadow = true,
): Part {
  _a.set(...from)
  _b.set(...to)
  const direction = _b.clone().sub(_a)
  const length = direction.length()
  const geometry = cylinderGeometry(radius, length, radial)
  const matrix = new Matrix4().compose(
    _a.clone().add(_b).multiplyScalar(0.5),
    new Quaternion().setFromUnitVectors(_up, direction.normalize()),
    new Vector3(1, 1, 1),
  )
  return { geometry, material, matrix, shadow }
}
