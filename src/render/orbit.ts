import { Matrix4, Spherical, Vector3 } from 'three'

/**
 * Pre-rendered orbit views. With a cloud renderer, the exterior camera rests only on a fixed grid
 * of orbit poses: 48 azimuths (every 7.5°) at elevation steps of 5° and zoom steps of 6%. When the
 * camera stops it eases to the nearest pose, a correction of at most a few degrees, so every
 * resting view is one the cloud may already have rendered. Once the current view is shown, the
 * other azimuths of its ring are rendered in the background, nearest first; orbiting then lands
 * on finished images instead of waiting for a render.
 */

export const AZIMUTH_STEPS = 48
const AZIMUTH_STEP = (Math.PI * 2) / AZIMUTH_STEPS
const POLAR_STEP = (5 * Math.PI) / 180
const RADIUS_RATIO = 1.06

/** OrbitControls' limits in the exterior view (CameraRig uses the same). */
export const ORBIT_LIMITS = {
  minDistance: 12,
  maxDistance: 170,
  minPolarAngle: 0.1,
  maxPolarAngle: Math.PI / 2 - 0.015,
}

/** Grid indices of an orbit pose: azimuth (0..47), elevation row, and zoom step. */
export type GridPose = { azimuth: number; polar: number; radius: number }

const spherical = new Spherical()
const offset = new Vector3()

/** The camera's orbit coordinates around `target`, as OrbitControls measures them. */
export function orbitCoordinates(position: Vector3, target: Vector3) {
  spherical.setFromVector3(offset.copy(position).sub(target))
  return { theta: spherical.theta, phi: spherical.phi, radius: spherical.radius }
}

const polarRange = [
  Math.ceil(ORBIT_LIMITS.minPolarAngle / POLAR_STEP),
  Math.floor(ORBIT_LIMITS.maxPolarAngle / POLAR_STEP),
] as const
const radiusRange = [
  0,
  Math.floor(
    Math.log(ORBIT_LIMITS.maxDistance / ORBIT_LIMITS.minDistance) / Math.log(RADIUS_RATIO),
  ),
] as const

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))
const wrap = (i: number) => ((i % AZIMUTH_STEPS) + AZIMUTH_STEPS) % AZIMUTH_STEPS
/** `azimuth` shifted by whole turns to within half a turn of `reference` (the short way round). */
const near = (azimuth: number, reference: number) =>
  reference + wrap(azimuth - reference + AZIMUTH_STEPS / 2) - AZIMUTH_STEPS / 2

/** Continuous grid coordinates of a pose: rounding them gives the nearest grid pose. */
function gridCoordinates(position: Vector3, target: Vector3) {
  const { theta, phi, radius } = orbitCoordinates(position, target)
  return {
    azimuth: theta / AZIMUTH_STEP,
    polar: phi / POLAR_STEP,
    radius: Math.log(Math.max(radius, 1e-6) / ORBIT_LIMITS.minDistance) / Math.log(RADIUS_RATIO),
  }
}

/**
 * The grid pose to rest on. Normally the nearest one; but a deliberate small move away from the
 * last pose (a key press, a short drag) always advances at least one step, so it is never undone.
 */
export function snapPose(position: Vector3, target: Vector3, last: GridPose | null): GridPose {
  const g = gridCoordinates(position, target)
  const pick = (value: number, previous: number | undefined, nudge = 0.15) => {
    const nearest = Math.round(value)
    if (previous === undefined || nearest !== previous) return nearest
    const delta = value - previous
    return Math.abs(delta) > nudge ? previous + Math.sign(delta) : nearest
  }
  // Azimuth wraps: measure the move from the last pose the short way round.
  const azimuth = last ? near(g.azimuth, last.azimuth) : g.azimuth
  return {
    azimuth: wrap(pick(azimuth, last?.azimuth)),
    polar: clamp(pick(g.polar, last?.polar), polarRange),
    radius: clamp(pick(g.radius, last?.radius), radiusRange),
  }
}

/** The grid pose the camera sits on, or null when it is between poses. */
export function poseAt(position: Vector3, target: Vector3): GridPose | null {
  const g = gridCoordinates(position, target)
  const pose = {
    azimuth: wrap(Math.round(g.azimuth)),
    polar: Math.round(g.polar),
    radius: Math.round(g.radius),
  }
  const close =
    Math.abs(g.azimuth - Math.round(g.azimuth)) < 1e-3 &&
    Math.abs(g.polar - pose.polar) < 1e-3 &&
    Math.abs(g.radius - pose.radius) < 1e-3
  return close ? pose : null
}

/** Where a grid pose puts the camera: target plus the pose's spherical offset. */
export function posePosition(target: Vector3, pose: GridPose, out = new Vector3()) {
  spherical.set(
    ORBIT_LIMITS.minDistance * Math.pow(RADIUS_RATIO, pose.radius),
    pose.polar * POLAR_STEP,
    pose.azimuth * AZIMUTH_STEP,
  )
  return out.setFromSpherical(spherical).add(target)
}

/** The camera's world matrix at a grid pose, looking at the target as OrbitControls does. */
export function poseMatrix(target: Vector3, pose: GridPose) {
  const eye = posePosition(target, pose)
  return new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0)).setPosition(eye)
}

/** Moves between two poses for an eased snap (t from 0 to 1), the short way round. */
export function blendPosition(target: Vector3, from: Vector3, pose: GridPose, t: number) {
  const a = gridCoordinates(from, target)
  const azimuth = a.azimuth + (near(pose.azimuth, a.azimuth) - a.azimuth) * t
  spherical.set(
    ORBIT_LIMITS.minDistance * Math.pow(RADIUS_RATIO, a.radius + (pose.radius - a.radius) * t),
    (a.polar + (pose.polar - a.polar) * t) * POLAR_STEP,
    azimuth * AZIMUTH_STEP,
  )
  return new Vector3().setFromSpherical(spherical).add(target)
}

/** The ring's azimuths, nearest to `center` first, alternating sides. */
export function ringOrder(center: number) {
  const order = [wrap(center)]
  for (let d = 1; order.length < AZIMUTH_STEPS; d++) {
    order.push(wrap(center + d))
    if (order.length < AZIMUTH_STEPS) order.push(wrap(center - d))
  }
  return order
}

/** One ring: a scene state, orbit target, elevation, zoom, field of view, and image size. */
export function ringKey(scene: string, target: Vector3, pose: GridPose, fov: number, size: string) {
  const t = [target.x, target.y, target.z].map((v) => v.toFixed(2)).join(',')
  return `${scene}|${t}|p${pose.polar}|r${pose.radius}|f${fov.toFixed(2)}|${size}`
}

/**
 * Rendered views as the server sent them (gzip-compressed half floats, a few MB each), least
 * recently used dropped first beyond a byte budget.
 */
export class ViewCache<T extends { bytes: Uint8Array }> {
  private readonly entries = new Map<string, T>()
  private size = 0
  readonly budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  has(key: string) {
    return this.entries.has(key)
  }

  get(key: string) {
    const entry = this.entries.get(key)
    if (entry) {
      // Most recently used last.
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return entry
  }

  set(key: string, entry: T) {
    const old = this.entries.get(key)
    if (old) {
      this.size -= old.bytes.byteLength
      this.entries.delete(key)
    }
    this.entries.set(key, entry)
    this.size += entry.bytes.byteLength
    for (const [k, v] of this.entries) {
      if (this.size <= this.budget || k === key) break
      this.entries.delete(k)
      this.size -= v.bytes.byteLength
    }
  }

  get bytes() {
    return this.size
  }
}
