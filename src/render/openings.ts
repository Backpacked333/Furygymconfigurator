import { Shape, type Material } from 'three'
import { box, cylinder, extrude, roundedBox, tube } from './geometry'
import { material } from './materials'
import { palette } from './palette'
import { part, place, rod, type Part, type V3 } from './parts'

/**
 * Operable glazing for both families: Studio doors in the portal glazing, and the Container's
 * glass overhead door, top-hung awning sashes, and roll-up shutter. Builders take explicit
 * dimensions in feet so they stay independent of the shell modules that place them.
 */

const AXIS_X: V3 = [0, 0, Math.PI / 2]

/** A rectangle whose chosen corners follow the portal radius (end bays of the Studio glazing). */
export function bayShape(
  w: number,
  h: number,
  r: number,
  corners: { tl?: boolean; tr?: boolean; bl?: boolean; br?: boolean },
) {
  const s = new Shape()
  const x0 = -w / 2,
    x1 = w / 2,
    y0 = -h / 2,
    y1 = h / 2
  const rr = Math.min(r, w / 2, h / 2)
  s.moveTo(x0 + (corners.bl ? rr : 0), y0)
  s.lineTo(x1 - (corners.br ? rr : 0), y0)
  if (corners.br) s.quadraticCurveTo(x1, y0, x1, y0 + rr)
  s.lineTo(x1, y1 - (corners.tr ? rr : 0))
  if (corners.tr) s.quadraticCurveTo(x1, y1, x1 - rr, y1)
  s.lineTo(x0 + (corners.tl ? rr : 0), y1)
  if (corners.tl) s.quadraticCurveTo(x0, y1, x0, y1 - rr)
  s.lineTo(x0, y0 + (corners.bl ? rr : 0))
  if (corners.bl) s.quadraticCurveTo(x0, y0, x0 + rr, y0)
  return s
}

/** One glass pane, optionally with portal-following corners. */
export function pane(
  w: number,
  h: number,
  r = 0,
  corners: { tl?: boolean; tr?: boolean; bl?: boolean; br?: boolean } = {},
) {
  const key = `${w}:${h}:${r}:${corners.tl}:${corners.tr}:${corners.bl}:${corners.br}`
  return extrude(`pane:${key}`, () => bayShape(w, h, r, corners), 0.025, 0, 16)
}

/** A framed glass leaf in its own plane: x ∈ [-w, 0] (hinge or leading edge at 0), y ∈ [0, h]. */
function leaf(w: number, h: number, frame: Material, stile = 0.2, depth = 0.18): Part[] {
  const glass = palette.glass()
  return [
    part(box(stile, h, depth), frame, [-stile / 2, h / 2, 0]),
    part(box(stile, h, depth), frame, [-w + stile / 2, h / 2, 0]),
    part(box(w - stile * 2, 0.32, depth), frame, [-w / 2, 0.16, 0]),
    part(box(w - stile * 2, stile, depth), frame, [-w / 2, h - stile / 2, 0]),
    part(
      box(w - stile * 2 + 0.04, h - 0.32 - stile + 0.04, 0.025),
      glass,
      [-w / 2, (0.32 + h - stile) / 2, 0],
      undefined,
      undefined,
      false,
    ),
  ]
}

/** Long vertical pull with standoffs on both faces. */
function pull(x: number, y: number, depth: number, length = 2.4): Part[] {
  const steel = palette.brushed(false)
  const parts: Part[] = []
  for (const side of [-1, 1]) {
    parts.push(part(cylinder(0.035, 0.035, length, 20), steel, [x, y, side * (depth / 2 + 0.17)]))
    for (const dy of [-length / 2 + 0.25, length / 2 - 0.25])
      parts.push(
        part(
          cylinder(0.02, 0.02, 0.18, 12),
          steel,
          [x, y + dy, side * (depth / 2 + 0.08)],
          [Math.PI / 2, 0, 0],
        ),
      )
  }
  return parts
}

/**
 * Hinged Studio door in a bay of width `w` between mullions, with a transom bar above. Hinged on
 * the bay's right edge and swinging outward (+z) when open.
 */
export function hingedDoor(opts: {
  x0: number
  x1: number
  bottom: number
  height: number
  z: number
  open: boolean
  frame: Material
}): Part[] {
  const { x0, x1, bottom, height, z, open, frame } = opts
  const w = x1 - x0
  const body = [...leaf(w, height, frame, 0.22, 0.2), ...pull(-w + 0.36, 4.25 - bottom, 0.2)]
  return place(body, [x1, bottom, z], [0, open ? 1.2 : 0, 0])
}

/**
 * Sliding Studio door: the leaf runs in an outer track across the bay and, when open, slides in
 * front of the neighboring fixed pane.
 */
export function slidingDoor(opts: {
  x0: number
  x1: number
  bottom: number
  height: number
  z: number
  open: boolean
  frame: Material
}): Part[] {
  const { x0, x1, bottom, height, z, open, frame } = opts
  const w = x1 - x0 + 0.14
  const travel = open ? -(x1 - x0) * 0.9 : 0
  const body = [...leaf(w, height, frame, 0.2, 0.16), ...pull(-w + 0.3, 4.25 - bottom, 0.16, 2)]
  return [
    ...place(body, [x1 + 0.07 + travel, bottom, z + 0.2]),
    // Top track spanning the door bay and its neighbor, and a slim threshold rail.
    part(box((x1 - x0) * 2 + 0.3, 0.18, 0.14), frame, [x0, bottom + height + 0.09, z + 0.2]),
    part(box((x1 - x0) * 2 + 0.3, 0.04, 0.14), frame, [x0, bottom + 0.02, z + 0.2]),
  ]
}

/** One horizontal section of a full-view door: aluminum rails and stiles around glass lites. */
function overheadSection(width: number, height: number, columns: number, frame: Material) {
  const glass = palette.glass()
  const parts: Part[] = [
    part(box(width, 0.17, 0.14), frame, [0, -height / 2 + 0.085, 0]),
    part(box(width, 0.17, 0.14), frame, [0, height / 2 - 0.085, 0]),
  ]
  const col = width / columns
  for (let i = 0; i <= columns; i++)
    parts.push(part(box(0.15, height - 0.02, 0.14), frame, [-width / 2 + i * col, 0, 0]))
  parts.push(
    part(box(width - 0.1, height - 0.3, 0.02), glass, [0, 0, 0.01], undefined, undefined, false),
  )
  return parts
}

/**
 * Full-view glass overhead (sectional) door. Closed, four sections fill the opening; open, they
 * lie horizontally on tracks under the ceiling. Vertical and horizontal tracks are always shown.
 */
export function glassOverheadDoor(opts: {
  center: number
  width: number
  sill: number
  head: number
  z: number
  open: boolean
  frame: Material
}): Part[] {
  const { center, width, sill, head, z, open, frame } = opts
  const sections = 4
  const sh = (head - sill) / sections
  const columns = Math.max(2, Math.round(width / 4.6))
  const section = overheadSection(width - 0.1, sh, columns, frame)
  const track = palette.brushed(true, '#b9bcbd')
  const trackY = head + 0.32
  const parts: Part[] = []
  for (let k = 0; k < sections; k++) {
    if (open)
      parts.push(
        ...place(section, [center, trackY, z - 0.32 - sh * (k + 0.5)], [-Math.PI / 2, 0, 0]),
      )
    else parts.push(...place(section, [center, sill + sh * (k + 0.5), z]))
  }
  // Bottom weather seal.
  if (!open)
    parts.push(
      part(box(width - 0.1, 0.06, 0.16), palette.rubber('#141515'), [center, sill + 0.03, z]),
    )
  for (const side of [-1, 1]) {
    const x = center + side * (width / 2 + 0.02)
    parts.push(part(box(0.09, head - sill + 0.15, 0.16), track, [x, (head + sill) / 2, z - 0.16]))
    parts.push(
      part(box(0.09, 0.14, sh * sections + 0.2), track, [x, trackY, z - 0.4 - (sh * sections) / 2]),
    )
    parts.push(
      part(
        tube(
          `overhead-radius:${side}`,
          [
            [0, head - 0.05, -0.16],
            [0, head + 0.2, -0.22],
            [0, trackY, -0.42],
          ],
          0.05,
          6,
        ),
        track,
        [x, 0, z],
      ),
    )
  }
  // Torsion spring shaft above the opening and a jackshaft opener at one end.
  parts.push(
    part(cylinder(0.05, 0.05, width + 0.2, 12), track, [center, head + 0.45, z - 0.25], AXIS_X),
  )
  parts.push(
    part(roundedBox(0.45, 0.55, 0.4, 0.06, 2), palette.powder('#1d1f1e'), [
      center + width / 2 - 0.35,
      head + 0.1,
      z - 0.45,
    ]),
  )
  return parts
}

/**
 * Top-hung awning sashes across an opening, with fixed mullions between them and a pair of gas
 * struts per sash. Open sashes swing outward about their head hinge.
 */
export function awningSashes(opts: {
  center: number
  width: number
  sill: number
  head: number
  z: number
  open: boolean
  frame: Material
}): Part[] {
  const { center, width, sill, head, z, open, frame } = opts
  const glass = palette.glass()
  const count = Math.max(2, Math.round(width / 4.2))
  const sw = width / count
  const sh = head - sill - 0.04
  const angle = open ? -1.08 : 0
  const strut = palette.brushed(false, '#c9cccd')
  const parts: Part[] = []
  for (let i = 0; i < count; i++) {
    const x = center - width / 2 + sw * (i + 0.5)
    const w = sw - 0.16
    const sash: Part[] = [
      part(box(w, 0.17, 0.17), frame, [0, -0.085, 0]),
      part(box(w, 0.2, 0.17), frame, [0, -sh + 0.1, 0]),
      part(box(0.17, sh, 0.17), frame, [-w / 2 + 0.085, -sh / 2, 0]),
      part(box(0.17, sh, 0.17), frame, [w / 2 - 0.085, -sh / 2, 0]),
      part(box(w - 0.3, 0.12, 0.15), frame, [0, -sh * 0.46, 0]),
      part(
        box(w - 0.3, sh - 0.4, 0.025),
        glass,
        [0, -sh / 2 - 0.02, 0],
        undefined,
        undefined,
        false,
      ),
    ]
    parts.push(...place(sash, [x, head, z], [angle, 0, 0]))
    // Hinge leaf along the head.
    parts.push(part(cylinder(0.035, 0.035, w - 0.4, 12), strut, [x, head - 0.02, z + 0.1], AXIS_X))
    if (open)
      for (const side of [-1, 1]) {
        const sx = x + side * (w / 2 - 0.12)
        const along = 2.6
        const tip: V3 = [sx, head - Math.cos(angle) * along, z + 0.08 - Math.sin(angle) * along]
        const base: V3 = [sx, head - 2.3, z + 0.06]
        const mid: V3 = [
          base[0],
          base[1] + (tip[1] - base[1]) * 0.55,
          base[2] + (tip[2] - base[2]) * 0.55,
        ]
        parts.push(rod(base, mid, 0.045, palette.powder('#1d1f1e'), 10))
        parts.push(rod(mid, tip, 0.02, strut, 8))
      }
  }
  // Fixed mullions between the sashes and at the jambs.
  for (let i = 0; i <= count; i++)
    parts.push(
      part(box(0.16, head - sill, 0.22), frame, [
        center - width / 2 + i * sw,
        (head + sill) / 2,
        z - 0.05,
      ]),
    )
  parts.push(part(box(width + 0.16, 0.14, 0.24), frame, [center, sill + 0.07, z - 0.05]))
  return parts
}

/** The 10-foot roll-up shutter, coiled in its hood when open or lowered to the sill when closed. */
export function rollUpShutter(opts: {
  center: number
  head: number
  sill: number
  open: boolean
  hood: Material
}): Part[] {
  const { center, head, sill, open, hood } = opts
  const shutter = material({
    set: 'painted_metal_shutter',
    color: '#c9ccc6',
    roughness: 0.9,
    interior: true,
  })
  const aluminium = palette.anodized('#8a8f8c', true)
  const drop = open ? 1.35 : head - 0.95 - sill
  const bottom = head - 0.78 - drop
  return [
    part(roundedBox(10.5, 0.85, 0.95, 0.06, 2), hood, [center, head - 0.45, 3.4]),
    part(
      box(10, drop, 0.06),
      shutter,
      [center, head - 0.78 - drop / 2, 3.62],
      undefined,
      undefined,
      false,
    ),
    part(box(10.05, 0.12, 0.14), aluminium, [center, bottom, 3.62]),
    part(box(0.18, head - 1.2, 0.22), aluminium, [center - 5.08, (head - 0.4) / 2, 3.66]),
    part(box(0.18, head - 1.2, 0.22), aluminium, [center + 5.08, (head - 0.4) / 2, 3.66]),
    ...(open
      ? []
      : [part(roundedBox(0.5, 0.08, 0.12, 0.03, 1), aluminium, [center, bottom + 0.3, 3.7])]),
  ]
}
