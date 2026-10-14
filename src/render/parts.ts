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

export function mirrorX(parts: Part[]) {
  return place(parts, [0, 0, 0], [0, 0, 0], [-1, 1, 1])
}

export type Batch = { geometry: BufferGeometry; material: Material; shadow: boolean }

/**
 * Static batching: parts sharing a material (and shadow flag) are baked into one geometry, so a
 * detailed model costs a handful of draw calls. Mirrored transforms flip winding, which is
 * corrected per part so faces stay front-facing.
 */
export function batch(parts: Part[]): Batch[] {
  const groups = new Map<string, { material: Material; shadow: boolean; items: BufferGeometry[] }>()
  for (const p of parts) {
    const key = `${p.material.uuid}:${p.shadow}`
    let group = groups.get(key)
    if (!group) {
      group = { material: p.material, shadow: p.shadow, items: [] }
      groups.set(key, group)
    }
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
    group.items.push(g)
  }
  return [...groups.values()].map(({ material, shadow, items }) => {
    const geometry = mergeGeometries(items, false)
    items.forEach((g) => g.dispose())
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()
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
