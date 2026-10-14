import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Shape,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Every geometry in the scene carries UVs measured in feet, so one shared texture per material
 * keeps a consistent, physically sized texel density on every surface.
 */
export type UVOptions = { swap?: boolean; scale?: number }

export function boxProjectUV(
  geometry: BufferGeometry,
  { swap = false, scale = 1 }: UVOptions = {},
) {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const uv = new Float32Array(position.count * 2)
  const p = new Vector3(),
    n = new Vector3()
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i)
    n.fromBufferAttribute(normal, i)
    const ax = Math.abs(n.x),
      ay = Math.abs(n.y),
      az = Math.abs(n.z)
    let u: number, v: number
    if (ax >= ay && ax >= az) {
      u = n.x > 0 ? -p.z : p.z
      v = p.y
    } else if (ay >= az) {
      u = p.x
      v = n.y > 0 ? -p.z : p.z
    } else {
      u = n.z > 0 ? p.x : -p.x
      v = p.y
    }
    uv[i * 2] = (swap ? v : u) * scale
    uv[i * 2 + 1] = (swap ? u : v) * scale
  }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
  return geometry
}

/** Cylindrical UVs: u is arc length around Y, v is height, both in feet. */
export function cylinderProjectUV(
  geometry: BufferGeometry,
  { swap = false, scale = 1 }: UVOptions = {},
) {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const uv = new Float32Array(position.count * 2)
  const p = new Vector3(),
    n = new Vector3()
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i)
    n.fromBufferAttribute(normal, i)
    const radius = Math.hypot(p.x, p.z)
    let u = Math.atan2(p.z, p.x) * Math.max(radius, 0.01)
    let v = p.y
    // Caps: planar mapping keeps grain and speckle straight across end faces.
    if (Math.abs(n.y) > 0.9) {
      u = p.x
      v = p.z
    }
    uv[i * 2] = (swap ? v : u) * scale
    uv[i * 2 + 1] = (swap ? u : v) * scale
  }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
  return geometry
}

const cache = new Map<string, BufferGeometry>()
function cached<T extends BufferGeometry>(key: string, create: () => T): T {
  let geometry = cache.get(key)
  if (!geometry) {
    geometry = create()
    geometry.computeBoundingSphere()
    cache.set(key, geometry)
  }
  return geometry as T
}

const k = (...values: (number | boolean | undefined)[]) =>
  values.map((v) => (typeof v === 'number' ? v.toFixed(4) : String(v))).join(':')

export function box(w: number, h: number, d: number, uv: UVOptions = {}) {
  return cached(`box:${k(w, h, d, uv.swap, uv.scale)}`, () =>
    boxProjectUV(new BoxGeometry(w, h, d), uv),
  )
}

/** Softened box: real objects never have mathematically sharp edges, and bevels catch light. */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  radius = 0.03,
  segments = 2,
  uv: UVOptions = {},
) {
  const r = Math.min(radius, w / 2.01, h / 2.01, d / 2.01)
  if (r < 0.004) return box(w, h, d, uv)
  return cached(`rbox:${k(w, h, d, r, segments, uv.swap, uv.scale)}`, () =>
    boxProjectUV(new RoundedBoxGeometry(w, h, d, segments, r), uv),
  )
}

export function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radial = 32,
  uv: UVOptions = {},
  open = false,
) {
  return cached(`cyl:${k(radiusTop, radiusBottom, height, radial, uv.swap, uv.scale, open)}`, () =>
    cylinderProjectUV(new CylinderGeometry(radiusTop, radiusBottom, height, radial, 1, open), uv),
  )
}

/** A rounded-rectangle outline, extruded with a soft bevel (frames, pads, portal shells). */
export function roundedRectShape(width: number, height: number, radius: number, x = 0, y = 0) {
  const shape = new Shape()
  const r = Math.min(radius, width / 2, height / 2)
  shape.moveTo(x - width / 2 + r, y - height / 2)
  shape.lineTo(x + width / 2 - r, y - height / 2)
  shape.quadraticCurveTo(x + width / 2, y - height / 2, x + width / 2, y - height / 2 + r)
  shape.lineTo(x + width / 2, y + height / 2 - r)
  shape.quadraticCurveTo(x + width / 2, y + height / 2, x + width / 2 - r, y + height / 2)
  shape.lineTo(x - width / 2 + r, y + height / 2)
  shape.quadraticCurveTo(x - width / 2, y + height / 2, x - width / 2, y + height / 2 - r)
  shape.lineTo(x - width / 2, y - height / 2 + r)
  shape.quadraticCurveTo(x - width / 2, y - height / 2, x - width / 2 + r, y - height / 2)
  return shape
}

export function extrude(
  key: string,
  create: () => Shape | Shape[],
  depth: number,
  bevel = 0.02,
  curveSegments = 12,
  uv: UVOptions = {},
) {
  return cached(`ext:${key}:${k(depth, bevel, curveSegments, uv.swap, uv.scale)}`, () => {
    const geometry = new ExtrudeGeometry(create(), {
      depth,
      bevelEnabled: bevel > 0,
      bevelSize: bevel,
      bevelThickness: bevel,
      bevelSegments: 3,
      curveSegments,
    })
    geometry.translate(0, 0, -depth / 2)
    geometry.computeVertexNormals()
    return boxProjectUV(geometry, uv)
  })
}

export function custom<T extends BufferGeometry>(key: string, create: () => T) {
  return cached(`custom:${key}`, create)
}

export { mergeGeometries }

/**
 * ISO container trapezoidal corrugation (278 mm pitch, 36 mm deep): a panel whose outer face is
 * corrugated along X and whose inner face is flat. Outer face lies at z = 0, inner at z = -depth.
 * The panel spans x ∈ [0, length] and y ∈ [0, height].
 */
export function corrugatedPanel(length: number, height: number, pitch = 0.912, depth = 0.118) {
  return custom(`corrugated:${k(length, height, pitch, depth)}`, () => {
    const shape = new Shape()
    const flatOuter = pitch * 0.26,
      slope = pitch * 0.245,
      flatInner = pitch * 0.25
    const back = depth + 0.03
    shape.moveTo(0, back)
    shape.lineTo(0, 0)
    let u = 0
    const phase = (length % pitch) / 2
    if (phase > 0.01) {
      shape.lineTo(phase, 0)
      u = phase
    }
    while (u + pitch <= length + 1e-6) {
      shape.lineTo(u + flatOuter, 0)
      shape.lineTo(u + flatOuter + slope, depth)
      shape.lineTo(u + flatOuter + slope + flatInner, depth)
      shape.lineTo(u + pitch, 0)
      u += pitch
    }
    if (u < length) shape.lineTo(length, 0)
    shape.lineTo(length, back)
    shape.lineTo(0, back)
    const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 })
    geometry.rotateX(-Math.PI / 2)
    // Non-indexed extrusions keep per-face normals: crisp, correctly lit corrugation edges.
    geometry.computeVertexNormals()
    return boxProjectUV(geometry)
  })
}

/** A tube along an arbitrary 3D path (bike frames, handrails, springs). */
export function tube(key: string, points: [number, number, number][], radius: number, radial = 12) {
  return custom(`tube:${key}:${k(radius, radial)}`, () => {
    const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)))
    const geometry = new TubeGeometry(curve, Math.max(8, points.length * 8), radius, radial, false)
    return boxProjectUV(geometry)
  })
}

/** Revolved profile around Y (plates, wheels, knobs, pucks). Profile points are [radius, y]. */
export function lathe(key: string, profile: [number, number][], segments = 40) {
  return custom(`lathe:${key}:${segments}`, () => {
    const geometry = new LatheGeometry(
      profile.map(([r, y]) => new Vector2(r, y)),
      segments,
    )
    return cylinderProjectUV(geometry)
  })
}
