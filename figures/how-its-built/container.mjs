// Fig 1: a 20-foot Container Gym in twelve steps. Part sizes follow the configurator's container
// model (src/render/architecture.ts); geometry is illustrative, not manufacturer CAD.
import * as k from '../kit/iso-kit.mjs'
import { condenserSvg, equipment, FT, helpers, sitePad } from './common.mjs'
import { leafSvg, shutterSvg } from './moving.mjs'

export function containerFigure() {
  const WIDTH = 600
  const HEIGHT = 400
  // --- Dimensions -------------------------------------------------------------------------------
  const L = 20 * FT // 240
  const H = 9.5 * FT // 114
  const X1 = L / 2 // 120
  const Y1 = 48 // 8′ wide
  const RAIL = 6 // bottom and top rail height
  const POST = 4.8
  const CAST = { x: 7, y: 6.4 }
  const TOP0 = H - RAIL // 108: underside of the top rails
  const FLOOR = 6.8 // top of the rubber floor

  const STAGES = [
    { name: 'concrete piers', drop: 30 },
    { name: 'base frame', drop: 52 },
    { name: 'end frames + blind end wall', drop: 56 },
    { name: '28 mm plywood floor', drop: 40 },
    { name: 'rear side wall', drop: 56 },
    { name: 'studs, spray foam, lining + power', drop: 30 },
    { name: 'rubber floor, tile by tile', drop: 22 },
    { name: 'training equipment', drop: 42 },
    { name: '10′ roll-up door', drop: 40 },
    { name: 'front wall + door opening', drop: 56 },
    { name: 'roof panel', drop: 50 },
    { name: 'cargo doors close', drop: 30 },
  ]
  const SPACING = 0.6
  const FIRST = 0.3
  const DUR = 0.6
  const SWING = 0.9 // cargo doors: after landing open, they swing shut
  const SHUTTER = { from: 0.5, to: 1.75 } // roll-up stage time window for the shutter, from its start

  const P = k.fitProjection(
    [
      ...k.boxCorners({ x: -166, y: -66, w: 318, d: 162, r: 0 }, -16, -8),
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
  // The body is a list of items in painter's order. Each item belongs to one build stage.
  const items = []
  const put = (stage, svg, k = null) => items.push({ stage, svg, k })
  const byDepth = (list) => [...list].sort((a, b) => a.depth - b.depth)
  sitePad(h, put, P, { x0: -166, x1: 152, y0: -66, y1: 96, ruler: [-X1, X1, 74] })
  // The condenser and power pedestal at the blind end.
  put(5, condenserSvg(h, P, -160, -6, -X1), 1)
  put(
    5,
    S(box(-144, -136, 30, 38, -8, 34, 0.4)) +
      Ln(onY(38, -142.6, -137.4, 18, 30), { tone: 'faint' }) +
      D([at([-140, 38, 26])], { size: 0.45, tone: 'hi' }),
    0.9,
  )
  // --- 0: Concrete piers under the corner castings and at mid-span -------------------------------
  const PIERS = [
    [-116, -44],
    [0, -44],
    [116, -44],
    [-116, 44],
    [0, 44],
    [116, 44],
  ].map(([x, y]) => ({ x, y, depth: depth(x, y) }))
  byDepth(PIERS).forEach((p, i) => {
    const pl = plan(p.x - 8, p.x + 8, p.y - 7, p.y + 7, 0.8)
    put(
      0,
      S(k.slabOf(pl, -8, 8, P, 3, 0.6), { tone: 'lo' }) +
        D([at([p.x - 4.5, p.y, 0]), at([p.x + 4.5, p.y, 0])], { size: 0.45 }),
      i / 5,
    )
  })

  // --- 1: Base frame, back half (front rail and +x sill come after the floor) --------------------
  const casting = (x0, y0, z0, faces) => {
    const out = [S(box(x0, x0 + CAST.x, y0, y0 + CAST.y, z0, z0 + RAIL, 0.4))]
    if (faces.includes('y'))
      out.push(hole(onY(y0 + CAST.y, x0 + 1.6, x0 + 5.4, z0 + 1.6, z0 + 4.4)))
    if (faces.includes('x'))
      out.push(hole(onX(x0 + CAST.x, y0 + 1.8, y0 + 4.6, z0 + 1.6, z0 + 4.4)))
    return out.join('')
  }
  put(1, S(box(-X1 + CAST.x, X1 - CAST.x, -Y1, -Y1 + 3, 0, RAIL, 0.4)))
  put(1, casting(-X1, -Y1, 0, ''))
  put(1, S(box(-X1, -X1 + 3, -Y1 + CAST.y, Y1 - CAST.y, 0, RAIL, 0.4)))
  for (let x = -108; x <= 108; x += FT) {
    const pocket = Math.abs(Math.abs(x) - 36) < 1
    if (pocket) continue
    put(
      1,
      S(box(x - 1.2, x + 1.2, -Y1 + 3, Y1 - 3, 1, 5, 0.3), { tone: 'lo' }),
      0.2 + ((x + 108) / 216) * 0.8,
    )
  }
  for (const x of [-41, 41]) {
    put(1, S(box(x - 7, x + 7, -Y1 + 3, Y1 - 3, 0.8, 5.2, 0.4)), 0.2 + ((x + 108) / 216) * 0.8)
  }
  put(1, casting(X1 - CAST.x, -Y1, 0, 'x'))

  // --- 3: Plywood floor, notched round the corner castings ---------------------------------------
  {
    const a = 113,
      b = 117,
      c = 41.6,
      e = 45
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
    const seams = [-69, -21, 27, 75].map((x) => k.lineOnTop([x, -e], [x, e], RAIL, P)).join('')
    const screws = []
    for (let x = -108; x <= 108; x += FT)
      if (Math.abs(Math.abs(x) - 36) > 1)
        for (const y of [-38, 0, 38]) screws.push(at([x, y, RAIL]))
    put(
      3,
      S(k.extrude(ring, RAIL - 1.1, 1.1, P, { convex: false }), {
        tone: 'lo',
        inner: Ln(seams, { tone: 'faint' }),
      }) + D(screws, { size: 0.35, tone: 'lo' }),
    )
  }

  // --- 4 + 2: Rear side wall with its top rail, then the blind end frame -------------------------
  put(4, corrugated('x', -115.2, 115.2, -45.8, RAIL, TOP0, 1))
  put(4, S(box(-X1 + CAST.x, X1 - CAST.x, -Y1, -Y1 + 2.9, TOP0, H, 0.4)))
  put(2, corrugated('y', -42.4, 42.4, -117.4, RAIL, TOP0, 1))
  put(2, S(box(-X1, -X1 + 3.4, -Y1 + CAST.y, Y1 - CAST.y, TOP0, H, 0.4)))
  put(2, S(box(-X1, -X1 + POST, -Y1, -Y1 + POST, RAIL, TOP0, 0.4)))
  put(2, casting(-X1, -Y1, TOP0, ''))
  put(2, S(box(X1 - POST, X1, -Y1, -Y1 + POST, RAIL, TOP0, 0.4)))
  put(2, casting(X1 - CAST.x, -Y1, TOP0, 'x'))

  // --- 5: Furring studs, closed-cell spray foam into the corrugations, then the lining panels ----
  {
    // Spray foam filling the rear wall's corrugations, and the end wall's.
    const foam = []
    for (let x = -108; x <= 108; x += 9)
      for (let z = 12; z <= 102; z += 9) foam.push(at([x + ((z / 9) % 2) * 4.5, -44.6, z]))
    put(
      5,
      S(box(-114.2, 114.2, -45.6, -44.6, FLOOR, 107.4), { tone: 'lo', crease: 'none' }) +
        D(foam, { size: 0.35, tone: 'faint' }),
      0.2,
    )
    put(5, S(box(-117, -116, -42.4, 42.4, FLOOR, 107.4), { tone: 'lo', crease: 'none' }), 0.2)
    // Furring studs at 16″ centres, set left to right.
    const studs = []
    for (let x = -112; x <= 112; x += 16)
      studs.push(S(box(x - 0.75, x + 0.75, -45, -44.2, FLOOR, 107.4), { tone: 'mid' }))
    studs.forEach((svg, i) => put(5, svg, (0.15 * i) / (studs.length - 1)))
    // Lining in four panels, then the end wall.
    const panels = [-114.2, -57, 0, 57, 114.2]
    panels
      .slice(0, -1)
      .forEach((x0, i) =>
        put(
          5,
          S(box(x0, panels[i + 1], -44.2, -42.8, FLOOR, 107.4), { tone: 'hi', crease: 'lo' }),
          0.35 + i * 0.1,
        ),
      )
    const endSeams = [-14, 14]
      .map((y) => k.segment([-114.2, y, FLOOR], [-114.2, y, 107.4], P))
      .join('')
    put(
      5,
      S(box(-115.6, -114.2, -42.8, 43.2, FLOOR, 107.4), {
        tone: 'hi',
        crease: 'lo',
        inner: Ln(endSeams, { tone: 'faint' }),
      }),
      0.7,
    )
    // Duplex outlets low on the rear wall.
    for (const x of [-96, 6, 104])
      put(
        5,
        S(box(x - 1.6, x + 1.6, -42.8, -42.2, 17, 21.4), { tone: 'lo' }) +
          D([at([x, -42.2, 18.4]), at([x, -42.2, 20])], { size: 0.3, tone: 'mid' }),
        0.95,
      )
    // Conduit from the panel up the end wall and along to the LED channel.
    put(5, S(box(-114.2, -113, 27.4, 28.6, 70, 100), { tone: 'lo' }), 0.8)
    put(5, S(box(-114.2, -113, -41.2, 28.6, 100, 101.2), { tone: 'lo' }), 0.8)
    put(5, S(box(-114.2, 110, -42.8, -41.2, 101.4, 103), { tone: 'hi', crease: 'lo' }), 0.85)
    put(
      5,
      S(box(-114.2, -111.2, 22, 34, 52, 70, 0.3)) +
        Ln(onX(-111.2, 23.2, 32.8, 53.2, 68.8), { tone: 'faint' }) +
        D([at([-111.2, 31.6, 61])], { size: 0.45, tone: 'hi' }),
      0.75,
    )
    // Wall-mounted mini-split high on the rear wall, with its discharge slot.
    put(
      5,
      S(box(52, 88, -42.8, -36.6, 84, 95, 0.5), { tone: 'hi', crease: 'lo' }) +
        Ln(onY(-36.6, 55, 85, 85.4, 86.8), { tone: 'lo' }) +
        D([at([84.8, -36.6, 92.6])], { size: 0.4, tone: 'hi' }),
      1,
    )
  }

  // --- 6: Rubber floor laid tile by tile, 2′ squares in a sweep from the back corner ------------
  {
    const x0 = -114.2,
      x1 = 115.2,
      y0 = -42.8,
      y1 = 45
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
        6,
        S(box(t.x + 0.15, t.xb - 0.15, t.y + 0.15, t.yb - 0.15, RAIL, FLOOR, 0.2), { tone: 'lo' }),
        ((t.x - x0) / (x1 - x0) + (t.y - y0) / (y1 - y0)) / 2,
      )
  }

  equipment(h, put, 7, P)

  // --- 8: Roll-up door: guides, coil box and the shutter (redrawn live) --------------------------
  const SH = { x0: -59, x1: 59, y0: 41.6, y1: 42.6, top: 88, slat: 2.8 }
  const SHUTTER_REST = 85
  for (const x of [-61.6, 59]) put(8, S(box(x, x + 2.6, 40.6, 43.8, FLOOR, 88, 0.3)), 0)
  put(8, `<g data-shutter>${shutterSvg(k, P, SHUTTER_REST, SH)}</g>`)
  put(
    8,
    S(box(-62, 62, 34, 44, 88, 98, 0.6), {
      inner: Ln(k.segment([-62, 44, 93], [62, 44, 93], P), { tone: 'faint' }),
    }),
  )

  // --- 10: Roof panel with transverse pressings --------------------------------------------------
  {
    const out = [S(box(-113, 113, -45.1, 45.1, 111.2, 112.6, 0.3))]
    for (let x = -106; x < 108; x += 13.8)
      out.push(S(box(x, x + 6, -40, 40, 112.6, 113.2, 0.2), { crease: 'none' }))
    put(10, out.join(''))
  }

  // --- 1: Front of the base frame, in front of the floor ----------------------------------------
  put(1, casting(-X1, Y1 - CAST.y, 0, 'y'))
  {
    const rail = [S(box(-X1 + CAST.x, X1 - CAST.x, Y1 - 3, Y1, 0, RAIL, 0.4))]
    for (const x of [-41, 41]) rail.push(hole(onY(Y1, x - 7, x + 7, 1, 5)))
    put(1, rail.join(''))
  }
  put(1, S(box(X1 - 3, X1, -Y1 + CAST.y, Y1 - CAST.y, 0, RAIL, 0.4)))

  // --- 9: Front side wall either side of the opening, its top rail and the welded opening frame --
  put(9, corrugated('x', -115.2, -64, 45.6, RAIL, TOP0, 1), 0)
  put(9, corrugated('x', 64, 115.2, 45.6, RAIL, TOP0, 1), 0.25)
  put(9, S(box(-60, 60, 44.6, 48, RAIL, 7.2, 0.3)), 0.45)
  for (const x of [-64, 60]) put(9, S(box(x, x + 4, 44, 48, RAIL, 98, 0.4)), x < 0 ? 0.55 : 0.65)
  put(
    9,
    S(box(-64, 64, 44, 48, 98, TOP0, 0.4)) +
      k.faceTextSvg(k.sideMatrix([0, 48], 101.6, P, 'left'), 'FURY', {
        size: 5,
        tone: 'hi',
        anchor: 'middle',
      }),
    0.8,
  )
  put(
    9,
    S(box(-X1 + CAST.x, X1 - CAST.x, Y1 - 2.9, Y1, TOP0, H, 0.4)) +
      [-100, -84, 84, 100].map((x) => hole(onY(Y1, x - 4, x + 4, TOP0 + 1.8, TOP0 + 3.4))).join(''),
    1,
  )
  // Wall packs over the wall either side of the opening.
  for (const x of [-90, 90]) {
    put(
      9,
      S(box(x - 4, x + 4, 47.6, 51, 88, 94, 0.4)) +
        S(box(x - 3.2, x + 3.2, 49.6, 51.6, 86.6, 88, 0.2), { tone: 'hi' }),
      1,
    )
  }

  // --- 2: Front corner posts and the door-end header ---------------------------------------------
  put(2, S(box(-X1, -X1 + POST, Y1 - POST, Y1, RAIL, TOP0, 0.4)))
  put(2, casting(-X1, Y1 - CAST.y, TOP0, 'y'))
  put(2, S(box(X1 - 3.4, X1, -Y1 + CAST.y, Y1 - CAST.y, TOP0, H, 0.4)))

  // --- 11: Cargo doors (redrawn live while they swing) ------------------------------------------
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
  const leafOf = (side) => ({ ...LEAF, pivot: [118.8, side * 42.4] })
  put(11, `<g data-leaf="-1">${leafSvg(k, P, -1, 0, leafOf(-1))}</g>`)
  put(11, `<g data-leaf="1">${leafSvg(k, P, 1, 0, leafOf(1))}</g>`)

  // --- 2: The nearest corner, last ----------------------------------------------------------------
  put(1, casting(X1 - CAST.x, Y1 - CAST.y, 0, 'xy'))
  put(2, S(box(X1 - POST, X1, Y1 - POST, Y1, RAIL, TOP0, 0.4)))
  put(2, casting(X1 - CAST.x, Y1 - CAST.y, TOP0, 'xy'))

  return {
    id: 'container',
    fig: 'Fig 1',
    title: 'Container gym · build',
    width: WIDTH,
    height: HEIGHT,
    P,
    stages: STAGES.map((s) => ({ ...s })),
    spacing: SPACING,
    first: FIRST,
    dur: DUR,
    items,
    doors: { stage: 11, swing: SWING, leaf: LEAF, pivotX: 118.8, pivotY: 42.4, open: 1.45 },
    shutter: { stage: 8, rest: SHUTTER_REST, window: SHUTTER, sh: SH },
    label:
      'A 20-foot Fury container gym assembling itself on a concrete pad: piers, the steel base frame, end frames with corner posts, a plywood floor, the corrugated rear wall, an insulated lining with lights and power, a rubber floor, a power rack, bench, dumbbells and kettlebells, the roll-up door, the front wall with its 10-foot opening, the roof, and finally the cargo doors swinging shut.',
    caption:
      'A 20-foot Container Gym: the base frame and end frames are set on piers, each corrugated side wall is welded in with its own top rail, the inside is lined, wired and floored, the gym is fitted out, and the roof and cargo doors close it up. Nominal 20′ × 8′ × 9′6″, 160 sq ft, with the featured 10′ roll-up door.',
    done: 'built · 20′ × 8′ × 9′6″ · 160 sq ft',
    keys: [
      { mark: 'lit', label: 'The assembly being set now' },
      { mark: 'raised', label: 'Steel frame and corrugated shell' },
      { mark: 'flat', label: 'Floor build-up: plywood under rubber' },
    ],
  }
}
