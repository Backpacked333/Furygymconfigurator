/** CPU geometry port of Landscape/Surroundings. No React, browser, renderer or provider. */
import { BufferGeometry, Color, Matrix4, PlaneGeometry, Shape, ShapeGeometry } from 'three'
import type { Config } from '../src/lib/config'
import { noise, smoothstep } from '../src/lib/visuals'
import { box, cylinder, roundedBox, mergeGeometries } from '../src/render/geometry'
import { part, place, compose, type Part } from '../src/render/parts'
import { material } from '../src/render/prototype/materialCapture'
import { palette } from '../src/render/palette'
import {
  apartmentBlock,
  modernHouse,
  curtainWallOffice,
  precastOffice,
  planter,
  loungeSet,
  slatBench,
} from '../src/render/buildings'
import {
  sceneryLayout,
  GARDEN_WALL,
  LAMP_POST,
  type SceneryLayout,
  type BuildingSpot,
  type PlanterSpot,
  type PostSpot,
} from '../src/render/scenery'
import {
  treeShape,
  grassBlade,
  grassPalette,
  palmShape,
  palmFrond,
  shrubShape,
  type Biome,
} from '../src/render/vegetation'
import { agaveGeometry, boulderGeometry, limbParts } from '../src/render/landscapeParts'
import { deckFront } from '../src/render/envelope'
import type { Material } from 'three'

export type NativePart = Part & { instances?: Matrix4[] }
const LEAVES = {
  courtyard: ['#4f6b33', '#5d7a3a', '#6f8a45', '#41592b', '#7c9550', '#58733a'],
  desert: ['#7d8a62', '#8e9a72', '#6c7a55', '#9aa47e', '#a6ad88'],
}

/** Same seeded quadratic leaf silhouettes as leafAtlas, triangulated rather than canvas-rasterized. */
function leafCluster(biome: Biome): NativePart[] {
  const groups: BufferGeometry[][] = LEAVES[biome].map(() => [])
  for (let i = 0; i < (biome === 'desert' ? 70 : 42); i++) {
    const a = noise(i, 61) * Math.PI * 2,
      r = Math.sqrt(noise(i, 62)) * 512 * 0.36
    const length = biome === 'desert' ? 70 + noise(i, 63) * 40 : 96 + noise(i, 63) * 60
    const width = length * (biome === 'desert' ? 0.26 : 0.46)
    const shape = new Shape().moveTo(-length / 2, 0)
    shape.quadraticCurveTo(0, -width, length / 2, 0).quadraticCurveTo(0, width, -length / 2, 0)
    const geometry = new ShapeGeometry(shape, 5).toNonIndexed()
    geometry.rotateZ(-noise(i, 64) * Math.PI * 2)
    geometry.translate(Math.cos(a) * r, -Math.sin(a) * r, 0)
    geometry.scale(1 / 512, 1 / 512, 1 / 512)
    groups[i % groups.length].push(geometry)
  }
  return groups.map((geometries, i) => {
    const geometry = mergeGeometries(geometries)
    for (const item of geometries) item.dispose()
    return part(geometry, material({ color: LEAVES[biome][i], roughness: 0.72, side: 2 }))
  })
}

function tufts(
  count: number,
  blades: number,
  height: number,
  bend: number,
  colors: [string, string],
  locate: (i: number, variant: number) => [number, number] | null,
  variant = 0,
  base = 0,
): NativePart {
  const geometries: BufferGeometry[] = []
  for (let b = 0; b < blades; b++) {
    const g = grassBlade(height * (0.65 + noise(b, 91) * 0.5), bend * (0.6 + noise(b, 92) * 0.8))
    g.rotateY((b / blades) * Math.PI * 2 + noise(b, 93))
    g.translate((noise(b, 94) - 0.5) * 0.12, 0, (noise(b, 95) - 0.5) * 0.12)
    geometries.push(g.toNonIndexed())
  }
  const geometry = mergeGeometries(geometries)
  geometry.computeVertexNormals()
  for (const g of geometries) g.dispose()
  const instances: Matrix4[] = []
  for (let i = 0; i < count * 3 && instances.length < count; i++) {
    const p = locate(i, variant)
    if (!p) continue
    const s = 0.7 + noise(i, 97) * 0.6
    instances.push(compose([p[0], base, p[1]], [0, noise(i, 96) * Math.PI * 2, 0], [s, s, s]))
  }
  const lo = new Color(colors[0]),
    hi = new Color(colors[1])
  return {
    ...part(
      geometry,
      material({ color: lo.clone().lerp(hi, 0.5).getHex(), roughness: 0.9, side: 2 }),
    ),
    instances,
  }
}

function grassBed(p: PlanterSpot): NativePart[] {
  if (!p.grass) return []
  const g = p.grass
  return [
    tufts(
      g.count,
      16,
      g.height,
      0.6,
      g.colors ?? ['#6e6a3c', '#d6c98d'],
      (i) => [
        p.x + (noise(i, 201 + Math.round(p.x)) - 0.5) * g.width,
        p.z + (noise(i, 202 + Math.round(p.z)) - 0.5) * g.depth,
      ],
      0,
      g.base,
    ),
  ]
}

export function nativeScenery(c: Config): {
  parts: NativePart[]
  layout: SceneryLayout
  holds: string[]
} {
  const layout = sceneryLayout(c.environment, c.length),
    L = c.length
  if (c.environment === 'studio') return { parts: [], layout, holds: [] }
  if (!['residences', 'campus', 'desert'].includes(c.environment)) throw Error('unsupported-scene')
  const desert = c.environment === 'desert',
    parts: NativePart[] = []
  const ground = new PlaneGeometry(700, 700)
  const uv = ground.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 700, uv.getY(i) * 700)
  const set = desert
    ? 'dry_ground_01'
    : c.environment === 'campus'
      ? 'concrete_pavement'
      : 'herringbone_pavement'
  parts.push(
    part(
      ground,
      material({
        set,
        color: desert ? '#f4e6d2' : c.environment === 'campus' ? '#d8d2c7' : '#cdbfae',
        roughness: 1,
        normalScale: 0.8,
      }),
      [0, -0.14, 0],
      [-Math.PI / 2, 0, 0],
    ),
  )
  parts.push(...layout.buildings.flatMap(buildingParts))
  if (desert) {
    parts.push(...hardscape(L, 'desert', c.lights, layout), ...desertAccents(L))
    for (const [k, colors] of grassPalette('desert').entries())
      parts.push(
        tufts(
          120,
          9,
          1.1,
          0.55,
          colors,
          (index, variant) => {
            const i = index * 3 + variant,
              side = i % 2 ? 1 : -1
            return [
              side * (L / 2 + 3) + (noise(i, 11) - 0.5) * 1.8,
              4 + (noise(i, 12) - 0.5) * 13.4,
            ]
          },
          k,
        ),
      )
  } else {
    parts.push(...arrivalCourt(c))
    if (c.environment === 'campus') parts.push(...campusSite(layout, L))
    else {
      parts.push(
        ...layout.planters.flatMap(planterParts),
        ...place(loungeSet({ flame: c.lights && c.time > 17 }), [L / 2 + 17, 0, 12], [0, -0.5, 0]),
      )
      for (const post of layout.posts)
        parts.push(
          ...postParts(
            post,
            palette.powder('#1a1b1a', false, 0.6),
            c.lights ? palette.emitter('#ffd8a6', 5) : palette.plastic('#e7e3da', 0.4),
          ),
        )
    }
    parts.push(...layout.planters.flatMap(grassBed))
    if (c.environment === 'campus')
      parts.push(
        tufts(30, 16, 1.3, 0.6, ['#7a6c4c', '#d2c294'], (i) => [
          -L / 2 - 5 + (noise(i, 201 + Math.round(-L / 2 - 5)) - 0.5) * 4,
          3 + (noise(i, 205) - 0.5) * 11,
        ]),
      )
  }
  for (const t of layout.trees) {
    const shape = treeShape(t.seed, t.biome, t.biome === 'desert' ? 1700 : 1500)
    parts.push(
      ...place(
        limbParts(
          shape,
          material({
            set: 'bark_platanus',
            color: t.biome === 'desert' ? '#c9bfae' : '#a99b88',
            roughness: 1,
          }),
        ),
        [t.x, t.base, t.z],
        undefined,
        [t.scale, t.scale, t.scale],
      ),
    )
    const parent = compose([t.x, t.base, t.z], undefined, [t.scale, t.scale, t.scale])
    for (const p of leafCluster(t.biome))
      parts.push({ ...p, instances: shape.leaves.map((m) => parent.clone().multiply(m)) })
  }
  for (const p of layout.palms) {
    const shape = palmShape(p.seed, p.height)
    parts.push(
      ...place(
        limbParts(
          { limbs: shape.trunk, leaves: [], crownHeight: 0 },
          material({ set: 'bark_platanus', color: '#9a8a76', roughness: 1 }),
        ),
        [p.x, 0, p.z],
      ),
    )
    parts.push(
      part(
        cylinder(1.35, 0.62, 3.4, 20),
        material({ set: 'bark_platanus', color: '#a38a64', roughness: 1 }),
        [p.x + shape.crown.x, shape.crown.y - 1.9, p.z + shape.crown.z],
      ),
    )
    const parent = compose([p.x + shape.crown.x, shape.crown.y, p.z + shape.crown.z])
    parts.push({
      ...part(palmFrond(), material({ color: '#5f7a3c', roughness: 0.62, side: 2 })),
      instances: shape.fronds.map((m) => parent.clone().multiply(m)),
    })
  }
  for (const s of layout.shrubs) {
    const shape = shrubShape(s.seed, s.radius, s.height, Math.ceil(s.radius * s.radius * 90)),
      parent = compose([s.x, s.base, s.z])
    for (const p of leafCluster('courtyard'))
      parts.push({ ...p, instances: shape.leaves.map((m) => parent.clone().multiply(m)) })
    if (s.blossom && shape.blossoms.length) {
      const flowers: BufferGeometry[] = []
      for (let i = 0; i < 70; i++) {
        const a = noise(i, 121) * Math.PI * 2,
          r = Math.sqrt(noise(i, 122)) * 256 * 0.38,
          rad = 5 + noise(i, 124) * 6
        const circle = new Shape().absarc(0, 0, rad, 0, Math.PI * 2, false)
        const g = new ShapeGeometry(circle, 6).toNonIndexed()
        g.translate(Math.cos(a) * r, -Math.sin(a) * r, 0)
        g.scale(1 / 256, 1 / 256, 1 / 256)
        flowers.push(g)
      }
      const geometry = mergeGeometries(flowers)
      flowers.forEach((g) => g.dispose())
      parts.push({
        ...part(geometry, material({ color: s.blossom, roughness: 0.75, side: 2 })),
        instances: shape.blossoms.map((m) => parent.clone().multiply(m)),
      })
    }
  }
  const glow = smoothstep(17.25, 20.5, c.time) * 2.4
  for (const p of parts) {
    const spec = p.material.userData.prototypeMaterial?.authoredSpec
    if (spec?.emissive && spec.emissiveIntensity === 0)
      p.material = material({ ...spec, emissiveIntensity: glow })
  }
  return {
    parts,
    layout,
    holds: [
      'Authored scenery geometry, placement seeds, scan textures and sky model retained; native outdoor pixel parity has not been visually qualified.',
      'Leaf/flower canvas silhouettes are triangulated from authored seeds; canvas gradients/veins, bent shading normals and raster translucency are not exact shader parity.',
      'Ground uses the existing path-tracer scan representation, not raster two-scale anti-tiling; grass uses midpoint of authored gradient colors.',
    ],
  }
}

function hardscape(L: number, biome: Biome, lights: boolean, layout: SceneryLayout): Part[] {
  const desert = biome === 'desert'
  const paving = material({
    set: 'concrete_pavement',
    color: desert ? '#f0e2cc' : '#e9e6df',
    roughness: 1,
  })
  const smooth = material({
    set: 'concrete_wall_001',
    color: desert ? '#efe0c8' : '#e6e3db',
    roughness: 0.95,
  })
  const wall = material({
    set: 'concrete_slab_wall',
    color: desert ? '#ead3b2' : '#dedbd2',
    roughness: 1,
  })
  const steel = palette.powder('#2f2d2a', false, 0.75)
  const gravel = material({
    set: 'clean_pebbles',
    color: desert ? '#f1dcc0' : '#ffffff',
    roughness: 1,
  })
  const parts: Part[] = [
    part(box(L + 3, 0.24, 23), paving, [0, -0.12, 3.5], undefined, undefined, false),
  ]
  // Board-formed garden wall with a smooth precast coping.
  const { coping } = GARDEN_WALL
  for (const w of layout.walls)
    parts.push(
      part(box(w.length, GARDEN_WALL.height, GARDEN_WALL.thickness), wall, [0, GARDEN_WALL.y, w.z]),
      part(roundedBox(w.length + coping.overhang, coping.height, coping.depth, 0.03, 1), smooth, [
        0,
        coping.y,
        w.z,
      ]),
    )
  for (let i = 0; i < 7; i++)
    parts.push(
      part(
        roundedBox(5.2, 0.22, 1.95, 0.04, 1),
        smooth,
        [0, -0.05, 16.2 + i * 2.5],
        [0, (noise(i, 5) - 0.5) * 0.05, 0],
      ),
    )
  // Steel-edged gravel beds along both sides of the unit.
  for (const side of [-1, 1]) {
    const x = side * (L / 2 + 3)
    parts.push(part(box(2.0, 0.08, 13.9), gravel, [x, 0.03, 4], undefined, undefined, false))
    for (const dx of [-1.04, 1.04]) parts.push(part(box(0.025, 0.32, 14), steel, [x + dx, 0.02, 4]))
    for (const dz of [-7.01, 7.01])
      parts.push(part(box(2.1, 0.32, 0.025), steel, [x, 0.02, 4 + dz]))
    // Low path bollards.
    for (const z of [1, 10]) {
      const bx = side * (L / 2 + 1.75)
      parts.push(
        part(cylinder(0.11, 0.11, 1.05, 24), palette.powder('#2c2a27', false, 0.6), [bx, 0.52, z]),
      )
      parts.push(
        part(
          cylinder(0.115, 0.115, 0.08, 24),
          lights ? palette.emitter('#ffd6a0', 3) : palette.plastic('#d9d3c6', 0.4),
          [bx, 0.92, z],
          undefined,
          undefined,
          false,
        ),
      )
      parts.push(
        part(cylinder(0.12, 0.12, 0.05, 24), palette.powder('#2c2a27', false, 0.6), [bx, 1.07, z]),
      )
    }
  }
  // Tapered concrete planter for the potted tree.
  for (const pot of layout.pots) {
    parts.push(
      part(cylinder(pot.radius, 0.56, pot.height, 40), smooth, [pot.x, pot.height / 2, pot.z]),
    )
    parts.push(
      part(
        cylinder(0.68, 0.68, 0.05, 40),
        material({ set: 'dry_ground_01', color: '#7a6a58', roughness: 1 }),
        [pot.x, 1.72, pot.z],
        undefined,
        undefined,
        false,
      ),
    )
  }
  return parts
}

function desertAccents(L: number): Part[] {
  const agave = material({ color: '#7f9c92', roughness: 0.55, metalness: 0 })
  const stone = material({ set: 'concrete_wall_001', color: '#c9ab84', roughness: 1 })
  const parts: Part[] = []
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++)
      parts.push(
        part(
          agaveGeometry(),
          agave,
          [side * (L / 2 + 3) + (noise(i, 33) - 0.5) * 0.6, 0.08, -0.5 + i * 4.2],
          [0, noise(i + side, 34) * 6, 0],
          [0.9 + noise(i, 35) * 0.5, 0.9 + noise(i, 36) * 0.4, 0.9 + noise(i, 35) * 0.5],
        ),
      )
  }
  const rocks: [number, number, number][] = [
    [-L / 2 - 8, 1.6, -5],
    [L / 2 + 9, 2.1, -6],
    [L / 2 + 6.5, 0.9, 13],
    [-L / 2 - 6, 1.1, 14],
    [-L / 2 - 14, 2.6, -16],
    [L / 2 + 16, 1.8, 8],
  ]
  rocks.forEach(([x, s, z], i) =>
    parts.push(
      part(boulderGeometry(i), stone, [x, s * 0.1, z], [0, noise(i, 37) * 6, 0], [s * 1.3, s, s]),
    ),
  )
  return parts
}

function buildingParts(b: BuildingSpot): Part[] {
  const parts =
    b.kind === 'apartment'
      ? apartmentBlock({ length: b.length, style: b.style, seed: b.seed })
      : b.kind === 'house'
        ? modernHouse()
        : (b.kind === 'precast' ? precastOffice : curtainWallOffice)({
            length: b.length,
            floors: b.floors,
            depth: b.depth,
          })
  return place(parts, [b.x, 0, b.z], [0, b.turn, 0])
}

/** A raised planter of the layout. */
const planterParts = (p: PlanterSpot) =>
  place(planter(p.width, p.depth, p.height), [p.x, 0, p.z], [0, p.turn, 0])

/** A courtyard pole light: the pole, its head, and the lamp in it (lit by night). */
function postParts({ x, z }: PostSpot, pole: Material, lamp: Material): Part[] {
  const { height, head } = LAMP_POST
  return [
    part(cylinder(0.12, 0.16, height, 16), pole, [x, height / 2, z]),
    part(box(head.width, head.height, head.width), pole, [x, head.y, z]),
    part(box(0.55, 0.8, 0.55), lamp, [x, 12.2, z], undefined, undefined, false),
  ]
}

function arrivalCourt(c: Config): Part[] {
  const start = c.addons.deck ? deckFront(c) + 0.25 : 4.5

  const tones = ['#ccc9bd', '#c4c2b7', '#d2cec3'].map((color) =>
    material({ set: 'concrete_wall_001', color, roughness: 0.92 }),
  )
  const joint = palette.powder('#55574f', false, 1)
  const width = c.length + 4
  const columns = Math.ceil(width / 3)
  const slabWidth = width / columns
  const parts: Part[] = [part(box(width + 0.12, 0.1, 8.12), joint, [0, -0.08, start + 4])]
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < columns; col++)
      parts.push(
        part(
          box(slabWidth - 0.025, 0.08, 3.975),
          tones[Math.floor(noise(col, row + 83) * tones.length)],
          [-width / 2 + (col + 0.5) * slabWidth, -0.005, start + row * 4 + 2],
          undefined,
          undefined,
          false,
        ),
      )
  return parts
}

function campusSite(layout: SceneryLayout, L: number): Part[] {
  const gravel = material({ set: 'clean_pebbles', color: '#efe3cf', roughness: 1 })
  const edge = palette.powder('#2f2d2a', false, 0.75)
  const agave = material({ color: '#7f9c92', roughness: 0.55 })
  const stone = material({ set: 'concrete_wall_001', color: '#c9ab84', roughness: 1 })
  const parts: Part[] = [
    ...layout.planters.flatMap(planterParts),
    ...place(slatBench(), [L / 2 + 10, 0, 9], [0, -0.35, 0]),
    ...place(slatBench(), [-L / 2 - 12, 0, 12], [0, 0.4, 0]),
  ]
  // Gravel beds with agaves and boulders flanking the unit.
  for (const [x, z, w, d] of [
    [-L / 2 - 5, 3, 5, 12],
    [L / 2 + 5, 8, 5, 6],
  ] as const) {
    parts.push(part(box(w, 0.1, d), gravel, [x, 0.04, z], undefined, undefined, false))
    parts.push(part(box(w + 0.1, 0.3, 0.05), edge, [x, 0.05, z - d / 2]))
    parts.push(part(box(w + 0.1, 0.3, 0.05), edge, [x, 0.05, z + d / 2]))
    for (let i = 0; i < 4; i++)
      parts.push(
        part(
          agaveGeometry(),
          agave,
          [x + (noise(i, 211 + x) - 0.5) * (w - 1.5), 0.08, z + (noise(i, 212) - 0.5) * (d - 2)],
          [0, noise(i, 213) * 6, 0],
          [1.1 + noise(i, 214) * 0.5, 1 + noise(i, 215) * 0.4, 1.1 + noise(i, 214) * 0.5],
        ),
      )
    parts.push(
      part(
        boulderGeometry(Math.round(x)),
        stone,
        [x - 1, 0.1, z + d / 3],
        [0, x, 0],
        [1.4, 1, 1.2],
      ),
    )
  }
  // Succulents in the raised planters.
  for (let i = 0; i < 5; i++)
    parts.push(
      part(
        agaveGeometry(),
        agave,
        [L / 2 + 4 + i * 2.4, 2.0, -6 + (noise(i, 216) - 0.5) * 2],
        [0, i, 0],
        [0.7, 0.7, 0.7],
      ),
    )
  return parts
}
