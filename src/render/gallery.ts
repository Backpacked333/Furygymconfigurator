import { DEFAULT_CAMERA, catalogItem, footprint, type Config } from '../lib/config'
import { FLOOR_Y, interiorBounds } from './envelope'
import { EXTERIOR_FOV, INTERIOR_FOV, cameraFraming } from './framing'

/**
 * The gallery's camera angles, like a car configurator's: six around the outside and three in
 * the room, each a fixed camera for a design, so its path-traced still can be rendered once and
 * kept by a key (src/lib/stillKey.ts). Free of three.js imports: the app shell lays out the
 * filmstrip, and works out a still's key, before the 3D chunk has loaded.
 */

type Vec3 = [number, number, number]

export type AngleId =
  'front-left' | 'front' | 'left' | 'rear-left' | 'rear' | 'top' | 'entry' | 'centre' | 'back'
export type AngleGroup = 'exterior' | 'interior'
export type GalleryAngle = {
  id: AngleId
  group: AngleGroup
  /** The filmstrip's caption. */
  label: string
  /** How the status line names it: "Rendering the rear view". */
  phrase: string
  /**
   * From the building toward the camera, for an exterior angle (+z is the front, +x the
   * building's left). The hero angle has none: it takes the build's own (DEFAULT_CAMERA, or a
   * signature build's photograph angle).
   */
  direction?: Vec3
}

export const GALLERY_ANGLES: readonly GalleryAngle[] = [
  {
    id: 'front-left',
    group: 'exterior',
    label: 'Front ¾',
    phrase: 'the front three-quarter view',
  },
  {
    id: 'front',
    group: 'exterior',
    label: 'Front',
    phrase: 'the front view',
    direction: [0, 0.2, 1],
  },
  {
    id: 'left',
    group: 'exterior',
    label: 'Side',
    phrase: 'the side view',
    direction: [1, 0.2, 0.08],
  },
  {
    id: 'rear-left',
    group: 'exterior',
    label: 'Rear ¾',
    phrase: 'the rear three-quarter view',
    direction: [0.62, 0.34, -0.78],
  },
  {
    id: 'rear',
    group: 'exterior',
    label: 'Rear',
    phrase: 'the rear view',
    direction: [0, 0.32, -1],
  },
  {
    id: 'top',
    group: 'exterior',
    label: 'Above',
    phrase: 'the view from above',
    direction: [0.3, 1.6, 0.55],
  },
  { id: 'entry', group: 'interior', label: 'Entry', phrase: 'the interior from the entry' },
  { id: 'centre', group: 'interior', label: 'Centre', phrase: 'the interior from the centre' },
  { id: 'back', group: 'interior', label: 'Back', phrase: 'the interior from the back' },
]
export const DEFAULT_ANGLE: AngleId = 'front-left'
/** The first interior angle: where the Interior view switch lands. */
export const INTERIOR_ANGLE: AngleId = 'entry'

export const galleryAngle = (id: AngleId) => GALLERY_ANGLES.find((a) => a.id === id)!

/**
 * The stage's two shapes: 16:10 on wider screens, 4:5 on phones. Stills are rendered and kept
 * for each, since a crop of the other would lose the build or the sky.
 */
export type AspectClass = 'wide' | 'tall'
export const ASPECT_RATIO: Record<AspectClass, number> = { wide: 16 / 10, tall: 4 / 5 }
/** The phone layout (styles.css uses the same breakpoint). */
export const TALL_MEDIA = '(max-width: 820px)'
/** The class of a stage (or of the canvas inside it) by its measured shape. */
export const aspectClassOf = (width: number, height: number): AspectClass =>
  width >= height ? 'wide' : 'tall'

/** The interior's vertical field of view: wider on a tall stage, so the room still reads. */
const INTERIOR_FOV_BY_ASPECT: Record<AspectClass, number> = { wide: INTERIOR_FOV, tall: 78 }
/** Eye height above the finished floor, as a person standing in the room. */
const EYE = 4.85
/** How close an interior camera may come to a wall. */
const WALL_MARGIN = 0.5
/** Equipment taller than this blocks a camera standing in its footprint. */
const BLOCKING_HEIGHT = 3
/** Clearance kept around blocking equipment. */
const EQUIPMENT_MARGIN = 0.8

export type GalleryCamera = { position: Vec3; target: Vec3; fov: number }

const same = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6)

/**
 * The hero angle's key part: plain for the default direction, else with the direction it was
 * framed from, so a still of a signature build's photograph angle never passes for the default
 * one (stillKey.ts keys stills by angle).
 */
export function angleKey(angle: AngleId, hero: Vec3 = DEFAULT_CAMERA) {
  if (angle !== 'front-left' || same(hero, DEFAULT_CAMERA)) return angle
  return `${angle}~${hero.map((v) => v.toFixed(3)).join(',')}`
}

/** Whether a standing camera at (x, z) is clear of the tall equipment in the room. */
function clear(c: Config, x: number, z: number) {
  return c.items.every((item) => {
    if (catalogItem(item.sku).h <= BLOCKING_HEIGHT) return true
    const { w, d } = footprint(item)
    return (
      Math.abs(x - item.x) > w / 2 + EQUIPMENT_MARGIN ||
      Math.abs(z - item.z) > d / 2 + EQUIPMENT_MARGIN
    )
  })
}

/**
 * An interior camera: standing at eye height at the first spot of its list that is clear of tall
 * equipment (or the first spot, if none is), kept inside the walls, looking across the room.
 */
function interiorCamera(c: Config, angle: AngleId, aspect: AspectClass): GalleryCamera {
  const b = interiorBounds(c)
  const inside = (x: number, z: number): [number, number] => [
    Math.min(b.halfWidth - WALL_MARGIN, Math.max(-b.halfWidth + WALL_MARGIN, x)),
    Math.min(b.front - WALL_MARGIN, Math.max(b.back + WALL_MARGIN, z)),
  ]
  const eye = Math.min(FLOOR_Y + EYE, b.ceiling - WALL_MARGIN)
  const middle = (b.back + b.front) / 2
  let spots: [number, number][]
  let target: Vec3
  if (angle === 'centre') {
    // Just inside the glazing, looking straight at the back wall.
    spots = [0, -2, 2, -4, 4].map((x) => [x, b.front - 0.75])
    target = [0, FLOOR_Y + 3.3, b.back + 0.4]
  } else {
    // The entry corner looks down the room toward the far end; the back looks the other way.
    const side = angle === 'entry' ? 1 : -1
    spots = [1.6, 3, 4.5].flatMap((inset) =>
      [2.2, 1.2].map((back): [number, number] => [side * (b.halfWidth - inset), b.front - back]),
    )
    target = [-side * b.halfWidth * 0.53, FLOOR_Y + 3.64, middle - 0.65]
  }
  const [x, z] = inside(...(spots.find(([sx, sz]) => clear(c, sx, sz)) ?? spots[0]))
  return {
    position: [x, eye, z],
    target,
    fov: INTERIOR_FOV_BY_ASPECT[aspect],
  }
}

/**
 * The scenery's buildings (Surroundings.tsx), as footprints an exterior camera must stay out of:
 * each one's front face along its local x axis at the origin, its body behind it (-z), placed at
 * (x, z) and turned `turn` radians about the vertical, as `place()` puts them. The settings are
 * built like a stage set around the front, so a view from behind would otherwise stand inside an
 * apartment block. Kept in step with Surroundings.tsx by hand.
 */
type Footprint = { x: number; z: number; turn: number; length: number; depth: number }
function scenery(c: Config): Footprint[] {
  const L = c.length
  switch (c.environment) {
    case 'residences':
      return [
        { x: 0, z: -34, turn: 0, length: 160, depth: 46 },
        { x: -(L / 2 + 44), z: 6, turn: Math.PI / 2, length: 110, depth: 46 },
        { x: L / 2 + 50, z: 2, turn: -Math.PI / 2, length: 110, depth: 46 },
      ]
    case 'campus':
      return [
        { x: -58, z: -52, turn: 0.12, length: 120, depth: 80 },
        { x: 46, z: -60, turn: 0, length: 96, depth: 60 },
        { x: L / 2 + 70, z: 10, turn: -Math.PI / 2, length: 90, depth: 60 },
      ]
    case 'backyard':
      // The house's body and its upper floor; the low deck in front of it is stepped over.
      return [
        { x: -(L / 2 + 34), z: -26, turn: 0.42, length: 68, depth: 38 },
        { x: L / 2 + 52, z: -40, turn: -0.55, length: 68, depth: 38 },
      ]
    default:
      return []
  }
}
/** Room kept between an exterior camera and the scenery's walls. */
const SCENERY_MARGIN = 2.5
/** The closest an exterior camera comes, and the widest it opens, when the scenery is near. */
const MIN_EXTERIOR_DISTANCE = 16
const MAX_EXTERIOR_FOV = 58

/** Whether a point of the ground plan is inside a footprint, with the margin around it. */
function inside(f: Footprint, x: number, z: number) {
  const dx = x - f.x,
    dz = z - f.z
  const cos = Math.cos(f.turn),
    sin = Math.sin(f.turn)
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos
  return (
    Math.abs(lx) < f.length / 2 + SCENERY_MARGIN &&
    lz < SCENERY_MARGIN &&
    lz > -f.depth - SCENERY_MARGIN
  )
}

/** Whether a point of the ground plan is inside one of the setting's buildings (or too near). */
export const inScenery = (c: Config, x: number, z: number) =>
  scenery(c).some((f) => inside(f, x, z))

/**
 * An exterior camera brought in front of any building in its way, its lens widened by as much
 * as it came closer, so the build still fits: a view from behind, in a courtyard closed by an
 * apartment block, stands in the courtyard rather than inside the block.
 */
function clearOfScenery(c: Config, framed: GalleryCamera): GalleryCamera {
  const footprints = scenery(c)
  if (!footprints.length) return framed
  const [tx, ty, tz] = framed.target
  const ray = framed.position.map((v, i) => v - framed.target[i])
  const distance = Math.hypot(...ray)
  const step = 0.5
  let reach = distance
  for (let t = step; t <= distance; t += step) {
    const x = tx + (ray[0] / distance) * t,
      z = tz + (ray[2] / distance) * t
    if (footprints.some((f) => inside(f, x, z))) {
      reach = t - step
      break
    }
  }
  if (reach >= distance) return framed
  const near = Math.max(MIN_EXTERIOR_DISTANCE, reach)
  const half = Math.tan((framed.fov * Math.PI) / 360) * (distance / near)
  const fov = Math.min(MAX_EXTERIOR_FOV, (Math.atan(half) * 360) / Math.PI)
  const k = near / distance
  return {
    position: [tx + ray[0] * k, ty + ray[1] * k, tz + ray[2] * k],
    target: framed.target,
    fov,
  }
}

/**
 * The camera of a gallery angle for a design, at a stage shape: the exterior ones framed by
 * cameraFraming so the whole build fits (and kept out of the scenery's buildings), the interior
 * ones standing in the room. `hero` is the
 * direction of the front three-quarter view (the build's own). A pure function of its inputs, so
 * the same design is always rendered from the same camera.
 */
export function galleryCamera(
  config: Config,
  angle: AngleId,
  aspect: AspectClass,
  hero: Vec3 = DEFAULT_CAMERA,
): GalleryCamera {
  const spec = galleryAngle(angle)
  if (spec.group === 'interior') return interiorCamera(config, angle, aspect)
  const framed = cameraFraming(config, 'exterior', spec.direction ?? hero, ASPECT_RATIO[aspect])
  return clearOfScenery(config, { ...framed, fov: EXTERIOR_FOV })
}
