import { memo, useEffect, useMemo } from 'react'
import {
  BufferGeometry,
  Color,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from 'three/webgpu'
import type { Config } from '../lib/config'
import { noise } from '../lib/visuals'
import { box, cylinder, mergeGeometries, roundedBox } from '../render/geometry'
import { groundMaterial } from '../render/ground'
import { material, prefetchTextures, type TextureSet } from '../render/materials'
import { palette } from '../render/palette'
import { part, type Part } from '../render/parts'
import type { Quality } from '../render/quality'
import {
  grassBlade,
  grassMaterial,
  grassPalette,
  leafCard,
  leafMaterial,
  treeShape,
  type Biome,
} from '../render/vegetation'
import { Parts } from './Parts'
import { useInstances } from './useInstances'
import { thinned } from '../render/instances'
import { agaveGeometry, boulderGeometry, limbParts } from '../render/landscapeParts'
import { GARDEN_WALL, HEDGE, sceneryLayout, type SceneryLayout } from '../render/scenery'
import { Backyard, Campus, Residences } from './Surroundings'

/** Module-level so the lawn's grass material is not rebuilt on every Landscape render. */
const LAWN_COLORS: [string, string] = ['#3d5126', '#93a258']

// --- Ground -----------------------------------------------------------------------------

const GROUND_SIZE = 700

/**
 * Scanned ground with anti-tiling (render/ground.ts): two scales of the same scan are blended by
 * low-frequency noise and modulated by a macro brightness field, so a 600-foot plane never shows
 * a repeat.
 */
export function Ground({ set, size, tint }: { set: TextureSet; size: number; tint: string }) {
  // Kept for the session, never disposed while drawn (which made three rebuild it).
  const ground = useMemo(() => groundMaterial(set, size, tint), [set, size, tint])
  const plane = useMemo(() => {
    const g = new PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1)
    // UVs in feet, like every library surface (the raster material maps by world position).
    const uvs = g.getAttribute('uv')
    for (let i = 0; i < uvs.count; i++)
      uvs.setXY(i, uvs.getX(i) * GROUND_SIZE, uvs.getY(i) * GROUND_SIZE)
    return g
  }, [])
  useEffect(() => () => plane.dispose(), [plane])
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.14, 0]}
      receiveShadow
      material={ground}
      geometry={plane}
    />
  )
}

// --- Hardscape ----------------------------------------------------------------------------

/**
 * The garden's paving, its wall and the potted tree's pot (where scenery.ts puts them), its steps,
 * gravel beds and bollards.
 */
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

// --- Trees --------------------------------------------------------------------------------

export const Tree = memo(function Tree({
  position,
  scale,
  seed,
  biome,
  quality,
}: {
  position: [number, number, number]
  scale: number
  seed: number
  biome: Biome
  quality: Quality
}) {
  const { count, drawn } = thinned(biome === 'desert' ? 1700 : 1500, quality, 300)
  const shape = useMemo(() => treeShape(seed, biome, count), [seed, biome, count])
  const limbs = useMemo(
    () =>
      limbParts(
        shape,
        material({
          set: 'bark_platanus',
          color: biome === 'desert' ? '#c9bfae' : '#a99b88',
          roughness: 1,
        }),
      ),
    [shape, biome],
  )
  const card = useMemo(leafCard, [])
  const leaves = useMemo(() => leafMaterial(biome, shape.crownHeight), [biome, shape.crownHeight])
  useEffect(() => () => card.dispose(), [card])
  const mesh = useInstances(shape.leaves, drawn, card, leaves)
  return (
    <group position={position} scale={scale}>
      <Parts parts={limbs} />
      <instancedMesh
        ref={mesh}
        args={[card, leaves, shape.leaves.length]}
        castShadow
        receiveShadow
      />
    </group>
  )
})

/** A clipped hedge: leaf cards scattered over the faces of a box in front of the garden wall. */
export const Hedge = memo(function Hedge({
  length,
  quality,
  z = -10.75,
}: {
  length: number
  quality: Quality
  z?: number
}) {
  const { count, drawn } = thinned(4200, quality, 500)
  const card = useMemo(leafCard, [])
  const leaves = useMemo(() => leafMaterial('courtyard', HEDGE.height / 2, true), [])
  useEffect(() => () => card.dispose(), [card])
  const matrices = useMemo(() => {
    const object = new Object3D()
    const list: Matrix4[] = []
    for (let i = 0; i < count; i++) {
      const face = noise(i, 51)
      const x = (noise(i, 52) - 0.5) * length
      const jitter = (noise(i, 53) - 0.5) * 0.35
      if (face < 0.62) object.position.set(x, noise(i, 54) * HEDGE.height, HEDGE.depth / 2 + jitter)
      else if (face < 0.9)
        object.position.set(x, HEDGE.height + jitter * 0.6, (noise(i, 54) - 0.5) * HEDGE.depth)
      else object.position.set(x, noise(i, 54) * HEDGE.height, -HEDGE.depth / 2 + jitter)
      object.rotation.set(
        noise(i, 55) * Math.PI,
        noise(i, 56) * Math.PI * 2,
        noise(i, 57) * Math.PI,
      )
      object.scale.setScalar(0.75 + noise(i, 58) * 0.4)
      object.updateMatrix()
      list.push(object.matrix.clone())
    }
    return list
  }, [count, length])
  const mesh = useInstances(matrices, drawn, card, leaves)
  const core = useMemo(
    () => [
      part(
        box(length - 0.4, HEDGE.height - 0.3, HEDGE.depth - 0.5),
        material({ color: '#2b3a1e', roughness: 1 }),
        [0, (HEDGE.height - 0.3) / 2, 0],
      ),
    ],
    [length],
  )
  return (
    <group position={[0, 0, z]}>
      <Parts parts={core} />
      <instancedMesh
        ref={mesh}
        args={[card, leaves, matrices.length]}
        castShadow
        receiveShadow
        userData={{ noProbe: true }}
      />
    </group>
  )
})

// --- Grasses, agaves, boulders -----------------------------------------------------------

/** Instanced clumps of grass blades scattered by a placement function. */
export function Tufts({
  count,
  drawn = count,
  blades,
  height,
  bend,
  place,
  variant = 0,
  colors,
  shadow,
}: {
  /** Tufts placed (at full density), and how many the raster draws (instances.ts). */
  count: number
  drawn?: number
  blades: number
  height: number
  bend: number
  place: (i: number, variant: number) => [number, number] | null
  variant?: number
  colors: [string, string]
  shadow: boolean
}) {
  const geometry = useMemo(() => {
    const parts: BufferGeometry[] = []
    for (let b = 0; b < blades; b++) {
      const g = grassBlade(height * (0.65 + noise(b, 91) * 0.5), bend * (0.6 + noise(b, 92) * 0.8))
      g.rotateY((b / blades) * Math.PI * 2 + noise(b, 93))
      g.translate((noise(b, 94) - 0.5) * 0.12, 0, (noise(b, 95) - 0.5) * 0.12)
      parts.push(g.toNonIndexed())
    }
    const merged = mergeGeometries(parts)
    merged.computeVertexNormals()
    return merged
  }, [blades, height, bend])
  const [base, tip] = colors
  const grass = useMemo(() => grassMaterial(base, tip), [base, tip])
  // Grass materials are shared for the session; only the geometry belongs to this clump.
  useEffect(() => () => geometry.dispose(), [geometry])
  const matrices = useMemo(() => {
    const object = new Object3D()
    const list: Matrix4[] = []
    for (let i = 0; i < count * 3 && list.length < count; i++) {
      const spot = place(i, variant)
      if (!spot) continue
      object.position.set(spot[0], 0, spot[1])
      object.rotation.set(0, noise(i, 96) * Math.PI * 2, 0)
      object.scale.setScalar(0.7 + noise(i, 97) * 0.6)
      object.updateMatrix()
      list.push(object.matrix.clone())
    }
    return list
  }, [count, place, variant])
  const mesh = useInstances(matrices, drawn, geometry, grass)
  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, grass, Math.max(1, count)]}
      castShadow={shadow}
      receiveShadow
      userData={{ noProbe: true }}
    />
  )
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

// --- Studio backdrop ---------------------------------------------------------------------

let studioFloor: MeshStandardMaterial | null = null
function StudioFloor() {
  // Kept for the session so switching back to the backdrop reuses its shader.
  studioFloor ??= new MeshStandardMaterial({ color: new Color('#d8d5ce'), roughness: 0.62 })
  const floor = studioFloor
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow material={floor}>
      <circleGeometry args={[220, 96]} />
    </mesh>
  )
}

// --- Assembly -----------------------------------------------------------------------------

export function Landscape({ config: c, quality }: { config: Config; quality: Quality }) {
  if (c.environment === 'residences') return <Residences config={c} quality={quality} />
  if (c.environment === 'campus') return <Campus config={c} quality={quality} />
  if (c.environment === 'backyard') return <Backyard config={c} quality={quality} />
  return <Garden config={c} quality={quality} />
}

/**
 * The original garden courtyard and desert retreat settings. Where the wall, the hedge, the trees
 * and the potted tree stand is scenery.ts's layout, which the gallery's cameras keep clear of.
 */
function Garden({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  const biome: Biome = c.environment === 'desert' ? 'desert' : 'courtyard'
  const studio = c.environment === 'studio'
  const layout = useMemo(() => sceneryLayout(c.environment, L), [c.environment, L])
  const groundSet: TextureSet = biome === 'desert' ? 'dry_ground_01' : 'leafy_grass'
  // The ground is the largest surface on screen: ask for its scan before the hardscape and the
  // studio queue theirs (Ground itself only asks after it mounts). Requests are deduplicated.
  if (!studio) prefetchTextures(groundSet)
  // The Studio look shows its backdrop floor alone: the hardscape would only download scans it never
  // shows (about 7.8 MB), which the live view would then wait on before it traces.
  const hard = useMemo(
    () => (studio ? [] : hardscape(L, biome, c.lights, layout)),
    [studio, L, biome, c.lights, layout],
  )
  const accents = useMemo(() => (biome === 'desert' ? desertAccents(L) : []), [L, biome])
  const palettes = grassPalette(biome)
  const bedPlace = useMemo(
    () =>
      (index: number, variant: number): [number, number] | null => {
        const i = index * 3 + variant
        const side = i % 2 ? 1 : -1
        return [side * (L / 2 + 3) + (noise(i, 11) - 0.5) * 1.8, 4 + (noise(i, 12) - 0.5) * 13.4]
      },
    [L],
  )
  const lawnPlace = useMemo(
    () =>
      (i: number): [number, number] | null => {
        const x = (noise(i, 13) - 0.5) * (L + 34)
        const z = -11.4 + noise(i, 14) * 40
        const onPaving = Math.abs(x) < (L + 3) / 2 + 0.3 && z > -8.3 && z < 15.3
        const onPath = Math.abs(x) < 2.9 && z > 15 && z < 33
        return onPaving || onPath ? null : [x, z]
      },
    [L],
  )
  if (studio) return <StudioFloor />
  return (
    <group>
      <Ground
        set={groundSet}
        size={biome === 'desert' ? 13.1 : 6.56}
        tint={biome === 'desert' ? '#f4e6d2' : '#b9d49a'}
      />
      <Parts parts={hard} />
      {accents.length > 0 && <Parts parts={accents} />}
      {palettes.map((colors, k) => (
        <Tufts
          key={`bed-${k}`}
          {...thinned(biome === 'desert' ? 120 : 260, quality, 30)}
          blades={biome === 'desert' ? 9 : 14}
          height={biome === 'desert' ? 1.1 : 1.8}
          bend={0.55}
          place={bedPlace}
          variant={k}
          colors={colors}
          shadow={quality !== 'lite'}
        />
      ))}
      {layout.hedges.map((h) => (
        <Hedge key={h.z} length={h.length} quality={quality} z={h.z} />
      ))}
      {biome === 'courtyard' && (
        <Tufts
          {...thinned(5200, quality)}
          blades={9}
          height={0.42}
          bend={0.12}
          place={lawnPlace}
          colors={LAWN_COLORS}
          shadow={false}
        />
      )}
      {layout.trees.map((t) => (
        <Tree
          key={t.seed}
          position={[t.x, t.base, t.z]}
          scale={t.scale}
          seed={t.seed}
          biome={t.biome}
          quality={quality}
        />
      ))}
    </group>
  )
}
