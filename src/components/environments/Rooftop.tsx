import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu'
import {
  abs,
  color,
  float,
  floor,
  fract,
  mix,
  normalWorld,
  positionWorld,
  sin,
  step,
  uniform,
  vec3,
} from 'three/tsl'
import type { Config } from '../../lib/config'
import { effectiveLighting } from '../../lib/lighting'
import { noise } from '../../lib/visuals'
import { box, cylinder } from '../../render/geometry'
import { material } from '../../render/materials'
import { palette } from '../../render/palette'
import { part, type Part } from '../../render/parts'
import type { Quality } from '../../render/quality'
import { grassPalette } from '../../render/vegetation'
import { Parts } from '../Parts'
import { Tree, Tufts } from './common'
import { DENSITY, bollard } from './layout'

/** The roof: the unit sits at its center, with the parapet this far from the unit's ends. */
const SIDE = 18
const BACK = -22
const FRONT = 26
/** Street level, far below the roof. */
const STREET = -72

/** 0 by day, 1 at night: lights the skyline's windows without rebuilding its shader. */
const cityNight = uniform(0)

/**
 * One material for every tower around the roof. Floors and window bays are drawn from world
 * position, so towers of any size share a single shader and draw call: glass bands by day, about
 * a third of the windows lit warm at night. Roofs (faces pointing up) have no windows.
 */
let skylineMaterial: MeshStandardNodeMaterial | null = null
function skyline() {
  if (skylineMaterial) return skylineMaterial
  const m = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 })
  const storey = positionWorld.y.div(12)
  const along = positionWorld.x.add(positionWorld.z).div(9)
  const wall = float(1).sub(abs(normalWorld.y))
  const glazing = step(0.22, fract(storey))
    .mul(step(fract(storey), 0.78))
    .mul(step(0.18, fract(along)))
    .mul(step(fract(along), 0.82))
    .mul(wall)
  // A per-window random number: the classic sine hash, stable across frames and towers.
  const cell = fract(sin(floor(storey).mul(12.9898).add(floor(along).mul(78.233))).mul(43758.5453))
  const lit = step(0.62, cell)
  m.colorNode = mix(color('#b9b6ae'), color('#334252'), glazing)
  m.roughnessNode = mix(float(0.85), float(0.18), glazing)
  m.emissiveNode = vec3(1, 0.74, 0.46).mul(glazing.mul(lit).mul(cityNight).mul(1.4))
  skylineMaterial = m
  return m
}

/** Towers in a ring around the roof, rising from the street. */
function Skyline() {
  const geometry = useMemo(() => {
    const g = new BoxGeometry(1, 1, 1)
    g.translate(0, 0.5, 0)
    return g
  }, [])
  useEffect(() => () => geometry.dispose(), [geometry])
  const towers = useMemo(() => {
    const list: { matrix: Matrix4; tint: Color }[] = []
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2 + noise(i, 71) * 0.08
      const radius = 260 + noise(i, 72) * 340
      const width = 40 + noise(i, 73) * 50
      const depth = 40 + noise(i, 74) * 50
      const height = 70 + Math.pow(noise(i, 75), 2) * 220
      const matrix = new Matrix4().compose(
        new Vector3(Math.sin(angle) * radius, STREET, Math.cos(angle) * radius),
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle),
        new Vector3(width, height, depth),
      )
      const shade = 0.82 + noise(i, 76) * 0.3
      list.push({ matrix, tint: new Color(shade, shade * 0.99, shade * 0.96) })
    }
    return list
  }, [])
  const mesh = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    towers.forEach(({ matrix, tint }, i) => {
      m.setMatrixAt(i, matrix)
      m.setColorAt(i, tint)
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [towers])
  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, skyline(), towers.length]}
      receiveShadow={false}
      castShadow={false}
      userData={{ noProbe: true }}
    />
  )
}

/** The roof deck: pavers, a parapet with a glass rail, plant and stair bulkheads, planters. */
function roof(L: number, lights: boolean): Part[] {
  const halfX = L / 2 + SIDE
  const depth = FRONT - BACK
  const centerZ = (FRONT + BACK) / 2
  const pavers = material({ set: 'concrete_pavement', color: '#cbc7bf', roughness: 1 })
  const parapet = material({ set: 'concrete_slab_wall', color: '#d3d0c9', roughness: 1 })
  const coping = palette.anodized('#3a3c3e')
  const steel = palette.brushed(false, '#b9bcbd')
  const dark = palette.powder('#2a2c2e', false, 0.7)
  const planter = material({ set: 'concrete_wall_001', color: '#bfbcb4', roughness: 0.95 })
  const soil = material({ set: 'dry_ground_01', color: '#56473a', roughness: 1 })
  const parts: Part[] = [
    part(box(halfX * 2, 0.3, depth), pavers, [0, -0.15, centerZ], undefined, undefined, false),
    // The building's own facade, falling away below the parapet to the street.
    part(box(halfX * 2 + 1.6, -STREET, depth + 1.6), parapet, [0, STREET / 2 - 0.3, centerZ]),
    // Timber decking in front of the unit.
    part(box(L + 4, 0.12, 9), palette.teak(), [0, 0.02, 9.5], undefined, undefined, false),
  ]
  const wall = (x: number, z: number, w: number, d: number) => {
    parts.push(part(box(w, 3.4, d), parapet, [x, 1.7, z]))
    parts.push(part(box(w + 0.1, 0.12, d + 0.1), coping, [x, 3.46, z]))
  }
  wall(0, BACK, halfX * 2, 0.8)
  wall(0, FRONT, halfX * 2, 0.8)
  wall(-halfX, centerZ, 0.8, depth)
  wall(halfX, centerZ, 0.8, depth)
  // Frameless glass balustrade on the front and sides, on a slim base channel.
  const glass = palette.glass()
  const rail = (x: number, z: number, w: number, d: number) => {
    parts.push(part(box(w, 3, d), glass, [x, 5.02, z], undefined, undefined, false))
    parts.push(part(box(w + 0.02, 0.1, d + 0.12), coping, [x, 3.58, z]))
  }
  rail(0, FRONT, halfX * 2, 0.04)
  rail(-halfX, centerZ + 4, 0.04, depth - 8)
  rail(halfX, centerZ + 4, 0.04, depth - 8)
  // Stair bulkhead in dark metal panels, and two rooftop air handlers.
  parts.push(part(box(12, 10, 10), dark, [-L / 2 - 9, 5, BACK + 6]))
  parts.push(part(box(3.4, 7.4, 0.2), steel, [-L / 2 - 9, 3.7, BACK + 11.05]))
  for (const [i, x] of [L / 2 + 6, L / 2 + 12.5].entries()) {
    parts.push(part(box(5, 4.2, 5.4), steel, [x, 2.1, BACK + 5]))
    parts.push(part(cylinder(1.7, 1.7, 0.3, 32), dark, [x, 4.35, BACK + 5]))
    parts.push(part(box(0.6, 0.6, 9), steel, [x - 1.2 + i * 0.4, 0.6, BACK + 11]))
  }
  // Long planters along the front, two big tree pots beside the unit.
  for (const x of [-L / 2 - 6, L / 2 + 6]) {
    parts.push(part(box(10, 2, 2.6), planter, [x, 1, FRONT - 2.4]))
    parts.push(part(box(9.6, 0.05, 2.2), soil, [x, 1.96, FRONT - 2.4], undefined, undefined, false))
    parts.push(part(cylinder(1.4, 1.1, 2.4, 40), planter, [x * 0.92, 1.2, 12]))
    parts.push(part(cylinder(1.3, 1.3, 0.05, 40), soil, [x * 0.92, 2.36, 12]))
  }
  for (const z of [-2, 12]) {
    parts.push(...bollard(L / 2 + 2.6, z, lights))
    parts.push(...bollard(-L / 2 - 2.6, z, lights))
  }
  return parts
}

/** An urban rooftop: the unit on a paved roof terrace, the city's towers all around. */
export function Rooftop({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  const density = DENSITY[quality]
  const night = effectiveLighting(c) === 'night'
  useEffect(() => {
    cityNight.value = night ? 1 : 0
  }, [night])
  const roofParts = useMemo(() => roof(L, c.lights), [L, c.lights])
  const palettes = grassPalette('rooftop')
  const planterPlace = useMemo(
    () =>
      (index: number, variant: number): [number, number] | null => {
        const i = index * 3 + variant
        const side = i % 2 ? 1 : -1
        return [
          side * (L / 2 + 6) + (noise(i, 25) - 0.5) * 9.2,
          FRONT - 2.4 + (noise(i, 26) - 0.5) * 1.8,
        ]
      },
    [L],
  )
  const street = useMemo(() => new MeshStandardMaterial({ color: '#3b3d3f', roughness: 0.95 }), [])
  useEffect(() => () => street.dispose(), [street])
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, STREET, 0]} material={street}>
        <planeGeometry args={[1400, 1400, 1, 1]} />
      </mesh>
      <Skyline />
      <Parts parts={roofParts} />
      {palettes.map((colors, k) => (
        <Tufts
          key={`planter-${k}`}
          count={Math.round(110 * density) + 20}
          blades={12}
          height={2.1}
          bend={0.7}
          place={(i, v) => {
            const spot = planterPlace(i, v)
            return spot && [spot[0], spot[1]]
          }}
          variant={k}
          colors={colors}
          shadow={quality !== 'lite'}
        />
      ))}
      {[-1, 1].map((side) => (
        <Tree
          key={side}
          position={[side * (L / 2 + 6) * 0.92, 2.36, 12]}
          scale={0.62}
          seed={side > 0 ? 21 : 22}
          biome="rooftop"
          quality={quality}
        />
      ))}
    </group>
  )
}
