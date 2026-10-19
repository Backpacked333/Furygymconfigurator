import type { Config } from './config'
import { productFamily } from './products'
import type { Vec3 } from './visuals'

/**
 * Camera poses shared by the hero stills, the render worker that draws them, and the live 360
 * view, which starts from the pose of the still on screen. No three.js here: the batch renderer
 * imports this module in Node.
 */
export type ExteriorAngle = 'hero' | 'front' | 'frontLeft' | 'rear' | 'aerial'
export type InteriorAngle = 'interiorHero' | 'interiorReverse'
export type AngleId = ExteriorAngle | InteriorAngle

export type CameraPreset = {
  id: AngleId
  view: 'exterior' | 'interior'
  label: string
  fov: number
  /** Exterior angles: unit direction from the look target toward the camera. */
  direction?: Vec3
  /**
   * The angle looks through the Studio glazing or the Container opening, so the interior shows:
   * its stills stack an interior layer under a shell layer that is transparent there.
   */
  seesInterior: boolean
}

const normalize = ([x, y, z]: Vec3): Vec3 => {
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}

export const CAMERA_PRESETS: Record<AngleId, CameraPreset> = {
  hero: {
    id: 'hero',
    view: 'exterior',
    label: 'Three-quarter',
    fov: 32,
    direction: normalize([0.48, 0.24, 0.84]),
    seesInterior: true,
  },
  front: {
    id: 'front',
    view: 'exterior',
    label: 'Front',
    fov: 32,
    direction: normalize([0, 0.14, 1]),
    seesInterior: true,
  },
  frontLeft: {
    id: 'frontLeft',
    view: 'exterior',
    label: 'Front left',
    fov: 32,
    direction: normalize([-0.62, 0.2, 0.76]),
    seesInterior: true,
  },
  rear: {
    id: 'rear',
    view: 'exterior',
    label: 'Rear',
    fov: 32,
    direction: normalize([-0.55, 0.22, -0.8]),
    seesInterior: false,
  },
  aerial: {
    id: 'aerial',
    view: 'exterior',
    label: 'Aerial',
    fov: 30,
    direction: normalize([0.42, 0.78, 0.6]),
    seesInterior: true,
  },
  interiorHero: {
    id: 'interiorHero',
    view: 'interior',
    label: 'Inside',
    fov: 68,
    seesInterior: true,
  },
  interiorReverse: {
    id: 'interiorReverse',
    view: 'interior',
    label: 'Looking out',
    fov: 68,
    seesInterior: true,
  },
}
export const ANGLES = Object.keys(CAMERA_PRESETS) as AngleId[]
export const EXTERIOR_ANGLES = ANGLES.filter((a) => CAMERA_PRESETS[a].view === 'exterior')

/** Stills are rendered 16:9 and cropped to the stage with object-fit: cover. */
export const STILL_ASPECT = 16 / 9
export const STILL_WIDTHS = [640, 1024, 2048] as const

export type Pose = { position: Vec3; target: Vec3; fov: number }

type FramingConfig = Pick<Config, 'family' | 'length' | 'addons'>

/**
 * Distance at which the unit and its additions fill the frame from a direction. Live, the frame
 * fits the additions actually chosen; stills fit the largest Studio, so an angle keeps the same
 * camera as options change and one still crossfades into the next without a jump.
 */
export function exteriorFraming(
  c: FramingConfig,
  fov: number,
  aspect: number,
  direction: Vec3,
  fixed = false,
): Pose {
  const studio = c.family === 'studio'
  const a = fixed
    ? { deck: studio, gazebo: studio, roof: studio, stairs: studio }
    : c.family === 'studio'
      ? c.addons
      : { deck: false, gazebo: false, roof: false, stairs: false }
  const hasOutdoor = a.deck || a.gazebo || a.stairs
  const shellHeight = productFamily(c.family).height
  const width = c.length + (a.stairs ? 6 : 2),
    depth = hasOutdoor ? 17 : 10
  const v = (fov * Math.PI) / 360,
    h = Math.atan(Math.tan(v) * aspect)
  const height = a.roof || a.stairs ? 14 : shellHeight
  const radius = Math.sqrt(width * width + depth * depth + height * height) / 2
  const d = (radius / Math.sin(Math.min(v, h))) * 0.94
  const target: Vec3 = [a.stairs ? 2 : 0, a.roof ? 5 : 3.5, hasOutdoor ? 2.2 : 0]
  const [x, y, z] = normalize(direction)
  return { position: [target[0] + x * d, target[1] + y * d, target[2] + z * d], target, fov }
}

/** Eye-level poses inside the unit, at standing height. */
export function interiorFraming(c: Pick<Config, 'length'>, angle: InteriorAngle): Pose {
  const L = c.length
  return angle === 'interiorHero'
    ? { position: [L / 2 - 2.2, 5.8, 1.4], target: [-L / 4, 4.6, -0.7], fov: 68 }
    : { position: [-L / 2 + 2.2, 5.6, -1.6], target: [L / 6, 4.4, 3.2], fov: 68 }
}

/** The pose of a still: fixed per product and size, independent of the chosen additions. */
export function stillPose(c: FramingConfig, angle: AngleId, aspect = STILL_ASPECT): Pose {
  const preset = CAMERA_PRESETS[angle]
  return preset.view === 'interior'
    ? interiorFraming(c, angle as InteriorAngle)
    : exteriorFraming(c, preset.fov, aspect, preset.direction!, true)
}

/**
 * Vertical field of view that shows exactly the part of a 16:9 still visible when it is drawn
 * with object-fit: cover on a stage of another aspect. The live view uses it so that stepping
 * from a still into the 360 view starts from the same picture.
 */
export function coverFov(fov: number, stageAspect: number) {
  if (stageAspect <= STILL_ASPECT) return fov
  const half = (fov * Math.PI) / 360
  return (Math.atan((Math.tan(half) * STILL_ASPECT) / stageAspect) * 360) / Math.PI
}
