import { useMemo } from 'react'
import type { Config } from '../../lib/config'
import { effectiveLighting } from '../../lib/lighting'
import { noise } from '../../lib/visuals'
import { box, roundedBox } from '../../render/geometry'
import { material } from '../../render/materials'
import { palette } from '../../render/palette'
import { part, type Part } from '../../render/parts'
import type { Quality } from '@fury/viewer360'
import { grassPalette } from '../../render/vegetation'
import { Parts } from '../Parts'
import { Ground, Hedge, Tree, Tufts } from './common'
import { DENSITY, LAWN, LAWN_COLORS, bollard, lawnPlacer } from './layout'

/** Fence line: back at FENCE_BACK, sides SIDE feet beyond the unit's ends. */
const FENCE_BACK = -16
const FENCE_FRONT = 22
const SIDE = 16
const FENCE_HEIGHT = 6

/** A horizontal-slat cedar privacy fence on steel posts, along the back and both sides. */
function fence(L: number): Part[] {
  const cedar = material({ set: 'hinoki_planks', color: '#c8946a', roughness: 1 })
  const post = palette.powder('#2b2a27', false, 0.7)
  const parts: Part[] = []
  const halfX = L / 2 + SIDE
  const runs: { center: [number, number]; length: number; alongX: boolean }[] = [
    { center: [0, FENCE_BACK], length: halfX * 2, alongX: true },
    {
      center: [-halfX, (FENCE_BACK + FENCE_FRONT) / 2],
      length: FENCE_FRONT - FENCE_BACK,
      alongX: false,
    },
    {
      center: [halfX, (FENCE_BACK + FENCE_FRONT) / 2],
      length: FENCE_FRONT - FENCE_BACK,
      alongX: false,
    },
  ]
  for (const run of runs) {
    for (let y = 0.35; y < FENCE_HEIGHT; y += 0.52) {
      const board = run.alongX ? box(run.length, 0.44, 0.09) : box(0.09, 0.44, run.length)
      parts.push(part(board, cedar, [run.center[0], y, run.center[1]]))
    }
    const posts = Math.ceil(run.length / 8)
    for (let i = 0; i <= posts; i++) {
      const t = -run.length / 2 + (i * run.length) / posts
      const [x, z] = run.alongX
        ? [run.center[0] + t, run.center[1] - 0.12]
        : [run.center[0] + (run.center[0] < 0 ? 0.12 : -0.12), run.center[1] + t]
      parts.push(part(box(0.22, FENCE_HEIGHT + 0.2, 0.22), post, [x, (FENCE_HEIGHT + 0.2) / 2, z]))
    }
  }
  return parts
}

/**
 * The house the garden belongs to, beyond the back fence: a painted two-story volume and a darker
 * single-story wing, with windows that read as glass by day and glow warmly after dark.
 */
function house(L: number, night: boolean): Part[] {
  const siding = material({ set: 'beige_wall_001', color: '#ddd7cb', roughness: 0.9 })
  const wing = material({ set: 'concrete_wall_001', color: '#6b6c68', roughness: 0.95 })
  const roof = palette.powder('#2f302e', false, 0.7)
  const frame = palette.anodized('#24262a')
  const glass = material({ color: '#1d2329', roughness: 0.06, metalness: 0.2, clearcoat: 1 })
  // After dark some rooms are lit, some dimly, some not at all.
  const lit = [palette.emitter('#ffcf96', 0.75), palette.emitter('#ffb878', 0.22), glass]
  const face = -34
  const parts: Part[] = [
    part(box(58, 21, 20), siding, [-8, 10.5, face - 10]),
    part(box(61, 0.8, 23), roof, [-8, 21.4, face - 10]),
    part(box(28, 12, 16), wing, [L / 2 + 22, 6, face - 6]),
    part(box(30, 0.7, 18), roof, [L / 2 + 22, 12.35, face - 6]),
  ]
  let count = 0
  const window = (x: number, y: number, w: number, h: number, z: number) => {
    const pane = night ? lit[Math.floor(noise(count++, 31) * 2.6)] : glass
    parts.push(part(box(w + 0.4, h + 0.4, 0.3), frame, [x, y, z + 0.1]))
    parts.push(part(box(w, h, 0.1), pane, [x, y, z + 0.28], undefined, undefined, false))
  }
  // Upper floor: a row of tall windows. Ground floor: a wide sliding door and two windows.
  for (let i = 0; i < 6; i++) window(-31 + i * 9.2, 15.5, 4.4, 6, face)
  window(-14, 4.8, 16, 8, face)
  window(-30, 5.2, 5, 5.5, face)
  window(4, 5.2, 5, 5.5, face)
  window(L / 2 + 22, 6.2, 18, 6.5, face + 2)
  return parts
}

/** Patio under and in front of the unit, stepping stones, and a raised timber planting bed. */
function garden(L: number, lights: boolean): Part[] {
  const paving = material({ set: 'concrete_pavement', color: '#dedad2', roughness: 1 })
  const stone = material({ set: 'concrete_wall_001', color: '#d6d2c8', roughness: 0.95 })
  const timber = palette.teak()
  const soil = material({ set: 'dry_ground_01', color: '#5d4c3d', roughness: 1 })
  const parts: Part[] = [
    part(box(L + 4, 0.24, 18), paving, [0, -0.12, 4], undefined, undefined, false),
  ]
  for (let i = 0; i < 5; i++)
    parts.push(
      part(
        roundedBox(2.4, 0.2, 2.4, 0.08, 1),
        stone,
        [L / 2 - 1.5 + (noise(i, 21) - 0.5) * 0.8, -0.04, 15.6 + i * 3.1],
        [0, (noise(i, 22) - 0.5) * 0.4, 0],
      ),
    )
  const bedX = -L / 2 - 7
  parts.push(part(box(2.2, 1.6, 9.2), timber, [bedX, 0.8, 7]))
  parts.push(part(box(1.9, 0.05, 8.9), soil, [bedX, 1.58, 7], undefined, undefined, false))
  for (const z of [-3, 11]) parts.push(...bollard(L / 2 + 2.6, z, lights))
  for (const z of [-3, 11]) parts.push(...bollard(-L / 2 - 2.6, z, lights))
  return parts
}

/** A suburban backyard: lawn inside a cedar fence, a patio, maples, and the house beyond. */
export function Backyard({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  const density = DENSITY[quality]
  const night = effectiveLighting(c) === 'night'
  const fenceParts = useMemo(() => fence(L), [L])
  const houseParts = useMemo(() => house(L, night), [L, night])
  const gardenParts = useMemo(() => garden(L, c.lights), [L, c.lights])
  const palettes = grassPalette('backyard')
  const bedPlace = useMemo(
    () =>
      (index: number, variant: number): [number, number] | null => {
        const i = index * 3 + variant
        return [-L / 2 - 7 + (noise(i, 23) - 0.5) * 1.6, 7 + (noise(i, 24) - 0.5) * 8.6]
      },
    [L],
  )
  const lawnPlace = useMemo(
    () =>
      lawnPlacer({ x0: -L / 2 - SIDE, x1: L / 2 + SIDE, z0: FENCE_BACK + 1.6, z1: 46 }, [
        { x0: -L / 2 - 2.3, x1: L / 2 + 2.3, z0: -5.3, z1: 13.3 },
        { x0: -L / 2 - 8.3, x1: -L / 2 - 5.7, z0: 2.2, z1: 11.8 },
      ]),
    [L],
  )
  return (
    <group>
      <Ground set="leafy_grass" size={6.56} tint="#a9c98c" />
      <Parts parts={fenceParts} />
      <Parts parts={houseParts} />
      <Parts parts={gardenParts} />
      <Hedge length={L + SIDE * 2 - 2} quality={quality} z={FENCE_BACK + 1.1} />
      {palettes.map((colors, k) => (
        <Tufts
          key={`bed-${k}`}
          count={Math.round(90 * density) + 16}
          blades={12}
          height={1.6}
          bend={0.5}
          place={bedPlace}
          variant={k}
          colors={colors}
          shadow={false}
        />
      ))}
      <Tufts
        count={Math.round(2600 * density)}
        blades={LAWN.blades}
        segments={LAWN.segments}
        height={0.4}
        bend={0.12}
        place={lawnPlace}
        colors={LAWN_COLORS}
        shadow={false}
        receiveShadow={false}
      />
      <Tree
        position={[-L / 2 - 10, 0, -9]}
        scale={1.8}
        seed={11}
        biome="backyard"
        quality={quality}
      />
      <Tree
        position={[L / 2 + 11, 0, -7]}
        scale={1.45}
        seed={12}
        biome="backyard"
        quality={quality}
      />
      <Tree
        position={[L / 2 + 24, 0, -24]}
        scale={2.2}
        seed={13}
        biome="backyard"
        quality={quality}
      />
      {/* A tree line beyond the open end of the garden, behind the rear view. */}
      {[-1, 0, 1].map((i) => (
        <Tree
          key={i}
          position={[i * 34 + 8, 0, 92 + i * 6]}
          scale={2.3}
          seed={14 + i}
          biome="backyard"
          quality={quality}
        />
      ))}
    </group>
  )
}
