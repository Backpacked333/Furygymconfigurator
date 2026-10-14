import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BufferGeometry,
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three/webgpu'
import {
  color,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalMap,
  positionWorld,
  texture,
  vec2,
  vec3,
} from 'three/tsl'
import type { Config } from '../lib/config'
import { noise } from '../lib/visuals'
import {
  box,
  boxProjectUV,
  custom,
  cylinder,
  mergeGeometries,
  roundedBox,
} from '../render/geometry'
import { material, textureMaps, type TextureSet } from '../render/materials'
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

const DENSITY: Record<Quality, number> = { ultra: 1, high: 0.65, lite: 0.25 }

// --- Ground -----------------------------------------------------------------------------

/**
 * Scanned ground with anti-tiling: two scales of the same scan are blended by low-frequency noise
 * and modulated by a macro brightness field, so a 600-foot plane never shows a repeat.
 */
function Ground({ set, size, tint }: { set: TextureSet; size: number; tint: string }) {
  const [groundMaterial, setGroundMaterial] = useState<MeshStandardNodeMaterial | null>(null)
  useEffect(() => {
    let active = true
    let created: MeshStandardNodeMaterial | null = null
    textureMaps(set).then((maps) => {
      if (!active || !maps.albedo) return
      const p = positionWorld.xz
      const uvA = p.div(size)
      const uvB = p.div(size * 3.3).add(vec2(0.37, 0.71))
      const blend = mx_noise_float(vec3(p.mul(0.04), 0))
        .mul(0.5)
        .add(0.5)
        .smoothstep(0.32, 0.68)
      const macro = mx_fractal_noise_float(vec3(p.mul(0.011), 0.5), 3, 2, 0.5)
        .mul(0.22)
        .add(1)
      const m = new MeshStandardNodeMaterial()
      m.colorNode = mix(texture(maps.albedo, uvA).rgb, texture(maps.albedo, uvB).rgb, blend)
        .mul(color(tint))
        .mul(macro)
      m.roughnessNode = mix(texture(maps.arm, uvA).g, texture(maps.arm, uvB).g, blend)
      m.normalNode = normalMap(texture(maps.normal, uvA), vec2(0.8, 0.8))
      created = m
      setGroundMaterial(m)
    })
    return () => {
      active = false
      created?.dispose()
    }
  }, [set, size, tint])
  const fallback = useMemo(() => new MeshStandardMaterial({ color: tint, roughness: 1 }), [tint])
  useEffect(() => () => fallback.dispose(), [fallback])
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.14, 0]}
      receiveShadow
      material={groundMaterial ?? fallback}
    >
      <planeGeometry args={[700, 700, 1, 1]} />
    </mesh>
  )
}

// --- Hardscape ----------------------------------------------------------------------------

function hardscape(L: number, biome: Biome, lights: boolean): Part[] {
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

// --- Trees --------------------------------------------------------------------------------

const _up = new Vector3(0, 1, 0)
function limbParts(shape: ReturnType<typeof treeShape>, bark: MeshStandardMaterial): Part[] {
  return shape.limbs.map(({ from, to, r0, r1 }, i) => {
    const direction = to.clone().sub(from)
    const length = direction.length()
    const geometry = cylinder(r1, r0, length, i < 2 ? 18 : 10)
    const matrix = new Matrix4().compose(
      from.clone().add(to).multiplyScalar(0.5),
      new Quaternion().setFromUnitVectors(_up, direction.normalize()),
      new Vector3(1, 1, 1),
    )
    return { geometry, material: bark, matrix, shadow: true }
  })
}

const Tree = memo(function Tree({
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
  const count = Math.round((biome === 'desert' ? 1700 : 1500) * DENSITY[quality]) + 300
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
  useEffect(
    () => () => {
      card.dispose()
      leaves.dispose()
    },
    [card, leaves],
  )
  const mesh = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    shape.leaves.forEach((matrix, i) => m.setMatrixAt(i, matrix))
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [shape])
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
const Hedge = memo(function Hedge({ length, quality }: { length: number; quality: Quality }) {
  const height = 3.3,
    depth = 1.5
  const count = Math.round(4200 * DENSITY[quality]) + 500
  const card = useMemo(leafCard, [])
  const leaves = useMemo(() => leafMaterial('courtyard', height / 2, true), [])
  useEffect(
    () => () => {
      card.dispose()
      leaves.dispose()
    },
    [card, leaves],
  )
  const matrices = useMemo(() => {
    const object = new Object3D()
    const list: Matrix4[] = []
    for (let i = 0; i < count; i++) {
      const face = noise(i, 51)
      const x = (noise(i, 52) - 0.5) * length
      const jitter = (noise(i, 53) - 0.5) * 0.35
      if (face < 0.62) object.position.set(x, noise(i, 54) * height, depth / 2 + jitter)
      else if (face < 0.9)
        object.position.set(x, height + jitter * 0.6, (noise(i, 54) - 0.5) * depth)
      else object.position.set(x, noise(i, 54) * height, -depth / 2 + jitter)
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
  const mesh = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    matrices.forEach((matrix, i) => m.setMatrixAt(i, matrix))
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [matrices])
  const core = useMemo(
    () => [
      part(
        box(length - 0.4, height - 0.3, depth - 0.5),
        material({ color: '#2b3a1e', roughness: 1 }),
        [0, (height - 0.3) / 2, 0],
      ),
    ],
    [length],
  )
  return (
    <group position={[0, 0, -10.75]}>
      <Parts parts={core} />
      <instancedMesh ref={mesh} args={[card, leaves, matrices.length]} castShadow receiveShadow />
    </group>
  )
})

// --- Grasses, agaves, boulders -----------------------------------------------------------

/** Instanced clumps of grass blades scattered by a placement function. */
function Tufts({
  count,
  blades,
  height,
  bend,
  place,
  variant = 0,
  colors,
  shadow,
}: {
  count: number
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
  const grass = useMemo(() => grassMaterial(colors[0], colors[1]), [colors])
  useEffect(
    () => () => {
      geometry.dispose()
      grass.dispose()
    },
    [geometry, grass],
  )
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
  const mesh = useRef<InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    matrices.forEach((matrix, i) => m.setMatrixAt(i, matrix))
    m.count = matrices.length
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [matrices])
  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, grass, Math.max(1, count)]}
      castShadow={shadow}
      receiveShadow
    />
  )
}

function agaveGeometry() {
  return custom('agave', () => {
    const leaves: BufferGeometry[] = []
    for (let i = 0; i < 18; i++) {
      const g = grassBlade(1.1 + noise(i, 31) * 0.5, 0.75, 0.13)
      g.rotateX(-0.25 - noise(i, 32) * 0.45)
      g.rotateY((i / 18) * Math.PI * 2 * 1.618)
      leaves.push(g.toNonIndexed())
    }
    const merged = mergeGeometries(leaves)
    merged.computeVertexNormals()
    return boxProjectUV(merged)
  })
}

function boulderGeometry(seed: number) {
  return custom(`boulder:${seed}`, () => {
    const g = new IcosahedronGeometry(1, 3)
    const p = g.getAttribute('position')
    const v = new Vector3()
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i)
      const n =
        Math.sin(v.x * 3.1 + seed) * 0.08 +
        Math.sin(v.y * 4.7 + seed * 2) * 0.06 +
        Math.sin(v.z * 5.3 + seed * 3) * 0.05
      v.multiplyScalar(1 + n)
      v.y = Math.max(v.y, -0.35) * 0.62
      p.setXYZ(i, v.x, v.y, v.z)
    }
    g.computeVertexNormals()
    return boxProjectUV(g)
  })
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

function StudioFloor() {
  const floor = useMemo(
    () => new MeshStandardMaterial({ color: new Color('#d8d5ce'), roughness: 0.62 }),
    [],
  )
  useEffect(() => () => floor.dispose(), [floor])
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow material={floor}>
      <circleGeometry args={[220, 96]} />
    </mesh>
  )
}

// --- Assembly -----------------------------------------------------------------------------

export function Landscape({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  const biome: Biome = c.environment === 'desert' ? 'desert' : 'courtyard'
  const studio = c.environment === 'studio'
  const density = DENSITY[quality]
  const hard = useMemo(() => hardscape(L, biome, c.lights), [L, biome, c.lights])
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
        set={biome === 'desert' ? 'dry_ground_01' : 'leafy_grass'}
        size={biome === 'desert' ? 13.1 : 6.56}
        tint={biome === 'desert' ? '#f4e6d2' : '#b9d49a'}
      />
      <Parts parts={hard} />
      {accents.length > 0 && <Parts parts={accents} />}
      {palettes.map((colors, k) => (
        <Tufts
          key={`bed-${k}`}
          count={Math.round((biome === 'desert' ? 120 : 260) * density) + 30}
          blades={biome === 'desert' ? 9 : 14}
          height={biome === 'desert' ? 1.1 : 1.8}
          bend={0.55}
          place={bedPlace}
          variant={k}
          colors={colors}
          shadow={quality !== 'lite'}
        />
      ))}
      {biome === 'courtyard' && <Hedge length={L + 20} quality={quality} />}
      {biome === 'courtyard' && (
        <Tufts
          count={Math.round(5200 * density)}
          blades={9}
          height={0.42}
          bend={0.12}
          place={lawnPlace}
          colors={['#3d5126', '#93a258']}
          shadow={false}
        />
      )}
      {[-1, 1].map((side) => (
        <group key={side}>
          <Tree
            position={[side * (L / 2 + 6), 0, -8]}
            scale={1.55}
            seed={side > 0 ? 1 : 2}
            biome={biome}
            quality={quality}
          />
          <Tree
            position={[side * (L / 2 + 14), 0, -19]}
            scale={2.0}
            seed={side > 0 ? 3 : 4}
            biome={biome}
            quality={quality}
          />
        </group>
      ))}
      <Tree
        position={[-L / 2 - 0.8, 1.75, 11.5]}
        scale={0.5}
        seed={5}
        biome={biome}
        quality={quality}
      />
    </group>
  )
}
