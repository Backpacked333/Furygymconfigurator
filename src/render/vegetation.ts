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
  color,
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

export type Biome = 'courtyard' | 'desert'

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
  desert: {
    leaves: ['#7d8a62', '#8e9a72', '#6c7a55', '#9aa47e', '#a6ad88'],
    grass: [
      ['#7a6c4c', '#d2c294'],
      ['#6d6a4a', '#c4b98a'],
      ['#857455', '#dccaa0'],
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
    const count = biome === 'desert' ? 70 : 42
    for (let i = 0; i < count; i++) {
      // Leaves cluster toward the card center so card edges never read as squares.
      const a = noise(i, 61) * Math.PI * 2
      const r = Math.sqrt(noise(i, 62)) * size * 0.36
      const x = size / 2 + Math.cos(a) * r
      const y = size / 2 + Math.sin(a) * r
      const length = biome === 'desert' ? 70 + noise(i, 63) * 40 : 96 + noise(i, 63) * 60
      const width = length * (biome === 'desert' ? 0.26 : 0.46)
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
export function leafMaterial(biome: Biome, crownHeight: number, hedge = false) {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.72, metalness: 0 })
  const map = leafAtlas(biome)
  const sample = texture(map, uv())
  m.colorNode = sample.rgb
  m.opacityNode = sample.a
  m.alphaTest = 0.45
  const crown = modelWorldMatrix.mul(vec4(0, crownHeight, 0, 1)).xyz
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

/** A deterministic broadleaf (or, in the desert, sparse olive-like) tree in local feet. */
export function treeShape(seed: number, biome: Biome, leafCount: number): TreeShape {
  const limbs: TreeShape['limbs'] = []
  const rand = (i: number) => noise(seed * 97 + i, 71)
  const trunkTop = new Vector3((rand(1) - 0.5) * 0.5, 5.2 + rand(2) * 0.8, (rand(3) - 0.5) * 0.5)
  const mid = new Vector3(trunkTop.x * 0.4, trunkTop.y * 0.55, trunkTop.z * 0.4)
  limbs.push({ from: new Vector3(0, -0.2, 0), to: mid, r0: 0.3, r1: 0.22 })
  limbs.push({ from: mid, to: trunkTop, r0: 0.22, r1: 0.16 })
  const clusters: { center: Vector3; radius: number }[] = []
  const branches = biome === 'desert' ? 6 : 8
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
    const scale = (biome === 'desert' ? 0.75 : 0.95) + noise(i, 87) * 0.45
    s.setScalar(scale)
    leaves.push(new Matrix4().compose(p, q, s))
  }
  const crownHeight = clusters.reduce((sum, c) => sum + c.center.y, 0) / clusters.length
  return { limbs, leaves, crownHeight }
}

/** One arching grass blade, tapering to a point. */
export function grassBlade(height = 1, bend = 0.35, width = 0.035) {
  const segments = 5
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
export function grassMaterial(base: string, tip: string) {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.85 })
  const height = positionWorld.y.div(2.2).clamp(0, 1)
  m.colorNode = mix(color(base), color(tip), height.pow(0.8))
  return m
}

export function grassPalette(biome: Biome) {
  return PALETTES[biome].grass
}

// --- Palms and flowering shrubs -----------------------------------------------------------

/**
 * One fan-palm frond (Washingtonia) in local space: a petiole along +x ending in a palmate fan of
 * drooping leaflets. Merged into one geometry and instanced around every crown.
 */
export function palmFrond() {
  const positions: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    positions.push(...a, ...b, ...c, ...a, ...c, ...d)
  // Petiole.
  const pw = 0.06
  quad([0, 0, -pw], [3.2, 0, -pw], [3.2, 0, pw], [0, 0, pw])
  quad([0, -pw, 0], [3.2, -pw, 0], [3.2, pw, 0], [0, pw, 0])
  const leaflets = 26
  for (let i = 0; i < leaflets; i++) {
    const a = -1.35 + (i / (leaflets - 1)) * 2.7
    const length = 2.4 + Math.cos(a) * 0.6
    const segments = 4
    let prev: number[] | null = null
    for (let s = 0; s <= segments; s++) {
      const t = s / segments
      const r = t * length
      const x = 3.2 + Math.cos(a) * r,
        z = Math.sin(a) * r
      const y = -0.9 * t * t * (0.6 + Math.abs(Math.sin(a)) * 0.6)
      const w = 0.13 * (1 - t * 0.7)
      const left = [x - Math.sin(a) * w, y, z + Math.cos(a) * w]
      const right = [x + Math.sin(a) * w, y, z - Math.cos(a) * w]
      if (prev) quad(prev.slice(0, 3), prev.slice(3), right, left)
      prev = [...left, ...right]
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(positions, 3))
  g.computeVertexNormals()
  return g
}

/** Fronds shade from a deep, shaded green near the crown to sunlit sage at the tips. */
export function palmMaterial() {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.62, metalness: 0 })
  m.colorNode = color('#5f7a3c')
  // Bent normals: the crown lights as one soft volume.
  const crown = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz
  const outward = cameraViewMatrix.mul(vec4(normalize(positionWorld.sub(crown)), 0)).xyz
  m.normalNode = normalize(mix(normalView, outward, 0.55))
  m.emissiveNode = color('#5f7a3c').mul(foliageDaylight.mul(0.12))
  return m
}

export type PalmShape = {
  trunk: { from: Vector3; to: Vector3; r0: number; r1: number }[]
  crown: Vector3
  /** Frond transforms relative to the crown. */
  fronds: Matrix4[]
}
/** A tall, slightly leaning fan palm; heights in feet. */
export function palmShape(seed: number, height: number): PalmShape {
  const rand = (i: number) => noise(seed * 53 + i, 77)
  const lean = new Vector3((rand(1) - 0.5) * 0.12, 1, (rand(2) - 0.5) * 0.12).normalize()
  const trunk: PalmShape['trunk'] = []
  const segments = 6
  let base = new Vector3(0, -0.2, 0)
  for (let i = 0; i < segments; i++) {
    const t = (i + 1) / segments
    const bend = new Vector3(lean.x * t * t * 1.4, 0, lean.z * t * t * 1.4)
    const top = new Vector3(0, height * t, 0).add(bend.multiplyScalar(height * 0.15))
    trunk.push({ from: base, to: top, r0: 0.95 - (i / segments) * 0.4, r1: 0.95 - t * 0.4 })
    base = top
  }
  const crown = base.clone()
  const fronds: Matrix4[] = []
  const q = new Quaternion(),
    up = new Vector3(0, 1, 0),
    pitch = new Quaternion(),
    s = new Vector3(1, 1, 1)
  const count = 24
  for (let i = 0; i < count; i++) {
    const yaw = (i / count) * Math.PI * 2 * 1.618 + rand(10 + i)
    // Upper fronds stand up; lower ones droop, as in mature crowns.
    const tier = i / count
    const elevation = 0.9 - tier * 1.5 + (rand(40 + i) - 0.5) * 0.2
    pitch.setFromAxisAngle(new Vector3(0, 0, 1), elevation)
    q.setFromAxisAngle(up, yaw).multiply(pitch)
    s.setScalar(0.85 + rand(60 + i) * 0.3)
    fronds.push(
      new Matrix4().compose(crown.clone().add(new Vector3(0, -tier * 0.8, 0)), q.clone(), s),
    )
  }
  return { trunk, crown, fronds }
}

/** A cluster of small blossoms on transparency, for flowering shrub cards. */
const flowerAtlases = new Map<string, Texture>()
export function flowerAtlas(blossom: string) {
  const cached = flowerAtlases.get(blossom)
  if (cached) return cached
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const base = new Color(blossom)
    for (let i = 0; i < 70; i++) {
      const a = noise(i, 121) * Math.PI * 2
      const r = Math.sqrt(noise(i, 122)) * size * 0.38
      const shade = base.clone().offsetHSL(0, 0, (noise(i, 123) - 0.5) * 0.18)
      ctx.fillStyle = `#${shade.getHexString()}`
      ctx.beginPath()
      ctx.arc(
        size / 2 + Math.cos(a) * r,
        size / 2 + Math.sin(a) * r,
        5 + noise(i, 124) * 6,
        0,
        Math.PI * 2,
      )
      ctx.fill()
    }
  }
  const map = new CanvasTexture(canvas)
  map.colorSpace = SRGBColorSpace
  flowerAtlases.set(blossom, map)
  return map
}
/** Alpha-tested blossom cards, normals bent to the shrub's dome like the leaves around them. */
export function blossomMaterial(blossom: string, crownHeight: number) {
  const m = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.75, metalness: 0 })
  const sample = texture(flowerAtlas(blossom), uv())
  m.colorNode = sample.rgb
  m.opacityNode = sample.a
  m.alphaTest = 0.4
  const crown = modelWorldMatrix.mul(vec4(0, crownHeight, 0, 1)).xyz
  const outward = cameraViewMatrix.mul(vec4(normalize(positionWorld.sub(crown)), 0)).xyz
  m.normalNode = normalize(mix(normalView, outward, 0.8))
  m.emissiveNode = sample.rgb.mul(foliageDaylight.mul(0.1))
  return m
}

/** Leaf and blossom card placements over a domed shrub (feet, local to the shrub). */
export function shrubShape(seed: number, radius: number, height: number, leafCount: number) {
  const leaves: Matrix4[] = []
  const blossoms: Matrix4[] = []
  const q = new Quaternion(),
    e = new Vector3(),
    p = new Vector3(),
    s = new Vector3()
  for (let i = 0; i < leafCount; i++) {
    const u = noise(i, 131 + seed)
    const phi = noise(i, 132 + seed) * Math.PI * 2
    const r = Math.sqrt(noise(i, 133 + seed))
    const y = height * (0.15 + 0.85 * Math.sqrt(u))
    const rr = radius * r * Math.sqrt(Math.max(0, 1 - (y / height) ** 2) + 0.15)
    p.set(Math.cos(phi) * rr, y, Math.sin(phi) * rr)
    e.set(noise(i, 134) * Math.PI, noise(i, 135) * Math.PI * 2, noise(i, 136) * Math.PI)
    q.setFromAxisAngle(e.clone().normalize(), e.length())
    s.setScalar(0.42 + noise(i, 137) * 0.25)
    const m = new Matrix4().compose(p, q, s)
    if (noise(i, 138 + seed) < 0.3 && y > height * 0.4) blossoms.push(m)
    else leaves.push(m)
  }
  return { leaves, blossoms }
}
