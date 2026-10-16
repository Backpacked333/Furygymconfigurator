// Container Gym figures: 20′ or 40′, with the opening options Fury publishes (the featured 10′
// roll-up door, a center opening, a partial open side, a full open side). Part sizes follow the
// configurator's container model (src/render/architecture.ts) and opening widths follow
// openingGeometry() in src/lib/config.ts; geometry is illustrative, not manufacturer CAD.
import * as k from '../kit/iso-kit.mjs'
import { condenserSvg, equipment, FT, helpers, sitePad } from './common.mjs'
import { leafSvg, shutterSvg } from './moving.mjs'

const OPENINGS = {
  'roll-up': {
    width: () => 10,
    center: () => 0,
    name: '10′ roll-up door',
    caption: 'with the featured 10′ roll-up door',
  },
  center: {
    width: (L) => L * 0.6,
    center: () => 0,
    name: 'center opening',
    caption: 'with a center opening to outdoor training',
  },
  partial: {
    width: (L) => L / 2 - 0.6,
    center: (L) => -L / 4,
    name: 'partial open side',
    caption: 'with a partial open side toward one end',
  },
  full: {
    width: (L) => L - 1.2,
    center: () => 0,
    name: 'full open side',
    caption: 'with a full open side along the training floor',
  },
}

export function containerFigure({ length = 20, opening = 'roll-up', fig = 'Fig 1' } = {}) {
  const long = length === 40
  const WIDTH = long ? 760 : 600
  const HEIGHT = long ? 380 : 400
  const O = OPENINGS[opening]
  const rollUp = opening === 'roll-up'
  // --- Dimensions -------------------------------------------------------------------------------
  const L = length * FT
  const H = 9.5 * FT // 114
  const X1 = L / 2
  const Y1 = 48 // 8′ wide
  const RAIL = 6 // bottom and top rail height
  const POST = 4.8
  const CAST = { x: 7, y: 6.4 }
  const TOP0 = H - RAIL // underside of the top rails
  const FLOOR = 6.8 // top of the rubber floor
  const OW = O.width(length) * FT // opening width
  const OC = O.center(length) * FT // opening center
  const OL = OC - OW / 2
  const OR = OC + OW / 2
  const IN = X1 - 5.8 // inside face of the lining at the ends

  const list = [
    ['concrete piers', 30],
    ['base frame', 52],
    ['end frames + blind end wall', 56],
    ['28 mm plywood floor', 40],
    ['rear side wall', 56],
    ['studs, spray foam, lining + power', 30],
    ['rubber floor, tile by tile', 22],
    ['training equipment', 42],
    ...(rollUp ? [['10′ roll-up door', 40]] : []),
    [rollUp ? 'front wall + door opening' : `front wall + ${O.name}`, 56],
    ['roof panel', 50],
    ['cargo doors close', 30],
  ]
  const STAGES = list.map(([name, drop]) => ({ name, drop }))
  const ST = Object.fromEntries(list.map(([name], i) => [name, i]))
  const DOOR = STAGES.length - 1
  const ROOF = DOOR - 1
  const FRONT = DOOR - 2
  const ROLL = rollUp ? DOOR - 3 : -1
  const SPACING = long ? 0.62 : 0.6
  const FIRST = 0.3
  const DUR = SPACING
  const SWING = 0.9 // cargo doors: after landing open, they swing shut
  const SHUTTER = { from: 0.5, to: 1.75 } // roll-up stage time window for the shutter, from its start

  const pad = { x0: -X1 - 46, x1: X1 + 32, y0: -66, y1: 96 }
  const P = k.fitProjection(
    [
      ...k.boxCorners(
        { x: pad.x0, y: pad.y0, w: pad.x1 - pad.x0, d: pad.y1 - pad.y0, r: 0 },
        -16,
        -8,
      ),
      [-X1, -Y1, H + 30],
      [X1, Y1, H],
      [X1 + 30, 0, 60],
    ],
    WIDTH,
    HEIGHT,
    { pad: 26, azimuth: 58 },
  )
  const h = helpers(P)
  const { at, S, Ln, D, plan, box, depth, onY, onX, hole, corrugated } = h
  // The body is a list of items in painter's order. Each item belongs to one build stage, and may
  // carry its place in that stage's stagger (k: 0 first, 1 last).
  const items = []
  // Each item is drawn in one material for the colour theme; MAT is the one in hand.
  let MAT = 'paint'
  const put = (stage, svg, k = null, mat = MAT) => items.push({ stage, svg, k, mat })
  const byDepth = (list) => [...list].sort((a, b) => a.depth - b.depth)
  const span = (from, to, step) => {
    const out = []
    for (let x = from; x <= to + 1e-6; x += step) out.push(x)
    return out
  }
  sitePad(h, put, P, { ...pad, ruler: [-X1, X1, 74] })
  const LINING = ST['studs, spray foam, lining + power']
  // The condenser and power pedestal at the blind end.
  put(LINING, condenserSvg(h, P, -X1 - 40, -6, -X1), 1, 'galv')
  put(
    LINING,
    S(box(-X1 - 24, -X1 - 16, 30, 38, -8, 34, 0.4)) +
      Ln(onY(38, -X1 - 22.6, -X1 - 17.4, 18, 30), { tone: 'faint' }) +
      D([at([-X1 - 20, 38, 26])], { size: 0.45, tone: 'hi' }),
    0.9,
    'galv',
  )
  // --- Concrete piers under the corner castings and every 10′ between ---------------------------
  const pierX = span(-X1 + 4, X1 - 4, (L - 8) / (long ? 4 : 2))
  const PIERS = pierX
    .flatMap((x) => [
      [x, -44],
      [x, 44],
    ])
    .map(([x, y]) => ({ x, y, depth: depth(x, y) }))
  byDepth(PIERS).forEach((p, i) => {
    const pl = plan(p.x - 8, p.x + 8, p.y - 7, p.y + 7, 0.8)
    put(
      0,
      S(k.slabOf(pl, -8, 8, P, 3, 0.6), { tone: 'lo' }) +
        D([at([p.x - 4.5, p.y, 0]), at([p.x + 4.5, p.y, 0])], { size: 0.45 }),
      i / (PIERS.length - 1),
      'concrete',
    )
  })

  // --- Base frame, back half (front rail and +x sill come after the floor) ----------------------
  const casting = (x0, y0, z0, faces) => {
    const out = [S(box(x0, x0 + CAST.x, y0, y0 + CAST.y, z0, z0 + RAIL, 0.4))]
    if (faces.includes('y'))
      out.push(hole(onY(y0 + CAST.y, x0 + 1.6, x0 + 5.4, z0 + 1.6, z0 + 4.4)))
    if (faces.includes('x'))
      out.push(hole(onX(x0 + CAST.x, y0 + 1.8, y0 + 4.6, z0 + 1.6, z0 + 4.4)))
    return out.join('')
  }
  const pockets = long ? [] : [-41, 41]
  put(1, S(box(-X1 + CAST.x, X1 - CAST.x, -Y1, -Y1 + 3, 0, RAIL, 0.4)))
  put(1, casting(-X1, -Y1, 0, ''))
  put(1, S(box(-X1, -X1 + 3, -Y1 + CAST.y, Y1 - CAST.y, 0, RAIL, 0.4)))
  const sweep = (x) => 0.2 + ((x + X1) / L) * 0.8
  const members = span(-X1 + 12, X1 - 12, FT).filter(
    (x) => !pockets.some((p) => Math.abs(x - p) < 8),
  )
  for (const x of members)
    put(1, S(box(x - 1.2, x + 1.2, -Y1 + 3, Y1 - 3, 1, 5, 0.3), { tone: 'lo' }), sweep(x))
  for (const x of pockets) put(1, S(box(x - 7, x + 7, -Y1 + 3, Y1 - 3, 0.8, 5.2, 0.4)), sweep(x))
  put(1, casting(X1 - CAST.x, -Y1, 0, 'x'))

  // --- Plywood floor, notched round the corner castings -----------------------------------------
  {
    const a = X1 - 7
    const b = X1 - 3
    const c = 41.6
    const e = 45
    const ring = [
      [-b, -c],
      [-a, -c],
      [-a, -e],
      [a, -e],
      [a, -c],
      [b, -c],
      [b, c],
      [a, c],
      [a, e],
      [-a, e],
      [-a, c],
      [-b, c],
    ]
    const seams = span(-X1 + 51, X1 - 40, 48)
      .map((x) => k.lineOnTop([x, -e], [x, e], RAIL, P))
      .join('')
    const screws = []
    for (const x of members) for (const y of [-38, 0, 38]) screws.push(at([x, y, RAIL]))
    put(
      ST['28 mm plywood floor'],
      S(k.extrude(ring, RAIL - 1.1, 1.1, P, { convex: false }), {
        tone: 'lo',
        inner: Ln(seams, { tone: 'faint' }),
      }) + D(screws, { size: 0.35, tone: 'lo' }),
      null,
      'ply',
    )
  }

  // --- Rear side wall with its top rail, then the blind end frame -------------------------------
  put(ST['rear side wall'], corrugated('x', -X1 + 4.8, X1 - 4.8, -45.8, RAIL, TOP0, 1))
  put(ST['rear side wall'], S(box(-X1 + CAST.x, X1 - CAST.x, -Y1, -Y1 + 2.9, TOP0, H, 0.4)))
  put(2, corrugated('y', -42.4, 42.4, -X1 + 2.6, RAIL, TOP0, 1))
  put(2, S(box(-X1, -X1 + 3.4, -Y1 + CAST.y, Y1 - CAST.y, TOP0, H, 0.4)))
  put(2, S(box(-X1, -X1 + POST, -Y1, -Y1 + POST, RAIL, TOP0, 0.4)))
  put(2, casting(-X1, -Y1, TOP0, ''))
  put(2, S(box(X1 - POST, X1, -Y1, -Y1 + POST, RAIL, TOP0, 0.4)))
  put(2, casting(X1 - CAST.x, -Y1, TOP0, 'x'))

  // --- Furring studs, closed-cell spray foam into the corrugations, then the lining panels -------
  {
    const foam = []
    for (const x of span(-X1 + 12, X1 - 12, 9))
      for (let z = 12; z <= 102; z += 9) foam.push(at([x + ((z / 9) % 2) * 4.5, -44.6, z]))
    put(
      LINING,
      S(box(-IN, IN, -45.6, -44.6, FLOOR, 107.4), { tone: 'lo', crease: 'none' }) +
        D(foam, { size: 0.35, tone: 'faint' }),
      0.2,
      'foam',
    )
    put(
      LINING,
      S(box(-X1 + 3, -X1 + 4, -42.4, 42.4, FLOOR, 107.4), { tone: 'lo', crease: 'none' }),
      0.2,
      'foam',
    )
    // Furring studs at 16″ centres, set left to right.
    const studs = span(-X1 + 8, X1 - 8, 16).map((x) =>
      S(box(x - 0.75, x + 0.75, -45, -44.2, FLOOR, 107.4), { tone: 'mid' }),
    )
    studs.forEach((svg, i) => put(LINING, svg, (0.15 * i) / (studs.length - 1), 'pine'))
    MAT = 'lining'
    // Lining in 4′-8″ panels, then the end wall.
    const count = Math.round((2 * IN) / 57)
    const edges = Array.from({ length: count + 1 }, (_, i) => -IN + (2 * IN * i) / count)
    edges
      .slice(0, -1)
      .forEach((x0, i) =>
        put(
          LINING,
          S(box(x0, edges[i + 1], -44.2, -42.8, FLOOR, 107.4), { tone: 'hi', crease: 'lo' }),
          0.35 + (0.3 * i) / Math.max(1, count - 1),
        ),
      )
    const endSeams = [-14, 14].map((y) => k.segment([-IN, y, FLOOR], [-IN, y, 107.4], P)).join('')
    put(
      LINING,
      S(box(-IN - 1.4, -IN, -42.8, 43.2, FLOOR, 107.4), {
        tone: 'hi',
        crease: 'lo',
        inner: Ln(endSeams, { tone: 'faint' }),
      }),
      0.7,
    )
    // Duplex outlets low on the rear wall.
    for (const x of span(-X1 + 24, X1 - 16, long ? 72 : 100))
      put(
        LINING,
        S(box(x - 1.6, x + 1.6, -42.8, -42.2, 17, 21.4), { tone: 'lo' }) +
          D([at([x, -42.2, 18.4]), at([x, -42.2, 20])], { size: 0.3, tone: 'mid' }),
        0.95,
      )
    // Conduit from the panel up the end wall and along to the LED channel.
    put(LINING, S(box(-IN, -IN + 1.2, 27.4, 28.6, 70, 100), { tone: 'lo' }), 0.8, 'galv')
    put(LINING, S(box(-IN, -IN + 1.2, -41.2, 28.6, 100, 101.2), { tone: 'lo' }), 0.8, 'galv')
    put(LINING, S(box(-IN, X1 - 10, -42.8, -41.2, 101.4, 103), { tone: 'hi', crease: 'lo' }), 0.85)
    put(
      LINING,
      S(box(-IN, -IN + 3, 22, 34, 52, 70, 0.3)) +
        Ln(onX(-IN + 3, 23.2, 32.8, 53.2, 68.8), { tone: 'faint' }) +
        D([at([-IN + 3, 31.6, 61])], { size: 0.45, tone: 'hi' }),
      0.75,
      'galv',
    )
    // Wall-mounted mini-splits high on the rear wall, with their discharge slots.
    for (const x of long ? [-100, 140] : [70])
      put(
        LINING,
        S(box(x - 18, x + 18, -42.8, -36.6, 84, 95, 0.5), { tone: 'hi', crease: 'lo' }) +
          Ln(onY(-36.6, x - 15, x + 15, 85.4, 86.8), { tone: 'lo' }) +
          D([at([x + 14.8, -36.6, 92.6])], { size: 0.4, tone: 'hi' }),
        1,
      )
    MAT = 'paint'
  }

  // --- Rubber floor laid tile by tile, 2′ squares in a sweep from the back corner ---------------
  {
    const x0 = -IN
    const x1 = X1 - 4.8
    const y0 = -42.8
    const y1 = 45
    const tiles = []
    for (let x = x0; x < x1 - 0.5; x += 24)
      for (let y = y0; y < y1 - 0.5; y += 24) {
        const xb = Math.min(x + 24, x1)
        const yb = Math.min(y + 24, y1)
        tiles.push({ x, y, xb, yb, d: depth((x + xb) / 2, (y + yb) / 2) })
      }
    tiles.sort((a, b) => a.d - b.d)
    for (const t of tiles)
      put(
        ST['rubber floor, tile by tile'],
        S(box(t.x + 0.15, t.xb - 0.15, t.y + 0.15, t.yb - 0.15, RAIL, FLOOR, 0.2), { tone: 'lo' }),
        ((t.x - x0) / (x1 - x0) + (t.y - y0) / (y1 - y0)) / 2,
        'rubber',
      )
  }

  // --- Training equipment: one set per 20′ ------------------------------------------------------
  for (const dx of long ? [-120, 118] : [0])
    equipment(h, put, ST['training equipment'], P, [dx, 0, 0])

  // --- Roll-up door: guides, coil box and the shutter (redrawn live) ----------------------------
  const SH = { x0: OL + 1, x1: OR - 1, y0: 41.6, y1: 42.6, top: 88, slat: 2.8 }
  const SHUTTER_REST = 85
  if (rollUp) {
    MAT = 'galv'
    for (const x of [OL - 1.6, OR - 1]) put(ROLL, S(box(x, x + 2.6, 40.6, 43.8, FLOOR, 88, 0.3)), 0)
    put(ROLL, `<g data-shutter>${shutterSvg(k, P, SHUTTER_REST, SH)}</g>`)
    put(
      ROLL,
      S(box(OL - 2, OR + 2, 34, 44, 88, 98, 0.6), {
        inner: Ln(k.segment([OL - 2, 44, 93], [OR + 2, 44, 93], P), { tone: 'faint' }),
      }),
      0.4,
    )
    MAT = 'paint'
  }

  // --- Roof panel with transverse pressings -----------------------------------------------------
  {
    const out = [S(box(-X1 + 7, X1 - 7, -45.1, 45.1, 111.2, 112.6, 0.3))]
    for (const x of span(-X1 + 14, X1 - 18, 13.8))
      out.push(S(box(x, x + 6, -40, 40, 112.6, 113.2, 0.2), { crease: 'none' }))
    put(ROOF, out.join(''))
  }

  // --- Front of the base frame, in front of the floor -------------------------------------------
  put(1, casting(-X1, Y1 - CAST.y, 0, 'y'))
  {
    const rail = [S(box(-X1 + CAST.x, X1 - CAST.x, Y1 - 3, Y1, 0, RAIL, 0.4))]
    for (const x of pockets) rail.push(hole(onY(Y1, x - 7, x + 7, 1, 5)))
    put(1, rail.join(''))
  }
  put(1, S(box(X1 - 3, X1, -Y1 + CAST.y, Y1 - CAST.y, 0, RAIL, 0.4)))

  // --- Front side wall either side of the opening, its top rail and the welded opening frame ----
  const leftPanel = [-X1 + 4.8, OL - 4]
  const rightPanel = [OR + 4, X1 - 4.8]
  if (leftPanel[1] - leftPanel[0] > 2)
    put(FRONT, corrugated('x', leftPanel[0], leftPanel[1], 45.6, RAIL, TOP0, 1), 0)
  if (rightPanel[1] - rightPanel[0] > 2)
    put(FRONT, corrugated('x', rightPanel[0], rightPanel[1], 45.6, RAIL, TOP0, 1), 0.25)
  put(
    FRONT,
    S(box(Math.max(OL, -X1 + POST), Math.min(OR, X1 - POST), 44.6, 48, RAIL, 7.2, 0.3)),
    0.45,
  )
  // Jamb posts either side, unless the opening runs right up to a corner post.
  const hx0 = Math.max(OL - 4, -X1 + POST)
  const hx1 = Math.min(OR + 4, X1 - POST)
  for (const x of [OL - 4, OR])
    if (x >= -X1 + POST && x + 4 <= X1 - POST)
      put(FRONT, S(box(x, x + 4, 44, 48, RAIL, 98, 0.4)), x < OC ? 0.55 : 0.65)
  // The welded header over the opening, with the one engraved word.
  put(
    FRONT,
    S(box(hx0, hx1, 44, 48, 98, TOP0, 0.4)) +
      k.faceTextSvg(k.sideMatrix([OC, 48], 101.6, P, 'left'), 'FURY', {
        size: 5,
        tone: 'hi',
        anchor: 'middle',
      }),
    0.8,
  )
  // Wide openings get two intermediate posts, at thirds, to carry the header.
  if (OW > 160)
    for (const x of [OL + OW / 3, OL + (2 * OW) / 3])
      put(FRONT, S(box(x - 2, x + 2, 44, 48, 7.2, 98, 0.4)), 0.7)
  put(
    FRONT,
    S(box(-X1 + CAST.x, X1 - CAST.x, Y1 - 2.9, Y1, TOP0, H, 0.4)) +
      [-X1 + 20, -X1 + 36, X1 - 36, X1 - 20]
        .map((x) => hole(onY(Y1, x - 4, x + 4, TOP0 + 1.8, TOP0 + 3.4)))
        .join(''),
    1,
  )
  // Wall packs over the wall panels either side of the opening.
  for (const [a, b] of [leftPanel, rightPanel])
    if (b - a > 24) {
      const x = (a + b) / 2
      put(
        FRONT,
        S(box(x - 4, x + 4, 47.6, 51, 88, 94, 0.4)) +
          S(box(x - 3.2, x + 3.2, 49.6, 51.6, 86.6, 88, 0.2), { tone: 'hi', mat: 'lens' }),
        1,
        'blacksteel',
      )
    }

  // --- Front corner posts and the door-end header -----------------------------------------------
  put(2, S(box(-X1, -X1 + POST, Y1 - POST, Y1, RAIL, TOP0, 0.4)))
  put(2, casting(-X1, Y1 - CAST.y, TOP0, 'y'))
  put(2, S(box(X1 - 3.4, X1, -Y1 + CAST.y, Y1 - CAST.y, TOP0, H, 0.4)))

  // --- Cargo doors (redrawn live while they swing) ----------------------------------------------
  const LEAF = {
    width: 41.4,
    thick: 1.2,
    z0: 8,
    z1: 107,
    pressings: [16, 34, 52, 70, 88],
    bars: [0.28, 0.72],
    handle: 46,
    hinges: [18, 44, 70, 96],
  }
  const pivotX = X1 - 1.2
  const leafOf = (side) => ({ ...LEAF, pivot: [pivotX, side * 42.4] })
  put(DOOR, `<g data-leaf="-1">${leafSvg(k, P, -1, 0, leafOf(-1))}</g>`)
  put(DOOR, `<g data-leaf="1">${leafSvg(k, P, 1, 0, leafOf(1))}</g>`)

  // --- The nearest corner, last -----------------------------------------------------------------
  put(1, casting(X1 - CAST.x, Y1 - CAST.y, 0, 'xy'))
  put(2, S(box(X1 - POST, X1, Y1 - POST, Y1, RAIL, TOP0, 0.4)))
  put(2, casting(X1 - CAST.x, Y1 - CAST.y, TOP0, 'xy'))

  const sqft = length * 8
  const tag = rollUp ? (long ? '40′ Container Gym' : 'Container Gym') : `Container · ${O.name}`
  return {
    id: `container${long ? '-40' : ''}${rollUp ? '' : `-${opening}`}`,
    fig,
    title: `${tag} · build`,
    width: WIDTH,
    height: HEIGHT,
    P,
    stages: STAGES,
    spacing: SPACING,
    first: FIRST,
    dur: DUR,
    items,
    doors: { stage: DOOR, swing: SWING, leaf: LEAF, pivotX, pivotY: 42.4, open: 1.45 },
    shutter: rollUp ? { stage: ROLL, rest: SHUTTER_REST, window: SHUTTER, sh: SH } : null,
    label: `A ${length}-foot Fury Container Gym ${O.caption}, assembling itself on a concrete pad: ${STAGES.map((s) => s.name).join(', ')}.`,
    caption: `A ${length}′ Container Gym ${O.caption}: the base frame and end frames are set on piers, each corrugated side wall is welded in with its own top rail, the walls are studded, foamed, lined and wired, the rubber floor goes down tile by tile, the gym is fitted out, and the roof and cargo doors close it up. Nominal ${length}′ × 8′ × 9′6″, ${sqft} sq ft.`,
    done: `built · ${length}′ × 8′ × 9′6″ · ${sqft} sq ft`,
    keys: [
      { mark: 'lit', label: 'The pieces being set now' },
      { mark: 'raised', label: 'Steel frame and corrugated shell' },
      { mark: 'flat', label: 'Floor build-up: plywood under rubber' },
    ],
  }
}
