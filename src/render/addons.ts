import { productHeight, type Config } from '../lib/config'
import { finishColor } from './architecture'
import { GRADE_DECK, ROOF_FRAME, STUDIO, deckFront, roofTop } from './envelope'
import { box, cylinder, extrude, roundedBox, roundedRectShape } from './geometry'
import { material } from './materials'
import { palette } from './palette'
import { part, rod, type Part, type V3 } from './parts'

const DECK_TOP = 0.86
/** Stair geometry: 17 risers and 10 in. goings up to the roof deck. */
export const STAIR = { x: 2, risers: 17, going: 0.83, start: 11.5, width: 3.5 }

export { deckFront, roofTop }

function boards(depth: number, centerZ: number, top: number, length: number, x = 0) {
  const teak = palette.teak()
  const board = roundedBox(length, 0.09, 0.46, 0.015, 1)
  const parts: Part[] = []
  const count = Math.floor(depth / 0.485)
  const start = centerZ - ((count - 1) * 0.485) / 2
  for (let i = 0; i < count; i++)
    parts.push(
      part(board, teak, [x, top - 0.045, start + i * 0.485], undefined, undefined, i % 4 === 0),
    )
  return parts
}

export function deck(c: Config): Part[] {
  const L = c.length
  if (c.family === 'container') {
    const { top, depth } = GRADE_DECK
    const z = 4 + depth / 2 + 0.02
    const teak = palette.teak()
    const parts: Part[] = [
      part(box(L - 0.2, top - 0.1, depth - 0.1), palette.powder('#1b1c1b', false, 0.9), [
        0,
        (top - 0.1) / 2,
        z,
      ]),
      ...boards(depth, z, top, L),
      // Timber fascia boards on edge around the open sides.
      part(roundedBox(L + 0.06, top - 0.04, 0.09, 0.015, 1), teak, [
        0,
        (top - 0.04) / 2,
        4 + depth,
      ]),
      part(roundedBox(0.09, top - 0.04, depth, 0.015, 1), teak, [
        -L / 2 - 0.02,
        (top - 0.04) / 2,
        z,
      ]),
      part(roundedBox(0.09, top - 0.04, depth, 0.015, 1), teak, [
        L / 2 + 0.02,
        (top - 0.04) / 2,
        z,
      ]),
    ]
    // Stepping stones leading to the deck.
    for (let i = 0; i < 3; i++)
      parts.push(
        part(
          roundedBox(2.1, 0.16, 1.5, 0.05, 2),
          palette.concrete(),
          [-L * 0.18 + i * 0.35, 0.02, 4 + depth + 1.3 + i * 2.1],
          [0, (i - 1) * 0.06, 0],
        ),
      )
    return parts
  }
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
        `pergola:${L}:${radius}`,
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

// --- Railings -------------------------------------------------------------------------------

const RAIL_HEIGHT = 3.5

/**
 * A straight railing run on a level surface: frameless glass in a base shoe with a round steel
 * cap, or black posts carrying a flat top rail and tensioned stainless cables.
 */
function railRun(
  from: [number, number],
  to: [number, number],
  floor: number,
  style: Config['railing'],
) {
  const parts: Part[] = []
  const dx = to[0] - from[0],
    dz = to[1] - from[1]
  const length = Math.hypot(dx, dz)
  if (length < 0.3) return parts
  const angle = Math.atan2(-dz, dx)
  const cx = (from[0] + to[0]) / 2,
    cz = (from[1] + to[1]) / 2
  if (style === 'glass') {
    parts.push(
      part(
        box(length, 0.32, 0.26),
        palette.anodized('#2a2d2b'),
        [cx, floor + 0.16, cz],
        [0, angle, 0],
      ),
    )
    parts.push(
      part(
        box(length - 0.04, RAIL_HEIGHT - 0.2, 0.045),
        palette.glass(),
        [cx, floor + 0.3 + (RAIL_HEIGHT - 0.2) / 2, cz],
        [0, angle, 0],
        undefined,
        false,
      ),
    )
    parts.push(
      part(
        cylinder(0.07, 0.07, length, 20),
        palette.brushed(false),
        [cx, floor + RAIL_HEIGHT + 0.1, cz],
        [0, angle, Math.PI / 2],
      ),
    )
    return parts
  }
  const post = palette.powder('#161817', false, 0.55)
  const cable = palette.brushed(false, '#d4d6d6')
  const posts = Math.max(1, Math.ceil(length / 4.2))
  for (let i = 0; i <= posts; i++) {
    const t = i / posts
    parts.push(
      part(roundedBox(0.16, RAIL_HEIGHT, 0.16, 0.015, 1), post, [
        from[0] + dx * t,
        floor + RAIL_HEIGHT / 2,
        from[1] + dz * t,
      ]),
    )
  }
  parts.push(
    part(
      roundedBox(length + 0.16, 0.1, 0.3, 0.02, 1),
      post,
      [cx, floor + RAIL_HEIGHT + 0.05, cz],
      [0, angle, 0],
    ),
  )
  for (let k = 0; k < 10; k++) {
    const y = floor + 0.3 + k * 0.31
    parts.push(rod([from[0], y, from[1]], [to[0], y, to[1]], 0.012, cable, 6, false))
  }
  return parts
}

/** Railing along a straight flight, following its pitch. */
function stairRail(
  bottom: V3,
  top: V3,
  style: Config['railing'],
  steel: ReturnType<typeof palette.brushed>,
): Part[] {
  const parts: Part[] = []
  const up: V3 = [0, RAIL_HEIGHT - 0.4, 0]
  const lift = (p: V3, h: number): V3 => [p[0], p[1] + h, p[2]]
  if (style === 'cable') {
    const post = palette.powder('#161817', false, 0.55)
    const n = 4
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const p: V3 = [
        bottom[0] + (top[0] - bottom[0]) * t,
        bottom[1] + (top[1] - bottom[1]) * t,
        bottom[2] + (top[2] - bottom[2]) * t,
      ]
      parts.push(rod(p, lift(p, up[1] + 0.1), 0.08, post, 4))
    }
    parts.push(rod(lift(bottom, up[1] + 0.12), lift(top, up[1] + 0.12), 0.07, post, 4))
    for (let k = 0; k < 7; k++) {
      const h = 0.35 + k * 0.42
      parts.push(
        rod(lift(bottom, h), lift(top, h), 0.012, palette.brushed(false, '#d4d6d6'), 6, false),
      )
    }
    return parts
  }
  parts.push(rod(lift(bottom, 3.05), lift(top, 3.05), 0.05, steel, 16))
  const n = 8
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p: V3 = [
      bottom[0] + (top[0] - bottom[0]) * t,
      bottom[1] + (top[1] - bottom[1]) * t,
      bottom[2] + (top[2] - bottom[2]) * t,
    ]
    parts.push(rod(p, lift(p, 3.05), 0.022, steel, 10))
  }
  return parts
}

export function roofDeck(c: Config): Part[] {
  const L = c.length
  const top = roofTop(c)
  const parts: Part[] = []
  let x: number, z: number
  if (c.family === 'container') {
    const H = productHeight(c)
    const cedar = palette.cedar(false, '#857a70')
    const band = (w: number, d: number, at: V3) =>
      part(box(w, ROOF_FRAME, d, { swap: true }), cedar, at)
    // Timber-clad deck frame around the container top, then the deck boards.
    parts.push(band(L + 0.3, 0.24, [0, H + ROOF_FRAME / 2, 3.93]))
    parts.push(band(L + 0.3, 0.24, [0, H + ROOF_FRAME / 2, -3.93]))
    parts.push(band(0.24, 7.62, [-L / 2 - 0.03, H + ROOF_FRAME / 2, 0]))
    parts.push(band(0.24, 7.62, [L / 2 + 0.03, H + ROOF_FRAME / 2, 0]))
    parts.push(
      part(
        box(L - 0.2, ROOF_FRAME - 0.1, 7.6),
        palette.black(),
        [0, H + (ROOF_FRAME - 0.1) / 2, 0],
        undefined,
        undefined,
        false,
      ),
    )
    parts.push(...boards(7.8, 0, top, L + 0.1))
    x = L / 2 - 0.05
    z = 3.92
  } else {
    parts.push(...boards(7.3, 0, top, L - 1.7))
    x = L / 2 - 0.75
    z = 3.6
  }
  const run = (from: [number, number], to: [number, number]) =>
    parts.push(...railRun(from, to, top, c.railing))
  run([-x, z], [x, z])
  run([-x, -z], [x, -z])
  run([-x, -z], [-x, z])
  if (c.addons.stairs) run([x, -1.4], [x, z])
  else run([x, -z], [x, z])
  return parts
}

export function stairs(c: Config): Part[] {
  const L = c.length
  const container = c.family === 'container'
  const frame = container ? palette.powder('#161817', false, 0.55) : palette.shell(finishColor(c))
  const tread = container ? palette.powder('#202221', false, 0.7) : palette.teak()
  const steel = palette.brushed(false)
  const { risers, going, start, width } = STAIR
  const top = roofTop(c)
  const rise = top / risers
  const x0 = L / 2 + STAIR.x
  const parts: Part[] = []
  const treadGeometry = roundedBox(width, container ? 0.1 : 0.13, 0.95, 0.025, 2)
  for (let i = 0; i < risers - 1; i++)
    parts.push(part(treadGeometry, tread, [x0, (i + 1) * rise, start - i * going]))
  if (container)
    // Anti-slip nosings on the steel treads.
    for (let i = 0; i < risers - 1; i++)
      parts.push(
        part(
          box(width - 0.1, 0.02, 0.08),
          palette.zinc(),
          [x0, (i + 1) * rise + 0.06, start - i * going + 0.42],
          undefined,
          undefined,
          false,
        ),
      )
  const runLength = Math.hypot(risers * going, top)
  const slope = Math.atan2(top, risers * going)
  const midZ = start - ((risers - 1) * going) / 2,
    midY = top / 2
  const landingZ = start - risers * going + 0.1
  for (const side of [-1, 1]) {
    parts.push(
      part(
        box(container ? 0.1 : 0.08, 0.95, runLength + 0.6),
        frame,
        [x0 + side * (width / 2 + 0.03), midY - 0.15, midZ],
        [slope, 0, 0],
      ),
    )
    const railX = x0 + side * (width / 2 + 0.07)
    parts.push(
      ...stairRail(
        [railX, rise, start + 0.2],
        [railX, top, landingZ + 1.15],
        container ? c.railing : 'glass',
        steel,
      ),
    )
  }
  // Landing beside the roof deck, carried on two posts.
  parts.push(part(roundedBox(4.6, 0.16, 2.3, 0.03, 2), tread, [x0 - 0.6, top, landingZ]))
  parts.push(part(box(4.6, 0.5, 2.3), frame, [x0 - 0.6, top - 0.33, landingZ]))
  for (const dz of [-1.05, 1.05])
    parts.push(
      part(roundedBox(0.3, top - 0.55, 0.3, 0.02, 1), frame, [
        x0 + width / 2 - 0.1,
        (top - 0.55) / 2,
        landingZ + dz,
      ]),
    )
  // Outer guard at the landing.
  parts.push(
    ...railRun(
      [x0 + width / 2 + 0.07, landingZ - 1.15],
      [x0 + width / 2 + 0.07, landingZ + 1.15],
      top,
      container ? c.railing : 'glass',
    ),
  )
  parts.push(
    ...railRun(
      [L / 2, landingZ - 1.15],
      [x0 + width / 2 + 0.07, landingZ - 1.15],
      top,
      container ? c.railing : 'glass',
    ),
  )
  // Ground pad.
  parts.push(
    part(
      box(4.2, 0.1, 1.6),
      palette.concrete(),
      [x0, 0.04, start + 1.1],
      undefined,
      undefined,
      false,
    ),
  )
  return parts
}

/** Recessed downlight positions in the Container canopy soffit (x, y, z). */
export function canopyLights(c: Config): V3[] {
  const L = c.length
  const count = Math.max(3, Math.round(L / 4.8))
  const y = canopyTop(c) - 0.72
  return Array.from({ length: count }, (_, i) => [
    -L / 2 + (L / count) * (i + 0.5),
    y,
    4 + CANOPY_DEPTH * 0.5,
  ])
}
const CANOPY_DEPTH = 3.6
const canopyTop = (c: Config) => productHeight(c) + (c.addons.roof ? -0.02 : 0.14)

/** A cantilevered steel canopy over the Container front with recessed downlights. */
export function canopy(c: Config): Part[] {
  const L = c.length
  const paint = palette.shell(finishColor(c))
  const top = canopyTop(c),
    thick = 0.7
  const parts: Part[] = [
    part(roundedBox(L + 0.6, thick, CANOPY_DEPTH, 0.03, 1), paint, [
      0,
      top - thick / 2,
      4 + CANOPY_DEPTH / 2 - 0.05,
    ]),
    // Drip edge along the fascia.
    part(box(L + 0.6, 0.06, 0.08), paint, [0, top - thick - 0.03, 4 + CANOPY_DEPTH - 0.09]),
  ]
  const trim = palette.powder('#121313', false, 0.6)
  const lens = c.lights ? palette.emitter('#fff1dc', 8) : palette.plastic('#d8d4cb', 0.3)
  for (const [x, y, z] of canopyLights(c)) {
    parts.push(
      part(cylinder(0.2, 0.2, 0.03, 28), trim, [x, y + 0.005, z], undefined, undefined, false),
    )
    parts.push(
      part(cylinder(0.13, 0.13, 0.03, 24), lens, [x, y - 0.004, z], undefined, undefined, false),
    )
  }
  // Warm glow on the soffit around each fitting.
  if (c.lights)
    parts.push(
      part(
        box(L - 0.4, 0.01, 0.03),
        material({ color: '#000000', emissive: '#ffcf96', emissiveIntensity: 1.2, roughness: 1 }),
        [0, top - thick - 0.002, 4 + CANOPY_DEPTH - 0.3],
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
