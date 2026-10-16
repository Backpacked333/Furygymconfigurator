import {
  FINISHES,
  openingGeometry,
  productHeight,
  studioBays,
  studioDoorBay,
  type Config,
} from '../lib/config'
import {
  box,
  corrugatedPanel,
  cylinder,
  extrude,
  lathe,
  roundedBox,
  roundedRectShape,
  type UVOptions,
} from './geometry'
import { material } from './materials'
import {
  awningSashes,
  glassOverheadDoor,
  hingedDoor,
  pane,
  rollUpShutter,
  slidingDoor,
} from './openings'
import { palette } from './palette'
import { oriented, part, type Part, type V3 } from './parts'

/** Top of the finished floor; equipment stands on it. */
export const FLOOR_Y = 0.96
/**
 * Studio portal (feet): base height, shell wall thickness, outer corner radius, depth, and the
 * width of the front face (proud lip plus recessed bezel) around the glazing.
 */
export const STUDIO = { base: 0.3, wall: 0.36, radius: 1.6, depth: 8, bezel: 0.8, lip: 0.3 }
/** Center plane of the Studio glazing frame. */
const GLAZING_Z = 3.5
/** Container opening: sill and the plane of the infill behind the welded frame. */
const SILL = 0.62
const INFILL_Z = 3.55
const CONTAINER_BACK = -3.62

export const finishColor = (c: Config) => FINISHES.find((f) => f.id === c.finish)!.color

/** Relative luminance of a hex color (0-1), used to pick contrasting frame colors. */
function luminance(hex: string) {
  const v = parseInt(hex.slice(1), 16)
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255
}
/**
 * Window and door frames: matched to dark finishes (bronze frames on an espresso shell), black
 * on light ones, as in Fury's builds.
 */
export function frameMaterial(c: Config) {
  const color = finishColor(c)
  return palette.anodized(luminance(color) > 0.3 ? '#141615' : color)
}

/**
 * Rounded-rectangle frame extruded along Z. Bevels grow an extrusion outward by their size, so the
 * outline is pre-shrunk (and the hole pre-grown) to keep the nominal dimensions exact.
 */
function ring(
  key: string,
  w: number,
  h: number,
  r: number,
  inset: number,
  depth: number,
  bevel = 0,
  uv: UVOptions = {},
) {
  return extrude(
    `ring:${key}:${w}:${h}:${r}:${inset}`,
    () => {
      const shape = roundedRectShape(w - bevel * 2, h - bevel * 2, r - bevel)
      shape.holes.push(
        roundedRectShape(
          w - inset * 2 + bevel * 2,
          h - inset * 2 + bevel * 2,
          Math.max(0.01, r - inset + bevel),
        ),
      )
      return shape
    },
    depth - bevel * 2,
    bevel,
    24,
    uv,
  )
}
function slab(
  key: string,
  w: number,
  h: number,
  r: number,
  depth: number,
  bevel = 0,
  uv: UVOptions = {},
) {
  return extrude(
    `slab:${key}:${w}:${h}:${r}`,
    () => roundedRectShape(w - bevel * 2, h - bevel * 2, r - bevel),
    depth - bevel * 2,
    bevel,
    24,
    uv,
  )
}

/** Hairline shadow gap between cladding panels. */
const seam = () => material({ color: '#0b0c0c', roughness: 0.85 })

// --- Interior finishes ------------------------------------------------------------------

/** Wall and ceiling lining for the chosen interior style (both families). */
function liner(c: Config) {
  switch (c.interiorStyle) {
    case 'timber':
      return palette.cedar()
    case 'birch':
      return palette.ply()
    case 'gallery':
      return palette.paint('#f5f3ef')
    default:
      return palette.paint(c.finish === 'chalk' ? '#f4f1eb' : '#f1eee8')
  }
}
/** Cedar boards run horizontally on walls; the other linings are isotropic. */
const linerUV = (c: Config): UVOptions => (c.interiorStyle === 'timber' ? { swap: true } : {})

/** 4 x 8 ft sheet joints on plywood-lined walls and ceilings. */
function plyJoints(
  width: number,
  wallBottom: number,
  wallTop: number,
  back: number,
  front: number,
  ceiling: number,
): Part[] {
  const m = material({ color: '#3a2f22', roughness: 0.9, interior: true })
  const parts: Part[] = []
  const count = Math.round(width / 4)
  const step = width / count
  for (let i = 1; i < count; i++) {
    const x = -width / 2 + i * step
    parts.push(
      part(
        box(0.025, wallTop - wallBottom, 0.006),
        m,
        [x, (wallTop + wallBottom) / 2, back + 0.003],
        undefined,
        undefined,
        false,
      ),
    )
    parts.push(
      part(
        box(0.025, 0.006, front - back),
        m,
        [x, ceiling - 0.003, (front + back) / 2],
        undefined,
        undefined,
        false,
      ),
    )
  }
  return parts
}

// --- Studio ---------------------------------------------------------------------------------

/**
 * The S-Series shell: a rounded steel portal with a proud front lip over a recessed bezel (the
 * reveal line around the glazing), fastened cladding seams, a closed back, and a shadow plinth.
 */
export function studioShell(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c),
    { base, wall, radius, depth, bezel, lip } = STUDIO
  const shell = palette.shell(finishColor(c))
  const center = base + H / 2
  const lipDepth = 0.32
  const bodyFront = depth / 2 - lipDepth
  const bodyDepth = bodyFront + depth / 2
  const parts: Part[] = [
    // Body: a hair smaller than the lip so the joint between them reads as a line.
    part(ring('portal', L - 0.04, H - 0.04, radius - 0.02, wall, bodyDepth, 0.035), shell, [
      0,
      center,
      -depth / 2 + bodyDepth / 2,
    ]),
    part(ring('lip', L, H, radius, lip, lipDepth, 0.03), shell, [
      0,
      center,
      depth / 2 - lipDepth / 2,
    ]),
    // Recessed bezel stepping in to the glazing.
    part(
      ring(
        'bezel',
        L - lip * 2 + 0.02,
        H - lip * 2 + 0.02,
        radius - lip,
        bezel - lip + 0.01,
        0.3,
        0.02,
      ),
      shell,
      [0, center, depth / 2 - 0.28],
    ),
    // Exterior back skin closing the portal.
    part(slab('back', L - wall * 2 + 0.02, H - wall * 2 + 0.02, radius - wall, 0.12), shell, [
      0,
      center,
      -depth / 2 + 0.1,
    ]),
    // Recessed plinth: the shell reads as floating just above the ground.
    part(box(L - 1.4, base + 0.02, depth - 1.2), palette.powder('#161716', false, 0.85), [
      0,
      base / 2 - 0.01,
      0,
    ]),
  ]
  // Panel seams: across the lip where the corners meet the straights, over the roof, and down
  // the end walls; and the fastener line along the lip.
  const gap = seam()
  const straight = L - radius * 2
  const panels = Math.max(2, Math.round(straight / 5))
  const top = base + H
  for (let i = 0; i <= panels; i++) {
    const x = -straight / 2 + (i * straight) / panels
    for (const y of [top - lip / 2, base + lip / 2])
      parts.push(
        part(
          box(0.014, lip + 0.01, 0.006),
          gap,
          [x, y, depth / 2 + 0.002],
          undefined,
          undefined,
          false,
        ),
      )
    parts.push(
      part(
        box(0.016, 0.006, bodyDepth - 0.1),
        gap,
        [x, top - 0.017, -depth / 2 + bodyDepth / 2],
        undefined,
        undefined,
        false,
      ),
    )
  }
  for (const side of [-1, 1])
    for (const z of [-1.35, 1.35])
      parts.push(
        part(
          box(0.006, H - radius * 2, 0.016),
          gap,
          [side * (L / 2 - 0.017), center, z],
          undefined,
          undefined,
          false,
        ),
      )
  const fastener = lathe(
    'fastener',
    [
      [0, 0],
      [0.034, 0],
      [0.03, 0.01],
      [0.018, 0.016],
      [0, 0.018],
    ],
    12,
  )
  const steel = palette.brushed(false, '#6f7374')
  const pitch = 2.1
  const along = Math.floor(straight / pitch)
  for (let i = 0; i <= along; i++) {
    const x = -((along * pitch) / 2) + i * pitch
    for (const y of [top - lip / 2, base + lip / 2])
      parts.push(part(fastener, steel, [x, y, depth / 2], [Math.PI / 2, 0, 0], undefined, false))
  }
  const rise = H - radius * 2
  const up = Math.max(1, Math.floor(rise / pitch))
  for (let i = 0; i <= up; i++)
    for (const side of [-1, 1])
      parts.push(
        part(
          fastener,
          steel,
          [side * (L / 2 - lip / 2), center - rise / 2 + (i * rise) / up, depth / 2],
          [Math.PI / 2, 0, 0],
          undefined,
          false,
        ),
      )
  return parts
}

/** Lining, floor, back wall, ceiling, trims, and services inside the Studio. */
export function studioInterior(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c),
    { base, wall, radius, bezel } = STUDIO
  const center = base + H / 2
  const innerW = L - wall * 2,
    innerH = H - wall * 2,
    innerR = radius - wall
  const lining = 0.08
  const lined = liner(c),
    uv = linerUV(c)
  const back = -3.78
  const front = 3.6
  const reveal = (innerW - (L - bezel * 2)) / 2
  const parts: Part[] = [
    part(ring('lining', innerW, innerH, innerR, lining, front - back, 0, uv), lined, [
      0,
      center,
      (front + back) / 2,
    ]),
    part(
      slab('backwall', innerW - lining * 2, innerH - lining * 2, innerR - lining, 0.08, 0, uv),
      lined,
      [0, center, back],
    ),
    // Inner return from the lining to the glazing opening.
    part(ring('return', innerW - 0.02, innerH - 0.02, innerR, reveal + 0.01, 0.06, 0, uv), lined, [
      0,
      center,
      front - 0.03,
    ]),
  ]
  parts.push(...floor(c, L - 1.24, back + 0.04, front, FLOOR_Y))
  parts.push(...skirting(L / 2 - 0.62, back + 0.04, front, FLOOR_Y))
  const ceilingTop = base + H - wall - lining
  const ceiling = c.interiorStyle === 'slatted' ? ceilingTop - 0.42 : ceilingTop
  if (c.interiorStyle === 'slatted')
    parts.push(...slatCeiling(L - 2.4, back + 0.04, front - 0.12, ceiling, ceilingTop))
  if (c.interiorStyle === 'birch')
    parts.push(...plyJoints(L - 3.2, FLOOR_Y, ceilingTop - innerR, back + 0.045, front, ceilingTop))
  parts.push(...services(c, back + 0.04, ceiling))
  return parts
}

function floor(c: Config, width: number, back: number, front: number, top: number): Part[] {
  const depth = front - back,
    z = (front + back) / 2
  const finish =
    c.flooring === 'oak'
      ? material({
          set: 'laminate_floor_02',
          roughness: 0.85,
          clearcoat: 0.55,
          clearcoatRoughness: 0.22,
          interior: true,
        })
      : c.flooring === 'stone'
        ? material({
            set: 'granite_tile_04',
            color: '#dadcd5',
            roughness: 0.8,
            clearcoat: 0.25,
            clearcoatRoughness: 0.3,
            interior: true,
          })
        : c.flooring === 'concrete'
          ? palette.polishedConcrete()
          : material({ set: 'rubber_tiles', roughness: 1, interior: true })
  return [
    part(box(width, 0.3, depth), palette.black(), [0, top - 0.17, z], [0, 0, 0], [1, 1, 1], false),
    part(box(width, 0.04, depth), finish, [0, top - 0.02, z], undefined, undefined, false),
  ]
}

/** Recessed black metal skirting: a shadow-gap base along the walls. */
function skirting(halfWidth: number, back: number, front: number, top: number): Part[] {
  const m = palette.powder('#1a1b1a')
  const depth = front - back
  return [
    part(
      box(0.03, 0.2, depth),
      m,
      [-halfWidth, top + 0.1, (front + back) / 2],
      [0, 0, 0],
      [1, 1, 1],
      false,
    ),
    part(
      box(0.03, 0.2, depth),
      m,
      [halfWidth, top + 0.1, (front + back) / 2],
      [0, 0, 0],
      [1, 1, 1],
      false,
    ),
    part(
      box(halfWidth * 2, 0.2, 0.03),
      m,
      [0, top + 0.1, back + 0.02],
      [0, 0, 0],
      [1, 1, 1],
      false,
    ),
  ]
}

/** Solid oak slats on black acoustic felt, running front to back. */
function slatCeiling(width: number, back: number, front: number, underside: number, top: number) {
  const parts: Part[] = []
  const spacing = 0.24
  const count = Math.floor(width / spacing) + 1
  const start = -((count - 1) * spacing) / 2
  const depth = front - back,
    z = (front + back) / 2
  const slat = roundedBox(0.12, 0.1, depth, 0.012, 1, { swap: true })
  const oak = palette.oakOiled()
  for (let i = 0; i < count; i++)
    parts.push(
      part(slat, oak, [start + i * spacing, underside + 0.05, z], undefined, undefined, false),
    )
  parts.push(
    part(
      box(width + 0.3, 0.03, depth),
      material({ color: '#0e0f0f', roughness: 1, interior: true }),
      [0, underside + 0.17, z],
    ),
  )
  // Plenum closure above the felt.
  parts.push(
    part(
      box(width + 0.3, top - underside - 0.18, depth),
      palette.black(),
      [0, (top + underside + 0.18) / 2, z],
      undefined,
      undefined,
      false,
    ),
  )
  return parts
}

/** Wall-mounted mini-split, room controller, and duplex outlets. */
function services(c: Config, backFace: number, ceiling: number): Part[] {
  const L = c.length
  const white = palette.plastic('#eeefec', 0.35)
  const dark = palette.plastic('#1b1d1c', 0.3)
  const unitX = L * 0.29
  const parts: Part[] = [
    part(roundedBox(2.65, 0.92, 0.7, 0.16, 3), white, [unitX, ceiling - 1.05, backFace + 0.36]),
    part(box(2.3, 0.1, 0.06), dark, [unitX, ceiling - 1.44, backFace + 0.66], [0.5, 0, 0]),
    part(box(0.14, 0.03, 0.01), palette.emitter('#7fd3ff', 1.2), [
      unitX + 1.05,
      ceiling - 1.2,
      backFace + 0.715,
    ]),
    // Room controller: glass touch panel with a dim status UI.
    part(roundedBox(0.4, 0.62, 0.05, 0.02, 2), palette.screen(), [
      L / 2 - 1.5,
      4.55,
      backFace + 0.03,
    ]),
    part(box(0.26, 0.05, 0.005), palette.emitter('#ffd7a8', 0.9), [
      L / 2 - 1.5,
      4.68,
      backFace + 0.058,
    ]),
    part(box(0.18, 0.03, 0.005), palette.emitter('#ffffff', 0.5), [
      L / 2 - 1.5,
      4.56,
      backFace + 0.058,
    ]),
    // Duplex outlets near the floor.
    ...[-L * 0.38, L * 0.12].flatMap((x) => [
      part(roundedBox(0.24, 0.38, 0.03, 0.01, 1), white, [x, FLOOR_Y + 1.1, backFace + 0.015]),
      part(box(0.1, 0.04, 0.01), dark, [x, FLOOR_Y + 1.15, backFace + 0.032]),
      part(box(0.1, 0.04, 0.01), dark, [x, FLOOR_Y + 1.05, backFace + 0.032]),
    ]),
  ]
  return parts
}

/**
 * Glazing set in the bezel opening: a black perimeter frame, mullions dividing equal bays (five on
 * 20 feet, eleven on 40), glass that follows the portal radius in the end bays, and a hinged or
 * sliding door.
 */
export function studioGlazing(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c),
    { base, radius, bezel } = STUDIO
  const center = base + H / 2
  const ow = L - bezel * 2,
    oh = H - bezel * 2,
    orr = radius - bezel
  const fw = 0.16
  const frame = frameMaterial(c)
  const glass = palette.glass()
  const parts: Part[] = [
    part(ring('glazing-frame', ow + 0.02, oh + 0.02, orr + 0.01, fw + 0.01, 0.3, 0.01), frame, [
      0,
      center,
      GLAZING_Z,
    ]),
  ]
  const { span, count, width } = studioBays(L)
  const top = center + oh / 2 - fw,
    bottom = center - oh / 2 + fw
  const r = orr - fw
  const door = studioDoorBay(c)
  for (let i = 1; i < count; i++)
    parts.push(part(box(0.14, oh - fw * 2, 0.3), frame, [-span / 2 + i * width, center, GLAZING_Z]))
  for (let i = 0; i < count; i++) {
    if (i === door) continue
    const x0 = -span / 2 + i * width + (i === 0 ? 0 : 0.07)
    const x1 = -span / 2 + (i + 1) * width - (i === count - 1 ? 0 : 0.07)
    const first = i === 0,
      last = i === count - 1
    parts.push(
      part(
        pane(x1 - x0 + 0.04, top - bottom + 0.04, r, { tl: first, bl: first, tr: last, br: last }),
        glass,
        [(x0 + x1) / 2, center, GLAZING_Z + 0.02],
        undefined,
        undefined,
        false,
      ),
    )
  }
  // Door bay: the leaf below a transom bar and fixed transom light.
  const x0 = -span / 2 + door * width + 0.07,
    x1 = x0 + width - 0.14
  const doorHeight = Math.min(7.7, top - bottom - 0.5)
  const transom = bottom + doorHeight
  parts.push(part(box(x1 - x0, 0.14, 0.3), frame, [(x0 + x1) / 2, transom + 0.07, GLAZING_Z]))
  parts.push(
    part(
      box(x1 - x0 + 0.04, top - transom - 0.1, 0.025),
      glass,
      [(x0 + x1) / 2, (top + transom + 0.14) / 2, GLAZING_Z + 0.02],
      undefined,
      undefined,
      false,
    ),
  )
  const doorSpec = { x0, x1, bottom, height: doorHeight, z: GLAZING_Z, open: c.doorsOpen, frame }
  parts.push(...(c.studioDoor === 'sliding' ? slidingDoor(doorSpec) : hingedDoor(doorSpec)))
  return parts
}

// --- Container ------------------------------------------------------------------------------

/** Clear head of the glass overhead door, low enough for its raised sections to fit indoors. */
const overheadHead = (H: number) =>
  Math.min(H - 1.9, SILL + INFILL_Z - 0.2 - (CONTAINER_BACK + 0.12))

/** A painted ISO shipping container: corrugated walls, rails, castings, and cargo doors. */
export function containerShell(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c)
  const paint = palette.shell(finishColor(c))
  const trim = c.integratedFinish ? paint : palette.shell('#7f857c')
  const dark = palette.powder('#121313', false, 0.9)
  const parts: Part[] = []
  const wallBottom = 0.5,
    wallHeight = H - 0.9
  const opening = openingGeometry(c)
  const left = opening.center - opening.width / 2,
    right = opening.center + opening.width / 2

  // Corner posts, castings with apertures, and the perimeter rails.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * (L / 2 - 0.2),
        z = sz * (4 - 0.2)
      parts.push(part(box(0.4, H - 0.7, 0.4), paint, [x, H / 2, z]))
      for (const y of [0.19, H - 0.19]) {
        parts.push(
          part(roundedBox(0.58, 0.38, 0.53, 0.02, 1), paint, [
            sx * (L / 2 - 0.29),
            y,
            sz * (4 - 0.265),
          ]),
        )
        parts.push(
          part(
            roundedBox(0.3, 0.16, 0.02, 0.06, 2),
            dark,
            [sx * (L / 2 - 0.29), y, sz * 4.004],
            undefined,
            undefined,
            false,
          ),
        )
        parts.push(
          part(
            roundedBox(0.02, 0.16, 0.24, 0.06, 2),
            dark,
            [sx * (L / 2 + 0.004), y, sz * (4 - 0.265)],
            undefined,
            undefined,
            false,
          ),
        )
      }
    }
  for (const sz of [-1, 1]) {
    parts.push(part(box(L - 1.16, 0.5, 0.2), paint, [0, 0.25, sz * 3.9]))
    parts.push(part(box(L - 1.16, 0.38, 0.24), paint, [0, H - 0.19, sz * 3.88]))
  }
  for (const sx of [-1, 1]) {
    parts.push(part(box(0.24, 0.5, 8 - 1.06), paint, [sx * (L / 2 - 0.12), 0.25, 0]))
    parts.push(part(box(0.24, 0.42, 8 - 1.06), paint, [sx * (L / 2 - 0.12), H - 0.21, 0]))
  }
  // Corrugated roof sheet, ribs running across the width, recessed between the top rails.
  parts.push(
    oriented(
      corrugatedPanel(L - 0.8, 7.56, 0.92, 0.07),
      paint,
      [
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
      ],
      [-L / 2 + 0.4, H - 0.03, 3.78],
    ),
  )
  // Forklift pockets on 20-foot units.
  if (L === 20)
    for (const x of [-3.4, 3.4])
      for (const sz of [-1, 1])
        parts.push(
          part(box(1.15, 0.34, 0.05), dark, [x, 0.22, sz * 3.985], undefined, undefined, false),
        )

  // Corrugated side walls; the front wall is cut around the chosen opening.
  const panel = (from: number, to: number, side: 1 | -1) => {
    const length = to - from
    if (length < 0.2) return
    const g = corrugatedPanel(length, wallHeight)
    if (side === 1)
      parts.push(
        oriented(
          g,
          paint,
          [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          [from, wallBottom, 3.99],
        ),
      )
    else
      parts.push(
        oriented(
          g,
          paint,
          [
            [-1, 0, 0],
            [0, 1, 0],
            [0, 0, -1],
          ],
          [to, wallBottom, -3.99],
        ),
      )
  }
  panel(-L / 2 + 0.4, left - 0.17, 1)
  panel(right + 0.17, L / 2 - 0.4, 1)
  panel(-L / 2 + 0.4, L / 2 - 0.4, -1)
  // Blind end wall.
  parts.push(
    oriented(
      corrugatedPanel(7.2, wallHeight, 1.1, 0.13),
      paint,
      [
        [0, 0, 1],
        [0, 1, 0],
        [-1, 0, 0],
      ],
      [-L / 2 + 0.01, wallBottom, -3.6],
    ),
  )
  parts.push(...cargoDoors(L, H, paint, dark))

  // Welded opening frame.
  const head = H - 0.9
  parts.push(part(box(right - left + 0.34, 0.34, 0.34), trim, [opening.center, head + 0.08, 3.83]))
  for (const x of [left - 0.08, right + 0.08])
    parts.push(part(box(0.34, head - 0.5, 0.34), trim, [x, (head + 0.5) / 2, 3.83]))
  parts.push(part(box(right - left, 0.12, 0.42), trim, [opening.center, 0.56, 3.79]))
  parts.push(...containerInfill(c, opening.center, right - left, head, trim))
  return parts
}

/** The chosen door or glazing inside the container opening. */
function containerInfill(
  c: Config,
  center: number,
  width: number,
  head: number,
  trim: ReturnType<typeof palette.shell>,
): Part[] {
  const H = productHeight(c)
  const open = c.doorsOpen
  if (c.containerOpening === 'roll-up')
    return rollUpShutter({ center, head, sill: SILL, open, hood: trim })
  const frame = frameMaterial(c)
  if (c.openingInfill === 'glass-overhead') {
    const doorHead = overheadHead(H)
    return [
      // Header panel above the lowered door head, flush with the frame.
      part(box(width, head - doorHead - 0.08, 0.1), trim, [
        center,
        (head + doorHead) / 2 - 0.04,
        3.9,
      ]),
      ...glassOverheadDoor({ center, width, sill: SILL, head: doorHead, z: INFILL_Z, open, frame }),
    ]
  }
  if (c.openingInfill === 'awning')
    return awningSashes({ center, width, sill: SILL, head: head - 0.1, z: 3.78, open, frame })
  return []
}

/** Iconic container end: two leaves with horizontal pressings, four locking bars, cam keepers. */
function cargoDoors(
  L: number,
  H: number,
  paint: ReturnType<typeof palette.shell>,
  dark: ReturnType<typeof palette.powder>,
) {
  const parts: Part[] = []
  // Leaves sit recessed inside the corner-casting plane, as on real containers.
  const x = L / 2 - 0.18
  const bottom = 0.5,
    top = H - 0.42
  const leafW = 3.55,
    leafH = top - bottom
  const zinc = palette.zinc()
  for (const side of [-1, 1]) {
    const zc = side * (leafW / 2 + 0.02)
    // Pressed panel: corrugation profile runs vertically, ribs horizontal.
    parts.push(
      oriented(
        corrugatedPanel(leafH - 0.5, leafW - 0.4, 1.3, 0.09),
        paint,
        [
          [0, 1, 0],
          [0, 0, 1],
          [1, 0, 0],
        ],
        [x - 0.06, bottom + 0.25, zc - (leafW - 0.4) / 2],
      ),
    )
    // Leaf frame.
    parts.push(part(box(0.12, 0.25, leafW), paint, [x, bottom + 0.13, zc]))
    parts.push(part(box(0.12, 0.25, leafW), paint, [x, top - 0.13, zc]))
    parts.push(
      part(box(0.12, leafH, 0.2), paint, [x, (top + bottom) / 2, zc - side * (leafW / 2 - 0.1)]),
    )
    parts.push(
      part(box(0.12, leafH, 0.2), paint, [x, (top + bottom) / 2, zc + side * (leafW / 2 - 0.1)]),
    )
    // Hinges on the outer edges.
    for (const y of [1.2, 3.6, 6, 8.2])
      parts.push(part(cylinder(0.07, 0.07, 0.42, 16), paint, [x + 0.08, y, side * 3.72]))
    // Locking bars with guides, cam keepers, and handles.
    for (const f of [0.3, 0.72]) {
      const z = zc + side * (f - 0.5) * leafW
      parts.push(
        part(cylinder(0.045, 0.045, leafH + 0.2, 16), zinc, [x + 0.13, (top + bottom) / 2, z]),
      )
      for (const y of [bottom + 0.15, top - 0.15])
        parts.push(part(roundedBox(0.16, 0.26, 0.2, 0.03, 1), dark, [x + 0.1, y, z]))
      for (const y of [2.2, 5, 7.6])
        parts.push(part(roundedBox(0.1, 0.12, 0.2, 0.02, 1), zinc, [x + 0.1, y, z]))
      parts.push(
        part(
          roundedBox(0.06, 0.11, 1.05, 0.02, 1),
          zinc,
          [x + 0.175, 3.5, z - side * 0.45],
          [0.12 * side, 0, 0],
        ),
      )
    }
  }
  return parts
}

/** Insulated, finished container interior: lined walls, floor build-up, and ceiling. */
export function containerInterior(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c)
  const lined = liner(c),
    uv = linerUV(c)
  const opening = openingGeometry(c)
  const left = opening.center - opening.width / 2,
    right = opening.center + opening.width / 2
  const ceiling = H - 0.72
  const back = CONTAINER_BACK
  const front = 3.6
  const wallH = ceiling - 0.6
  const head = H - 0.9
  const header = c.openingInfill === 'glass-overhead' ? overheadHead(H) : head - 0.5
  const parts: Part[] = [
    part(box(L - 0.9, wallH, 0.12, uv), lined, [0, 0.6 + wallH / 2, back - 0.06]),
    part(box(0.12, wallH, front - back, uv), lined, [
      -L / 2 + 0.5,
      0.6 + wallH / 2,
      (front + back) / 2,
    ]),
    part(box(0.12, wallH, front - back, uv), lined, [
      L / 2 - 0.5,
      0.6 + wallH / 2,
      (front + back) / 2,
    ]),
    part(box(L - 0.9, 0.12, front - back, uv), lined, [0, ceiling + 0.06, (front + back) / 2]),
  ]
  const frontPanel = (from: number, to: number) => {
    if (to - from > 0.1)
      parts.push(
        part(box(to - from, wallH, 0.12, uv), lined, [
          (from + to) / 2,
          0.6 + wallH / 2,
          front + 0.06,
        ]),
      )
  }
  frontPanel(-L / 2 + 0.44, left - 0.25)
  frontPanel(right + 0.25, L / 2 - 0.44)
  parts.push(
    part(box(right - left + 0.5, ceiling - header, 0.12, uv), lined, [
      opening.center,
      (ceiling + header) / 2,
      front + 0.06,
    ]),
  )
  parts.push(...floor(c, L - 1.24, back, front, FLOOR_Y))
  parts.push(...skirting(L / 2 - 0.62, back, front, FLOOR_Y))
  if (c.interiorStyle === 'slatted')
    parts.push(...slatCeiling(L - 1.6, back, front - 0.2, ceiling - 0.38, ceiling))
  if (c.interiorStyle === 'birch')
    parts.push(...plyJoints(L - 1.2, 0.6, ceiling, back + 0.003, front, ceiling))
  parts.push(...services(c, back, c.interiorStyle === 'slatted' ? ceiling - 0.38 : ceiling))
  return parts
}

/** Interior geometry the lights and probe need for either family. */
export function interiorBounds(c: Config) {
  const H = productHeight(c)
  const slatted = c.interiorStyle === 'slatted'
  if (c.family === 'studio') {
    const top = STUDIO.base + H - STUDIO.wall - 0.08
    return {
      ceiling: slatted ? top - 0.42 : top,
      back: -3.74,
      front: 3.62,
      halfWidth: c.length / 2 - 0.62,
    }
  }
  return {
    ceiling: slatted ? H - 1.1 : H - 0.72,
    back: CONTAINER_BACK,
    front: 3.6,
    halfWidth: c.length / 2 - 0.62,
  }
}

export type { V3 }
