import { useMemo } from 'react'
import { Color, MeshStandardMaterial } from 'three/webgpu'
import type { Config } from '../lib/config'
import { noise } from '../lib/visuals'
import { box, cylinder, roundedBox } from '../render/geometry'
import { material, prefetchTextures } from '../render/materials'
import { palette } from '../render/palette'
import { part, type Part } from '../render/parts'
import type { Quality } from '../render/quality'
import { grassPalette } from '../render/vegetation'
import { Parts } from './Parts'
import { Backyard } from './environments/Backyard'
import { Rooftop } from './environments/Rooftop'
import { Ground, Hedge, Tree, Tufts } from './environments/common'
import { DENSITY, LAWN_COLORS, bollard, lawnPlacer } from './environments/layout'

// --- Courtyard ----------------------------------------------------------------------------

function hardscape(L: number, lights: boolean): Part[] {
  const paving = material({ set: 'concrete_pavement', color: '#e9e6df', roughness: 1 })
  const smooth = material({ set: 'concrete_wall_001', color: '#e6e3db', roughness: 0.95 })
  const wall = material({ set: 'concrete_slab_wall', color: '#dedbd2', roughness: 1 })
  const steel = palette.powder('#2f2d2a', false, 0.75)
  const gravel = material({ set: 'clean_pebbles', color: '#ffffff', roughness: 1 })
  const parts: Part[] = [
    part(box(L + 3, 0.24, 23), paving, [0, -0.12, 3.5], undefined, undefined, false),
    // Board-formed garden wall with a smooth precast coping.
    part(box(L + 24, 3.8, 0.55), wall, [0, 1.8, -12]),
    part(roundedBox(L + 24.2, 0.16, 0.8, 0.03, 1), smooth, [0, 3.76, -12]),
  ]
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
    for (const z of [1, 10]) parts.push(...bollard(side * (L / 2 + 1.75), z, lights))
  }
  // Tapered concrete planter for the potted tree.
  parts.push(part(cylinder(0.75, 0.56, 1.8, 40), smooth, [-L / 2 - 0.8, 0.9, 11.5]))
  parts.push(
    part(
      cylinder(0.68, 0.68, 0.05, 40),
      material({ set: 'dry_ground_01', color: '#7a6a58', roughness: 1 }),
      [-L / 2 - 0.8, 1.72, 11.5],
      undefined,
      undefined,
      false,
    ),
  )
  return parts
}

/** A walled garden courtyard: paving, gravel beds, a clipped hedge, lawn and mature trees. */
function Courtyard({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  const density = DENSITY[quality]
  const hard = useMemo(() => hardscape(L, c.lights), [L, c.lights])
  const palettes = grassPalette('courtyard')
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
      lawnPlacer({ x0: -(L + 34) / 2, x1: (L + 34) / 2, z0: -11.4, z1: 28.6 }, [
        { x0: -(L + 3) / 2 - 0.3, x1: (L + 3) / 2 + 0.3, z0: -8.3, z1: 15.3 },
        { x0: -2.9, x1: 2.9, z0: 15, z1: 33 },
      ]),
    [L],
  )
  return (
    <group>
      <Ground set="leafy_grass" size={6.56} tint="#b9d49a" />
      <Parts parts={hard} />
      {palettes.map((colors, k) => (
        <Tufts
          key={`bed-${k}`}
          count={Math.round(260 * density) + 30}
          blades={14}
          height={1.8}
          bend={0.55}
          place={bedPlace}
          variant={k}
          colors={colors}
          shadow={quality !== 'lite'}
        />
      ))}
      <Hedge length={L + 20} quality={quality} />
      <Tufts
        count={Math.round(5200 * density)}
        blades={9}
        height={0.42}
        bend={0.12}
        place={lawnPlace}
        colors={LAWN_COLORS}
        shadow={false}
      />
      {[-1, 1].map((side) => (
        <group key={side}>
          <Tree
            position={[side * (L / 2 + 6), 0, -8]}
            scale={1.55}
            seed={side > 0 ? 1 : 2}
            biome="courtyard"
            quality={quality}
          />
          <Tree
            position={[side * (L / 2 + 14), 0, -19]}
            scale={2.0}
            seed={side > 0 ? 3 : 4}
            biome="courtyard"
            quality={quality}
          />
        </group>
      ))}
      <Tree
        position={[-L / 2 - 0.8, 1.75, 11.5]}
        scale={0.5}
        seed={5}
        biome="courtyard"
        quality={quality}
      />
    </group>
  )
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

/** The surroundings of the unit: one of three outdoor settings, or the photo-studio floor. */
export function Landscape({ config: c, quality }: { config: Config; quality: Quality }) {
  // The ground is the largest surface on screen: ask for its scan before the hardscape and the
  // studio queue theirs (Ground itself only asks after it mounts). Requests are deduplicated.
  if (c.environment === 'courtyard' || c.environment === 'backyard') prefetchTextures('leafy_grass')
  if (c.environment === 'rooftop') prefetchTextures('concrete_pavement')
  switch (c.environment) {
    case 'studio':
      return <StudioFloor />
    case 'backyard':
      return <Backyard config={c} quality={quality} />
    case 'rooftop':
      return <Rooftop config={c} quality={quality} />
    default:
      return <Courtyard config={c} quality={quality} />
  }
}
