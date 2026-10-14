import { productHeight, type Config } from '../lib/config'
import { GROUND_DECK_Y, roofDeckElevation, stairLayout } from '../lib/spatial'
import { STUDIO, finishColor } from './architecture'
import { box, cylinder, extrude, roundedBox, roundedRectShape } from './geometry'
import { palette } from './palette'
import { part, type Part } from './parts'

const DECK_TOP = GROUND_DECK_Y
/** Legacy dimensions; use stairLayout(config) for family-dependent assembly geometry. */
export const STAIR = { x: 2, risers: 17, rise: 10.4 / 17, going: 0.83, start: 11.5 }

function boards(depth: number, centerZ: number, top: number, length: number) {
  const teak = palette.teak()
  const board = roundedBox(length, 0.09, 0.46, 0.015, 1)
  const parts: Part[] = []
  const count = Math.floor(depth / 0.485)
  const start = centerZ - ((count - 1) * 0.485) / 2
  for (let i = 0; i < count; i++)
    parts.push(
      part(board, teak, [0, top - 0.045, start + i * 0.485], undefined, undefined, i % 4 === 0),
    )
  return parts
}

export function deck(c: Config): Part[] {
  const L = c.length
  const frame = palette.shell(finishColor(c))
  const parts: Part[] = [
    part(roundedBox(L, DECK_TOP - 0.15, 8, 0.1, 2), frame, [0, (DECK_TOP - 0.09) / 2, 8]),
    ...boards(7.9, 8, DECK_TOP, L - 0.3),
    // Front step.
    part(roundedBox(L * 0.6, 0.34, 1, 0.06, 2), frame, [0, 0.17, 12.55]),
    ...[12.3, 12.78].map((z) =>
      part(roundedBox(L * 0.6 - 0.2, 0.08, 0.44, 0.015, 1), palette.teak(), [0, 0.38, z]),
    ),
  ]
  if (c.lights)
    parts.push(
      part(
        box(L - 1, 0.03, 0.03),
        palette.emitter('#ffd7a6', 4),
        [0, DECK_TOP - 0.12, 12.01],
        undefined,
        undefined,
        false,
      ),
    )
  return parts
}

export function pergola(c: Config): Part[] {
  const L = c.length,
    H = productHeight(c),
    { base, radius } = STUDIO
  const frame = palette.shell(finishColor(c))
  const teak = palette.teak()
  const parts: Part[] = [
    part(
      extrude(
        `pergola:${L}`,
        () => {
          const s = roundedRectShape(L, H, radius)
          s.holes.push(roundedRectShape(L - 0.7, H - 0.7, radius - 0.35))
          return s
        },
        0.32,
        0.03,
        24,
      ),
      frame,
      [0, base + H / 2, 11.65],
    ),
  ]
  for (const side of [-1, 1])
    parts.push(part(box(0.35, 0.35, 7.7), frame, [side * (L / 2 - 0.18), base + H - 0.18, 7.8]))
  const louver = roundedBox(0.14, 0.42, 7.6, 0.02, 1, { swap: true })
  for (let x = -L / 2 + 0.75; x <= L / 2 - 0.7; x += 0.62)
    parts.push(part(louver, teak, [x, base + H - 0.3, 7.8], [0, 0, 0.42]))
  return parts
}

export function roofDeck(c: Config): Part[] {
  const L = c.length
  const top = roofDeckElevation(c) - 0.12
  const glass = palette.glass()
  const steel = palette.brushed(false)
  const shoe = palette.anodized('#2a2d2b')
  const parts: Part[] = boards(7.3, 0, top + 0.12, L - 1.7)
  const railH = 3.5
  const run = (from: [number, number], to: [number, number]) => {
    const dx = to[0] - from[0],
      dz = to[1] - from[1]
    const length = Math.hypot(dx, dz)
    if (length < 0.3) return
    const angle = Math.atan2(-dz, dx)
    const cx = (from[0] + to[0]) / 2,
      cz = (from[1] + to[1]) / 2
    parts.push(part(box(length, 0.32, 0.26), shoe, [cx, top + 0.16, cz], [0, angle, 0]))
    parts.push(
      part(
        box(length - 0.04, railH - 0.2, 0.045),
        glass,
        [cx, top + 0.3 + (railH - 0.2) / 2, cz],
        [0, angle, 0],
        undefined,
        false,
      ),
    )
    parts.push(
      part(
        cylinder(0.07, 0.07, length, 20),
        steel,
        [cx, top + railH + 0.1, cz],
        [0, angle, Math.PI / 2],
      ),
    )
  }
  const x = L / 2 - 0.75,
    z = 3.6
  run([-x, z], [x, z])
  run([-x, -z], [x, -z])
  run([-x, -z], [-x, z])
  if (c.addons.stairs) run([x, -0.45], [x, z])
  else run([x, -z], [x, z])
  return parts
}

export function stairs(c: Config): Part[] {
  const frame = palette.shell(finishColor(c))
  const teak = palette.teak()
  const steel = palette.brushed(false)
  const { risers, rise, going, start, x: x0, top, landing, ground } = stairLayout(c)
  const parts: Part[] = []
  const tread = roundedBox(3.5, 0.13, 0.95, 0.025, 2)
  for (let i = 0; i < risers; i++)
    parts.push(part(tread, teak, [x0, ground + (i + 1) * rise - 0.065, start - i * going]))
  const runLength = Math.hypot((risers - 1) * going, (risers - 1) * rise)
  const slope = Math.atan2(rise, going)
  const midZ = start - ((risers - 1) * going) / 2,
    midY = ground + ((risers + 1) * rise) / 2
  for (const side of [-1, 1]) {
    parts.push(part(box(0.14, 0.42, 0.4), frame, [x0 + side * 1.78, ground + 0.21, start + 0.1]))
    parts.push(
      part(
        box(0.12, 0.35, runLength + 0.4),
        frame,
        [x0 + side * 1.78, midY - 0.15, midZ],
        [slope, 0, 0],
      ),
    )
    parts.push(
      part(
        cylinder(0.05, 0.05, runLength + 0.15, 16),
        steel,
        [x0 + side * 1.82, midY + 3.05, midZ],
        [Math.PI / 2 + slope, 0, 0],
      ),
    )
    parts.push(
      part(
        cylinder(0.05, 0.05, 0.475, 12),
        steel,
        [x0 + side * 1.82, top + 3.05, landing.max.z + 0.2375],
        [Math.PI / 2, 0, 0],
      ),
    )
    for (let i = 0; i < risers; i += 2)
      parts.push(
        part(cylinder(0.022, 0.022, 3, 10), steel, [
          x0 + side * 1.82,
          ground + (i + 1) * rise + 1.55,
          start - i * going,
        ]),
      )
  }
  const width = landing.max.x - landing.min.x,
    depth = landing.max.z - landing.min.z
  const cx = (landing.min.x + landing.max.x) / 2,
    cz = (landing.min.z + landing.max.z) / 2
  parts.push(part(box(width, 0.4, depth), frame, [cx, top - 0.3, cz]))
  for (let z = landing.min.z + 0.25; z < landing.max.z; z += 0.5)
    parts.push(part(roundedBox(width, 0.1, 0.47, 0.015, 1), teak, [cx, top - 0.05, z]))
  // Continuous landing perimeter, with an unobstructed roof transfer and stair arrival.
  const rail = (x1: number, z1: number, x2: number, z2: number) => {
    const length = Math.hypot(x2 - x1, z2 - z1),
      angle = Math.atan2(-(z2 - z1), x2 - x1)
    parts.push(
      part(
        box(length, 0.09, 0.09),
        steel,
        [(x1 + x2) / 2, top + 3.1, (z1 + z2) / 2],
        [0, angle, 0],
      ),
    )
    parts.push(
      part(
        box(length, 0.08, 0.08),
        frame,
        [(x1 + x2) / 2, top + 1.5, (z1 + z2) / 2],
        [0, angle, 0],
      ),
    )
    const count = Math.ceil(length / 0.4)
    for (let i = 0; i <= count; i++)
      parts.push(
        part(box(0.04, 3.1, 0.04), frame, [
          x1 + ((x2 - x1) * i) / count,
          top + 1.55,
          z1 + ((z2 - z1) * i) / count,
        ]),
      )
  }
  rail(landing.min.x, landing.min.z, landing.max.x, landing.min.z)
  rail(landing.max.x, landing.min.z, landing.max.x, landing.max.z)
  rail(landing.min.x, landing.max.z, x0 - 1.85, landing.max.z)
  for (const x of [x0 - 1.78, x0 + 1.78]) {
    parts.push(part(box(0.15, top - 0.5, 0.15), frame, [x, (top - 0.5) / 2, landing.min.z + 0.18]))
    parts.push(part(box(0.65, 0.08, 0.65), palette.concrete(), [x, 0.04, landing.min.z + 0.18]))
  }
  // Ground pad.
  parts.push(
    part(
      box(4.2, 0.1, 2.5),
      palette.concrete(),
      [x0, 0.05, start + 0.75],
      undefined,
      undefined,
      false,
    ),
  )
  return parts
}

/** Vertical teak battens on both end walls of the Studio. */
export function timberAccent(c: Config): Part[] {
  const L = c.length
  const teak = palette.teak()
  const batten = roundedBox(0.09, 7.8, 0.15, 0.015, 1, { swap: true })
  const parts: Part[] = []
  for (const side of [-1, 1])
    for (let i = 0; i < 27; i++)
      parts.push(
        part(
          batten,
          teak,
          [side * (L / 2 + 0.05), 5.15, -3.65 + i * 0.265],
          undefined,
          undefined,
          i % 3 === 0,
        ),
      )
  return parts
}

/** Presentation context only: keep separate from the product, item totals and priced scope. */
export function siteContext(c: Config): Part[] {
  const context = c.presentation?.context
  if (!context || context === 'product') return []
  const parts: Part[] = [],
    timber = palette.teak(),
    frame = palette.powder('#292d29'),
    concrete = palette.concrete()
  if (context === 'custom-wellness') {
    const width = Math.min(c.length - 2, 24),
      top = productHeight(c) - 0.6
    parts.push(part(box(width, 0.5, 7.4), frame, [0, top, 7.6]))
    for (let x = -width / 2 + 0.2; x < width / 2; x += 0.4)
      parts.push(part(box(0.16, 0.12, 7.1), timber, [x, top - 0.31, 7.6]))
    for (const x of [-width / 2 + 0.1, width / 2 - 0.1]) {
      parts.push(part(box(0.2, top, 0.2), frame, [x, top / 2, 11.1]))
      parts.push(part(box(0.7, 0.1, 0.7), concrete, [x, 0.05, 11.1]))
    }
    if (!c.addons.deck) {
      parts.push(part(box(width, 0.72, 7.4), concrete, [0, 0.36, 7.6]))
      parts.push(...boards(7.4, 7.6, DECK_TOP, width))
    }
    for (const x of [-width / 2 + 1.7, width / 2 - 1.7]) {
      parts.push(part(box(2.5, 0.7, 1.5), concrete, [x, DECK_TOP + 0.35, 10.1]))
      parts.push(part(roundedBox(2.5, 0.09, 1.5, 0.025, 1), timber, [x, DECK_TOP + 0.745, 10.1]))
    }
  } else if (context === 'sunken-lounge') {
    // Raised site terrace gives a visible recessed court without a hidden below-ground mesh.
    const z = 18.5,
      w = 12,
      d = 7,
      terrace = 1.25,
      court = 0.18
    parts.push(part(box(w, 0.12, d), concrete, [0, court - 0.06, z]))
    for (const x of [-1, 1])
      parts.push(part(box(1, terrace, d + 2), concrete, [x * (w / 2 + 0.5), terrace / 2, z]))
    parts.push(part(box(w, terrace, 1), concrete, [0, terrace / 2, z + d / 2 + 0.5]))
    for (const x of [-1, 1])
      parts.push(part(box(4.5, terrace, 1), concrete, [x * 3.75, terrace / 2, z - d / 2 - 0.5]))
    for (let i = 0; i < 3; i++)
      parts.push(
        part(box(3, (i + 1) * 0.3, 0.8), concrete, [
          0,
          court + (i + 1) * 0.15,
          z - d / 2 + 1.2 - i * 0.8,
        ]),
      )
    const fabric = palette.vinyl('#d7cdb8')
    for (const x of [-1, 1]) {
      parts.push(part(box(1.8, 0.8, 5.2), frame, [x * 4.9, court + 0.4, z]))
      parts.push(part(roundedBox(1.8, 0.3, 5.2, 0.12, 2), fabric, [x * 4.9, court + 0.95, z]))
      parts.push(part(roundedBox(0.3, 1, 5.2, 0.1, 2), fabric, [x * 5.65, court + 1.3, z]))
    }
    parts.push(part(roundedBox(3.5, 0.6, 2.5, 0.12, 2), timber, [0, court + 0.3, z + 0.5]))
  }
  return parts
}
