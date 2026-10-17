import type { Config, EnvironmentId } from '../lib/config'
import type { ApartmentStyle } from './buildings'
import type { Biome } from './vegetation'

/**
 * Where each setting puts the things a camera must keep out of, and see past: buildings, trees,
 * palms, lamp posts, planters, hedges, garden walls and shrubs. Surroundings.tsx and Landscape.tsx
 * place them from here, and the gallery (gallery.ts) keeps its cameras out of the same shapes and
 * measures how much of the build they hide, so the two never drift apart. Free of three.js
 * imports: the app shell works out the gallery's cameras before the 3D chunk has loaded.
 *
 * Feet, with the build at the origin, its glazed front toward +z.
 */

type Vec3 = [number, number, number]

// --- What each setting places --------------------------------------------------------------

/**
 * A building as its generator (buildings.ts) is asked for it, standing at (x, z) and turned `turn`
 * radians about the vertical, as parts.ts place() turns it: its front face along its local x axis
 * through that point, its body behind it (local -z).
 */
export type BuildingSpot = { x: number; z: number; turn: number } & (
  | { kind: 'apartment'; length: number; style: ApartmentStyle; seed: number }
  | { kind: 'curtain-wall' | 'precast'; length: number; floors: number; depth: number }
  | { kind: 'house' }
)
/** A tree (vegetation.ts treeShape) standing on `base`: the ground, or a planter's soil. */
export type TreeSpot = {
  x: number
  z: number
  base: number
  scale: number
  seed: number
  biome: Biome
}
/** A fan palm (vegetation.ts palmShape), `height` feet to its crown. */
export type PalmSpot = { x: number; z: number; height: number; seed: number }
/** A courtyard lamp post (LAMP_POST). */
export type PostSpot = { x: number; z: number }
/** Ornamental grass in a planter: its bed, where it grows from, and its blades. */
export type GrassSpot = {
  width: number
  depth: number
  base: number
  height: number
  count: number
  colors?: [string, string]
}
/** A raised planter (buildings.ts planter) at (x, z), turned `turn`, and the grass in it. */
export type PlanterSpot = {
  x: number
  z: number
  turn: number
  width: number
  depth: number
  height: number
  grass?: GrassSpot
}
/** A round concrete pot (the garden's potted tree stands in one). */
export type PotSpot = { x: number; z: number; radius: number; height: number }
/** A clipped hedge (HEDGE) along x, centred, at z. */
export type HedgeSpot = { z: number; length: number }
/** A board-formed garden wall (GARDEN_WALL) along x, centred, at z. */
export type WallSpot = { z: number; length: number }
/** A domed shrub (vegetation.ts shrubShape) on `base`, in flower when it has a `blossom`. */
export type ShrubSpot = {
  x: number
  z: number
  base: number
  radius: number
  height: number
  seed: number
  blossom?: string
}

export type SceneryLayout = {
  buildings: BuildingSpot[]
  trees: TreeSpot[]
  palms: PalmSpot[]
  posts: PostSpot[]
  planters: PlanterSpot[]
  pots: PotSpot[]
  hedges: HedgeSpot[]
  walls: WallSpot[]
  shrubs: ShrubSpot[]
}

/** A clipped hedge's body (Landscape.tsx Hedge), before its leaves. */
export const HEDGE = { height: 3.3, depth: 1.5 }
/** The garden's board-formed wall and its precast coping (Landscape.tsx). */
export const GARDEN_WALL = {
  height: 3.8,
  thickness: 0.55,
  y: 1.8,
  coping: { y: 3.76, height: 0.16, depth: 0.8, overhang: 0.2 },
}
/** A courtyard lamp post: its pole, and the head on top of it (Surroundings.tsx). */
export const LAMP_POST = { height: 12, head: { y: 12.3, height: 1.1, width: 0.7 } }

const NONE: SceneryLayout = {
  buildings: [],
  trees: [],
  palms: [],
  posts: [],
  planters: [],
  pots: [],
  hedges: [],
  walls: [],
  shrubs: [],
}

/** The residential courtyard (photos 1 and 3): three apartment blocks around a paved court. */
function residences(L: number): SceneryLayout {
  const grass = { base: 2.4, height: 2.6 }
  return {
    ...NONE,
    buildings: [
      { kind: 'apartment', length: 160, style: 'brick', seed: 1, x: 0, z: -34, turn: 0 },
      {
        kind: 'apartment',
        length: 110,
        style: 'timber',
        seed: 2,
        x: -(L / 2 + 44),
        z: 6,
        turn: Math.PI / 2,
      },
      {
        kind: 'apartment',
        length: 110,
        style: 'brick',
        seed: 3,
        x: L / 2 + 50,
        z: 2,
        turn: -Math.PI / 2,
      },
    ],
    planters: [
      {
        x: -L / 2 - 12,
        z: 7,
        turn: 0.04,
        width: 14,
        depth: 3.2,
        height: 2.2,
        grass: { ...grass, width: 13, depth: 2.6, count: 70 },
      },
      {
        x: L / 2 + 7.5,
        z: 2,
        turn: 0,
        width: 3.2,
        depth: 16,
        height: 2.2,
        grass: { ...grass, width: 2.6, depth: 15, count: 80 },
      },
      {
        x: 0,
        z: -13,
        turn: 0,
        width: L + 14,
        depth: 3.6,
        height: 2.2,
        grass: {
          ...grass,
          width: L + 12,
          depth: 3,
          count: 120,
          colors: ['#3e5229', '#8fa25a'],
          height: 1.6,
        },
      },
    ],
    // On the back planter, near either end of the build.
    shrubs: [-L / 2 - 2, L / 2 - 4].map((x, i) => ({
      x: x + 3,
      z: -13,
      base: 2.4,
      radius: 1.6,
      height: 2.4,
      seed: i + 3,
    })),
    posts: [
      { x: -L / 2 - 14, z: 14 },
      { x: L / 2 + 14, z: -4 },
      { x: -L / 2 - 4, z: -20 },
    ],
    trees: [
      { x: -L / 2 - 16, base: 2.4, z: 7, scale: 1.2, seed: 6, biome: 'courtyard' },
      { x: L / 2 + 12, base: 0, z: -20, scale: 1.7, seed: 7, biome: 'courtyard' },
      { x: -L / 2 - 16, base: 0, z: -22, scale: 1.8, seed: 8, biome: 'courtyard' },
    ],
  }
}

/** The corporate campus (photo 2): glass and precast offices, palms, planters with olive trees. */
function campus(L: number): SceneryLayout {
  return {
    ...NONE,
    buildings: [
      { kind: 'curtain-wall', length: 120, floors: 5, depth: 80, x: -58, z: -52, turn: 0.12 },
      { kind: 'precast', length: 96, floors: 4, depth: 60, x: 46, z: -60, turn: 0 },
      {
        kind: 'curtain-wall',
        length: 90,
        floors: 4,
        depth: 60,
        x: L / 2 + 70,
        z: 10,
        turn: -Math.PI / 2,
      },
    ],
    planters: [
      { x: L / 2 + 9, z: -6, turn: 0, width: 14, depth: 4, height: 1.8 },
      { x: -L / 2 - 9, z: -9, turn: 0, width: 4, depth: 12, height: 1.8 },
    ],
    trees: [
      { x: L / 2 + 9, base: 1.8, z: -6, scale: 1.15, seed: 10, biome: 'desert' },
      { x: -L / 2 - 10, base: 1.8, z: -10, scale: 1.3, seed: 11, biome: 'desert' },
      { x: L / 2 + 22, base: 0, z: 14, scale: 1.5, seed: 12, biome: 'desert' },
    ],
    palms: [
      [-14, -38, 20],
      [6, -42, 24],
      [22, -36, 18],
      [-32, -34, 22],
      [L / 2 + 26, -14, 20],
    ].map(([x, z, height], i) => ({ x, z, height, seed: i + 1 })),
  }
}

/** The private backyard (photos 4 and 5): a modern house, a neighbor's, a hedge and a lawn. */
function backyard(L: number): SceneryLayout {
  const lavender = '#8d7cc0'
  return {
    ...NONE,
    buildings: [
      { kind: 'house', x: -(L / 2 + 34), z: -26, turn: 0.42 },
      // A neighbor's house beyond the hedge on the other side.
      { kind: 'house', x: L / 2 + 52, z: -40, turn: -0.55 },
    ],
    hedges: [{ z: -14, length: L + 34 }],
    shrubs: [
      ...[-L / 2 - 4.5, -L / 2 - 3, L / 2 + 3.5].map((x, i) => ({
        x,
        z: 9 + i * 1.4,
        base: 0,
        radius: 1.3,
        height: 1.6,
        seed: 20 + i,
        blossom: lavender,
      })),
      ...[0, 1, 2].map((i) => ({
        x: -L / 2 - 8 - i * 3.2,
        z: -6 + i * 1.1,
        base: 0,
        radius: 1.8,
        height: 2.6,
        seed: 30 + i,
        blossom: '#eef0ea',
      })),
      { x: L / 2 + 5, z: -5, base: 0, radius: 2.2, height: 3, seed: 40, blossom: '#d9c7e6' },
    ],
    trees: [
      { x: -L / 2 - 12, base: 0, z: -16, scale: 1.9, seed: 13, biome: 'courtyard' },
      { x: L / 2 + 16, base: 0, z: -18, scale: 2.1, seed: 14, biome: 'courtyard' },
      { x: L / 2 + 26, base: 0, z: 6, scale: 1.6, seed: 15, biome: 'courtyard' },
    ],
  }
}

/** The garden courtyard and the desert retreat: a walled garden with trees either side. */
function garden(L: number, biome: Biome): SceneryLayout {
  return {
    ...NONE,
    walls: [{ z: -12, length: L + 24 }],
    hedges: biome === 'courtyard' ? [{ z: -10.75, length: L + 20 }] : [],
    trees: [
      ...[-1, 1].flatMap((side): TreeSpot[] => [
        { x: side * (L / 2 + 6), base: 0, z: -8, scale: 1.55, seed: side > 0 ? 1 : 2, biome },
        { x: side * (L / 2 + 14), base: 0, z: -19, scale: 2.0, seed: side > 0 ? 3 : 4, biome },
      ]),
      // The potted tree by the front corner.
      { x: -L / 2 - 0.8, base: 1.75, z: 11.5, scale: 0.5, seed: 5, biome },
    ],
    pots: [{ x: -L / 2 - 0.8, z: 11.5, radius: 0.75, height: 1.8 }],
  }
}

/** What a setting places around a build `length` feet long. */
export function sceneryLayout(environment: EnvironmentId, length: number): SceneryLayout {
  switch (environment) {
    case 'residences':
      return residences(length)
    case 'campus':
      return campus(length)
    case 'backyard':
      return backyard(length)
    case 'courtyard':
      return garden(length, 'courtyard')
    case 'desert':
      return garden(length, 'desert')
    case 'studio':
      return NONE
  }
}

// --- The shapes a camera keeps out of ------------------------------------------------------

export type KeepOutKind =
  | 'building'
  | 'trunk'
  | 'crown'
  | 'post'
  | 'planter'
  | 'planting'
  | 'pot'
  | 'hedge'
  | 'wall'
  | 'shrub'
type Solid = {
  kind: KeepOutKind
  /** Foliage: seen through at its edges, so a sight line grazing it is not hidden. */
  porous: boolean
}
/**
 * A box between `min` and `max` in its own frame, placed at (x, z) and turned `turn` about the
 * vertical (as parts.ts place() turns a building); or an upright cylinder.
 */
export type KeepOut =
  | (Solid & { shape: 'box'; x: number; z: number; turn: number; min: Vec3; max: Vec3 })
  | (Solid & {
      shape: 'cylinder'
      x: number
      z: number
      radius: number
      bottom: number
      top: number
    })

/**
 * A tree's reach at scale 1 (vegetation.ts treeShape over every seed: its leaf cards, and its
 * trunk below them); the desert's sparser olive is a little smaller.
 */
export const TREE_REACH: Record<Biome, { radius: number; bottom: number; top: number }> = {
  courtyard: { radius: 6.4, bottom: 4.3, top: 11.6 },
  desert: { radius: 6.3, bottom: 4.4, top: 11.1 },
}
const TRUNK_RADIUS = 0.45
/** A palm's crown of fronds around its top, and its trunk (vegetation.ts palmShape). */
export const PALM_REACH = { radius: 7.9, below: 5.7, above: 5.3, trunk: 1.3 }
/** Leaf cards stand this far out of a hedge's body or a shrub's dome. */
const LEAVES = 0.4

/** The building generators' extents (buildings.ts), in the building's own frame. */
function buildingBox(b: BuildingSpot): { min: Vec3; max: Vec3 }[] {
  switch (b.kind) {
    case 'apartment': {
      // Its bays are 13 feet, as many as fit the length asked for; the parapet sill overhangs.
      const half = (Math.max(3, Math.round(b.length / 13)) * 13) / 2 + 0.3
      return [{ min: [-half, 0, -46], max: [half, 51.5, 0.6] }]
    }
    case 'curtain-wall':
      // The side mullions stand out of the +x face; the roof cap overhangs all round.
      return [
        {
          min: [-b.length / 2 - 0.3, 0, -b.depth - 0.3],
          max: [b.length / 2 + 0.6, b.floors * 13.5 + 7, 0.6],
        },
      ]
    case 'precast':
      return [
        {
          min: [-b.length / 2 - 0.5, 0, -b.depth - 0.5],
          max: [b.length / 2 + 0.5, b.floors * 13 + 4.7, 0.9],
        },
      ]
    case 'house':
      // Its body under the roof plates, and the terrace in front with its steps and planters.
      return [
        { min: [-34, 0, -35], max: [34, 22.3, 4.5] },
        { min: [-32, 0, 0], max: [26, 3.6, 12.7] },
      ]
  }
}

/** Every shape of a setting's layout. */
export function keepOuts(layout: SceneryLayout): KeepOut[] {
  const out: KeepOut[] = []
  const solid = { porous: false }
  for (const b of layout.buildings)
    for (const { min, max } of buildingBox(b))
      out.push({ ...solid, kind: 'building', shape: 'box', x: b.x, z: b.z, turn: b.turn, min, max })
  for (const t of layout.trees) {
    const reach = TREE_REACH[t.biome]
    const crown = t.base + reach.bottom * t.scale
    out.push({
      ...solid,
      kind: 'trunk',
      shape: 'cylinder',
      x: t.x,
      z: t.z,
      radius: TRUNK_RADIUS * t.scale,
      bottom: t.base - 0.2 * t.scale,
      top: crown,
    })
    out.push({
      kind: 'crown',
      porous: true,
      shape: 'cylinder',
      x: t.x,
      z: t.z,
      radius: reach.radius * t.scale,
      bottom: crown,
      top: t.base + reach.top * t.scale,
    })
  }
  for (const p of layout.palms) {
    out.push({
      ...solid,
      kind: 'trunk',
      shape: 'cylinder',
      x: p.x,
      z: p.z,
      radius: PALM_REACH.trunk,
      bottom: 0,
      top: p.height - PALM_REACH.below,
    })
    out.push({
      kind: 'crown',
      porous: true,
      shape: 'cylinder',
      x: p.x,
      z: p.z,
      radius: PALM_REACH.radius,
      bottom: p.height - PALM_REACH.below,
      top: p.height + PALM_REACH.above,
    })
  }
  const { head } = LAMP_POST
  for (const p of layout.posts)
    out.push({
      ...solid,
      kind: 'post',
      shape: 'cylinder',
      x: p.x,
      z: p.z,
      // The head's corners.
      radius: head.width / Math.SQRT2,
      bottom: 0,
      top: head.y + head.height / 2,
    })
  for (const p of layout.planters) {
    // The planter to its coping, then the grass in it.
    const coping = p.height + 0.3
    const w = p.width / 2 + 0.15,
      d = p.depth / 2 + 0.15
    out.push({
      ...solid,
      kind: 'planter',
      shape: 'box',
      x: p.x,
      z: p.z,
      turn: p.turn,
      min: [-w, 0, -d],
      max: [w, coping, d],
    })
    if (p.grass)
      out.push({
        kind: 'planting',
        porous: true,
        shape: 'box',
        x: p.x,
        z: p.z,
        turn: p.turn,
        min: [-p.grass.width / 2, coping, -p.grass.depth / 2],
        max: [p.grass.width / 2, p.grass.base + p.grass.height, p.grass.depth / 2],
      })
  }
  for (const p of layout.pots)
    out.push({
      ...solid,
      kind: 'pot',
      shape: 'cylinder',
      x: p.x,
      z: p.z,
      radius: p.radius,
      bottom: 0,
      top: p.height,
    })
  for (const h of layout.hedges) {
    const w = h.length / 2 + LEAVES,
      d = HEDGE.depth / 2 + LEAVES
    out.push({
      ...solid,
      kind: 'hedge',
      shape: 'box',
      x: 0,
      z: h.z,
      turn: 0,
      min: [-w, 0, -d],
      max: [w, HEDGE.height + LEAVES, d],
    })
  }
  const { coping } = GARDEN_WALL
  for (const w of layout.walls) {
    const half = (w.length + coping.overhang) / 2
    out.push({
      ...solid,
      kind: 'wall',
      shape: 'box',
      x: 0,
      z: w.z,
      turn: 0,
      min: [-half, 0, -coping.depth / 2],
      max: [half, coping.y + coping.height / 2, coping.depth / 2],
    })
  }
  for (const s of layout.shrubs)
    out.push({
      kind: 'shrub',
      porous: true,
      shape: 'cylinder',
      x: s.x,
      z: s.z,
      radius: s.radius * 1.08 + LEAVES,
      bottom: s.base,
      top: s.base + s.height + LEAVES,
    })
  return out
}

const kept = new Map<string, KeepOut[]>()
/** The shapes of a design's setting (its length moves them), worked out once. */
export function sceneryKeepOuts(c: Pick<Config, 'environment' | 'length'>): KeepOut[] {
  const key = `${c.environment}|${c.length}`
  let shapes = kept.get(key)
  if (!shapes) kept.set(key, (shapes = keepOuts(sceneryLayout(c.environment, c.length))))
  return shapes
}

// --- Queries ---------------------------------------------------------------------------------

/** A point of the ground plan in a box's own frame (the inverse of its turn). */
function local(k: { x: number; z: number; turn: number }, x: number, z: number): [number, number] {
  const dx = x - k.x,
    dz = z - k.z
  const cos = Math.cos(k.turn),
    sin = Math.sin(k.turn)
  return [dx * cos - dz * sin, dx * sin + dz * cos]
}

/** Whether a point is inside a shape grown by `margin` all round. */
export function contains(k: KeepOut, [x, y, z]: Vec3, margin = 0) {
  if (k.shape === 'cylinder')
    return (
      Math.hypot(x - k.x, z - k.z) < k.radius + margin &&
      y > k.bottom - margin &&
      y < k.top + margin
    )
  const [lx, lz] = local(k, x, z)
  return (
    lx > k.min[0] - margin &&
    lx < k.max[0] + margin &&
    y > k.min[1] - margin &&
    y < k.max[1] + margin &&
    lz > k.min[2] - margin &&
    lz < k.max[2] + margin
  )
}

/**
 * How much of foliage's reach hides what is behind it: nineteen leaves in twenty of a tree's crown
 * lie within this share of its reach (vegetation.ts treeShape), the rest a lacework seen through.
 */
export const FOLIAGE_CORE = 0.85

/**
 * Whether the segment from `a` to `b` passes through a shape. A porous one (foliage) is taken at
 * `soft` of its width, since a sight line through the edge of a crown still sees between leaves.
 */
export function crosses(k: KeepOut, a: Vec3, b: Vec3, soft = FOLIAGE_CORE) {
  if (k.shape === 'cylinder') {
    const r = k.radius * (k.porous ? soft : 1)
    const dx = b[0] - a[0],
      dz = b[2] - a[2]
    const ox = a[0] - k.x,
      oz = a[2] - k.z
    // Where the segment's ground track is within the radius: t0..t1.
    const qa = dx * dx + dz * dz,
      qb = 2 * (ox * dx + oz * dz),
      qc = ox * ox + oz * oz - r * r
    let t0: number, t1: number
    if (qa < 1e-9) {
      if (qc > 0) return false
      ;[t0, t1] = [0, 1]
    } else {
      const disc = qb * qb - 4 * qa * qc
      if (disc <= 0) return false
      const root = Math.sqrt(disc)
      t0 = Math.max(0, (-qb - root) / (2 * qa))
      t1 = Math.min(1, (-qb + root) / (2 * qa))
      if (t0 >= t1) return false
    }
    // And within its height there.
    const y0 = a[1] + (b[1] - a[1]) * t0,
      y1 = a[1] + (b[1] - a[1]) * t1
    return Math.max(y0, y1) > k.bottom && Math.min(y0, y1) < k.top
  }
  // The slab test, in the box's own frame (a porous box shrinks about its middle).
  const [ax, az] = local(k, a[0], a[2])
  const [bx, bz] = local(k, b[0], b[2])
  const from: Vec3 = [ax, a[1], az],
    to: Vec3 = [bx, b[1], bz]
  const shrink = k.porous ? soft : 1
  let t0 = 0,
    t1 = 1
  for (let i = 0; i < 3; i++) {
    const mid = (k.min[i] + k.max[i]) / 2,
      half = ((k.max[i] - k.min[i]) / 2) * (i === 1 ? 1 : shrink)
    const lo = mid - half,
      hi = mid + half
    const d = to[i] - from[i]
    if (Math.abs(d) < 1e-9) {
      if (from[i] < lo || from[i] > hi) return false
      continue
    }
    let near = (lo - from[i]) / d,
      far = (hi - from[i]) / d
    if (near > far) [near, far] = [far, near]
    t0 = Math.max(t0, near)
    t1 = Math.min(t1, far)
    if (t0 > t1) return false
  }
  return true
}
