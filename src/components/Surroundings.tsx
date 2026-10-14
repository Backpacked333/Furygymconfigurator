import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { InstancedMesh, type Matrix4 } from 'three/webgpu'
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
import { DENSITY, agaveGeometry, boulderGeometry, limbParts } from '../render/scenery'
import { Parts } from './Parts'

/**
 * The three settings of Fury's portfolio photography: a residential courtyard framed by apartment
 * blocks, a corporate campus of glass and precast offices with palms and agaves, and a private
 * backyard beside a modern house. Background architecture is batched per material.
 */

/** Interior light in background windows: off by day, warming through dusk into night. */
function useWindowGlow(time: number) {
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    setWindowGlow(smoothstep(17.25, 20.5, time) * 2.4)
    invalidate()
  }, [time, invalidate])
}

function useInstances(matrices: Matrix4[]) {
  const mesh = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    matrices.forEach((matrix, i) => m.setMatrixAt(i, matrix))
    m.count = matrices.length
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [matrices])
  return mesh
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
  const count = Math.round(radius * radius * 90 * DENSITY[quality]) + 60
  const shape = useMemo(
    () => shrubShape(seed, radius, height, count),
    [seed, radius, height, count],
  )
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
  const leafMesh = useInstances(shape.leaves)
  const flowerMesh = useInstances(shape.blossoms)
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
        count={Math.round(count * DENSITY[quality]) + 6}
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

// --- Residential courtyard (photos 1 and 3) -----------------------------------------------

export function Residences({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  useWindowGlow(c.time)
  const buildings = useMemo(
    () => [
      ...place(apartmentBlock({ length: 160, style: 'brick', seed: 1 }), [0, 0, -34]),
      ...place(
        apartmentBlock({ length: 110, style: 'timber', seed: 2 }),
        [-(L / 2 + 44), 0, 6],
        [0, Math.PI / 2, 0],
      ),
      ...place(
        apartmentBlock({ length: 110, style: 'brick', seed: 3 }),
        [L / 2 + 50, 0, 2],
        [0, -Math.PI / 2, 0],
      ),
    ],
    [L],
  )
  const flame = c.lights && c.time > 17
  const furniture = useMemo(() => {
    const parts: Part[] = [
      ...place(planter(14, 3.2, 2.2), [-L / 2 - 6, 0, 9], [0, 0.04, 0]),
      ...place(planter(3.2, 16, 2.2), [L / 2 + 7.5, 0, 2]),
      ...place(planter(L + 14, 3.6, 2.2), [0, 0, -13]),
      ...place(loungeSet({ flame }), [L / 2 + 17, 0, 12], [0, -0.5, 0]),
    ]
    // Courtyard pole lights.
    const pole = palette.powder('#1a1b1a', false, 0.6)
    const lamp = c.lights ? palette.emitter('#ffd8a6', 5) : palette.plastic('#e7e3da', 0.4)
    for (const [x, z] of [
      [-L / 2 - 14, 14],
      [L / 2 + 14, -4],
      [-L / 2 - 4, -20],
    ]) {
      parts.push(part(cylinder(0.12, 0.16, 12, 16), pole, [x, 6, z]))
      parts.push(part(box(0.7, 1.1, 0.7), pole, [x, 12.3, z]))
      parts.push(part(box(0.55, 0.8, 0.55), lamp, [x, 12.2, z], undefined, undefined, false))
    }
    return parts
  }, [L, c.lights, flame])
  return (
    <group>
      <Ground set="herringbone_pavement" size={6.562} tint="#cdbfae" />
      <Parts parts={buildings} />
      <Parts parts={furniture} />
      <GrassBed x={-L / 2 - 6} z={9} w={13} d={2.6} y={2.4} count={70} quality={quality} />
      <GrassBed x={L / 2 + 7.5} z={2} w={2.6} d={15} y={2.4} count={80} quality={quality} />
      <GrassBed
        x={0}
        z={-13}
        w={L + 12}
        d={3}
        y={2.4}
        count={120}
        quality={quality}
        colors={['#3e5229', '#8fa25a']}
        height={1.6}
      />
      {[-L / 2 - 2, L / 2 - 4].map((x, i) => (
        <Shrub
          key={x}
          position={[x + 3, 2.4, -13]}
          radius={1.6}
          height={2.4}
          seed={i + 3}
          quality={quality}
        />
      ))}
      <Tree
        position={[-L / 2 - 10, 2.4, 9]}
        scale={1.2}
        seed={6}
        biome="courtyard"
        quality={quality}
      />
      <Tree
        position={[L / 2 + 12, 0, -20]}
        scale={1.7}
        seed={7}
        biome="courtyard"
        quality={quality}
      />
      <Tree
        position={[-L / 2 - 16, 0, -22]}
        scale={1.8}
        seed={8}
        biome="courtyard"
        quality={quality}
      />
    </group>
  )
}

// --- Corporate campus (photo 2) -----------------------------------------------------------

export function Campus({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  useWindowGlow(c.time)
  const buildings = useMemo(
    () => [
      ...place(
        curtainWallOffice({ length: 120, floors: 5, depth: 80 }),
        [-58, 0, -52],
        [0, 0.12, 0],
      ),
      ...place(precastOffice({ length: 96, floors: 4, depth: 60 }), [46, 0, -60]),
      ...place(
        curtainWallOffice({ length: 90, floors: 4, depth: 60 }),
        [L / 2 + 70, 0, 10],
        [0, -Math.PI / 2, 0],
      ),
    ],
    [L],
  )
  const site = useMemo(() => {
    const gravel = material({ set: 'clean_pebbles', color: '#efe3cf', roughness: 1 })
    const edge = palette.powder('#2f2d2a', false, 0.75)
    const agave = material({ color: '#7f9c92', roughness: 0.55 })
    const stone = material({ set: 'concrete_wall_001', color: '#c9ab84', roughness: 1 })
    const parts: Part[] = [
      ...place(planter(14, 4, 1.8), [L / 2 + 9, 0, -6]),
      ...place(planter(4, 12, 1.8), [-L / 2 - 9, 0, -9]),
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
  }, [L])
  return (
    <group>
      <Ground set="concrete_pavement" size={5.906} tint="#d8d2c7" />
      <Parts parts={buildings} />
      <Parts parts={site} />
      <Tree
        position={[L / 2 + 9, 1.8, -6]}
        scale={1.15}
        seed={10}
        biome="desert"
        quality={quality}
      />
      <Tree
        position={[-L / 2 - 10, 1.8, -10]}
        scale={1.3}
        seed={11}
        biome="desert"
        quality={quality}
      />
      <Tree position={[L / 2 + 22, 0, 14]} scale={1.5} seed={12} biome="desert" quality={quality} />
      {[
        [-14, -38, 20],
        [6, -42, 24],
        [22, -36, 18],
        [-32, -34, 22],
        [L / 2 + 26, -14, 20],
      ].map(([x, z, h], i) => (
        <Palm key={i} position={[x, 0, z]} height={h} seed={i + 1} />
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
  const house = useMemo(
    () => [
      ...place(modernHouse(), [-(L / 2 + 34), 0, -26], [0, 0.42, 0]),
      // A neighbor's house beyond the hedge on the other side.
      ...place(modernHouse(), [L / 2 + 52, 0, -40], [0, -0.55, 0]),
    ],
    [L],
  )
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
  const lavender = '#8d7cc0'
  return (
    <group>
      <Ground set="leafy_grass" size={6.56} tint="#b4d095" />
      <Parts parts={house} />
      <Parts parts={hardscape} />
      <Tufts
        count={Math.round(6500 * DENSITY[quality])}
        blades={9}
        height={0.42}
        bend={0.12}
        place={lawn}
        colors={['#3d5126', '#93a258']}
        shadow={false}
      />
      <Hedge length={L + 34} quality={quality} z={-14} />
      {[-L / 2 - 4.5, -L / 2 - 3, L / 2 + 3.5].map((x, i) => (
        <Shrub
          key={`lav${i}`}
          position={[x, 0, 9 + i * 1.4]}
          radius={1.3}
          height={1.6}
          seed={20 + i}
          blossom={lavender}
          quality={quality}
        />
      ))}
      {[0, 1, 2].map((i) => (
        <Shrub
          key={`hyd${i}`}
          position={[-L / 2 - 8 - i * 3.2, 0, -6 + i * 1.1]}
          radius={1.8}
          height={2.6}
          seed={30 + i}
          blossom="#eef0ea"
          quality={quality}
        />
      ))}
      <Shrub
        position={[L / 2 + 5, 0, -5]}
        radius={2.2}
        height={3}
        seed={40}
        blossom="#d9c7e6"
        quality={quality}
      />
      <GrassBed x={-L / 2 - 2.6} z={1} w={2} d={6} count={40} quality={quality} />
      <GrassBed x={L / 2 + 2.6} z={-1} w={2} d={5} count={35} quality={quality} />
      <Tree
        position={[-L / 2 - 12, 0, -16]}
        scale={1.9}
        seed={13}
        biome="courtyard"
        quality={quality}
      />
      <Tree
        position={[L / 2 + 16, 0, -18]}
        scale={2.1}
        seed={14}
        biome="courtyard"
        quality={quality}
      />
      <Tree
        position={[L / 2 + 26, 0, 6]}
        scale={1.6}
        seed={15}
        biome="courtyard"
        quality={quality}
      />
    </group>
  )
}
