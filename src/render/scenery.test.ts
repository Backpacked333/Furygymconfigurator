import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Box3, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { ENVIRONMENTS } from '../lib/config'
import { apartmentBlock, curtainWallOffice, modernHouse, planter, precastOffice } from './buildings'
import { place, type Part } from './parts'
import {
  FOLIAGE_CORE,
  GARDEN_WALL,
  HEDGE,
  LAMP_POST,
  contains,
  crosses,
  keepOuts,
  sceneryKeepOuts,
  sceneryLayout,
  type KeepOut,
  type SceneryLayout,
} from './scenery'
import { palmShape, shrubShape, treeShape } from './vegetation'

type Vec3 = [number, number, number]
const LENGTHS = [20, 40] as const

/**
 * What Surroundings.tsx and Landscape.tsx placed before they took it from the layout, copied from
 * them as they were: the layout must place every shape exactly there, so nothing on screen moves.
 */
function before(environment: string, L: number) {
  switch (environment) {
    case 'residences':
      return {
        buildings: [
          [0, -34, 0, 160],
          [-(L / 2 + 44), 6, Math.PI / 2, 110],
          [L / 2 + 50, 2, -Math.PI / 2, 110],
        ],
        planters: [
          [-L / 2 - 12, 7, 0.04, 14, 3.2, 2.2],
          [L / 2 + 7.5, 2, 0, 3.2, 16, 2.2],
          [0, -13, 0, L + 14, 3.6, 2.2],
        ],
        grass: [
          [13, 2.6, 2.4, 70, 2.6],
          [2.6, 15, 2.4, 80, 2.6],
          [L + 12, 3, 2.4, 120, 1.6],
        ],
        posts: [
          [-L / 2 - 14, 14],
          [L / 2 + 14, -4],
          [-L / 2 - 4, -20],
        ],
        shrubs: [-L / 2 - 2, L / 2 - 4].map((x, i) => [x + 3, 2.4, -13, 1.6, 2.4, i + 3]),
        trees: [
          [-L / 2 - 16, 2.4, 7, 1.2, 6],
          [L / 2 + 12, 0, -20, 1.7, 7],
          [-L / 2 - 16, 0, -22, 1.8, 8],
        ],
        palms: [],
        hedges: [],
        walls: [],
        pots: [],
      }
    case 'campus':
      return {
        buildings: [
          [-58, -52, 0.12, 120],
          [46, -60, 0, 96],
          [L / 2 + 70, 10, -Math.PI / 2, 90],
        ],
        planters: [
          [L / 2 + 9, -6, 0, 14, 4, 1.8],
          [-L / 2 - 9, -9, 0, 4, 12, 1.8],
        ],
        grass: [[13, 3, 2.1, 65, 1.3]],
        posts: [],
        shrubs: [],
        trees: [
          [L / 2 + 9, 1.8, -6, 1.15, 10],
          [-L / 2 - 10, 1.8, -10, 1.3, 11],
          [L / 2 + 22, 0, 14, 1.5, 12],
        ],
        palms: [
          [-14, -38, 20],
          [6, -42, 24],
          [22, -36, 18],
          [-32, -34, 22],
          [L / 2 + 26, -14, 20],
        ].map(([x, z, h], i) => [x, z, h, i + 1]),
        hedges: [],
        walls: [],
        pots: [],
      }
    case 'backyard':
      return {
        buildings: [
          [-(L / 2 + 34), -26, 0.42],
          [L / 2 + 52, -40, -0.55],
        ],
        planters: [],
        grass: [],
        posts: [],
        shrubs: [
          ...[-L / 2 - 4.5, -L / 2 - 3, L / 2 + 3.5].map((x, i) => [
            x,
            0,
            9 + i * 1.4,
            1.3,
            1.6,
            20 + i,
          ]),
          ...[0, 1, 2].map((i) => [-L / 2 - 8 - i * 3.2, 0, -6 + i * 1.1, 1.8, 2.6, 30 + i]),
          [L / 2 + 5, 0, -5, 2.2, 3, 40],
        ],
        trees: [
          [-L / 2 - 12, 0, -16, 1.9, 13],
          [L / 2 + 16, 0, -18, 2.1, 14],
          [L / 2 + 26, 0, 6, 1.6, 15],
        ],
        palms: [],
        hedges: [[-14, L + 34]],
        walls: [],
        pots: [],
      }
    case 'courtyard':
    case 'desert':
      return {
        buildings: [],
        planters: [],
        grass: [],
        posts: [],
        shrubs: [],
        trees: [
          ...[-1, 1].flatMap((side) => [
            [side * (L / 2 + 6), 0, -8, 1.55, side > 0 ? 1 : 2],
            [side * (L / 2 + 14), 0, -19, 2.0, side > 0 ? 3 : 4],
          ]),
          [-L / 2 - 0.8, 1.75, 11.5, 0.5, 5],
        ],
        palms: [],
        hedges: environment === 'courtyard' ? [[-10.75, L + 20]] : [],
        walls: [[-12, L + 24]],
        pots: [[-L / 2 - 0.8, 11.5, 0.75, 1.8]],
      }
    default:
      return {
        buildings: [],
        planters: [],
        grass: [],
        posts: [],
        shrubs: [],
        trees: [],
        palms: [],
        hedges: [],
        walls: [],
        pots: [],
      }
  }
}

/** The layout in the same terms. */
const placed = (layout: SceneryLayout) => ({
  buildings: layout.buildings.map((b) =>
    b.kind === 'house' ? [b.x, b.z, b.turn] : [b.x, b.z, b.turn, b.length],
  ),
  planters: layout.planters.map((p) => [p.x, p.z, p.turn, p.width, p.depth, p.height]),
  grass: layout.planters.flatMap(({ grass: g }) =>
    g ? [[g.width, g.depth, g.base, g.count, g.height]] : [],
  ),
  posts: layout.posts.map((p) => [p.x, p.z]),
  shrubs: layout.shrubs.map((s) => [s.x, s.base, s.z, s.radius, s.height, s.seed]),
  trees: layout.trees.map((t) => [t.x, t.base, t.z, t.scale, t.seed]),
  palms: layout.palms.map((p) => [p.x, p.z, p.height, p.seed]),
  hedges: layout.hedges.map((h) => [h.z, h.length]),
  walls: layout.walls.map((w) => [w.z, w.length]),
  pots: layout.pots.map((p) => [p.x, p.z, p.radius, p.height]),
})

/** Every corner of every part of a model, as placed. */
function corners(parts: Part[]): Vec3[] {
  const out: Vec3[] = []
  for (const p of parts) {
    p.geometry.computeBoundingBox()
    const { min, max } = p.geometry.boundingBox!
    for (const x of [min.x, max.x])
      for (const y of [min.y, max.y])
        for (const z of [min.z, max.z]) {
          const v = new Vector3(x, y, z).applyMatrix4(p.matrix)
          out.push([v.x, v.y, v.z])
        }
  }
  return out
}

/** Whether a point is inside one of the shapes, give or take `slack`. */
const held = (shapes: KeepOut[], p: Vec3, slack = 0.05) => shapes.some((k) => contains(k, p, slack))

describe('the scenery layout', () => {
  it('places every shape where the settings placed it before', () => {
    for (const { id } of ENVIRONMENTS)
      for (const L of LENGTHS)
        expect(placed(sceneryLayout(id, L)), `${id} ${L} ft`).toEqual(before(id, L))
  })

  it("holds the buildings' geometry, and no more than a foot beyond it", () => {
    for (const { id } of ENVIRONMENTS)
      for (const L of LENGTHS) {
        const layout = sceneryLayout(id, L)
        for (const b of layout.buildings) {
          const parts =
            b.kind === 'apartment'
              ? apartmentBlock({ length: b.length, style: b.style, seed: b.seed })
              : b.kind === 'house'
                ? modernHouse()
                : (b.kind === 'precast' ? precastOffice : curtainWallOffice)(b)
          const at = place(parts, [b.x, 0, b.z], [0, b.turn, 0])
          const shapes = keepOuts({
            ...layout,
            buildings: [b],
            trees: [],
            palms: [],
            planters: [],
          }).filter((k) => k.kind === 'building')
          for (const p of corners(at)) expect(held(shapes, p), `${id} ${b.kind} ${p}`).toBe(true)
          // Tight: each box's extent in its own frame is the model's, within a foot.
          const own = new Box3()
          for (const p of corners(parts)) own.expandByPoint(new Vector3(...p))
          const box = shapes[0]
          if (box.shape !== 'box') throw new Error('a building is a box')
          expect(own.max.y).toBeGreaterThan(box.max[1] - 1)
          expect(own.min.x).toBeLessThan(box.min[0] + 1)
          expect(own.max.x).toBeGreaterThan(box.max[0] - 1)
          expect(own.min.z).toBeLessThan(box.min[2] + 1)
        }
      }
  })

  it('holds every tree, palm, shrub and planter of every setting', () => {
    const v = new Vector3(),
      q = new Quaternion(),
      s = new Vector3()
    for (const { id } of ENVIRONMENTS) {
      const layout = sceneryLayout(id, 20)
      const shapes = keepOuts(layout)
      for (const t of layout.trees) {
        const shape = treeShape(t.seed, t.biome, 1800)
        const at = (p: Vector3): Vec3 => [
          t.x + p.x * t.scale,
          t.base + p.y * t.scale,
          t.z + p.z * t.scale,
        ]
        for (const m of shape.leaves) {
          m.decompose(v, q, s)
          // A leaf card's centre, and its reach toward the outside of the crown.
          const out = v.clone().add(new Vector3(v.x, 0, v.z).setLength(0.35 * s.x))
          expect(held(shapes, at(v)), `${id} tree ${t.seed} leaf`).toBe(true)
          expect(held(shapes, at(out)), `${id} tree ${t.seed} leaf edge`).toBe(true)
        }
        for (const limb of shape.limbs)
          expect(held(shapes, at(limb.to)), `${id} tree ${t.seed} limb`).toBe(true)
      }
      for (const p of layout.palms) {
        const shape = palmShape(p.seed, p.height)
        const tip = new Vector3()
        for (const frond of shape.fronds)
          for (const [x, y] of [
            [3.2, 0],
            [6.2, -1.1],
          ]) {
            tip.set(x, y, 0).applyMatrix4(frond).add(shape.crown)
            expect(held(shapes, [p.x + tip.x, tip.y, p.z + tip.z]), `${id} palm ${p.seed}`).toBe(
              true,
            )
          }
        for (const limb of shape.trunk)
          expect(held(shapes, [p.x + limb.to.x, limb.to.y - 0.1, p.z + limb.to.z])).toBe(true)
      }
      for (const sh of layout.shrubs) {
        const { leaves, blossoms } = shrubShape(sh.seed, sh.radius, sh.height, 400)
        for (const m of [...leaves, ...blossoms]) {
          v.setFromMatrixPosition(m)
          expect(held(shapes, [sh.x + v.x, sh.base + v.y, sh.z + v.z]), `${id} shrub`).toBe(true)
        }
      }
      for (const p of layout.planters) {
        const at = place(planter(p.width, p.depth, p.height), [p.x, 0, p.z], [0, p.turn, 0])
        for (const c of corners(at)) expect(held(shapes, c), `${id} planter`).toBe(true)
      }
    }
  })

  it("takes a crown's dense core as what hides the build: most leaves of every tree", () => {
    const v = new Vector3()
    for (const { id } of ENVIRONMENTS) {
      const layout = sceneryLayout(id, 20)
      const crowns = keepOuts(layout).filter((k) => k.kind === 'crown')
      for (const t of layout.trees) {
        const crown = crowns.find((k) => k.shape === 'cylinder' && k.x === t.x && k.z === t.z)!
        if (crown.shape !== 'cylinder') throw new Error('a crown is a cylinder')
        const leaves = treeShape(t.seed, t.biome, 1800).leaves
        const core = leaves.filter((m) => {
          v.setFromMatrixPosition(m)
          return Math.hypot(v.x, v.z) * t.scale <= crown.radius * FOLIAGE_CORE
        })
        expect(core.length / leaves.length, `${id} tree ${t.seed}`).toBeGreaterThanOrEqual(0.94)
      }
    }
  })

  it('holds the hedges, garden walls and lamp posts the settings build from its measurements', () => {
    for (const { id } of ENVIRONMENTS) {
      const layout = sceneryLayout(id, 20)
      const shapes = keepOuts(layout)
      for (const h of layout.hedges)
        for (const x of [-h.length / 2, 0, h.length / 2])
          for (const z of [-HEDGE.depth / 2, HEDGE.depth / 2])
            expect(held(shapes, [x, HEDGE.height, h.z + z])).toBe(true)
      const { coping } = GARDEN_WALL
      for (const w of layout.walls)
        for (const x of [-(w.length + coping.overhang) / 2, (w.length + coping.overhang) / 2])
          expect(held(shapes, [x, coping.y + coping.height / 2, w.z + coping.depth / 2])).toBe(true)
      for (const p of layout.posts)
        expect(
          held(shapes, [
            p.x + LAMP_POST.head.width / 2,
            LAMP_POST.head.y + LAMP_POST.head.height / 2,
            p.z + LAMP_POST.head.width / 2,
          ]),
        ).toBe(true)
    }
  })

  it('keeps the setting clear of the build, and keeps it by its length', () => {
    for (const { id } of ENVIRONMENTS)
      for (const L of LENGTHS) {
        const shapes = sceneryKeepOuts({ environment: id, length: L })
        // The build's body: nothing stands in it.
        for (const x of [-L / 2, 0, L / 2])
          for (const z of [-4, 0, 4])
            expect(held(shapes, [x, 4, z], 0), `${id} ${L} ft at ${x}, ${z}`).toBe(false)
        expect(sceneryKeepOuts({ environment: id, length: L })).toBe(shapes)
      }
    expect(sceneryKeepOuts({ environment: 'studio', length: 20 })).toEqual([])
  })

  it('tells a sight line through a shape from one past it', () => {
    const [wall] = keepOuts(sceneryLayout('desert', 20)).filter((k) => k.kind === 'wall')
    // Low behind the wall, toward the build's base: through it. From high up: over it.
    expect(crosses(wall, [0, 2, -30], [0, 1, 0])).toBe(true)
    expect(crosses(wall, [0, 20, -30], [0, 1, 0])).toBe(false)
    // Past its end.
    expect(crosses(wall, [40, 2, -30], [40, 1, 0])).toBe(false)
    const crown: KeepOut = {
      kind: 'crown',
      porous: true,
      shape: 'cylinder',
      x: 0,
      z: 0,
      radius: 5,
      bottom: 4,
      top: 12,
    }
    expect(crosses(crown, [-20, 8, 0], [20, 8, 0])).toBe(true)
    // Under it, and through its very edge (foliage, seen through).
    expect(crosses(crown, [-20, 2, 0], [20, 2, 0])).toBe(false)
    expect(crosses(crown, [-20, 8, 4.6], [20, 8, 4.6])).toBe(false)
    expect(crosses({ ...crown, porous: false }, [-20, 8, 4.6], [20, 8, 4.6])).toBe(true)
  })

  it('stays free of three.js, with the gallery that reads it', () => {
    // Followed through every module they import at run time: the app shell loads them all.
    const root = dirname(fileURLToPath(import.meta.url))
    const seen = new Set<string>()
    const visit = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      const source = readFileSync(path, 'utf8')
      for (const [, kind, from] of source.matchAll(/^import (type )?[^;]*? from '([^']+)'/gms)) {
        if (kind) continue
        expect(from, `${path} imports ${from}`).not.toMatch(/^three|@react-three/)
        if (from.startsWith('.')) visit(join(dirname(path), `${from.replace(/\.js$/, '')}.ts`))
      }
    }
    visit(join(root, 'gallery.ts'))
    expect([...seen].map((p) => p.slice(root.length - 'render'.length))).toContain(
      'render/scenery.ts',
    )
  })
})
