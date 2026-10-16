import { DEFAULT_CAMERA, catalogItem, footprint, productHeight, type Config } from '../lib/config'
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
/**
 * Equipment reaching eye level (taller than NEAR_HEIGHT) nearer the lens than NEAR_FIELD, in
 * front of it, fills the picture (a rack's plates); its footprint is grown by NEAR_REACH for the
 * bar and plates that overhang it. Lower pieces sit in the foreground, as furniture would.
 */
const NEAR_HEIGHT = 4
const NEAR_FIELD = 4.5
const NEAR_REACH = 1.2

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
 * How far in front of a camera at (x, z), looking toward `target`, the nearest equipment reaching
 * eye level stands, within its horizontal field of view (up to NEAR_FIELD).
 */
function headroom(c: Config, x: number, z: number, target: Vec3, fov: number, aspect: AspectClass) {
  const ahead = Math.atan2(target[0] - x, target[2] - z)
  const half = Math.atan(Math.tan((fov * Math.PI) / 360) * ASPECT_RATIO[aspect]) + 0.15
  const seen = (px: number, pz: number) => {
    const off = Math.atan2(px - x, pz - z) - ahead
    return Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < half
  }
  let nearest = NEAR_FIELD
  // Each item's grown footprint, sampled every half foot.
  for (const item of c.items) {
    if (catalogItem(item.sku).h <= NEAR_HEIGHT) continue
    const { w, d } = footprint(item)
    const across = w / 2 + NEAR_REACH,
      deep = d / 2 + NEAR_REACH
    for (let u = -across; u <= across + 1e-6; u += 0.5)
      for (let v = -deep; v <= deep + 1e-6; v += 0.5) {
        const px = item.x + u,
          pz = item.z + v
        const away = Math.hypot(px - x, pz - z)
        if (away < nearest && seen(px, pz)) nearest = away
      }
  }
  return nearest
}

/**
 * An interior camera, standing at eye height in the room and kept inside its walls: at the first
 * spot of its list clear of tall equipment with nothing at eye level just in front of the lens,
 * else at the clear spot with the most room in front of it (or the first spot, if none is clear).
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
  const fov = INTERIOR_FOV_BY_ASPECT[aspect]
  if (angle === 'centre') {
    // Just inside the glazing, looking across at the back wall.
    spots = [0, 2, -2, 4, -4].map((x) => [x, b.front - 0.75])
    target = [0, FLOOR_Y + 3.3, b.back + 0.4]
  } else {
    // The entry corner looks down the room toward the far end; the back looks the other way.
    const side = angle === 'entry' ? 1 : -1
    spots = [1.6, 3, 4.5, 6].flatMap((inset) =>
      [2.2, 1.2].map((back): [number, number] => [side * (b.halfWidth - inset), b.front - back]),
    )
    target = [-side * b.halfWidth * 0.53, FLOOR_Y + 3.64, middle - 0.65]
  }
  let spot = spots[0]
  let room = -1
  for (const [sx, sz] of spots) {
    if (!clear(c, sx, sz)) continue
    const ahead = headroom(c, sx, sz, target, fov, aspect)
    if (ahead > room + 1e-9) [spot, room] = [[sx, sz], ahead]
    if (ahead >= NEAR_FIELD) break
  }
  const [x, z] = inside(...spot)
  return { position: [x, eye, z], target, fov }
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

/**
 * A tree's crown (or a palm's), as a vertical cylinder: a camera must not stand in it, and the
 * build should not be seen through it. Trees are `treeShape` (vegetation.ts) at `scale`: their
 * branches reach about 6 feet out and 12 up, from a trunk about 4 feet tall.
 */
type Crown = { x: number; z: number; radius: number; bottom: number; top: number }
const tree = (x: number, base: number, z: number, scale: number): Crown => ({
  x,
  z,
  radius: 6 * scale,
  bottom: base + 4 * scale,
  top: base + 12.5 * scale,
})
/** A lamp post: thin, but a line through the picture. */
const pole = (x: number, z: number): Crown => ({ x, z, radius: 0.6, bottom: 0, top: 13 })
const palm = (x: number, z: number, height: number): Crown => ({
  x,
  z,
  radius: 7,
  bottom: height - 4,
  top: height + 3,
})
/** A raised planter or hedge, as a box from the ground to the top of its plants. */
type Bed = { x: number; z: number; width: number; depth: number; top: number }

/**
 * The trees and planting around the build in each setting (Surroundings.tsx, Landscape.tsx),
 * kept in step with them by hand, like `scenery`.
 */
function planting(c: Config): { crowns: Crown[]; beds: Bed[] } {
  const L = c.length
  switch (c.environment) {
    case 'residences':
      return {
        crowns: [
          tree(-L / 2 - 16, 2.4, 7, 1.2),
          tree(L / 2 + 12, 0, -20, 1.7),
          tree(-L / 2 - 16, 0, -22, 1.8),
          pole(-L / 2 - 14, 14),
          pole(L / 2 + 14, -4),
          pole(-L / 2 - 4, -20),
        ],
        beds: [
          { x: -L / 2 - 12, z: 7, width: 14, depth: 3.2, top: 4.8 },
          { x: L / 2 + 7.5, z: 2, width: 3.2, depth: 16, top: 4.8 },
          { x: 0, z: -13, width: L + 14, depth: 3.6, top: 4.8 },
        ],
      }
    case 'campus':
      return {
        crowns: [
          tree(L / 2 + 9, 1.8, -6, 1.15),
          tree(-L / 2 - 10, 1.8, -10, 1.3),
          tree(L / 2 + 22, 0, 14, 1.5),
          palm(-14, -38, 20),
          palm(6, -42, 24),
          palm(22, -36, 18),
          palm(-32, -34, 22),
          palm(L / 2 + 26, -14, 20),
        ],
        beds: [
          { x: L / 2 + 9, z: -6, width: 14, depth: 4, top: 3.4 },
          { x: -L / 2 - 9, z: -9, width: 4, depth: 12, top: 3.4 },
        ],
      }
    case 'backyard':
      return {
        crowns: [
          tree(-L / 2 - 12, 0, -16, 1.9),
          tree(L / 2 + 16, 0, -18, 2.1),
          tree(L / 2 + 26, 0, 6, 1.6),
        ],
        beds: [{ x: 0, z: -14, width: L + 34, depth: 1.5, top: 3.6 }],
      }
    case 'courtyard':
    case 'desert':
      return {
        crowns: [-1, 1].flatMap((side) => [
          tree(side * (L / 2 + 6), 0, -8, 1.55),
          tree(side * (L / 2 + 14), 0, -19, 2),
        ]),
        beds:
          c.environment === 'courtyard'
            ? [{ x: 0, z: -10.75, width: L + 20, depth: 1.5, top: 3.6 }]
            : [],
      }
    default:
      return { crowns: [], beds: [] }
  }
}

/** Room kept between an exterior camera and the scenery's walls. */
const SCENERY_MARGIN = 2.5
/** The closest an exterior camera comes, and the widest it opens, when the scenery is near. */
const MIN_EXTERIOR_DISTANCE = 16
const MAX_EXTERIOR_FOV = 58
/** The steepest an exterior camera looks down, short of straight down. */
const MAX_ELEVATION = (78 * Math.PI) / 180
/**
 * Above this a lifted camera looks down on the roof, which mirrors the sky (and the sun in a
 * still): lifting further costs more, unless the angle is drawn that high (the view from above).
 */
const STEEP = (34 * Math.PI) / 180

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

/** Whether the segment from `a` to `b` passes through a crown. */
function throughCrown(a: Vec3, b: Vec3, crown: Crown, shrink = 0.85) {
  const dx = b[0] - a[0],
    dz = b[2] - a[2]
  const ox = a[0] - crown.x,
    oz = a[2] - crown.z
  const r = crown.radius * shrink
  // Where the segment's ground track is within the crown's radius: t0..t1.
  const qa = dx * dx + dz * dz,
    qb = 2 * (ox * dx + oz * dz),
    qc = ox * ox + oz * oz - r * r
  let t0: number, t1: number
  if (qa < 1e-9) {
    if (qc > 0) return false
    ;[t0, t1] = [0, 1]
  } else {
    const disc = qb * qb - 4 * qa * qc
    if (disc <= 0) return false
    const root = Math.sqrt(disc)
    t0 = Math.max(0, (-qb - root) / (2 * qa))
    t1 = Math.min(1, (-qb + root) / (2 * qa))
    if (t0 >= t1) return false
  }
  // And within its height there.
  const y0 = a[1] + (b[1] - a[1]) * t0,
    y1 = a[1] + (b[1] - a[1]) * t1
  return Math.max(y0, y1) > crown.bottom && Math.min(y0, y1) < crown.top
}

/** Whether the segment from `a` to `b` passes through a bed, below the top of its plants. */
function throughBed(a: Vec3, b: Vec3, bed: Bed) {
  const lo: Vec3 = [bed.x - bed.width / 2, 0, bed.z - bed.depth / 2]
  const hi: Vec3 = [bed.x + bed.width / 2, bed.top, bed.z + bed.depth / 2]
  let t0 = 0,
    t1 = 1
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i]
    if (Math.abs(d) < 1e-9) {
      if (a[i] < lo[i] || a[i] > hi[i]) return false
      continue
    }
    let near = (lo[i] - a[i]) / d,
      far = (hi[i] - a[i]) / d
    if (near > far) [near, far] = [far, near]
    t0 = Math.max(t0, near)
    t1 = Math.min(t1, far)
    if (t0 > t1) return false
  }
  return true
}

/**
 * Points of the build an exterior camera should see: the corners of its body (a little inside
 * them) and its middle. The bottom ones are what a planter in front would hide.
 */
function buildPoints(c: Config) {
  const x = c.length * 0.42,
    z = 3.4,
    top = productHeight(c) * 0.92,
    bottom = 0.8
  const corners: Vec3[] = []
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx * x, bottom, sz * z])
  const high = corners.map(([px, , pz]): Vec3 => [px, top, pz])
  return { all: [...corners, ...high, [0, productHeight(c) / 2, 0] as Vec3], bottom: corners }
}

/**
 * How much of the build the setting hides from a camera at `position`: the share of its points
 * seen through a tree's crown (or past a lamp post), and of its bottom corners behind a planter.
 */
function obstruction(
  c: Config,
  position: Vec3,
  crowns = planting(c).crowns,
  beds = planting(c).beds,
  points = buildPoints(c),
) {
  const hidden = points.all.filter((p) => crowns.some((t) => throughCrown(position, p, t)))
  const buried = points.bottom.filter((p) => beds.some((b) => throughBed(position, p, b)))
  return { hidden: hidden.length / points.all.length, buried: buried.length / points.bottom.length }
}

/** Whether a camera at `position` stands in a tree's crown, or against a lamp post. */
function inCrown(c: Config, [x, y, z]: Vec3, crowns = planting(c).crowns) {
  return crowns.some((t) => Math.hypot(x - t.x, z - t.z) < t.radius + 1 && y < t.top + 2)
}

/** What the setting does to an exterior gallery camera, for tests: obstruction and crowns. */
export function siteCheck(c: Config, camera: GalleryCamera) {
  return { ...obstruction(c, camera.position), inCrown: inCrown(c, camera.position) }
}

/** Lifts (radians) and turns tried, smallest first, for a view the setting gets in the way of. */
const LIFTS = [0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.44, 0.52]
const TURNS = [0, -0.09, 0.09, -0.18, 0.18, -0.27, 0.27, -0.36, 0.36]
/** Fractions of the framed distance tried, standing further in (with a wider lens). */
const PULLS = [1, 0.85, 0.7, 0.55, 0.4]

/**
 * An exterior camera that sees the whole build, like a product photograph taken on location: from
 * the angle's direction when nothing is in the way, else from the nearest view that is clear, by
 * looking over planters from a little higher, stepping around a tree, or standing closer in with a
 * wider lens (in front of a building that closes the view). Each departure costs, and the
 * cheapest clear view wins: a camera never stands in a building or a tree, and a tree in front of
 * the build, or a planter hiding its base, counts against a view far more than a few degrees.
 */
function exteriorCamera(c: Config, direction: Vec3, aspect: AspectClass): GalleryCamera {
  const framed = cameraFraming(c, 'exterior', direction, ASPECT_RATIO[aspect])
  const target = framed.target
  const ray = framed.position.map((v, i) => v - target[i]) as Vec3
  const distance = Math.hypot(...ray)
  const azimuth = Math.atan2(ray[0], ray[2])
  const elevation = Math.asin(ray[1] / distance)
  const footprints = scenery(c)
  const { crowns, beds } = planting(c)
  const points = buildPoints(c)
  let best: { camera: GalleryCamera; cost: number } | null = null
  for (const lift of LIFTS) {
    const up = Math.min(MAX_ELEVATION, elevation + lift)
    if (lift > 0 && up <= elevation) break
    for (const turn of TURNS) {
      const around = azimuth + turn
      const unit: Vec3 = [
        Math.sin(around) * Math.cos(up),
        Math.sin(up),
        Math.cos(around) * Math.cos(up),
      ]
      // As far out as the framing asks, or in front of the first building in the way.
      let reach = distance
      for (let t = 0.5; t <= distance; t += 0.5)
        if (footprints.some((f) => inside(f, target[0] + unit[0] * t, target[2] + unit[2] * t))) {
          reach = t - 0.5
          break
        }
      for (const pull of PULLS) {
        const near = Math.max(MIN_EXTERIOR_DISTANCE, Math.min(reach, distance * pull))
        if (pull < 1 && near >= Math.min(reach, distance)) continue
        const position = target.map((v, i) => v + unit[i] * near) as Vec3
        const [x, y, z] = position
        if (y < 2 || footprints.some((f) => inside(f, x, z))) continue
        if (inCrown(c, position, crowns)) continue
        // The lens widens by as much as the camera came in, so the build still fits.
        const half = Math.tan((EXTERIOR_FOV * Math.PI) / 360) * (distance / near)
        const fov = (Math.atan(half) * 360) / Math.PI
        if (fov > MAX_EXTERIOR_FOV + 1e-6) continue
        const { hidden, buried } = obstruction(c, position, crowns, beds, points)
        const cost =
          10 * hidden +
          3 * buried +
          2 * lift +
          4 * Math.max(0, up - Math.max(elevation, STEEP)) +
          3 * Math.abs(turn) +
          (2.5 * (fov - EXTERIOR_FOV)) / EXTERIOR_FOV
        if (!best || cost < best.cost - 1e-9) best = { camera: { position, target, fov }, cost }
        // The angle as drawn, with nothing in the way: nothing can do better.
        if (best.cost === 0) return best.camera
      }
    }
  }
  return best?.camera ?? { ...framed, fov: EXTERIOR_FOV }
}

/** Cameras worked out lately, most recently used last: each takes a search (exteriorCamera). */
const cameras = new Map<string, GalleryCamera>()
const CAMERAS_KEPT = 300

/**
 * The camera of a gallery angle for a design, at a stage shape: the exterior ones framed by
 * cameraFraming so the whole build fits, and kept clear of the setting (exteriorCamera), the
 * interior ones standing in the room. `hero` is the direction of the front three-quarter view
 * (the build's own). A pure function of its inputs, so the same design is always rendered from
 * the same camera.
 */
export function galleryCamera(
  config: Config,
  angle: AngleId,
  aspect: AspectClass,
  hero: Vec3 = DEFAULT_CAMERA,
): GalleryCamera {
  const spec = galleryAngle(angle)
  // Kept by what moves a camera: the time of day, a finish or a slider's every step leave it.
  const key = JSON.stringify([
    angle,
    aspect,
    spec.direction ? null : hero,
    config.family,
    config.length,
    config.environment,
    config.addons,
    spec.group === 'interior' ? [config.interiorStyle, config.items] : null,
  ])
  let camera = cameras.get(key)
  if (camera) cameras.delete(key)
  else
    camera =
      spec.group === 'interior'
        ? interiorCamera(config, angle, aspect)
        : exteriorCamera(config, spec.direction ?? hero, aspect)
  cameras.set(key, camera)
  if (cameras.size > CAMERAS_KEPT) cameras.delete(cameras.keys().next().value!)
  return { position: [...camera.position], target: [...camera.target], fov: camera.fov }
}

/** Where a camera stands, and the way it looks (liveView.ts LivePose). */
type Pose = { position: Vec3; forward: Vec3 }
/** Between two interior angles looking as nearly the same way, the one nearer wins by this much. */
const STANDING_WEIGHT = 0.02

const angleBetween = (a: Vec3, b: Vec3) => {
  const la = Math.hypot(...a),
    lb = Math.hypot(...b)
  if (!la || !lb) return Math.PI
  const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)
  return Math.acos(Math.max(-1, Math.min(1, cos)))
}
const toward = (from: Vec3, to: Vec3): Vec3 => [to[0] - from[0], to[1] - from[1], to[2] - from[2]]

/**
 * The gallery angle of `group` nearest a camera of the 360° view, to return to its still: outside,
 * the one seen from most nearly the same direction around the build (azimuth and elevation, as
 * directions from the build's centre on the sphere around it); inside, the one looking most
 * nearly the same way, the nearer of two that look alike.
 */
export function nearestAngle(
  config: Config,
  group: AngleGroup,
  pose: Pose,
  aspect: AspectClass,
  hero: Vec3 = DEFAULT_CAMERA,
): AngleId {
  let best: AngleId = group === 'interior' ? INTERIOR_ANGLE : DEFAULT_ANGLE
  let least = Infinity
  for (const { id, group: own } of GALLERY_ANGLES) {
    if (own !== group) continue
    const camera = galleryCamera(config, id, aspect, hero)
    const apart =
      group === 'exterior'
        ? angleBetween(toward(camera.target, pose.position), toward(camera.target, camera.position))
        : angleBetween(pose.forward, toward(camera.position, camera.target)) +
          STANDING_WEIGHT * Math.hypot(...toward(camera.position, pose.position))
    if (apart < least - 1e-9) {
      least = apart
      best = id
    }
  }
  return best
}
