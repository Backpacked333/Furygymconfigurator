import { productHeight, type Config } from '../lib/config'
import {
  GROUND_ALBEDO,
  circumsolarShare,
  environmentRadiance,
  skyLook,
  sunBeam,
  type Environment,
} from '../lib/visuals'
import { FOLIAGE_CORE, contains, sceneryKeepOuts, type KeepOut, type KeepOutKind } from './scenery'

/**
 * How the site's own shape lights each point of it, for the live view's ambient light.
 *
 * The raster lights every outdoor surface with one capture of the site, taken at the unit's centre
 * (Atmosphere.tsx SITE_POINT): from there the sky is open overhead and the paving round about is
 * in full sun. A point at the foot of a courtyard block sees half that sky, the rest taken by the
 * block, and looks out over paving in the block's shadow; a facade across the court sees the
 * shaded court in front of it; the ground under a tree sees leaves. Traced, each of them is lit
 * by what it sees, and reads darker; lit by the centre's capture, the live view's shade read up to
 * a stop and more too bright (docs/benchmarks.md, "Live view vs stills").
 *
 * This field estimates, on a grid over the site, the light arriving at each point from every
 * direction, one bounce deep: the sky where it is open, and elsewhere the setting's buildings,
 * walls, planters, trees and the ground, each lit by the sun where the sun reaches it and by the
 * sky. The shapes are the ones the gallery's cameras keep out of (scenery.ts), plus the unit's
 * own box. The live view scales each surface's ambient light by the ratio of the light reaching it
 * to the light reaching the capture point, for the way it faces (`siteLightScale`): the capture's
 * colour and detail stay, and only how much of it a point receives changes. Being a ratio of two
 * estimates made alike, the albedos and radiances below need only be right relative to each other.
 *
 * Irradiance about a normal n is kept as the first two bands of spherical harmonics, convolved
 * with the cosine lobe: E(n) = e0 + ex·nx + ey·ny + ez·nz. Free of three.js: the texture is made
 * where it is drawn (SiteLight.tsx).
 */

type Vec3 = [number, number, number]

/** What a crown, a planting or a shrub lets through along a sight line that crosses it. */
export const FOLIAGE_PASS = 0.3
/** Luminance albedo of each kind of shape's surface, and of the leaves. */
const ALBEDO: Record<KeepOutKind, number> = {
  building: 0.3,
  trunk: 0.18,
  crown: 0.12,
  post: 0.25,
  planter: 0.4,
  planting: 0.15,
  pot: 0.35,
  hedge: 0.1,
  wall: 0.4,
  shrub: 0.12,
}
/** A surface lit by the sky sees about this share of what open ground does. */
const SKY_SEEN = 0.8
/** Sight lines from each cell over the upper and lower hemispheres. */
const RAYS = { up: 40, down: 24 }
/** How far a sight line looks for a shape (feet): past that, haze. */
const REACH = 260
/**
 * The grid's cells along x, y and z: the same for every site, so the live view's texture keeps its
 * size (at about 3.5 ft a cell over the residences' court). The ground's sun map is twice as fine.
 */
export const FIELD_DIMS: [number, number, number] = [72, 16, 72]
/** The most height the field covers (feet): above it, the sky is open anyway. */
const HIGHEST = 56
/** Where the field ends round the site's shapes, and above their tops (feet). */
const MARGIN = 9
const SPAN = 130
/** The scale is kept to this range: no surface goes black or glows. */
const SCALE = { least: 0.15, most: 2 }

export type SiteLightField = {
  /** Where the first cell's centre is, the spacing, and the cells along x, y and z. */
  origin: Vec3
  cell: Vec3
  dims: [number, number, number]
  /** Four values per cell, x fastest then y then z: e0, ex, ey, ez (relative irradiance). */
  values: Float32Array
  /** The same at the capture point, for the ratio. */
  capture: [number, number, number, number]
}

/** Directions spread evenly over a hemisphere (a Fibonacci spiral, even in solid angle). */
export function hemisphere(count: number, sign = 1): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  return Array.from({ length: count }, (_, i) => {
    const y = 1 - (i + 0.5) / count
    const r = Math.sqrt(1 - y * y)
    const a = i * golden
    return [Math.cos(a) * r, y * sign, Math.sin(a) * r]
  })
}

// --- Shapes made ready for many sight lines ---------------------------------------------------

type Prepared = {
  box: boolean
  porous: boolean
  albedo: number
  top: number
  x: number
  z: number
  cos: number
  sin: number
  /** A box's faces in its own frame (a porous box shrunk about its middle, as `crosses` does). */
  lo: Vec3
  hi: Vec3
  /** A cylinder's radius squared (shrunk when porous), and its bottom. */
  r2: number
  bottom: number
}

function prepare(shapes: KeepOut[]): Prepared[] {
  return shapes.map((k) => {
    const soft = k.porous ? FOLIAGE_CORE : 1
    const albedo = ALBEDO[k.kind]
    if (k.shape === 'cylinder')
      return {
        box: false,
        porous: k.porous,
        albedo,
        top: k.top,
        x: k.x,
        z: k.z,
        cos: 1,
        sin: 0,
        lo: [0, 0, 0],
        hi: [0, 0, 0],
        r2: (k.radius * soft) ** 2,
        bottom: k.bottom,
      }
    const face = (i: number, side: number) => {
      const mid = (k.min[i] + k.max[i]) / 2,
        half = ((k.max[i] - k.min[i]) / 2) * (i === 1 ? 1 : soft)
      return mid + side * half
    }
    return {
      box: true,
      porous: k.porous,
      albedo,
      top: k.max[1],
      x: k.x,
      z: k.z,
      cos: Math.cos(k.turn),
      sin: Math.sin(k.turn),
      lo: [face(0, -1), face(1, -1), face(2, -1)],
      hi: [face(0, 1), face(1, 1), face(2, 1)],
      r2: 0,
      bottom: 0,
    }
  })
}

/** The face a sight line last entered through (`enter`), as a world normal. */
const entered: Vec3 = [0, 0, 0]

/**
 * Where the sight line from `p` along `d` first enters a shape (its distance), or -1. The face it
 * enters through is left in `entered`.
 */
function enter(k: Prepared, p: Vec3, d: Vec3, reach = REACH): number {
  if (k.box) {
    const dx = p[0] - k.x,
      dz = p[2] - k.z
    const o0 = dx * k.cos - dz * k.sin,
      o2 = dx * k.sin + dz * k.cos
    const d0 = d[0] * k.cos - d[2] * k.sin,
      d2 = d[0] * k.sin + d[2] * k.cos
    let t0 = 0,
      t1 = reach,
      axis = -1,
      sign = 0
    for (let i = 0; i < 3; i++) {
      const o = i === 0 ? o0 : i === 1 ? p[1] : o2
      const di = i === 0 ? d0 : i === 1 ? d[1] : d2
      if (Math.abs(di) < 1e-12) {
        if (o < k.lo[i] || o > k.hi[i]) return -1
        continue
      }
      let near = (k.lo[i] - o) / di,
        far = (k.hi[i] - o) / di
      if (near > far) [near, far] = [far, near]
      if (near > t0) {
        t0 = near
        axis = i
        sign = di > 0 ? -1 : 1
      }
      if (far < t1) t1 = far
      if (t0 > t1) return -1
    }
    // A face in the box's frame, turned back into the world's.
    const lx = axis === 0 ? sign : 0,
      lz = axis === 2 ? sign : 0
    entered[0] = lx * k.cos + lz * k.sin
    entered[1] = axis === 1 ? sign : 0
    entered[2] = -lx * k.sin + lz * k.cos
    return t0
  }
  const ox = p[0] - k.x,
    oz = p[2] - k.z
  const qa = d[0] * d[0] + d[2] * d[2],
    qb = 2 * (ox * d[0] + oz * d[2]),
    qc = ox * ox + oz * oz - k.r2
  let t0: number, t1: number
  if (qa < 1e-12) {
    if (qc > 0) return -1
    t0 = 0
    t1 = reach
  } else {
    const disc = qb * qb - 4 * qa * qc
    if (disc <= 0) return -1
    const root = Math.sqrt(disc)
    t0 = (-qb - root) / (2 * qa)
    t1 = Math.min(reach, (-qb + root) / (2 * qa))
  }
  // Within its height: the span between its bottom and top along the sight line.
  let y0 = 0,
    y1 = reach
  if (Math.abs(d[1]) < 1e-12) {
    if (p[1] < k.bottom || p[1] > k.top) return -1
  } else {
    y0 = (k.bottom - p[1]) / d[1]
    y1 = (k.top - p[1]) / d[1]
    if (y0 > y1) [y0, y1] = [y1, y0]
  }
  const t = Math.max(t0, y0, 0)
  if (t > Math.min(t1, y1)) return -1
  if (t === y0 && y0 > t0) {
    entered[0] = 0
    entered[1] = d[1] > 0 ? -1 : 1
    entered[2] = 0
  } else {
    const hx = ox + d[0] * t,
      hz = oz + d[2] * t
    const r = Math.hypot(hx, hz) || 1
    entered[0] = hx / r
    entered[1] = 0
    entered[2] = hz / r
  }
  return t
}

/** The share of the sun's beam reaching `p` past the shapes (leaves let a little through). */
function sunPast(shapes: Prepared[], p: Vec3, sun: Vec3) {
  let pass = 1
  for (const k of shapes) {
    if (k.top < p[1]) continue
    if (enter(k, p, sun) < 0) continue
    if (!k.porous) return 0
    pass *= FOLIAGE_PASS
  }
  return pass
}

// --- The light ----------------------------------------------------------------------------------

/** What lights the site: the sun's beam, the sky in each upward direction, and the ground. */
type Sky = {
  sun: Vec3
  /** Luminance irradiance of the sun's beam (with the circumsolar glow), facing it. */
  beam: number
  /** Luminance radiance of the sky along each upward sight line, the glow left out. */
  radiance: Float64Array
  /** Irradiance the open sky gives level ground. */
  open: number
  ground: number
}

const luminance = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

function skyOf(environment: Environment, time: number, up: Vec3[]): Sky {
  const look = skyLook(environment, time)
  const sun = look.sunlight.direction
  const radiance = Float64Array.from(up, (d) => {
    // The live view's captures leave the circumsolar glow to the sun light (visuals.ts).
    const angle = Math.acos(Math.min(1, d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]))
    return luminance(environmentRadiance(d, look)) * (1 - circumsolarShare(angle))
  })
  const open = (2 * Math.PI * up.reduce((s, d, i) => s + radiance[i] * d[1], 0)) / up.length
  return {
    sun,
    beam: sun[1] > 0 ? luminance(sunBeam(look)) : 0,
    radiance,
    open,
    ground: luminance(GROUND_ALBEDO[environment]),
  }
}

/** Radiance of a lit surface: the sun where it reaches, the sky it sees. */
function surfaceRadiance(albedo: number, n: Vec3, sunlit: number, sky: Sky) {
  const facing = Math.max(0, n[0] * sky.sun[0] + n[1] * sky.sun[1] + n[2] * sky.sun[2])
  const skyLight = sky.open * SKY_SEEN * (0.5 + 0.5 * n[1])
  return (albedo / Math.PI) * (sky.beam * facing * sunlit + skyLight)
}

/** Radiance of foliage a sight line passes through: lit leaves and shaded ones together. */
const leafRadiance = (sky: Sky) =>
  (ALBEDO.crown / Math.PI) * (sky.beam * Math.max(0, sky.sun[1]) * 0.35 + sky.open * 0.5)

type Scene = {
  shapes: Prepared[]
  sky: Sky
  up: Vec3[]
  down: Vec3[]
  /** Whether the ground at a point is in sun (0 to 1), from the sun map. */
  groundSun: (x: number, z: number) => number
}

/** The light arriving along one sight line from `p`. */
function arriving(scene: Scene, p: Vec3, d: Vec3, skyIndex: number) {
  const { shapes, sky } = scene
  let nearest = REACH,
    hit: Prepared | null = null
  const normal: Vec3 = [0, 0, 0]
  let pass = 1
  // The ground, for sight lines going down.
  if (d[1] < 0) nearest = Math.min(REACH, -p[1] / d[1])
  for (const k of shapes) {
    if (d[1] >= 0 && k.top < p[1]) continue
    const t = enter(k, p, d, nearest)
    if (t < 0 || t >= nearest) continue
    if (k.porous) {
      pass *= FOLIAGE_PASS
      continue
    }
    nearest = t
    hit = k
    normal[0] = entered[0]
    normal[1] = entered[1]
    normal[2] = entered[2]
  }
  let behind: number
  if (hit) {
    const at: Vec3 = [
      p[0] + d[0] * nearest + normal[0] * 0.05,
      p[1] + d[1] * nearest + normal[1] * 0.05,
      p[2] + d[2] * nearest + normal[2] * 0.05,
    ]
    const facing = normal[0] * sky.sun[0] + normal[1] * sky.sun[1] + normal[2] * sky.sun[2]
    const sunlit = facing > 0 ? sunPast(shapes, at, sky.sun) : 0
    behind = surfaceRadiance(hit.albedo, normal, sunlit, sky)
  } else if (d[1] < 0) {
    const x = p[0] + d[0] * nearest,
      z = p[2] + d[2] * nearest
    behind = surfaceRadiance(sky.ground, [0, 1, 0], scene.groundSun(x, z), sky) / SKY_SEEN
  } else behind = sky.radiance[skyIndex]
  return pass * behind + (1 - pass) * leafRadiance(sky)
}

/** Irradiance at `p` as the four harmonic weights (see above). */
function irradiance(scene: Scene, p: Vec3): [number, number, number, number] {
  const w: [number, number, number, number] = [0, 0, 0, 0]
  const add = (d: Vec3, weight: number, light: number) => {
    w[0] += weight * light
    w[1] += 2 * weight * light * d[0]
    w[2] += 2 * weight * light * d[1]
    w[3] += 2 * weight * light * d[2]
  }
  // Each hemisphere's sight lines share its 2π steradians evenly; E(n) = (1/4)·Σ L·dω·(1 + 2 d·n)
  // over the sphere, the first two bands of the cosine lobe.
  const up = (2 * Math.PI) / scene.up.length,
    down = (2 * Math.PI) / scene.down.length
  scene.up.forEach((d, i) => add(d, up / 4, arriving(scene, p, d, i)))
  scene.down.forEach((d) => add(d, down / 4, arriving(scene, p, d, -1)))
  return w
}

/** The irradiance a surface facing `n` receives, from the four weights. */
export function irradianceFacing(w: ArrayLike<number>, n: Vec3) {
  return Math.max(0, w[0] + w[1] * n[0] + w[2] * n[1] + w[3] * n[2])
}

/** How much a surface's ambient light is scaled: its irradiance against the capture point's. */
export function siteLightScale(point: number, capture: number) {
  return Math.min(SCALE.most, Math.max(SCALE.least, point / Math.max(capture, 1e-6)))
}

// --- The field ----------------------------------------------------------------------------------

/** The unit's body, as a shape: it shades the paving (its finish does not enter). */
export function unitShape(c: Pick<Config, 'length' | 'family'>): KeepOut {
  return {
    kind: 'building',
    porous: false,
    shape: 'box',
    x: 0,
    z: 0,
    turn: 0,
    min: [-c.length / 2, 0, -4],
    max: [c.length / 2, productHeight(c as Config) + 0.3, 4],
  }
}

/** The ground plan and height the field covers: the shapes, a margin round them, at most SPAN. */
function extent(shapes: KeepOut[]) {
  let x0 = -20,
    x1 = 20,
    z0 = -20,
    z1 = 20,
    y1 = 12
  for (const k of shapes) {
    const reach =
      k.shape === 'cylinder'
        ? k.radius
        : Math.hypot(Math.max(-k.min[0], k.max[0]), Math.max(-k.min[2], k.max[2]))
    x0 = Math.min(x0, k.x - reach)
    x1 = Math.max(x1, k.x + reach)
    z0 = Math.min(z0, k.z - reach)
    z1 = Math.max(z1, k.z + reach)
    y1 = Math.max(y1, k.shape === 'box' ? k.max[1] : k.top)
  }
  const clamp = (v: number) => Math.max(-SPAN, Math.min(SPAN, v))
  return {
    min: [clamp(x0 - MARGIN), 0, clamp(z0 - MARGIN)] as Vec3,
    max: [clamp(x1 + MARGIN), Math.min(y1 + MARGIN, HIGHEST), clamp(z1 + MARGIN)] as Vec3,
  }
}

/**
 * The field over a site: its shapes, the unit's (`unit`, which the capture point looks through,
 * as the capture does, though its shadow stays), and the sky at a time of day.
 */
export function siteLightField(
  shapes: KeepOut[],
  unit: KeepOut | null,
  environment: Environment,
  time: number,
  capturePoint: Vec3,
): SiteLightField {
  const all = unit ? [...shapes, unit] : shapes
  const { min, max } = extent(all)
  const dims = FIELD_DIMS
  const cell = [0, 1, 2].map((i) => (max[i] - min[i]) / (dims[i] - 1)) as Vec3
  const up = hemisphere(RAYS.up),
    down = hemisphere(RAYS.down, -1)
  const sky = skyOf(environment, time, up)
  const prepared = prepare(all)
  // Which ground is in sun, on a grid twice as fine as the field's.
  const sx = dims[0] * 2,
    sz = dims[2] * 2
  const sunMap = new Float32Array(sx * sz)
  for (let j = 0; j < sz; j++)
    for (let i = 0; i < sx; i++) {
      const x = min[0] + ((max[0] - min[0]) * (i + 0.5)) / sx,
        z = min[2] + ((max[2] - min[2]) * (j + 0.5)) / sz
      sunMap[j * sx + i] = sky.beam > 0 ? sunPast(prepared, [x, 0.05, z], sky.sun) : 0
    }
  const groundSun = (x: number, z: number) => {
    const i = Math.floor(((x - min[0]) / (max[0] - min[0])) * sx),
      j = Math.floor(((z - min[2]) / (max[2] - min[2])) * sz)
    // Beyond the field the ground is open and in sun.
    if (i < 0 || j < 0 || i >= sx || j >= sz) return 1
    return sunMap[j * sx + i]
  }
  // The unit shades the ground (the sun map), but its own shading of what is round it is left to
  // the live view's ambient occlusion, which finds it on screen at its true shape.
  const open = unit ? prepared.slice(0, -1) : prepared
  const scene: Scene = { shapes: open, sky, up, down, groundSun }
  const count = dims[0] * dims[1] * dims[2]
  const values = new Float32Array(count * 4)
  const solid = new Uint8Array(count)
  const solids = all.filter((k) => !k.porous)
  for (let z = 0, i = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++, i++) {
        // A little above the ground, as a surface on it is.
        const p: Vec3 = [min[0] + x * cell[0], min[1] + y * cell[1] + 0.25, min[2] + z * cell[2]]
        if (solids.some((k) => contains(k, p))) {
          solid[i] = 1
          continue
        }
        values.set(irradiance(scene, p), i * 4)
      }
  fillSolid(values, solid, dims)
  // The capture looks through the unit, its shadow kept (shadowOnly.ts), as every point here does.
  return { origin: min, cell, dims, values, capture: irradiance(scene, capturePoint) }
}

/** Gives each solid cell the mean of its open neighbours, growing inward a layer at a time. */
function fillSolid(
  values: Float32Array,
  solid: Uint8Array,
  [nx, ny, nz]: [number, number, number],
) {
  const steps = [1, -1, nx, -nx, nx * ny, -nx * ny]
  for (let layer = 0; layer < 3; layer++) {
    const filled: number[] = []
    for (let i = 0; i < solid.length; i++) {
      if (!solid[i]) continue
      const x = i % nx,
        y = Math.floor(i / nx) % ny,
        z = Math.floor(i / (nx * ny))
      const sum = [0, 0, 0, 0]
      let n = 0
      steps.forEach((step, s) => {
        const inside =
          (s === 0 && x < nx - 1) ||
          (s === 1 && x > 0) ||
          (s === 2 && y < ny - 1) ||
          (s === 3 && y > 0) ||
          (s === 4 && z < nz - 1) ||
          (s === 5 && z > 0)
        if (!inside || solid[i + step]) return
        for (let c = 0; c < 4; c++) sum[c] += values[(i + step) * 4 + c]
        n++
      })
      if (!n) continue
      for (let c = 0; c < 4; c++) values[i * 4 + c] = sum[c] / n
      filled.push(i)
    }
    if (!filled.length) break
    for (const i of filled) solid[i] = 0
  }
}

/** The weights at a point, filtered between the eight cells round it (as the texture is). */
export function sampleField(field: SiteLightField, p: Vec3): [number, number, number, number] {
  const { origin, cell, dims, values } = field
  const f = [0, 1, 2].map((i) =>
    Math.max(0, Math.min(dims[i] - 1.0001, (p[i] - origin[i]) / cell[i])),
  )
  const base = f.map(Math.floor)
  const t = f.map((v, i) => v - base[i])
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let corner = 0; corner < 8; corner++) {
    const o = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1]
    const weight = o.reduce((w, oi, i) => w * (oi ? t[i] : 1 - t[i]), 1)
    if (!weight) continue
    const index = base[0] + o[0] + dims[0] * (base[1] + o[1] + dims[1] * (base[2] + o[2]))
    for (let c = 0; c < 4; c++) out[c] += weight * values[index * 4 + c]
  }
  return out
}

/** Where the site's light is captured (Atmosphere.tsx SITE_POINT): the unit's centre, 5 ft up. */
export const CAPTURE_POINT: Vec3 = [0, 5, 0]

type Design = Pick<Config, 'environment' | 'length' | 'family' | 'time'>
const fields = new Map<string, SiteLightField>()
/** A design's field (setting, unit, time of day), worked out once; none in the studio. */
export function siteField(c: Design): SiteLightField | null {
  if (c.environment === 'studio') return null
  const key = `${c.environment}|${c.length}|${c.family}|${c.time}`
  let field = fields.get(key)
  if (!field) {
    if (fields.size > 8) fields.clear()
    fields.set(
      key,
      (field = siteLightField(
        sceneryKeepOuts(c),
        unitShape(c),
        c.environment,
        c.time,
        CAPTURE_POINT,
      )),
    )
  }
  return field
}
