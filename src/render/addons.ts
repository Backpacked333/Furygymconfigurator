import { productHeight, type Config } from '../lib/config'
import { STUDIO, finishColor } from './architecture'
import { box, cylinder, extrude, roundedBox, roundedRectShape } from './geometry'
import { palette } from './palette'
import { part, type Part } from './parts'

const DECK_TOP = 0.86
/** Stair geometry: 17 risers of ~7.3 in. and 10 in. goings up to the roof deck. */
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
  const top = STUDIO.base + productHeight(c)
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
  if (c.addons.stairs) run([x, -1.4], [x, z])
  else run([x, -z], [x, z])
  return parts
}

export function stairs(c: Config): Part[] {
  const L = c.length
  const frame = palette.shell(finishColor(c))
  const teak = palette.teak()
  const steel = palette.brushed(false)
  const { risers, rise, going, start } = STAIR
  const x0 = L / 2 + STAIR.x
  const parts: Part[] = []
  const tread = roundedBox(3.5, 0.13, 0.95, 0.025, 2)
  for (let i = 0; i < risers; i++)
    parts.push(part(tread, teak, [x0, (i + 1) * rise, start - i * going]))
  const runLength = Math.hypot(risers * going, risers * rise)
  const slope = Math.atan2(risers * rise, risers * going)
  const midZ = start - ((risers - 1) * going) / 2,
    midY = (risers * rise) / 2
  for (const side of [-1, 1]) {
    parts.push(
      part(
        box(0.08, 0.95, runLength + 0.6),
        frame,
        [x0 + side * 1.78, midY - 0.15, midZ],
        [-slope, 0, 0],
      ),
    )
    parts.push(
      part(
        cylinder(0.05, 0.05, runLength + 0.8, 16),
        steel,
        [x0 + side * 1.82, midY + 3.05, midZ],
        [Math.PI / 2 - slope, 0, 0],
      ),
    )
    for (let i = 0; i < risers; i += 2)
      parts.push(
        part(cylinder(0.022, 0.022, 3, 10), steel, [
          x0 + side * 1.82,
          (i + 1) * rise + 1.55,
          start - i * going,
        ]),
      )
  }
  parts.push(
    part(roundedBox(4.6, 0.16, 2.3, 0.03, 2), teak, [
      x0 - 0.6,
      10.42,
      start - risers * going + 0.1,
    ]),
  )
  parts.push(part(box(4.6, 0.5, 2.3), frame, [x0 - 0.6, 10.1, start - risers * going + 0.1]))
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
