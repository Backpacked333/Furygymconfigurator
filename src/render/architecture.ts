import { Path } from 'three'
import { FINISHES, productHeight, type Config } from '../lib/config'
import {
  constructionOpening,
  FINISHED_FLOOR_Y,
  openingPanels,
  usableInterior,
  type OpeningPanel,
} from '../lib/spatial'
import {
  box,
  corrugatedPanel,
  cylinder,
  extrude,
  roundedBox,
  roundedRectShape,
  tube,
} from './geometry'
import { material } from './materials'
import { palette } from './palette'
import { oriented, part, place, type Part, type V3 } from './parts'

/** Top of the finished floor; equipment stands on it. */
export const FLOOR_Y = FINISHED_FLOOR_Y
/** Studio portal: base height, wall thickness, outer corner radius (feet). */
export const STUDIO = { base: 0.3, wall: 0.36, radius: 1.1, depth: 8 }

export const finishColor = (c: Config) => FINISHES.find((f) => f.id === c.finish)!.color

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
  )
}
function slab(key: string, w: number, h: number, r: number, depth: number, bevel = 0) {
  return extrude(
    `slab:${key}:${w}:${h}:${r}`,
    () => roundedRectShape(w - bevel * 2, h - bevel * 2, r - bevel),
    depth - bevel * 2,
    bevel,
    24,
  )
}

// --- Studio ---------------------------------------------------------------------------------

/** The S-Series shell: a rounded steel portal, closed back, and recessed shadow plinth. */
export function studioShell(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c),
    { base, wall, radius, depth } = STUDIO
  const shell = palette.shell(finishColor(c))
  const center = base + H / 2
  const parts = [
    part(ring('portal', L, H, radius, wall, depth - 0.07, 0.035), shell, [0, center, 0]),
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
    // Drip edge along the roof front.
    part(box(L - 2.4, 0.05, 0.08), shell, [0, base + H - 0.02, depth / 2 - 0.25]),
  ]
  const reveal = palette.powder('#252a28', false, 0.9)
  // Recessed perimeter seams follow the rolled corners rather than cutting a square fascia.
  for (const side of [-1, 1]) {
    const z = side * 3.97
    parts.push(
      part(ring('skin-reveal', L - 0.035, H - 0.035, radius - 0.018, 0.055, 0.025), reveal, [
        0,
        center,
        z,
      ]),
    )
    parts.push(
      part(ring('skin-return', L - 0.08, H - 0.08, radius - 0.04, 0.12, 0.035), shell, [
        0,
        center,
        z + side * 0.023,
      ]),
    )
  }
  for (let x = -L / 2 + 5; x < L / 2 - 1.1; x += 5)
    parts.push(
      part(box(0.025, 0.008, 7.4), reveal, [x, base + H + 0.003, 0], undefined, undefined, false),
    )
  return parts
}

/** Lining, floor, back wall, slatted ceiling, trims, and services inside the Studio. */
export function studioInterior(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c),
    { base, wall, radius } = STUDIO
  const center = base + H / 2
  const innerW = L - wall * 2,
    innerH = H - wall * 2,
    innerR = radius - wall
  const lining = 0.08
  const paint = palette.paint(c.finish === 'chalk' ? '#f4f1eb' : '#f1eee8')
  const back = -3.78
  const front = 3.62
  const parts: Part[] = [
    part(ring('lining', innerW, innerH, innerR, lining, front - back), paint, [
      0,
      center,
      (front + back) / 2,
    ]),
    part(slab('backwall', innerW - lining * 2, innerH - lining * 2, innerR - lining, 0.08), paint, [
      0,
      center,
      back,
    ]),
  ]
  parts.push(...floor(c, L - 1.24, back + 0.04, front, FLOOR_Y))
  parts.push(...skirting(L / 2 - 0.62, back + 0.04, front, FLOOR_Y))
  const ceilingTop = base + H - wall - lining
  parts.push(...slatCeiling(L - 2.4, back + 0.04, front - 0.12, ceilingTop - 0.42, ceilingTop))
  parts.push(...services(c, back + 0.04, ceilingTop - 0.42))
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

/** Wall-mounted mini-split, room controller, and wall LED channel. */
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

/** Full-height glazing following the portal outline, with mullions and a central door. */
export function studioGlazing(c: Config): Part[] {
  if (c.openingConcept && c.openingConcept !== 'standard') return conceptOpening(c)
  const L = c.length,
    H = productHeight(c),
    { base, wall, radius } = STUDIO
  const center = base + H / 2
  const w = L - wall * 2,
    h = H - wall * 2,
    r = radius - wall
  const frame = palette.anodized('#202422')
  const z = 3.82
  const panes = L === 20 ? 6 : 12
  const parts: Part[] = [
    part(ring('glazing-frame', w, h, r, 0.16, 0.24, 0.01), frame, [0, center, z]),
    part(
      extrude(
        `glass-door-cutout:${L}:${H}`,
        () => {
          const s = roundedRectShape(w - 0.2, h - 0.2, r - 0.1)
          const y0 = FLOOR_Y - center,
            y1 = y0 + 7.65
          s.holes.push(
            new Path()
              .moveTo(-1.64, y0)
              .lineTo(-1.64, y1)
              .lineTo(1.64, y1)
              .lineTo(1.64, y0)
              .closePath(),
          )
          return s
        },
        0.02,
      ),
      palette.glass(),
      [0, center, z + 0.02],
      undefined,
      undefined,
      false,
    ),
  ]
  const span = w - 0.32
  for (let i = 1; i < panes; i++) {
    const x = -span / 2 + (i * span) / panes
    if (Math.abs(x) < 1.7) continue
    parts.push(part(box(0.11, h - 0.3, 0.2), frame, [x, center, z]))
  }
  // Door leaf in the central bay: heavier stiles, rails, and pull handles inside and out.
  const doorW = 3.28
  parts.push(part(box(doorW, 0.12, 0.2), frame, [0, FLOOR_Y + 0.06, z]))
  parts.push(part(box(doorW, 0.1, 0.2), frame, [0, FLOOR_Y + 7.6, z]))
  for (const x of [-1.68, 1.68])
    parts.push(part(box(0.08, 7.65, 0.22), frame, [x, FLOOR_Y + 7.65 / 2, z]))
  parts.push(...openingPanels(c).flatMap((p) => openingLeaf(p, c)))
  return parts
}

// --- Container ------------------------------------------------------------------------------

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
  const opening = constructionOpening(c)
  const left = opening.center - opening.width / 2,
    right = opening.center + opening.width / 2

  // Corner posts, castings with apertures, and the perimeter rails.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * (L / 2 - 0.2),
        z = sz * (4 - 0.2)
      parts.push(part(box(0.4, H - 0.7, 0.4), paint, [x, H / 2, z]))
      for (const y of [0.19, H - 0.19]) {
        const cx = sx * (L / 2 - 0.29),
          cz = sz * (4 - 0.265)
        for (const s of [-1, 1]) {
          parts.push(
            part(ring('casting-face', 0.58, 0.38, 0.06, 0.1, 0.06), paint, [cx, y, cz + s * 0.235]),
          )
          parts.push(
            part(
              ring('casting-end', 0.53, 0.38, 0.06, 0.1, 0.06),
              paint,
              [cx + s * 0.26, y, cz],
              [0, Math.PI / 2, 0],
            ),
          )
          parts.push(part(box(0.58, 0.06, 0.53), paint, [cx, y + s * 0.16, cz]))
        }
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
  // Roof with shallow transverse pressings.
  parts.push(part(box(L - 0.6, 0.06, 7.7), paint, [0, H - 0.1, 0]))
  for (let x = -L / 2 + 0.9; x < L / 2 - 0.6; x += 1.15)
    parts.push(
      part(
        roundedBox(0.5, 0.03, 7.2, 0.012, 1),
        paint,
        [x, H - 0.06, 0],
        undefined,
        undefined,
        false,
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
  parts.push(...conceptOpening(c))
  return parts
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

function openingLeaf(p: OpeningPanel, c: Config): Part[] {
  const frame = palette.anodized('#292e2b'),
    seal = palette.black(),
    steel = palette.zinc()
  const { width: w, height: h, depth: d } = p
  const parts: Part[] = []
  const border = (
    inset: number,
    thickness: number,
    depth: number,
    m: ReturnType<typeof palette.black>,
  ) => {
    for (const x of [-1, 1])
      parts.push(
        part(box(thickness, h - inset * 2, depth), m, [x * (w / 2 - inset - thickness / 2), 0, 0]),
      )
    for (const y of [-1, 1])
      parts.push(
        part(box(w - inset * 2, thickness, depth), m, [0, y * (h / 2 - inset - thickness / 2), 0]),
      )
  }
  border(0, 0.12, d, frame)
  border(0.12, 0.035, 0.065, seal)
  if (p.kind === 'glass') {
    parts.push(
      part(box(w - 0.3, h - 0.3, 0.035), palette.glass(), [0, 0, 0], undefined, undefined, false),
    )
    const bays = Math.ceil(w / 4)
    for (let i = 1; i < bays; i++)
      parts.push(part(box(0.1, h - 0.24, d), frame, [-w / 2 + (i * w) / bays, 0, 0]))
    if (p.id === 'studio-entry') {
      for (const z of [-0.18, 0.18]) {
        parts.push(part(cylinder(0.035, 0.035, 2.1, 16), steel, [w * 0.32, 0.1, z]))
        for (const y of [-0.75, 0.95])
          parts.push(
            part(
              cylinder(0.025, 0.025, Math.abs(z), 10),
              steel,
              [w * 0.32, y, z / 2],
              [Math.PI / 2, 0, 0],
            ),
          )
      }
    }
  } else if (p.kind === 'solid') {
    parts.push(
      part(corrugatedPanel(w - 0.26, h - 0.26, 0.85, 0.075), palette.shell(finishColor(c)), [
        -w / 2 + 0.13,
        -h / 2 + 0.13,
        0.04,
      ]),
    )
    for (const x of [-w * 0.26, w * 0.26]) {
      parts.push(part(cylinder(0.035, 0.035, h - 0.1, 12), steel, [x, 0, d / 2 + 0.075]))
      for (const y of [-h / 2 + 0.15, 0, h / 2 - 0.15])
        parts.push(part(box(0.16, 0.12, 0.09), steel, [x, y, 0.12]))
      parts.push(part(roundedBox(0.62, 0.08, 0.08, 0.02, 1), steel, [x + 0.2, -0.7, 0.21]))
    }
    for (const y of [-h * 0.38, 0, h * 0.38])
      parts.push(part(cylinder(0.055, 0.055, 0.28, 12), steel, [-w / 2 + 0.04, y, 0.05]))
  } else {
    parts.push(
      part(
        box(w - 0.22, h - 0.22, 0.05),
        material({
          set: 'painted_metal_shutter',
          color: '#b0b4ad',
          roughness: 0.85,
          interior: true,
        }),
        [0, 0, 0],
      ),
    )
    for (let y = -h / 2 + 0.25; y < h / 2 - 0.15; y += 0.25)
      parts.push(part(box(w - 0.24, 0.015, 0.08), frame, [0, y, 0]))
  }
  return place(parts, [p.center.x, p.center.y, p.center.z], [p.rotationX, p.rotationY, 0])
}

/** Illustrative mechanisms from the reference concepts, never a manufacturer/engineering claim. */
export function conceptOpening(c: Config): Part[] {
  const concept = c.openingConcept ?? 'standard',
    panels = openingPanels(c),
    parts = panels.flatMap((p) => openingLeaf(p, c))
  const { width, center } = constructionOpening(c),
    head = productHeight(c) - 0.9
  const frame = palette.anodized('#262b28'),
    steel = palette.brushed(false)
  if (concept === 'open-front') {
    parts.push(part(box(width, 0.16, 0.5), frame, [center, head + 0.05, 3.75]))
    parts.push(part(box(width, 0.08, 0.6), frame, [center, FLOOR_Y - 0.04, 3.65]))
    return parts
  }
  if (concept === 'standard') {
    if (c.family === 'container' && c.containerOpening === 'roll-up') {
      parts.push(
        part(roundedBox(width + 0.4, 0.72, 0.8, 0.05, 2), frame, [center, head - 0.3, 3.3]),
      )
      for (const s of [-1, 1])
        parts.push(
          part(box(0.16, head - FLOOR_Y, 0.25), steel, [
            center + s * (width / 2 + 0.08),
            (head + FLOOR_Y) / 2,
            3.7,
          ]),
        )
    }
    return parts
  }
  for (const s of [-1, 1]) {
    const x = center + s * (width / 2 + 0.06)
    if (concept === 'sectional-glazed') {
      const room = usableInterior(c),
        trackY = room.max.y - 0.18,
        trackEnd = room.min.z + 0.12
      const turn = ((head - FLOOR_Y - 0.04) / 5) * Math.SQRT1_2
      parts.push(part(box(0.13, head - FLOOR_Y, 0.16), frame, [x, (head + FLOOR_Y) / 2, 3.75]))
      parts.push(
        part(box(0.13, 0.12, 3.75 - turn - trackEnd), frame, [
          x,
          trackY,
          (3.75 - turn + trackEnd) / 2,
        ]),
      )
      parts.push(
        part(
          tube(
            `sectional-track:${x}:${trackY}`,
            [
              [x, trackY - turn, 3.75],
              [x, trackY, 3.75 - turn],
            ],
            0.065,
            8,
            1,
          ),
          frame,
        ),
      )
      for (const p of panels)
        parts.push(
          part(
            cylinder(0.075, 0.075, 0.12, 12),
            steel,
            [x, p.center.y, p.center.z],
            [0, 0, Math.PI / 2],
          ),
        )
    } else if (concept === 'raised-glazed') {
      const p = panels[0],
        a = -p.rotationX
      const endpoint: V3 = [
        x,
        head - p.height * 0.7 * Math.cos(a),
        3.8 + p.height * 0.7 * Math.sin(a),
      ]
      parts.push(
        part(tube(`raise-arm:${x}:${a}`, [[x, head - 2.5, 3.68], endpoint], 0.065, 10, 1), steel),
      )
      parts.push(part(cylinder(0.12, 0.12, 0.28, 16), frame, [x, head, 3.8], [0, 0, Math.PI / 2]))
    } else {
      for (const y of [FLOOR_Y + 0.5, head - 0.5])
        parts.push(part(box(0.55, 0.18, 0.32), frame, [x, y, 3.8]))
    }
  }
  if (concept === 'raised-glazed')
    parts.push(part(box(width + 0.5, 0.26, 0.65), frame, [center, head + 0.14, 3.9]))
  return parts
}

/** Insulated, finished container interior: lined walls, floor build-up, slatted ceiling. */
export function containerInterior(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c)
  const paint = palette.paint(c.finish === 'chalk' ? '#f4f1eb' : '#f1eee8')
  const opening = constructionOpening(c)
  const left = opening.center - opening.width / 2,
    right = opening.center + opening.width / 2
  const ceiling = H - 0.72
  const back = -3.62
  const front = 3.6
  const wallH = ceiling - 0.6
  const parts: Part[] = [
    part(box(L - 0.9, wallH, 0.12), paint, [0, 0.6 + wallH / 2, back - 0.06]),
    part(box(0.12, wallH, front - back), paint, [
      -L / 2 + 0.5,
      0.6 + wallH / 2,
      (front + back) / 2,
    ]),
    part(box(0.12, wallH, front - back), paint, [L / 2 - 0.5, 0.6 + wallH / 2, (front + back) / 2]),
    part(box(L - 0.9, 0.12, front - back), paint, [0, ceiling + 0.06, (front + back) / 2]),
  ]
  const frontPanel = (from: number, to: number) => {
    if (to - from > 0.1)
      parts.push(
        part(box(to - from, wallH, 0.12), paint, [(from + to) / 2, 0.6 + wallH / 2, front + 0.06]),
      )
  }
  frontPanel(-L / 2 + 0.44, left - 0.25)
  frontPanel(right + 0.25, L / 2 - 0.44)
  parts.push(
    part(box(right - left + 0.5, ceiling - (H - 0.9) + 0.6, 0.12), paint, [
      opening.center,
      (ceiling + H - 0.9) / 2 + 0.1,
      front + 0.06,
    ]),
  )
  parts.push(...floor(c, L - 1.24, back, front, FLOOR_Y))
  parts.push(...skirting(L / 2 - 0.62, back, front, FLOOR_Y))
  parts.push(...slatCeiling(L - 1.6, back, front - 0.2, ceiling - 0.38, ceiling))
  parts.push(...services(c, back, ceiling - 0.38))
  return parts
}

/** Interior geometry the lights and probe need for either family. */
export function interiorBounds(c: Config) {
  const b = usableInterior(c)
  return { ceiling: b.max.y, back: b.min.z, front: b.max.z, halfWidth: b.max.x }
}

export type { V3 }
