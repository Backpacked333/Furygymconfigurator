import { memo, useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import type { Material } from 'three/webgpu'
import type { Config } from '../lib/config'
import { noise, smoothstep } from '../lib/visuals'
import { box, cylinder } from '../render/geometry'
import { material } from '../render/materials'
import { palette } from '../render/palette'
import { part, place, type Part } from '../render/parts'
import type { Quality } from '../render/quality'
import {
  apartmentBlock,
  curtainWallOffice,
  loungeSet,
  modernHouse,
  planter,
  precastOffice,
  setWindowGlow,
  slatBench,
} from '../render/buildings'
import {
  blossomMaterial,
  leafCard,
  leafMaterial,
  palmFrond,
  palmMaterial,
  palmShape,
  shrubShape,
} from '../render/vegetation'
import { Ground, Hedge, Tree, Tufts } from './Landscape'
import { useInstances } from './useInstances'
import { thinned } from '../render/instances'
import { agaveGeometry, boulderGeometry, limbParts } from '../render/landscapeParts'
import {
  LAMP_POST,
  sceneryLayout,
  type BuildingSpot,
  type PlanterSpot,
  type PostSpot,
  type SceneryLayout,
} from '../render/scenery'
import { Parts } from './Parts'

/**
 * The three settings of Fury's portfolio photography: a residential courtyard framed by apartment
 * blocks, a corporate campus of glass and precast offices with palms and agaves, and a private
 * backyard beside a modern house. Background architecture is batched per material. Where the
 * buildings, trees, palms, lamp posts, planters, hedges and shrubs stand is scenery.ts's layout,
 * which the gallery's cameras keep clear of.
 */

/** A building of the layout, as its generator builds it, where it stands. */
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

/** Interior light in background windows: off by day, warming through dusk into night. */
function useWindowGlow(time: number) {
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    setWindowGlow(smoothstep(17.25, 20.5, time) * 2.4)
    invalidate()
  }, [time, invalidate])
}

// --- Plants -------------------------------------------------------------------------------

const Palm = memo(function Palm({
  position,
  height,
  seed,
}: {
  position: [number, number, number]
  height: number
  seed: number
}) {
  const shape = useMemo(() => palmShape(seed, height), [seed, height])
  const trunk = useMemo(
    () =>
      limbParts(
        { limbs: shape.trunk, leaves: [], crownHeight: 0 },
        material({ set: 'bark_platanus', color: '#9a8a76', roughness: 1 }),
      ),
    [shape],
  )
  // Shag of dry, hanging fronds under the living crown, typical of Washingtonia.
  const skirt = useMemo(
    () => [
      part(
        cylinder(1.35, 0.62, 3.4, 20),
        material({ set: 'bark_platanus', color: '#a38a64', roughness: 1 }),
        [shape.crown.x, shape.crown.y - 1.9, shape.crown.z],
      ),
    ],
    [shape],
  )
  const frond = useMemo(palmFrond, [])
  const leaves = useMemo(palmMaterial, [])
  useEffect(
    () => () => {
      frond.dispose()
      leaves.dispose()
    },
    [frond, leaves],
  )
  const mesh = useInstances(shape.fronds)
  return (
    <group position={position}>
      <Parts parts={trunk} />
      <Parts parts={skirt} />
      <instancedMesh
        ref={mesh}
        args={[frond, leaves, shape.fronds.length]}
        position={[shape.crown.x, shape.crown.y, shape.crown.z]}
        castShadow
        receiveShadow
        userData={{ noProbe: true }}
      />
    </group>
  )
})

/** A domed shrub of leaf cards, optionally in flower. */
const Shrub = memo(function Shrub({
  position,
  radius,
  height,
  seed,
  blossom,
  quality,
}: {
  position: [number, number, number]
  radius: number
  height: number
  seed: number
  blossom?: string
  quality: Quality
}) {
  const { count, drawn } = thinned(radius * radius * 90, quality, 60)
  const shape = useMemo(
    () => shrubShape(seed, radius, height, count),
    [seed, radius, height, count],
  )
  // The tier draws the leaves and blossoms of its first `drawn` cards (instances.ts).
  const thin = useMemo(() => shrubShape(seed, radius, height, drawn), [seed, radius, height, drawn])
  const card = useMemo(leafCard, [])
  const leaves = useMemo(() => leafMaterial('courtyard', height * 0.5), [height])
  const flowers = useMemo(
    () => (blossom ? blossomMaterial(blossom, height * 0.5) : null),
    [blossom, height],
  )
  useEffect(
    () => () => {
      card.dispose()
      leaves.dispose()
      flowers?.dispose()
    },
    [card, leaves, flowers],
  )
  const leafMesh = useInstances(shape.leaves, thin.leaves.length, card, leaves)
  const flowerMesh = useInstances(shape.blossoms, thin.blossoms.length, card, flowers)
  return (
    <group position={position}>
      <instancedMesh
        ref={leafMesh}
        args={[card, leaves, Math.max(1, shape.leaves.length)]}
        castShadow
        receiveShadow
        userData={{ noProbe: true }}
      />
      {flowers && shape.blossoms.length > 0 && (
        <instancedMesh
          ref={flowerMesh}
          args={[card, flowers, shape.blossoms.length]}
          receiveShadow
          userData={{ noProbe: true }}
        />
      )}
    </group>
  )
})

/** Tall ornamental grass (feather reed grass) in a rectangular bed raised to `y`. */
function GrassBed({
  x,
  z,
  w,
  d,
  y = 0,
  count,
  quality,
  colors = ['#6e6a3c', '#d6c98d'],
  height = 2.6,
}: {
  x: number
  z: number
  w: number
  d: number
  y?: number
  count: number
  quality: Quality
  colors?: [string, string]
  height?: number
}) {
  const place = useMemo(
    () =>
      (i: number): [number, number] => [
        x + (noise(i, 201 + Math.round(x)) - 0.5) * w,
        z + (noise(i, 202 + Math.round(z)) - 0.5) * d,
      ],
    [x, z, w, d],
  )
  return (
    <group position={[0, y, 0]}>
      <Tufts
        {...thinned(count, quality, 6)}
        blades={16}
        height={height}
        bend={0.6}
        place={place}
        colors={colors}
        shadow={quality !== 'lite'}
      />
    </group>
  )
}

/** A setting's layout (scenery.ts), and its buildings as their generators build them. */
function useLayout(environment: 'residences' | 'campus' | 'backyard', L: number) {
  const layout = useMemo(() => sceneryLayout(environment, L), [environment, L])
  const buildings = useMemo(() => layout.buildings.flatMap(buildingParts), [layout])
  return { layout, buildings }
}

/** The layout's shrubs. */
function Shrubs({ layout, quality }: { layout: SceneryLayout; quality: Quality }) {
  return layout.shrubs.map((s) => (
    <Shrub
      key={s.seed}
      position={[s.x, s.base, s.z]}
      radius={s.radius}
      height={s.height}
      seed={s.seed}
      blossom={s.blossom}
      quality={quality}
    />
  ))
}

/** The layout's trees. */
function Trees({ layout, quality }: { layout: SceneryLayout; quality: Quality }) {
  return layout.trees.map((t) => (
    <Tree
      key={t.seed}
      position={[t.x, t.base, t.z]}
      scale={t.scale}
      seed={t.seed}
      biome={t.biome}
      quality={quality}
    />
  ))
}

// --- Residential courtyard (photos 1 and 3) -----------------------------------------------

export function Residences({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  useWindowGlow(c.time)
  const { layout, buildings } = useLayout('residences', L)
  const flame = c.lights && c.time > 17
  const furniture = useMemo(() => {
    const parts: Part[] = [
      ...layout.planters.flatMap(planterParts),
      ...place(loungeSet({ flame }), [L / 2 + 17, 0, 12], [0, -0.5, 0]),
    ]
    // Courtyard pole lights.
    const pole = palette.powder('#1a1b1a', false, 0.6)
    const lamp = c.lights ? palette.emitter('#ffd8a6', 5) : palette.plastic('#e7e3da', 0.4)
    for (const post of layout.posts) parts.push(...postParts(post, pole, lamp))
    return parts
  }, [layout, L, c.lights, flame])
  return (
    <group>
      <Ground set="herringbone_pavement" size={6.562} tint="#cdbfae" />
      <Parts parts={buildings} />
      <Parts parts={furniture} />
      {layout.planters.map(
        ({ x, z, grass }) =>
          grass && (
            <GrassBed
              key={`${x},${z}`}
              x={x}
              z={z}
              w={grass.width}
              d={grass.depth}
              y={grass.base}
              count={grass.count}
              quality={quality}
              colors={grass.colors}
              height={grass.height}
            />
          ),
      )}
      <Shrubs layout={layout} quality={quality} />
      <Trees layout={layout} quality={quality} />
    </group>
  )
}

// --- Corporate campus (photo 2) -----------------------------------------------------------

export function Campus({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  useWindowGlow(c.time)
  const { layout, buildings } = useLayout('campus', L)
  const site = useMemo(() => {
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
  }, [layout, L])
  return (
    <group>
      <Ground set="concrete_pavement" size={5.906} tint="#d8d2c7" />
      <Parts parts={buildings} />
      <Parts parts={site} />
      <Trees layout={layout} quality={quality} />
      {layout.palms.map((p) => (
        <Palm key={p.seed} position={[p.x, 0, p.z]} height={p.height} seed={p.seed} />
      ))}
      <GrassBed
        x={-L / 2 - 5}
        z={3}
        w={4}
        d={11}
        count={30}
        quality={quality}
        colors={['#7a6c4c', '#d2c294']}
        height={1.3}
      />
    </group>
  )
}

// --- Private backyard (photos 4 and 5) ----------------------------------------------------

export function Backyard({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  useWindowGlow(c.time)
  const { layout, buildings: house } = useLayout('backyard', L)
  const hardscape = useMemo(() => {
    const slab = material({ set: 'concrete_pavement', color: '#ece8e1', roughness: 1 })
    const joint = material({ color: '#7d7a73', roughness: 1 })
    const parts: Part[] = [
      part(box(L + 8, 0.24, 14), slab, [0, -0.1, 3.5], undefined, undefined, false),
      // Driveway leading off toward the house.
      part(box(14, 0.24, 40), slab, [L / 2 + 10, -0.1, 26], [0, 0.1, 0], undefined, false),
    ]
    for (let x = -L / 2 - 4 + 7; x < L / 2 + 4; x += 7)
      parts.push(part(box(0.06, 0.02, 14), joint, [x, 0.03, 3.5], undefined, undefined, false))
    return parts
  }, [L])
  const lawn = useMemo(
    () =>
      (i: number): [number, number] | null => {
        const x = (noise(i, 13) - 0.5) * (L + 50)
        const z = -12 + noise(i, 14) * 46
        const onPatio = Math.abs(x) < L / 2 + 4.3 && z > -3.7 && z < 10.7
        const onDrive = Math.abs(x - L / 2 - 10) < 7.5 && z > 6
        const onDeck = c.addons.deck && Math.abs(x) < L / 2 + 0.2 && z < 16
        return onPatio || onDrive || onDeck ? null : [x, z]
      },
    [L, c.addons.deck],
  )
  return (
    <group>
      <Ground set="leafy_grass" size={6.56} tint="#b4d095" />
      <Parts parts={house} />
      <Parts parts={hardscape} />
      <Tufts
        {...thinned(6500, quality)}
        blades={9}
        height={0.42}
        bend={0.12}
        place={lawn}
        colors={['#3d5126', '#93a258']}
        shadow={false}
      />
      {layout.hedges.map((h) => (
        <Hedge key={h.z} length={h.length} quality={quality} z={h.z} />
      ))}
      <Shrubs layout={layout} quality={quality} />
      <GrassBed x={-L / 2 - 2.6} z={1} w={2} d={6} count={40} quality={quality} />
      <GrassBed x={L / 2 + 2.6} z={-1} w={2} d={5} count={35} quality={quality} />
      <Trees layout={layout} quality={quality} />
    </group>
  )
}
