import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type Material,
  MeshStandardNodeMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three/webgpu'
import {
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalMap,
  positionWorld,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { noise } from '../../lib/visuals'
import { box, cylinder, mergeGeometries } from '../../render/geometry'
import { DENSITY } from './layout'
import { material, textureMaps, type TextureSet } from '../../render/materials'
import { part, type Part } from '../../render/parts'
import type { Quality } from '../../render/quality'
import { sceneWork } from '../../render/progress'
import {
  grassBlade,
  grassMaterial,
  leafCard,
  leafMaterial,
  treeShape,
  type Biome,
} from '../../render/vegetation'
import { Parts } from '../Parts'

/**
 * Pieces every outdoor setting is built from: scanned ground, trees, a clipped hedge, and
 * instanced grass. Materials and shaders are shared across settings, so switching between them
 * reuses compiled pipelines.
 */

// --- Ground -----------------------------------------------------------------------------

/** Built once per scan and tint and kept, like the material library, so switching back is free. */
const groundMaterials = new Map<string, Promise<MeshStandardNodeMaterial>>()
function loadGround(set: TextureSet, size: number, tint: string) {
  const key = `${set}|${size}|${tint}`
  let pending = groundMaterials.get(key)
  if (!pending) {
    pending = textureMaps(set).then((maps) => {
      if (!maps.albedo) throw new Error(`${set} has no albedo map`)
      // Scan scale and tint are uniforms so both biomes share one compiled ground shader.
      const p = positionWorld.xz
      const uvA = p.div(uniform(size))
      const uvB = p.div(uniform(size * 3.3)).add(vec2(0.37, 0.71))
      const blend = mx_noise_float(vec3(p.mul(0.04), 0))
        .mul(0.5)
        .add(0.5)
        .smoothstep(0.32, 0.68)
      const macro = mx_fractal_noise_float(vec3(p.mul(0.011), 0.5), 3, 2, 0.5)
        .mul(0.22)
        .add(1)
      const m = new MeshStandardNodeMaterial()
      m.colorNode = mix(texture(maps.albedo, uvA).rgb, texture(maps.albedo, uvB).rgb, blend)
        .mul(uniform(new Color(tint)))
        .mul(macro)
      m.roughnessNode = mix(texture(maps.arm, uvA).g, texture(maps.arm, uvB).g, blend)
      m.normalNode = normalMap(texture(maps.normal, uvA), vec2(0.8, 0.8))
      return m
    })
    // A failed scan keeps the untextured ground; a later request tries again.
    pending.catch(() => groundMaterials.delete(key))
    groundMaterials.set(key, pending)
  }
  return pending
}

/**
 * Scanned ground with anti-tiling: two scales of the same scan are blended by low-frequency noise
 * and modulated by a macro brightness field, so a 600-foot plane never shows a repeat.
 */
export function Ground({ set, size, tint }: { set: TextureSet; size: number; tint: string }) {
  // The previous ground stays until the next one is ready, as before, but is never disposed while
  // still drawn (which made three rebuild it).
  const [groundMaterial, setGroundMaterial] = useState<MeshStandardNodeMaterial | null>(null)
  useEffect(() => {
    let active = true
    sceneWork.set('ground', true)
    loadGround(set, size, tint)
      .then(
        (m) => {
          if (active) setGroundMaterial(m)
        },
        () => {},
      )
      .finally(() => {
        if (active) sceneWork.set('ground', false)
      })
    return () => {
      active = false
      sceneWork.set('ground', false)
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

// --- Trees --------------------------------------------------------------------------------

const _up = new Vector3(0, 1, 0)
function limbParts(shape: ReturnType<typeof treeShape>, bark: Material): Part[] {
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
  const count = Math.round((biome === 'rooftop' ? 1700 : 1500) * DENSITY[quality]) + 300
  const shape = useMemo(() => treeShape(seed, biome, count), [seed, biome, count])
  const limbs = useMemo(
    () =>
      limbParts(
        shape,
        material({
          set: 'bark_platanus',
          color: biome === 'rooftop' ? '#c9bfae' : '#a99b88',
          roughness: 1,
        }),
      ),
    [shape, biome],
  )
  const card = useMemo(leafCard, [])
  const leaves = useMemo(() => leafMaterial(biome, shape.crownHeight), [biome, shape.crownHeight])
  useEffect(() => () => card.dispose(), [card])
  const mesh = useRef<InstancedMesh>(null)
  // Also re-runs when new constructor args make R3F build a new InstancedMesh, whose instances
  // would otherwise all sit at the origin.
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    shape.leaves.forEach((matrix, i) => m.setMatrixAt(i, matrix))
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [shape, card, leaves])
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
  /** Depth of the hedge's center line. */
  z?: number
}) {
  const height = 3.3,
    depth = 1.5
  const count = Math.round(4200 * DENSITY[quality]) + 500
  const card = useMemo(leafCard, [])
  const leaves = useMemo(() => leafMaterial('courtyard', height / 2, true), [])
  useEffect(() => () => card.dispose(), [card])
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
  // Also re-runs when R3F builds a new InstancedMesh for new constructor args.
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    matrices.forEach((matrix, i) => m.setMatrixAt(i, matrix))
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [matrices, card, leaves])
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

/** Instanced clumps of grass blades scattered by a placement function. */
export function Tufts({
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
  const mesh = useRef<InstancedMesh>(null)
  // Also re-runs when R3F builds a new InstancedMesh for new constructor args.
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    matrices.forEach((matrix, i) => m.setMatrixAt(i, matrix))
    m.count = matrices.length
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [matrices, geometry, grass, count])
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
