import {
  DEFAULT_CAMERA,
  catalogItem,
  entryCenter,
  footprint,
  openingGeometry,
  productHeight,
  type Config,
  type PlacedItem,
} from '../lib/config'
import { FLOOR_Y, STUDIO, interiorBounds } from './envelope'
import { EXTERIOR_FOV, INTERIOR_FOV, cameraFraming } from './framing'
import { contains, crosses, sceneryKeepOuts, type KeepOut, type KeepOutKind } from './scenery'

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
export { TALL_MEDIA } from '../lib/stillsManifest'
/** The class of a stage (or of the canvas inside it) by its measured shape. */
export const aspectClassOf = (width: number, height: number): AspectClass =>
  width >= height ? 'wide' : 'tall'

/** The interior's vertical field of view: wider on a tall stage, so the room still reads. */
const INTERIOR_FOV_BY_ASPECT: Record<AspectClass, number> = { wide: INTERIOR_FOV, tall: 78 }
/**
 * How much longer than that an interior lens may be (degrees off its field of view), to frame a
 * piece from further back; never wider, which would stretch the room's corners as a fisheye does.
 */
const LONGEST = 12
/**
 * Eye height above the finished floor, as a person standing in the room, and how far the camera
 * may stand up or down from it.
 */
const EYE = 4.85
const EYE_RANGE = 0.5
/**
 * How far an interior camera looks down (degrees): a standing person's gaze, a little below level,
 * and the least and most it may, short of the steep look that leans the room's uprights.
 */
const PITCH = 8
const PITCH_RANGE = [2, 12] as const
/** How close an interior camera may come to a wall. */
const WALL_MARGIN = 0.5
/**
 * Equipment taller than this blocks a camera standing near it; lower pieces only keep a person off
 * them, and a mat (no higher than UNDERFOOT) not even that: it is flooring.
 */
const BLOCKING_HEIGHT = 3
const UNDERFOOT = 0.5
/** Clearance kept around tall equipment, and around low pieces. */
const EQUIPMENT_MARGIN = 0.8
const LOW_MARGIN = 0.4
/**
 * Equipment nearer the lens than NEAR that fills more of the frame than NEAR_FILL crowds it; cut by
 * the frame's edge, it may reach NEAR_REACH of the way across (or up) the picture.
 */
const NEAR = 5
const NEAR_FILL = 0.15
const NEAR_REACH = 0.35

export type GalleryCamera = { position: Vec3; target: Vec3; fov: number }

const same = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * The hero angle's key part: plain for the default direction, else with the direction it was
 * framed from, so a still of a signature build's photograph angle never passes for the default
 * one (stillKey.ts keys stills by angle).
 */
export function angleKey(angle: AngleId, hero: Vec3 = DEFAULT_CAMERA) {
  if (angle !== 'front-left' || same(hero, DEFAULT_CAMERA)) return angle
  return `${angle}~${hero.map((v) => v.toFixed(3)).join(',')}`
}

// --- What a camera sees --------------------------------------------------------------------

/**
 * A camera's picture plane: where a point lands in it, from -1 to 1 across and up the frame (null
 * for a point behind the lens).
 */
function lens(camera: GalleryCamera, aspect: AspectClass) {
  const forward = unit(sub(camera.target, camera.position))
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const tanV = Math.tan((camera.fov * Math.PI) / 360)
  const tanH = tanV * ASPECT_RATIO[aspect]
  return {
    forward,
    right,
    up,
    tanV,
    tanH,
    project(p: Vec3): [number, number] | null {
      const d = sub(p, camera.position)
      const depth = dot(d, forward)
      if (depth < 0.05) return null
      // Far off to the side of a point just in front of the lens: kept finite.
      const clamp = (v: number) => Math.max(-50, Math.min(50, v))
      return [clamp(dot(d, right) / (depth * tanH)), clamp(dot(d, up) / (depth * tanV))]
    },
  }
}

/** The convex hull of points of the picture plane (monotone chain), counter-clockwise. */
function hull(points: [number, number][]) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (sorted.length < 3) return sorted
  const turn = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const p of sorted) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper: [number, number][] = []
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

const area = (polygon: [number, number][]) => {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i],
      [x1, y1] = polygon[(i + 1) % polygon.length]
    sum += x0 * y1 - x1 * y0
  }
  return Math.abs(sum) / 2
}

/** A convex polygon cut to the frame (Sutherland–Hodgman). */
function clipToFrame(polygon: [number, number][]) {
  let out = polygon
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
  ] as const) {
    const input = out
    out = []
    const inside = (p: [number, number]) => sign * p[axis] <= 1
    for (let i = 0; i < input.length; i++) {
      const a = input[i],
        b = input[(i + 1) % input.length]
      if (inside(a)) out.push(a)
      if (inside(a) !== inside(b)) {
        const t = (sign - a[axis]) / (b[axis] - a[axis])
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
    if (!out.length) break
  }
  return out
}

// --- The room an interior camera stands in ---------------------------------------------------

type Sku = PlacedItem['sku']
/**
 * How much each piece is the subject of an interior picture: the racks, the trainer, the sauna and
 * the long cardio and Pilates pieces most, benches and bikes next, the small stations and the mats
 * least.
 */
const SUBJECT: Record<Sku, number> = {
  rack: 1,
  halfrack: 1,
  trainer: 1,
  sauna: 1,
  treadmill: 0.9,
  reformer: 0.9,
  bike: 0.7,
  airbike: 0.7,
  plunge: 0.7,
  lounge: 0.6,
  bench: 0.6,
  weights: 0.5,
  plyo: 0.4,
  medball: 0.4,
  shelf: 0.4,
  mat: 0.3,
}
/**
 * How much of the room behind it a piece hides: a rack or a cable column is an open frame, a
 * dumbbell station a row of bells on a stand; the rest are near enough solid. A loaded bar hides
 * little but its plates.
 */
const OPACITY: Partial<Record<Sku, number>> = {
  rack: 0.45,
  halfrack: 0.45,
  trainer: 0.55,
  weights: 0.75,
  medball: 0.7,
  bike: 0.7,
  airbike: 0.7,
  shelf: 0.85,
}
const BAR_OPACITY = 0.2

/** An axis-aligned box in the room: a piece of equipment, or the bar loaded on a rack. */
type Volume = {
  min: Vec3
  max: Vec3
  tall: boolean
  bar: boolean
  /** How much it is the picture's subject (SUBJECT), and how much of the room it hides. */
  weight: number
  opacity: number
}

/**
 * The room's equipment as boxes: each piece's footprint and height (the catalog's), and the loaded
 * bar a rack holds across its front, 7.25 feet long with plates 1.5 feet across (equipment.ts),
 * which overhangs the rack's frame either side.
 */
function equipment(c: Config): Volume[] {
  const out: Volume[] = []
  for (const item of c.items) {
    const p = catalogItem(item.sku)
    const { w, d } = item.rotation === 90 ? { w: p.d, d: p.w } : p
    out.push({
      min: [item.x - w / 2, FLOOR_Y, item.z - d / 2],
      max: [item.x + w / 2, FLOOR_Y + p.h, item.z + d / 2],
      tall: p.h > BLOCKING_HEIGHT,
      bar: false,
      weight: SUBJECT[item.sku],
      opacity: OPACITY[item.sku] ?? 1,
    })
    if (item.sku !== 'rack' && item.sku !== 'halfrack') continue
    // Along the rack's own x, in front of its middle; turned a quarter, along z (Equipment.tsx).
    const bar = item.sku === 'rack' ? { y: 4.49, z: 0.85 } : { y: 4.4, z: 0.65 }
    const [half, plate] = [3.63, 0.74]
    const [ax, az] = item.rotation === 90 ? [plate, half] : [half, plate]
    const [cx, cz] = item.rotation === 90 ? [item.x - bar.z, item.z] : [item.x, item.z + bar.z]
    out.push({
      min: [cx - ax, FLOOR_Y + bar.y - plate, cz - az],
      max: [cx + ax, FLOOR_Y + bar.y + plate, cz + az],
      tall: false,
      bar: true,
      weight: 0,
      opacity: BAR_OPACITY,
    })
  }
  return out
}

/**
 * The room's inside; the opening in its front that shows the setting (x from, x to, y from, y to):
 * a Studio's glazing runs its whole front inside the bezel, a Container's opening is the width
 * chosen for it, unless its shutter is down; and the mirror on its back wall, if it has one
 * (StudioModel.tsx).
 */
type Rect = [number, number, number, number]
type Room = { bounds: ReturnType<typeof interiorBounds>; opening: Rect | null; mirror: Rect | null }
function interiorRoom(c: Config): Room {
  const bounds = interiorBounds(c)
  const H = productHeight(c)
  const L = c.length
  const mirror: Rect | null = c.mirror ? [-0.4 * L, 0.08 * L, 2, 7.8] : null
  if (c.family === 'studio') {
    const inset = STUDIO.bezel + 0.16
    const opening: Rect = [
      -L / 2 + inset,
      L / 2 - inset,
      STUDIO.base + inset,
      STUDIO.base + H - inset,
    ]
    return { bounds, opening, mirror }
  }
  if (c.containerOpening === 'roll-up' && !c.doorsOpen) return { bounds, opening: null, mirror }
  const { width, center } = openingGeometry(c)
  return { bounds, opening: [center - width / 2, center + width / 2, 0.62, H - 0.9], mirror }
}
const within = ([x0, x1, y0, y1]: Rect, x: number, y: number) =>
  x >= x0 && x <= x1 && y >= y0 && y <= y1

/**
 * What an interior camera works from: the room, its equipment, the piece most the room's subject
 * (the largest of the most important, -1 in an empty room), and the end of the room the entry is
 * at (+x unless the door is toward -x).
 */
type Interior = { room: Room; volumes: Volume[]; main: number; side: 1 | -1 }
function interior(c: Config): Interior {
  const volumes = equipment(c)
  let main = -1,
    most = 0
  volumes.forEach(({ min, max, weight }, i) => {
    const size = weight * Math.cbrt((max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]))
    if (size > most + 1e-9) [main, most] = [i, size]
  })
  return { room: interiorRoom(c), volumes, main, side: entryCenter(c) < -0.5 ? -1 : 1 }
}

// --- What an interior camera sees ------------------------------------------------------------

/**
 * Where a box's outline in the picture comes from: its corners, when it is wholly in front of the
 * lens; else points along its edges, of which those in front of the lens are seen.
 */
const outlines = new WeakMap<Volume, { corners: Vec3[]; edges: Vec3[] }>()
function outline(volume: Volume) {
  let kept = outlines.get(volume)
  if (kept) return kept
  const { min, max } = volume
  const at = (i: number, t: number) => min[i] + (max[i] - min[i]) * t
  const corners: Vec3[] = [],
    edges: Vec3[] = []
  for (const a of [0, 1])
    for (const b of [0, 1]) {
      corners.push([at(0, a), at(1, b), at(2, 0)], [at(0, a), at(1, b), at(2, 1)])
      for (const t of [0, 0.25, 0.5, 0.75, 1])
        edges.push(
          [at(0, t), at(1, a), at(2, b)],
          [at(0, a), at(1, t), at(2, b)],
          [at(0, a), at(1, b), at(2, t)],
        )
    }
  outlines.set(volume, (kept = { corners, edges }))
  return kept
}

/** The distance from a point to a box (0 inside it). */
function distanceTo(p: Vec3, { min, max }: Volume) {
  const d = [0, 1, 2].map((i) => Math.max(min[i] - p[i], 0, p[i] - max[i]))
  return Math.hypot(...d)
}

/** How far along a ray from `p` (a unit `d`) it enters a box, if it does before `reach`. */
function enters(p: Vec3, d: Vec3, { min, max }: Volume, reach: number) {
  let t0 = 0,
    t1 = reach
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < min[i] || p[i] > max[i]) return null
      continue
    }
    let near = (min[i] - p[i]) / d[i],
      far = (max[i] - p[i]) / d[i]
    if (near > far) [near, far] = [far, near]
    if (near > t0) t0 = near
    if (far < t1) t1 = far
    if (t0 > t1) return null
  }
  return t0
}

type Surface = 'wall' | 'ceiling' | 'floor' | 'outside' | 'mirror'
/** Where a ray from `p` (a unit `d`) inside the room meets its shell, and what it meets there. */
function exit(
  { bounds: b, opening, mirror }: Room,
  p: Vec3,
  d: Vec3,
): { reach: number; surface: Surface } {
  const lo = [-b.halfWidth, FLOOR_Y, b.back],
    hi = [b.halfWidth, b.ceiling, b.front]
  let reach = Infinity,
    axis = 0
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) continue
    const t = ((d[i] > 0 ? hi[i] : lo[i]) - p[i]) / d[i]
    if (t < reach) [reach, axis] = [t, i]
  }
  reach = Math.max(0, reach)
  if (axis === 1) return { reach, surface: d[1] > 0 ? 'ceiling' : 'floor' }
  const x = p[0] + d[0] * reach,
    y = p[1] + d[1] * reach
  if (axis === 2 && d[2] > 0 && opening && within(opening, x, y))
    return { reach, surface: 'outside' }
  if (axis === 2 && d[2] < 0 && mirror && within(mirror, x, y)) return { reach, surface: 'mirror' }
  return { reach, surface: 'wall' }
}

/** Sight lines across and up the frame: a quick look, for the search, and a careful one. */
const SIGHT_LINES: Record<AspectClass, { quick: [number, number]; careful: [number, number] }> = {
  wide: { quick: [12, 8], careful: [20, 13] },
  tall: { quick: [8, 10], careful: [12, 16] },
}
/**
 * How much of the frame a blank surface leaves empty: a wall near the lens all of it, a wall far
 * across the room less (it shows the room's depth, a corner), the ceiling most of it, the floor
 * under the equipment a little; a mirror shows the room again, but a picture mostly of it reads
 * as a flat panel.
 */
const wallEmpty = (distance: number) => 1 - 0.6 * Math.min(1, Math.max(0, (distance - 7) / 9))
const CEILING_EMPTY = 0.7
const FLOOR_EMPTY = 0.25
const MIRROR_EMPTY = 0.8
/**
 * How much a piece counts as shown, by how whole it is in the frame: all of it from 97 %, none of
 * it from half; chopped by the frame's edge it counts against the picture, more than it would
 * left out.
 */
const shownCredit = (whole: number) => {
  const shown = Math.min(1, Math.max(0, (whole - 0.5) / 0.47))
  const chopped = Math.min(1, Math.max(0, (0.97 - whole) / 0.3)) * Math.min(1, whole / 0.08)
  return shown - chopped
}

/**
 * How an interior camera's picture is composed, from the room and the equipment in it:
 * - `subject`: the share of the room's equipment the picture shows, each piece by how much it is
 *   the subject (SUBJECT), and by how whole it is in the frame and how little else hides it;
 * - `main`: the same for the room's main piece alone (1 in an empty room), and `mainAcross`, where
 *   its middle lies across the frame (-1 to 1); `clearest`, the same for the piece shown best;
 * - `fill`: the share of the frame the equipment fills;
 * - `empty`: the share that is blank wall (less of it far off), ceiling and a little floor;
 * - `outside`: the share that is the setting, seen through the glazing;
 * - `balance`: where the equipment lies across the frame, on average (-1 to 1);
 * - `crowding`: the most of the frame one piece within NEAR of the lens fills;
 * - `intrusion`: how far into the frame (a share of its width or height) a piece within NEAR
 *   reaches from the edge that cuts it (a rack's bar across the picture);
 * - `cut`: how much of the picture is equipment cut hard by the frame's edge (each piece's share
 *   of the frame, by how much of it the edge cuts off, past a quarter).
 */
export function composition(
  c: Config,
  camera: GalleryCamera,
  aspect: AspectClass,
  scene = interior(c),
  careful = true,
) {
  const view = lens(camera, aspect)
  const { room, volumes, main } = scene
  const n = volumes.length
  // Each piece's outline in the picture: how much of the frame it covers, how whole it is there,
  // and where its middle lies across.
  const framed = new Array<number>(n).fill(0)
  const whole = new Array<number>(n).fill(0)
  const across = new Array<number>(n).fill(0)
  let crowding = 0,
    intrusion = 0,
    cut = 0
  volumes.forEach((volume, i) => {
    const { corners, edges } = outline(volume)
    let seen = corners.map(view.project)
    if (seen.every((p) => p === null)) return
    if (seen.some((p) => p === null)) seen = edges.map(view.project)
    const shape = hull(seen.filter((p): p is [number, number] => p !== null))
    if (shape.length < 3) return
    const inside = clipToFrame(shape)
    const inFrame = area(inside) / 4
    framed[i] = inFrame
    if (inFrame < 0.004) return
    const total = Math.min(area(shape) / 4, 4)
    const off = 1 - inFrame / Math.max(total, inFrame)
    whole[i] = 1 - off
    across[i] = inside.reduce((sum, p) => sum + p[0], 0) / inside.length
    if (off > 0.25) cut += Math.min(inFrame, 0.25) * ((off - 0.25) / 0.75)
    if (distanceTo(camera.position, volume) >= NEAR) return
    crowding = Math.max(crowding, inFrame)
    // Near and cut by the frame: how far into the picture it reaches (a bar from the edge).
    if (off > 0.25) {
      const span = (axis: 0 | 1) =>
        (Math.max(...inside.map((p) => p[axis])) - Math.min(...inside.map((p) => p[axis]))) / 2
      intrusion = Math.max(intrusion, span(0), span(1))
    }
  })
  // Sight lines through the frame: what each meets, the equipment in front of the room's shell,
  // seen through the open frames.
  const [nx, ny] = SIGHT_LINES[aspect][careful ? 'careful' : 'quick']
  const { forward: f, right: r, up, tanH, tanV } = view
  // Only a piece somewhere in the frame can stand in a sight line.
  const seen = volumes.map((_, k) => k).filter((k) => framed[k] > 0)
  const shown = new Array<number>(n).fill(0)
  const near: number[] = [],
    which: number[] = []
  const d: Vec3 = [0, 0, 0]
  let fill = 0,
    lean = 0,
    empty = 0,
    outside = 0
  for (let j = 0; j < ny; j++) {
    const v = (1 - (2 * j + 1) / ny) * tanV
    for (let i = 0; i < nx; i++) {
      const u = -1 + (2 * i + 1) / nx
      for (let k = 0; k < 3; k++) d[k] = f[k] + r[k] * u * tanH + up[k] * v
      const length = Math.hypot(d[0], d[1], d[2])
      for (let k = 0; k < 3; k++) d[k] /= length
      const { reach, surface } = exit(room, camera.position, d)
      // The pieces it meets, nearest first.
      near.length = which.length = 0
      for (const k of seen) {
        const t = enters(camera.position, d, volumes[k], reach)
        if (t === null) continue
        let at = near.length
        while (at > 0 && near[at - 1] > t) at--
        near.splice(at, 0, t)
        which.splice(at, 0, k)
      }
      let through = 1,
        solid = 0
      for (const k of which) {
        const { opacity, bar } = volumes[k]
        shown[k] += through * opacity
        solid = Math.max(solid, bar ? BAR_OPACITY : 1)
        through *= 1 - opacity
      }
      fill += solid
      lean += solid * u
      if (surface === 'outside') outside += through
      else
        empty +=
          through *
          (surface === 'ceiling'
            ? CEILING_EMPTY
            : surface === 'floor'
              ? FLOOR_EMPTY
              : surface === 'mirror'
                ? MIRROR_EMPTY
                : wallEmpty(reach))
    }
  }
  const lines = nx * ny
  // Each piece's credit: how whole it is in the frame, and how much of it shows past what stands
  // in front of it (where it covers enough sight lines to tell).
  let weights = 0,
    subject = 0,
    mainCredit = 1,
    clearest = 0
  volumes.forEach((volume, k) => {
    if (volume.bar || !volume.weight) return
    const expected = framed[k] * lines * volume.opacity
    const unhidden = expected >= 3 ? Math.min(1, shown[k] / expected) : 1
    const credit = shownCredit(whole[k]) * (0.35 + 0.65 * unhidden)
    weights += volume.weight
    subject += volume.weight * credit
    if (k === main) mainCredit = credit
    clearest = Math.max(clearest, credit)
  })
  return {
    subject: weights ? subject / weights : 1,
    main: mainCredit,
    clearest: weights ? clearest : 1,
    mainAcross: main >= 0 ? across[main] : 0,
    fill: fill / lines,
    empty: empty / lines,
    outside: outside / lines,
    balance: fill ? lean / fill : 0,
    crowding,
    intrusion,
    cut,
  }
}
type Composition = ReturnType<typeof composition>

/**
 * The share of the frame the equipment should fill: enough to be the picture's subject, not so
 * much that it crowds the room out.
 */
const FILL = [0.25, 0.55] as const
/** Blank wall and ceiling up to this share of the frame are the room around the equipment. */
const EMPTY_FREE = 0.32
/**
 * The setting through the glazing adds to the picture, up to OUTSIDE_ENOUGH of it; past
 * OUTSIDE_MOST it is a picture of the setting, not the room.
 */
const OUTSIDE_ENOUGH = 0.2
const OUTSIDE_MOST = 0.5
/**
 * A picture of a room with equipment that shows almost none of it (less than ALMOST_BARE of the
 * frame), or no piece of it that reads (whole and in view, READS of its credit), is no picture of
 * the gym: it costs up to BARE more, more than any compromise.
 */
const ALMOST_BARE = 0.08
const READS = 0.6
const BARE = 12

/**
 * What a composition costs: the room's equipment left out of the picture, or cut, or hidden, most;
 * then a frame too empty or too full of it, blank wall and ceiling, something near the lens
 * crowding the picture or reaching into it from the edge, hard cuts, and the equipment all to one
 * side. The setting through the glazing earns a little, short of a picture of it alone. The centre
 * view is of the room's main piece: it counts double there, and is kept off the frame's edges.
 */
function compositionCost(seen: Composition, angle: AngleId, equipped: boolean) {
  return (
    (equipped ? BARE * Math.max(0, 1 - seen.fill / ALMOST_BARE, 1 - seen.clearest / READS) : 0) +
    6 * (1 - seen.subject) +
    (angle === 'centre' ? 4 : 2) * (1 - seen.main) +
    5 * Math.max(0, FILL[0] - seen.fill, seen.fill - FILL[1]) +
    5 * Math.max(0, seen.empty - EMPTY_FREE) -
    1.5 * Math.min(seen.outside, OUTSIDE_ENOUGH) +
    4 * Math.max(0, seen.outside - OUTSIDE_MOST) +
    10 * Math.min(0.25, Math.max(0, seen.crowding - NEAR_FILL)) +
    3 * Math.max(0, seen.intrusion - NEAR_REACH) +
    4 * Math.min(0.5, seen.cut) +
    Math.max(0, Math.abs(seen.balance) - 0.3) +
    (angle === 'centre' ? 4 * Math.max(0, Math.abs(seen.mainAcross) - 0.3) : 0)
  )
}

// --- Interior cameras ------------------------------------------------------------------------

/**
 * Whether a person standing at (x, z) is clear of the equipment in the room: well clear of tall
 * pieces, off the low ones (a bench, a reformer), and anywhere on a mat.
 */
function clear(c: Config, x: number, z: number) {
  return c.items.every((item) => {
    const { h } = catalogItem(item.sku)
    if (h <= UNDERFOOT) return true
    const margin = h > BLOCKING_HEIGHT ? EQUIPMENT_MARGIN : LOW_MARGIN
    const { w, d } = footprint(item)
    return Math.abs(x - item.x) > w / 2 + margin || Math.abs(z - item.z) > d / 2 + margin
  })
}

const DEG = Math.PI / 180
/**
 * Where an interior camera stands and how it looks: its spot on the floor, its heading in plan
 * (radians, from +x toward +z), how far it looks down and how much longer its lens is than the
 * drawn one (degrees), and how far it stands up or down from eye height.
 */
type Stance = {
  x: number
  z: number
  heading: number
  pitch: number
  longer: number
  shift: number
}

/**
 * Where each interior angle may stand, and the way it may look, so the three are views of their
 * own: the entry stands toward the entry's end of the room, on the glazing's side, and looks down
 * the room toward its far end; the centre stands short of either end, on the glazing's side, and
 * looks across the room toward the back wall, at its main piece (`compositionCost`); the back
 * stands toward the back wall, or at the far end, and looks toward the glazing, or back toward the
 * entry.
 */
function suits(angle: AngleId, s: Stance, { room, side }: Interior) {
  const b = room.bounds
  const end = (side * s.x) / b.halfWidth
  const glazing = (s.z - b.back) / (b.front - b.back)
  const along = -side * Math.cos(s.heading),
    across = -Math.sin(s.heading)
  if (angle === 'entry') return end >= 0.3 && glazing >= 0.45 && along >= 0.5
  if (angle === 'centre') return Math.abs(end) <= 0.85 && glazing >= 0.45 && across >= 0.2
  return (glazing <= 0.45 || end <= -0.4) && (across <= -0.2 || along <= -0.5)
}
/**
 * Two interior angles are views of their own when they stand at least SPOT_APART from each other,
 * or, from near the same spot, look at least TURNED apart.
 */
const SPOT_APART = 3
const TURNED = 45 * DEG
const apart = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

/**
 * How close to the glazing an interior camera would rather not stand, and what each foot closer
 * costs: near it, its mullions, rails and the door's pull turn from thin lines in the picture into
 * bands across it. A cramped room may still need the space.
 */
const GLAZING_MARGIN = 1.5
const GLAZING_COST = 0.8
/** How far from the room's main piece the centre view would rather stand, to see it whole. */
const MAIN_DISTANCE = 9

/**
 * Where each interior angle would rather stand, all else equal: the entry at the entry's end of
 * the room, toward the glazing; the back at the far end, by the back wall; the centre toward the
 * glazing, about MAIN_DISTANCE from the room's main piece. Not too near the glazing; and a level
 * look, the drawn lens and eye height, unless the picture is better for leaving them.
 */
function stanceCost(angle: AngleId, s: Stance, { room, volumes, main, side }: Interior) {
  const b = room.bounds
  const end = (side * s.x) / b.halfWidth
  const glazing = (s.z - b.back) / (b.front - b.back)
  let own = GLAZING_COST * Math.max(0, s.z - (b.front - GLAZING_MARGIN))
  if (angle === 'entry') own += 0.25 * (1 - end) + 0.2 * (1 - glazing)
  else if (angle === 'back') own += 0.25 * (1 + end) + 0.2 * glazing
  else {
    own += 0.2 * (1 - glazing)
    if (main >= 0) {
      const { min, max } = volumes[main]
      const away = Math.hypot(s.x - (min[0] + max[0]) / 2, s.z - (min[2] + max[2]) / 2)
      own += 0.12 * Math.abs(away - MAIN_DISTANCE)
    }
  }
  return own + 0.03 * Math.abs(s.pitch - PITCH) + 0.01 * s.longer + 0.2 * Math.abs(s.shift)
}

/** Steps of the careful search, each tried either way, then again at half the step. */
const STEPS: [keyof Stance, number][] = [
  ['x', 0.5],
  ['z', 0.4],
  ['heading', 5 * DEG],
  ['pitch', 3],
  ['longer', 4],
  ['shift', 0.5],
]
/**
 * How many of the quick look's best spots are looked at carefully, each SEED_APART from the others
 * (or looking well away), so the three angles have room to choose.
 */
const SEEDS = 8
const SEED_APART = 3
/**
 * How the three interior angles are chosen together: by how much worse each picture is than the
 * angle's best, squared, so no angle is left a poor picture for the others to have their best; the
 * entry, the first the visitor sees, counting most; and two too alike to be views of their own
 * counting as much as a picture ALIKE worse, a last resort.
 */
const ANGLE_WEIGHT: Record<InteriorAngle, number> = { entry: 1.5, centre: 1, back: 1 }
const ALIKE = 6

type InteriorAngle = 'entry' | 'centre' | 'back'
const INTERIOR_ANGLES: InteriorAngle[] = ['entry', 'centre', 'back']
type Shot = { stance: Stance; cost: number; camera: GalleryCamera }

/**
 * An interior angle's search: the best few spots for its picture, standing in the room at about
 * eye height, inside its walls and clear of the equipment, where the angle may stand and look
 * (`suits`), each composed as a photographer would compose it (`composition`); and a careful look
 * that moves a spot a little at a time (stepping, turning, looking up or down, a longer lens,
 * standing up or down) while the picture improves, keeping away from the other angles. A quick
 * look from a grid of spots over the floor, every way the angle may face, finds the spots, each
 * SEED_APART from the others or looking well away. Where the room leaves the angle nowhere to
 * stand, it may stand where another angle would, then anywhere.
 */
function interiorSearch(c: Config, angle: InteriorAngle, aspect: AspectClass, scene: Interior) {
  const b = scene.room.bounds
  const drawn = INTERIOR_FOV_BY_ASPECT[aspect]
  const top = b.ceiling - WALL_MARGIN
  const xMost = b.halfWidth - WALL_MARGIN,
    zLeast = b.back + WALL_MARGIN,
    zMost = b.front - WALL_MARGIN
  const cameraOf = (s: Stance): GalleryCamera => {
    const pitch = -s.pitch * DEG
    const forward: Vec3 = [
      Math.cos(pitch) * Math.cos(s.heading),
      Math.sin(pitch),
      Math.cos(pitch) * Math.sin(s.heading),
    ]
    const position: Vec3 = [
      Math.max(-xMost, Math.min(xMost, s.x)),
      Math.min(FLOOR_Y + EYE + s.shift, top),
      Math.max(zLeast, Math.min(zMost, s.z)),
    ]
    // Aimed at a point short of the wall it looks at, so its target stays in the room.
    const reach = 0.6 * exit(scene.room, position, forward).reach
    const target = position.map((v, i) => v + forward[i] * reach) as Vec3
    return { position, target, fov: drawn - s.longer }
  }
  const costOf = (s: Stance, careful: boolean) =>
    stanceCost(angle, s, scene) +
    compositionCost(composition(c, cameraOf(s), aspect, scene, careful), angle, scene.main >= 0)
  const shot = (stance: Stance, cost = costOf(stance, true)): Shot => ({
    stance,
    cost,
    camera: cameraOf(stance),
  })
  for (const rules of [2, 1, 0]) {
    const allowed = (s: Stance) =>
      Math.abs(s.x) <= xMost + 1e-9 &&
      s.z >= zLeast - 1e-9 &&
      s.z <= zMost + 1e-9 &&
      s.pitch >= PITCH_RANGE[0] - 1e-9 &&
      s.pitch <= PITCH_RANGE[1] + 1e-9 &&
      s.longer >= -1e-9 &&
      s.longer <= LONGEST + 1e-9 &&
      Math.abs(s.shift) <= EYE_RANGE + 1e-9 &&
      (rules < 1 || clear(c, s.x, s.z)) &&
      (rules < 2 || suits(angle, s, scene))
    // The quick look.
    const columns = Math.max(1, Math.round((2 * xMost) / 1.2))
    const rows = 6
    const looks: { stance: Stance; cost: number }[] = []
    for (let i = 0; i <= columns; i++)
      for (let j = 0; j <= rows; j++)
        for (let k = 0; k < 36; k++) {
          const stance: Stance = {
            x: -xMost + (2 * xMost * i) / columns,
            z: zLeast + ((zMost - zLeast) * j) / rows,
            heading: k * 10 * DEG,
            pitch: PITCH,
            longer: 0,
            shift: 0,
          }
          if (!allowed(stance)) continue
          looks.push({ stance, cost: costOf(stance, false) })
        }
    if (!looks.length) continue
    looks.sort((p, q) => p.cost - q.cost)
    const seeds: Stance[] = []
    for (const { stance } of looks) {
      if (seeds.some((s) => !distinct(s, stance, SEED_APART, 0.5))) continue
      seeds.push(stance)
      if (seeds.length >= SEEDS) break
    }
    return {
      seeds: seeds.map((s) => shot(s)),
      refine(seed: Stance, away: Stance[]) {
        const ok = (s: Stance) => allowed(s) && away.every((a) => ownViews(a, s))
        let stance = seed,
          cost = costOf(seed, true)
        for (const scale of [1, 0.5]) {
          for (let round = 0, moved = true; moved && round < 6; round++) {
            moved = false
            for (const [key, step] of STEPS)
              for (const sign of [1, -1]) {
                const next = { ...stance, [key]: stance[key] + sign * step * scale }
                if (!ok(next)) continue
                const nextCost = costOf(next, true)
                if (nextCost < cost - 1e-9) [stance, cost, moved] = [next, nextCost, true]
              }
          }
        }
        return shot(stance, cost)
      },
    }
  }
  // No spot at all (never so: the last pass keeps no rule but the walls).
  const stance: Stance = { x: 0, z: 0, heading: -Math.PI / 2, pitch: PITCH, longer: 0, shift: 0 }
  return { seeds: [shot(stance, 0)], refine: (s: Stance) => shot(s, 0) }
}

/** Whether two stances stand at least `spot` feet apart, or look at least `turn` radians apart. */
const distinct = (a: Stance, b: Stance, spot: number, turn: number) =>
  Math.hypot(a.x - b.x, a.z - b.z) >= spot - 1e-9 || apart(a.heading, b.heading) >= turn - 1e-9
const ownViews = (a: Stance, b: Stance) => distinct(a, b, SPOT_APART, TURNED)

/**
 * The three interior cameras of a design: of each angle's best few spots (`interiorSearch`), the
 * three that do best together (ANGLE_WEIGHT), so no angle takes the view another needs and the
 * three are views of their own (`ownViews`); then each of them looked at carefully in turn,
 * keeping its own view. Where nothing is ideal each takes the best picture there is.
 */
function interiorCameras(c: Config, aspect: AspectClass): Record<InteriorAngle, GalleryCamera> {
  const scene = interior(c)
  const searches = INTERIOR_ANGLES.map((angle) => interiorSearch(c, angle, aspect, scene))
  const [entry, centre, back] = searches.map(({ seeds }, i) => {
    const least = Math.min(...seeds.map((s) => s.cost))
    const weight = ANGLE_WEIGHT[INTERIOR_ANGLES[i]]
    return seeds.map((s) => ({ ...s, worse: weight * (s.cost - least) ** 2 }))
  })
  const alike = (a: Shot, b: Shot) => (ownViews(a.stance, b.stance) ? 0 : ALIKE ** 2)
  let best: { stances: Stance[]; cost: number } | null = null
  for (const e of entry)
    for (const m of centre)
      for (const k of back) {
        const cost = e.worse + m.worse + k.worse + alike(e, m) + alike(e, k) + alike(m, k)
        if (!best || cost < best.cost - 1e-9)
          best = { stances: [e.stance, m.stance, k.stance], cost }
      }
  const stances = best!.stances
  const cameras = stances.map((stance, i) => {
    // Kept apart from the others it is apart from already.
    const others = stances.filter((o, j) => j !== i && ownViews(o, stance))
    const { stance: refined, camera } = searches[i].refine(stance, others)
    stances[i] = refined
    return camera
  })
  return { entry: cameras[0], centre: cameras[1], back: cameras[2] }
}

// --- Exterior cameras and the setting --------------------------------------------------------

/** Room kept between an exterior camera and each kind of shape in the setting (scenery.ts). */
const CLEARANCE: Record<KeepOutKind, number> = {
  building: 2.5,
  trunk: 1,
  crown: 1,
  post: 1,
  planter: 1,
  planting: 1,
  pot: 1,
  hedge: 1,
  wall: 1,
  shrub: 1,
}
/** Whether a camera at `p` stands in a shape, or too near it; under a tree's crown counts. */
function standsIn(k: KeepOut, p: Vec3) {
  if (k.kind === 'crown' && k.shape === 'cylinder')
    return Math.hypot(p[0] - k.x, p[2] - k.z) < k.radius + CLEARANCE.crown && p[1] < k.top + 2
  return contains(k, p, CLEARANCE[k.kind])
}
/**
 * How far along a way from `from` its ground track enters a box's footprint, grown by `margin`
 * (0 if it starts in it), or null if it never does.
 */
function entering(k: KeepOut, from: Vec3, way: Vec3, margin: number) {
  if (k.shape !== 'box') return null
  // In the box's own frame (scenery.ts turns boxes as parts.ts place() does).
  const cos = Math.cos(k.turn),
    sin = Math.sin(k.turn)
  const dx = from[0] - k.x,
    dz = from[2] - k.z
  const o = [dx * cos - dz * sin, dx * sin + dz * cos]
  const d = [way[0] * cos - way[2] * sin, way[0] * sin + way[2] * cos]
  let t0 = 0,
    t1 = Infinity
  for (const [i, axis] of [
    [0, 0],
    [1, 2],
  ] as const) {
    const lo = k.min[axis] - margin,
      hi = k.max[axis] + margin
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] <= lo || o[i] >= hi) return null
      continue
    }
    let near = (lo - o[i]) / d[i],
      far = (hi - o[i]) / d[i]
    if (near > far) [near, far] = [far, near]
    t0 = Math.max(t0, near)
    t1 = Math.min(t1, far)
    if (t0 >= t1) return null
  }
  return t0
}

/** Low shapes, which hide the build's base from a camera low behind them. */
const LOW = new Set<KeepOutKind>(['planter', 'planting', 'pot', 'hedge', 'wall', 'shrub'])

/**
 * Points over the build's outside an exterior camera should see: a grid over each face of its
 * body, a little in from the edges, each with the way its face looks. The lowest row is what a
 * planter in front would hide.
 */
type Sample = { point: Vec3; normal: Vec3; low: boolean }
function buildSamples(c: Config): Sample[] {
  const x = c.length / 2 - 0.25,
    z = 3.75,
    h = productHeight(c)
  const xs = [-3, -2, -1, 0, 1, 2, 3].map((i) => (i / 3) * x * 0.9)
  const ys = [0.15, 0.5, 0.85].map((f) => f * h)
  const zs = [-0.6, 0, 0.6].map((f) => f * z)
  const out: Sample[] = []
  for (const sign of [-1, 1]) {
    for (const px of xs)
      for (const py of ys)
        out.push({ point: [px, py, sign * z], normal: [0, 0, sign], low: py === ys[0] })
    for (const pz of zs)
      for (const py of ys)
        out.push({ point: [sign * x, py, pz], normal: [sign, 0, 0], low: py === ys[0] })
  }
  for (const px of xs)
    for (const pz of zs) out.push({ point: [px, h, pz], normal: [0, 1, 0], low: false })
  return out
}
const samples = new Map<string, Sample[]>()
const samplesOf = (c: Config) => {
  const key = `${c.family}|${c.length}`
  let kept = samples.get(key)
  if (!kept) samples.set(key, (kept = buildSamples(c)))
  return kept
}

/** A circle around a shape's footprint on the ground: its centre, and its radius. */
const circles = new WeakMap<KeepOut, [number, number, number]>()
function footprintCircle(k: KeepOut): [number, number, number] {
  let circle = circles.get(k)
  if (circle) return circle
  if (k.shape === 'cylinder') circle = [k.x, k.z, k.radius]
  else {
    // The box's middle, turned into place (scenery.ts turns boxes as parts.ts place() does).
    const mx = (k.min[0] + k.max[0]) / 2,
      mz = (k.min[2] + k.max[2]) / 2
    const cos = Math.cos(k.turn),
      sin = Math.sin(k.turn)
    circle = [
      k.x + mx * cos + mz * sin,
      k.z - mx * sin + mz * cos,
      Math.hypot(k.max[0] - k.min[0], k.max[2] - k.min[2]) / 2,
    ]
  }
  circles.set(k, circle)
  return circle
}

/**
 * What the setting hides of the build from a camera at `position`: the share of the build's
 * points the camera faces that it sees through a shape (`occlusion`), and the share of the lowest
 * ones behind a low shape in front (`buried`).
 */
function hiddenFrom(c: Config, position: Vec3, shapes = sceneryKeepOuts(c), most = Infinity) {
  let hidden = 0,
    low = 0,
    buried = 0
  // Only shapes near the way from the camera to the build can stand in it.
  const [px, , pz] = position
  const reach = Math.hypot(c.length / 2, 4, productHeight(c) / 2)
  const along = Math.hypot(px, pz) || 1
  shapes = shapes.filter((k) => {
    const [x, z, r] = footprintCircle(k)
    const t = Math.max(0, Math.min(1, (x * px + z * pz) / (along * along)))
    return Math.hypot(x - px * t, z - pz * t) < r + reach
  })
  const faced = samplesOf(c).filter((s) => dot(s.normal, sub(position, s.point)) > 0)
  const seen = faced.length
  for (const s of faced) {
    if (s.low) low++
    const blocker = shapes.find((k) => crosses(k, position, s.point))
    if (!blocker) continue
    hidden++
    if (s.low && LOW.has(blocker.kind)) buried++
    // More hidden than the caller has any use for: no need to count the rest.
    if (hidden > most * seen) return { occlusion: Infinity, buried: 1 }
  }
  return { occlusion: seen ? hidden / seen : 0, buried: low ? buried / low : 0 }
}

/**
 * How much of an exterior camera's picture the setting crowds in front of the build: the share of
 * a grid of sight lines across the frame that meet a tall shape (a tree's crown hanging over the
 * picture, a lamp post, a building's corner) nearer the lens than the build's near side. Low ones
 * (a garden wall, a hedge, a planter) lie along the bottom of the picture as the ground does; what
 * they hide of the build's base counts instead.
 */
function foreground(c: Config, camera: GalleryCamera, aspect: AspectClass, shapes: KeepOut[]) {
  shapes = shapes.filter((k) => !LOW.has(k.kind))
  const view = lens(camera, aspect)
  const toBuild = Math.hypot(...sub(camera.target, camera.position))
  const depth = Math.max(1, toBuild - Math.hypot(c.length / 2, 4))
  const xs = [-0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9]
  const ys = [-0.9, -0.63, -0.36, -0.09, 0.18, 0.45, 0.72, 0.9]
  let filled = 0
  for (const x of xs)
    for (const y of ys) {
      const way = unit(
        [0, 1, 2].map(
          (i) => view.forward[i] + view.right[i] * x * view.tanH + view.up[i] * y * view.tanV,
        ) as Vec3,
      )
      // As far as the build's near side, measured along the lens's axis.
      const reach = depth / Math.max(0.2, dot(way, view.forward))
      const end = camera.position.map((v, i) => v + way[i] * reach) as Vec3
      // Foliage at its full reach: its lacework edge clutters the picture as much as its core.
      if (shapes.some((k) => crosses(k, camera.position, end, 1))) filled++
    }
  return filled / (xs.length * ys.length)
}

/**
 * What the setting does to an exterior gallery camera, for tests: how much of the build it hides
 * (occlusion, and the base behind low shapes), how much of the picture it fills in front of the
 * build, and the shape the camera stands in, if any.
 */
export function siteCheck(c: Config, camera: GalleryCamera, aspect: AspectClass = 'wide') {
  const shapes = sceneryKeepOuts(c)
  const inside = shapes.find((k) => contains(k, camera.position))
  return {
    ...hiddenFrom(c, camera.position, shapes),
    foreground: foreground(c, camera, aspect, shapes),
    inside: inside?.kind ?? null,
  }
}

/** Room kept between an exterior camera and the scenery's walls. */
const MIN_EXTERIOR_DISTANCE = 16
/**
 * The widest an exterior camera opens, when the scenery is near: up the picture, and across it (a
 * tall stage opens further up than a wide one does).
 */
const MAX_EXTERIOR_FOV = 64
const MAX_EXTERIOR_ACROSS = 78
/**
 * What widening the lens costs, per its share of the drawn one: a wide lens close in stretches the
 * build's near end across the picture, so it is the last resort, short of a building in the way.
 */
const WIDER = 5
/** The steepest an exterior camera looks down, short of straight down. */
const MAX_ELEVATION = (78 * Math.PI) / 180
/**
 * Above this a lifted camera looks down on the roof, which mirrors the sky (and the sun in a
 * still): lifting further costs more, unless the angle is drawn that high (the view from above).
 */
const STEEP = (34 * Math.PI) / 180
/** The most of the build the setting may hide from an exterior camera. */
export const MAX_OCCLUSION = 0.2

/** Lifts (radians) tried, for a view the setting gets in the way of. */
const LIFTS = [0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.44, 0.52]
/**
 * What a lift costs: little for the few degrees that look over a planter, more past them, where a
 * view taken at eye level turns into one looked down on (a swing round a tree is better then).
 */
const liftCost = (lift: number) => 2 * lift + 6 * Math.max(0, lift - 0.15)
/** Swings around the build, up to 35° either way. */
const TURNS = [0, 5, 10, 15, 20, 25, 30, 35]
  .flatMap((d) => (d ? [-d, d] : [d]))
  .map((d) => (d * Math.PI) / 180)
/** Fractions of the framed distance tried, standing further in (with a wider lens). */
const PULLS = [1, 0.85, 0.7, 0.55, 0.4]
/**
 * The setting may fill this much of the picture in front of the build, as a garden would frame
 * it; past that, each tenth more costs as much as a 23° swing.
 */
const FOREGROUND_FREE = 0.3
const FOREGROUND = 12
/** The rear three-quarter view taken from the other rear quarter, when that is clearer. */
const OTHER_QUARTER = 0.6
/**
 * Each exterior angle's direction as drawn (the front three-quarter view's the default one): a
 * camera swung around a tree stays nearer its own than any other's, by this margin, so it never
 * passes for another angle (a rear quarter swung round to the rear).
 */
const DRAWN = new Map(
  GALLERY_ANGLES.filter((a) => a.group === 'exterior').map((a) => [
    a.id,
    unit(a.direction ?? DEFAULT_CAMERA),
  ]),
)
const OWN_MARGIN = (3 * Math.PI) / 180
const between = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))))

/**
 * An exterior camera that sees the whole build, like a product photograph taken on location: from
 * the angle's direction when nothing is in the way, else from the nearest view that is clear, by
 * looking over planters from a little higher, swinging around a tree (up to 35°), standing closer
 * in with a wider lens (in front of a building that closes the view), or, for the rear quarter,
 * from the other rear quarter. Each departure costs, and the cheapest view wins: a camera never
 * stands in a shape of the setting (scenery.ts), never sees more than MAX_OCCLUSION of the build
 * hidden where any view can do better, and a tree in front of the build, or a planter hiding its
 * base, counts against a view far more than a few degrees.
 */
function exteriorCamera(
  c: Config,
  angle: AngleId,
  direction: Vec3,
  aspect: AspectClass,
): GalleryCamera {
  const quarters = angle === 'rear-left'
  const others = [...DRAWN].filter(([id]) => id !== angle).map(([, way]) => way)
  const framed = cameraFraming(c, 'exterior', direction, ASPECT_RATIO[aspect])
  const target = framed.target
  const ray = sub(framed.position, target)
  const distance = Math.hypot(...ray)
  const azimuth = Math.atan2(ray[0], ray[2])
  const elevation = Math.asin(ray[1] / distance)
  const shapes = sceneryKeepOuts(c)
  const buildings = shapes.filter((k) => k.kind === 'building')
  // Every view tried, cheapest first by its departure from the angle as drawn.
  type Try = { other: boolean; lift: number; turn: number; pull: number; cost: number }
  const tries: Try[] = []
  for (const other of quarters ? [false, true] : [false])
    for (const lift of LIFTS)
      for (const turn of TURNS)
        for (const pull of PULLS)
          tries.push({
            other,
            lift,
            turn,
            pull,
            cost: liftCost(lift) + 3 * Math.abs(turn) + (other ? OTHER_QUARTER : 0),
          })
  tries.sort((a, b) => a.cost - b.cost)
  // How far out each way may go: as far as the framing asks, or to the first building in the way.
  const reaches = new Map<string, number>()
  const reachAlong = (way: Vec3, key: string) => {
    let reach = reaches.get(key)
    if (reach !== undefined) return reach
    reach = distance
    for (const k of buildings) {
      const enters = entering(k, target, way, CLEARANCE.building)
      if (enters !== null) reach = Math.min(reach, Math.max(0, enters - 0.5))
    }
    reaches.set(key, reach)
    return reach
  }
  let best: { camera: GalleryCamera; cost: number } | null = null
  for (const { other, lift, turn, pull, cost: departure } of tries) {
    // Nothing further down the list can do better.
    if (best && departure >= best.cost) break
    const up = Math.min(MAX_ELEVATION, elevation + lift)
    if (lift > 0 && up <= elevation) continue
    const around = (other ? -azimuth : azimuth) + turn
    const way: Vec3 = [
      Math.sin(around) * Math.cos(up),
      Math.sin(up),
      Math.cos(around) * Math.cos(up),
    ]
    // Nearer the angle's own direction (or the other rear quarter's) than any other angle's.
    const own: Vec3 = [Math.sin(other ? -azimuth : azimuth), 0, Math.cos(azimuth)]
    const off = between(
      way,
      unit([own[0] * Math.cos(elevation), Math.sin(elevation), own[2] * Math.cos(elevation)]),
    )
    if (others.some((o) => between(way, o) < off + OWN_MARGIN)) continue
    const reach = reachAlong(way, `${other}|${lift}|${turn}`)
    const near = Math.max(MIN_EXTERIOR_DISTANCE, Math.min(reach, distance * pull))
    if (pull < 1 && near >= Math.min(reach, distance)) continue
    const position = target.map((v, i) => v + way[i] * near) as Vec3
    if (position[1] < 2 || shapes.some((k) => standsIn(k, position))) continue
    // The lens widens by as much as the camera came in, so the build still fits, and a little
    // more: close in, its near end looms larger than the framing's sphere around it allows for.
    const closer = distance / near
    const half = Math.tan((EXTERIOR_FOV * Math.PI) / 360) * closer * (1 + 0.1 * (closer - 1))
    const fov = (Math.atan(half) * 360) / Math.PI
    const across =
      (Math.atan(Math.tan((fov * Math.PI) / 360) * ASPECT_RATIO[aspect]) * 360) / Math.PI
    if (fov > MAX_EXTERIOR_FOV + 1e-6 || across > MAX_EXTERIOR_ACROSS + 1e-6) continue
    let cost =
      departure +
      4 * Math.max(0, up - Math.max(elevation, STEEP)) +
      (WIDER * (fov - EXTERIOR_FOV)) / EXTERIOR_FOV
    if (best && cost >= best.cost) continue
    // Only a view hiding less than the best one so far can beat it; past the limit, only a view
    // hiding less than the best does when none is within it.
    const room = best ? (best.cost - cost) / 10 : Infinity
    const most =
      best && best.cost < 100 ? Math.min(room, MAX_OCCLUSION) : Math.max(room - 10, MAX_OCCLUSION)
    const { occlusion, buried } = hiddenFrom(c, position, shapes, most)
    if (occlusion === Infinity) continue
    cost += 10 * occlusion + 3 * buried + (occlusion > MAX_OCCLUSION + 1e-9 ? 100 : 0)
    if (best && cost >= best.cost - 1e-9) continue
    // The setting crowding the picture in front of the build (a crown overhead, a wall across).
    const camera = { position, target, fov }
    const filled = foreground(c, camera, aspect, shapes)
    cost += FOREGROUND * Math.max(0, filled - FOREGROUND_FREE)
    if (!best || cost < best.cost - 1e-9) best = { camera, cost }
    // The angle as drawn, with nothing in the way: nothing can do better.
    if (best.cost === 0) break
  }
  return best?.camera ?? { ...framed, fov: EXTERIOR_FOV }
}

/**
 * Cameras worked out lately, most recently used last: each takes a search (exteriorCamera, and
 * interiorCameras for a room's three).
 */
const cameras = new Map<string, GalleryCamera>()
const interiors = new Map<string, Record<InteriorAngle, GalleryCamera>>()
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
  let camera: GalleryCamera
  if (spec.group === 'interior') {
    // Kept by what moves the room's cameras: the setting and what is outside leave them.
    const key = JSON.stringify([
      aspect,
      config.family,
      config.length,
      config.interiorStyle,
      config.items,
      config.studioDoor,
      config.containerOpening,
      config.openingInfill,
      config.doorsOpen,
      config.mirror,
    ])
    let set = interiors.get(key)
    if (set) interiors.delete(key)
    else set = interiorCameras(config, aspect)
    interiors.set(key, set)
    if (interiors.size > CAMERAS_KEPT) interiors.delete(interiors.keys().next().value!)
    camera = set[angle as InteriorAngle]
  } else {
    // Kept by what moves a camera: the time of day, a finish or a slider's every step leave it.
    const key = JSON.stringify([
      angle,
      aspect,
      spec.direction ? null : hero,
      config.family,
      config.length,
      config.environment,
      config.addons,
    ])
    const kept = cameras.get(key)
    if (kept) cameras.delete(key)
    camera = kept ?? exteriorCamera(config, angle, spec.direction ?? hero, aspect)
    cameras.set(key, camera)
    if (cameras.size > CAMERAS_KEPT) cameras.delete(cameras.keys().next().value!)
  }
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
