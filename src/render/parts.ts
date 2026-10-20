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

/**
 * A batch's geometry key: its parts' geometry keys and placements, so not its material. Placements
 * match to 4 decimals, the tolerance the generators' keys (geometry.ts) and the scene fingerprints
 * already accept; a part's source geometry is taken as immutable once batched.
 */
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
 * parts reads as the same shape to the scene fingerprints (pathtrace.ts sceneParts). Each call
 * merges geometries of its own, which the caller owns and disposes (Equipment keeps them per
 * product); the live 360° view shares them by content instead (`cachedBatches`).
 */
export function batch(parts: Part[]): Batch[] {
  return groupParts(parts).map(({ material, shadow, parts: grouped }) => ({
    geometry: merge(grouped, batchKey(grouped)),
    material,
    shadow,
  }))
}

/** One batch's parts baked into one geometry, named `key`. */
function merge(grouped: Part[], key: string) {
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
  geometry.userData.key = key
  return geometry
}

/** A batch whose geometry comes from the shared cache (`cachedBatches`), with its key. */
export type CachedBatch = Batch & { key: string }

/**
 * Merged geometry shared by content, for the live 360° view (geometryReuse.ts). A finish or floor
 * edit rebuilds a part list into the same batches with other materials (siblings.ts), so a list
 * rebuilt for it finds every batch's geometry here and its meshes keep their geometry: the path
 * tracer sees the same structure and updates materials in place instead of building its BVH
 * again.
 *
 * Merging happens while rendering, but a render may never commit (a concurrent render thrown
 * away, StrictMode), so references are counted only by the effects of what did commit
 * (`acquireBatches`, `releaseBatches`). An entry no effect holds is disposed later, not when let
 * go: a list rebuilt to the same batches lets go of them and takes them up again in one commit.
 * Later means a later task, never a microtask, since React may run a commit's effects tasks after
 * the render that was handed the entry. Each time an entry no effect holds is handed out, or let
 * go by the last, it is stamped, and a sweep disposes only entries stamped before it was
 * scheduled, so one handed out again meanwhile survives it. Entries are counted, not owned: a
 * renderer rebuilt after a lost device mounts its scene before the old one unmounts, holding
 * each entry twice for a while.
 */
type Entry = { key: string; geometry: BufferGeometry; refs: number; stamp: number }
const entries = new Map<string, Entry>()
/** Each cached geometry's entry, so the effects count what they were handed, not a key's. */
const owners = new WeakMap<BufferGeometry, Entry>()
/** Entries no effect holds, waiting for a sweep. */
const idle = new Set<Entry>()
let clock = 0
let sweeping = false

function unheld(entry: Entry) {
  entry.stamp = ++clock
  idle.add(entry)
  schedule()
}

function schedule() {
  if (sweeping) return
  sweeping = true
  const horizon = clock
  setTimeout(() => {
    sweeping = false
    sweep(horizon)
  }, 0)
}

function sweep(horizon: number) {
  for (const entry of idle) {
    if (entry.refs > 0) idle.delete(entry)
    else if (entry.stamp <= horizon) {
      idle.delete(entry)
      if (entries.get(entry.key) === entry) entries.delete(entry.key)
      entry.geometry.dispose()
    }
  }
  // Handed out or let go since this sweep was scheduled: the next one decides.
  if (idle.size) schedule()
}

/**
 * The batches `batch` makes of a part list, their geometry shared with every list of the same
 * content: batches already cached are looked up by key, and only the others are merged. Counts
 * no reference: the effects of the render that shows them do (`acquireBatches`).
 */
export function cachedBatches(parts: Part[]): CachedBatch[] {
  return groupParts(parts).map(({ material, shadow, parts: grouped }) => {
    const key = batchKey(grouped)
    let entry = entries.get(key)
    if (!entry) {
      entry = { key, geometry: merge(grouped, key), refs: 0, stamp: 0 }
      entries.set(key, entry)
      owners.set(entry.geometry, entry)
    }
    // Not held yet: a render that never commits must not keep it.
    if (entry.refs === 0) unheld(entry)
    return { key, geometry: entry.geometry, material, shadow }
  })
}

/** Holds the cached batches a committed render shows (an effect's setup). */
export function acquireBatches(batches: readonly CachedBatch[]) {
  for (const b of batches) {
    const entry = owners.get(b.geometry)
    if (!entry) continue
    entry.refs++
    idle.delete(entry)
    // Swept between the render that was handed it and this commit: it is the geometry on the
    // mesh, so it is kept (three uploads a disposed geometry again). A list merged since under
    // its key keeps that entry; this one lives on until let go.
    if (!entries.has(entry.key)) entries.set(entry.key, entry)
  }
}

/** Lets go of cached batches (that effect's cleanup): disposed once no effect holds them. */
export function releaseBatches(batches: readonly CachedBatch[]) {
  for (const b of batches) {
    const entry = owners.get(b.geometry)
    if (!entry || entry.refs === 0) continue
    entry.refs--
    if (entry.refs === 0) unheld(entry)
  }
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
