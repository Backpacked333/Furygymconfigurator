import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Texture,
} from 'three/webgpu'
import {
  cameraViewMatrix,
  vec3,
  mix,
  modelWorldMatrix,
  normalize,
  normalView,
  positionWorld,
  texture,
  uniform,
  uv,
  vec4,
} from 'three/tsl'
import { noise } from '../lib/visuals'

export type Biome = 'courtyard' | 'backyard' | 'rooftop'

/** Sunlight available for leaf translucency (0 at night, 1 in full sun); set by the atmosphere. */
export const foliageDaylight = uniform(1)

const PALETTES: Record<Biome, { leaves: string[]; grass: [string, string][] }> = {
  courtyard: {
    leaves: ['#4f6b33', '#5d7a3a', '#6f8a45', '#41592b', '#7c9550', '#58733a'],
    grass: [
      ['#4a5a2f', '#a3a86b'],
      ['#56683a', '#b8b57d'],
      ['#3f5129', '#8f9a5c'],
    ],
  },
  // Maples and lawn borders: deeper, cooler greens with the odd warm leaf.
  backyard: {
    leaves: ['#3f5f2a', '#4c6e30', '#5e7f39', '#365224', '#6d8a3f', '#8a7a3a'],
    grass: [
      ['#43562b', '#9fae68'],
      ['#4f6534', '#b1b876'],
      ['#3a4d26', '#8a9a58'],
    ],
  },
  // Planter olives and ornamental grasses that suit a windy, sunny roof.
  rooftop: {
    leaves: ['#7d8a62', '#8e9a72', '#6c7a55', '#9aa47e', '#a6ad88'],
    grass: [
      ['#6f6a47', '#d1c48f'],
      ['#66694a', '#c3bb88'],
      ['#7a6f4f', '#dacb9c'],
    ],
  },
}

/** A procedurally painted cluster of leaves on transparency, used on alpha-tested foliage cards. */
const atlases = new Map<Biome, Texture>()
function leafAtlas(biome: Biome) {
  const cached = atlases.get(biome)
  if (cached) return cached
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const colors = PALETTES[biome].leaves
  if (ctx) {
    const count = biome === 'rooftop' ? 70 : 42
    for (let i = 0; i < count; i++) {
      // Leaves cluster toward the card center so card edges never read as squares.
      const a = noise(i, 61) * Math.PI * 2
      const r = Math.sqrt(noise(i, 62)) * size * 0.36
      const x = size / 2 + Math.cos(a) * r
      const y = size / 2 + Math.sin(a) * r
      const length = biome === 'rooftop' ? 70 + noise(i, 63) * 40 : 96 + noise(i, 63) * 60
      const width = length * (biome === 'rooftop' ? 0.26 : 0.46)
      const angle = noise(i, 64) * Math.PI * 2
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(angle)
      const base = new Color(colors[i % colors.length])
      const light = base.clone().offsetHSL(0, 0, 0.08)
      const gradient = ctx.createLinearGradient(-length / 2, 0, length / 2, 0)
      gradient.addColorStop(0, `#${base.getHexString()}`)
      gradient.addColorStop(1, `#${light.getHexString()}`)
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.moveTo(-length / 2, 0)
      ctx.quadraticCurveTo(0, -width, length / 2, 0)
      ctx.quadraticCurveTo(0, width, -length / 2, 0)
      ctx.fill()
      ctx.strokeStyle = `#${base.clone().offsetHSL(0, -0.05, -0.08).getHexString()}`
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(-length / 2, 0)
      ctx.lineTo(length / 2, 0)
      ctx.stroke()
      ctx.restore()
    }
  }
  const map = new CanvasTexture(canvas)
  map.colorSpace = SRGBColorSpace
  map.anisotropy = 4
  atlases.set(biome, map)
  return map
}

/**
 * Foliage material: alpha-tested leaf cards whose shading normals are bent toward the crown's
 * sphere, so a canopy reads as one soft volume instead of thousands of flat, noisy quads.
 */
const leafMaterials = new Map<string, MeshStandardNodeMaterial>()
export function leafMaterial(biome: Biome, crownHeight: number, hedge = false) {
  // Kept for the session, like the material library, so returning to a biome reuses them.
  const key = `${biome}|${crownHeight}|${hedge}`
  const cached = leafMaterials.get(key)
  if (cached) return cached
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.72, metalness: 0 })
  leafMaterials.set(key, m)
  const map = leafAtlas(biome)
  const sample = texture(map, uv())
  m.colorNode = sample.rgb
  m.opacityNode = sample.a
  m.alphaTest = 0.45
  // Per-tree values are uniforms, not constants, so every tree (and both biomes) shares one
  // compiled shader instead of compiling its own.
  const crown = modelWorldMatrix.mul(vec4(0, uniform(crownHeight), 0, 1)).xyz
  // A hedge bends normals away from its long axis rather than from a single point.
  const offset = positionWorld.sub(crown)
  const direction = hedge ? vec3(0, offset.y, offset.z) : offset
  const outward = cameraViewMatrix.mul(vec4(normalize(direction), 0)).xyz
  m.normalNode = normalize(mix(normalView, outward, 0.72))
  // Thin leaves transmit sunlight; a small self-lit term stands in for that translucency.
  m.emissiveNode = sample.rgb.mul(foliageDaylight.mul(0.16))
  return m
}

export function leafCard() {
  return new PlaneGeometry(1, 1)
}

export type TreeShape = {
  /** Trunk and branch segments: start, end, radius at start, radius at end. */
  limbs: { from: Vector3; to: Vector3; r0: number; r1: number }[]
  leaves: Matrix4[]
  crownHeight: number
}

/** A deterministic broadleaf (or, on the rooftop, sparse olive-like) tree in local feet. */
export function treeShape(seed: number, biome: Biome, leafCount: number): TreeShape {
  const limbs: TreeShape['limbs'] = []
  const rand = (i: number) => noise(seed * 97 + i, 71)
  const trunkTop = new Vector3((rand(1) - 0.5) * 0.5, 5.2 + rand(2) * 0.8, (rand(3) - 0.5) * 0.5)
  const mid = new Vector3(trunkTop.x * 0.4, trunkTop.y * 0.55, trunkTop.z * 0.4)
  limbs.push({ from: new Vector3(0, -0.2, 0), to: mid, r0: 0.3, r1: 0.22 })
  limbs.push({ from: mid, to: trunkTop, r0: 0.22, r1: 0.16 })
  const clusters: { center: Vector3; radius: number }[] = []
  const branches = biome === 'rooftop' ? 6 : 8
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rand(10 + i) * 0.6
    const lift = 0.45 + rand(20 + i) * 0.5
    const reach = 2.0 + rand(30 + i) * 1.6
    const start = mid.clone().lerp(trunkTop, 0.35 + rand(40 + i) * 0.6)
    const end = start
      .clone()
      .add(new Vector3(Math.cos(a) * reach, reach * lift + 0.8, Math.sin(a) * reach))
    limbs.push({ from: start, to: end, r0: 0.1, r1: 0.035 })
    // Secondary twig toward the canopy edge.
    const twig = end.clone().add(new Vector3(Math.cos(a + 0.5) * 0.9, 0.7, Math.sin(a + 0.5) * 0.9))
    limbs.push({ from: end, to: twig, r0: 0.035, r1: 0.015 })
    clusters.push({ center: end.clone().lerp(twig, 0.5), radius: 1.3 + rand(50 + i) * 0.7 })
  }
  clusters.push({ center: trunkTop.clone().add(new Vector3(0, 1.4, 0)), radius: 2.1 })
  const leaves: Matrix4[] = []
  const q = new Quaternion(),
    e = new Vector3(),
    p = new Vector3(),
    s = new Vector3()
  for (let i = 0; i < leafCount; i++) {
    const cluster = clusters[i % clusters.length]
    const u = noise(i, 81 + seed) * 2 - 1
    const phi = noise(i, 82 + seed) * Math.PI * 2
    const r = cluster.radius * (0.45 + 0.55 * Math.sqrt(noise(i, 83 + seed)))
    const sinT = Math.sqrt(1 - u * u)
    p.set(Math.cos(phi) * sinT * r, u * r * 0.75, Math.sin(phi) * sinT * r).add(cluster.center)
    e.set(noise(i, 84) * Math.PI, noise(i, 85) * Math.PI * 2, noise(i, 86) * Math.PI)
    q.setFromAxisAngle(e.clone().normalize(), e.length())
    const scale = (biome === 'rooftop' ? 0.75 : 0.95) + noise(i, 87) * 0.45
    s.setScalar(scale)
    leaves.push(new Matrix4().compose(p, q, s))
  }
  const crownHeight = clusters.reduce((sum, c) => sum + c.center.y, 0) / clusters.length
  return { limbs, leaves, crownHeight }
}

/** One arching grass blade, tapering to a point. */
export function grassBlade(height = 1, bend = 0.35, width = 0.035, segments = 5) {
  const positions: number[] = []
  const index: number[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const w = width * (1 - t * 0.85)
    const y = height * t
    const z = bend * t * t
    positions.push(-w, y, z, w, y, z)
    if (i < segments) {
      const a = i * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(positions, 3))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

/** Grass shaded from a dark, damp base to a sunlit tip using the blade's height ramp. */
const grassMaterials = new Map<string, MeshStandardNodeMaterial>()
export function grassMaterial(base: string, tip: string) {
  const key = `${base}|${tip}`
  const cached = grassMaterials.get(key)
  if (cached) return cached
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.85 })
  grassMaterials.set(key, m)
  const height = positionWorld.y.div(2.2).clamp(0, 1)
  // Uniforms rather than constants: all grass shares one compiled shader across biomes.
  m.colorNode = mix(uniform(new Color(base)), uniform(new Color(tip)), height.pow(0.8))
  return m
}

export function grassPalette(biome: Biome) {
  return PALETTES[biome].grass
}
