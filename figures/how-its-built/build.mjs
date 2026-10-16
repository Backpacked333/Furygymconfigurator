// "How a Fury container gym is built": an isometric figure that assembles a 20-foot Container Gym
// in twelve steps over about seven seconds, then takes it apart and starts again.
//
//   node figures/how-its-built/build.mjs          → public/how-its-built.html
//   node figures/how-its-built/build.mjs --light  → public/how-its-built-light.html
//
// World units are inches (1 ft = 12): x along the 20′ length, y across the 8′ width, z up.
// Nominal sizes come from src/lib/products.ts; part sizes follow the configurator's container model
// (src/render/architecture.ts). Geometry is illustrative, not manufacturer CAD.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as k from '../kit/iso-kit.mjs'
import * as G from '../kit/lathe.mjs'
import { leafSvg, shutterSvg } from './moving.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'public')
const theme = process.argv.includes('--light') ? 'light' : 'dark'

const WIDTH = 600
const HEIGHT = 400

// --- Dimensions -------------------------------------------------------------------------------
const FT = 12
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
  { name: 'insulated lining + electrics', drop: 40 },
  { name: 'rubber performance floor', drop: 30 },
  { name: 'training equipment', drop: 42 },
  { name: '10′ roll-up door', drop: 40 },
  { name: 'front wall + door opening', drop: 56 },
  { name: 'roof panel', drop: 50 },
  { name: 'cargo doors close', drop: 30 },
]
const SPACING = 0.5
const FIRST = 0.2
const DUR = 0.5
const SWING = 0.75 // cargo doors: after landing open, they swing shut
const SHUTTER = { from: 0.45, to: 1.55 } // roll-up stage time window for the shutter, from its start

const P = k.fitProjection(
  [
    ...k.boxCorners({ x: -138, y: -62, w: 290, d: 140, r: 0 }, -16, -8),
    [-X1, -Y1, H + 30],
    [X1, Y1, H],
    [X1 + 30, 0, 60],
  ],
  WIDTH,
  HEIGHT,
  { pad: 26, azimuth: 58 },
)

// --- Drawing helpers --------------------------------------------------------------------------
const at = (point) => k.iso(point, P)
const S = (paths, style = {}) => k.solidSvg(paths, { tone: 'mid', ...style })
const Ln = (d, style) => k.lineSvg(d, style)
const D = (points, style) => k.dotsSvg(points, style)
const plan = (x0, x1, y0, y1, r = 0.3) => ({ x: x0, y: y0, w: x1 - x0, d: y1 - y0, r })
const box = (x0, x1, y0, y1, z0, z1, bevel = 0, steps = 2) =>
  k.slabOf(
    plan(x0, x1, y0, y1, Math.min(0.4, (x1 - x0) / 3, (y1 - y0) / 3)),
    z0,
    z1 - z0,
    P,
    steps,
    bevel,
  )
const depth = (x, y, z = 0) => k.depthOf([x, y, z], P)
/** A closed outline on a face of constant y, for apertures, slots and panel doors. */
const onY = (y, x0, x1, z0, z1) =>
  k.pathOf([at([x0, y, z0]), at([x1, y, z0]), at([x1, y, z1]), at([x0, y, z1])], true)
const onX = (x, y0, y1, z0, z1) =>
  k.pathOf([at([x, y0, z0]), at([x, y1, z0]), at([x, y1, z1]), at([x, y0, z1])], true)
const hole = (d) => `<path class="cg-hole" d="${d}"/>`
const alongX = (o) => G.frameAlong(o, [1, 0, 0])
const alongY = (o) => G.frameAlong(o, [0, 1, 0])

/**
 * A trapezoid-corrugated sheet, the steel wall of an ISO container. The pressed side faces `face`
 * (+y or +x), the flat back plane sits behind it, and every fold gets a faint line from rail to rail.
 */
function corrugated(axis, from, to, plane, z0, z1, face = 1) {
  const pitch = 11.2
  const crest = 3.4
  const slope = 2.2
  const deep = 1.6
  const knots = []
  for (let base = from + 1.2; base < to; base += pitch)
    for (const [ds, off] of [
      [0, 0],
      [slope, deep],
      [slope + crest, deep],
      [2 * slope + crest, 0],
    ])
      knots.push([base + ds, off])
  const profile = [[from, 0]]
  for (const [s, off] of knots) {
    const [ps, poff] = profile[profile.length - 1]
    if (s <= to - 0.6) profile.push([s, off])
    else {
      profile.push([to, poff + ((off - poff) * (to - ps)) / Math.max(1e-6, s - ps)])
      break
    }
  }
  if (profile[profile.length - 1][0] < to) profile.push([to, profile[profile.length - 1][1]])
  const pt = (s, off) => (axis === 'x' ? [s, plane + face * off] : [plane + face * off, s])
  const ring = [...profile.map(([s, off]) => pt(s, off)), pt(to, -0.4), pt(from, -0.4)]
  const folds = profile.slice(1, -1).map(([s, off]) => {
    const [x, y] = pt(s, off)
    return k.segment([x, y, z0], [x, y, z1], P)
  })
  return S(k.extrude(ring, z0, z1 - z0, P, { convex: false }), {
    inner: Ln(folds.join(''), { tone: 'faint' }),
  })
}

// The body is a list of items in painter's order. Each item belongs to one build stage.
const items = []
const put = (stage, svg) => items.push({ stage, svg })
const byDepth = (list) => [...list].sort((a, b) => a.depth - b.depth)

// --- Site: pad, ruler and label plate (always there) ------------------------------------------
const PAD = plan(-138, 152, -62, 80, 3)
put(-1, `<path class="iso-halo" d="${k.haloOf(PAD, -16, 8, P)}"/>`)
put(-1, S(k.slabOf(PAD, -16, 8, P, 4, 1.2), { tone: 'lo' }))
{
  const strip = plan(-X1, X1, 58, 64, 0.6)
  put(-1, S(k.slabOf(strip, -8, 0.6, P, 3), { tone: 'lo', crease: 'none' }))
  const ticks = k.topTicks(-X1, X1, FT, 5, 58, -7.4, [2.2, 4], P)
  put(-1, Ln(ticks.minor, { tone: 'lo' }) + Ln(ticks.major, { tone: 'mid' }))
  put(-1, D([at([-X1 + 1.5, 62.5, -7.4]), at([X1 - 1.5, 62.5, -7.4])], { size: 0.45 }))
  const label = plan(102, 136, 67, 77, 0.8)
  put(
    -1,
    S(k.slabOf(label, -8, 0.8, P, 3), { tone: 'lo' }) +
      Ln(k.planOutline(k.insetPlan(label, 1.4), -7.2, P, 3), { tone: 'faint' }),
  )
  put(
    -1,
    Ln(
      k.lineOnTop([106, 70], [126, 70], -7.2, P) +
        k.lineOnTop([106, 72.4], [120, 72.4], -7.2, P) +
        k.lineOnTop([106, 74.8], [129, 74.8], -7.2, P),
      { tone: 'lo', free: true },
    ),
  )
  put(-1, D([at([104.4, 69.4, -7.2]), at([133.6, 74.6, -7.2])], { size: 0.4 }))
}

// --- 0: Concrete piers under the corner castings and at mid-span -------------------------------
const PIERS = [
  [-116, -44],
  [0, -44],
  [116, -44],
  [-116, 44],
  [0, 44],
  [116, 44],
].map(([x, y]) => ({ x, y, depth: depth(x, y) }))
for (const p of byDepth(PIERS)) {
  const pl = plan(p.x - 8, p.x + 8, p.y - 7, p.y + 7, 0.8)
  put(
    0,
    S(k.slabOf(pl, -8, 8, P, 3, 0.6), { tone: 'lo' }) +
      D([at([p.x - 4.5, p.y, 0]), at([p.x + 4.5, p.y, 0])], { size: 0.45 }),
  )
}

// --- 1: Base frame, back half (front rail and +x sill come after the floor) --------------------
const casting = (x0, y0, z0, faces) => {
  const out = [S(box(x0, x0 + CAST.x, y0, y0 + CAST.y, z0, z0 + RAIL, 0.4))]
  if (faces.includes('y')) out.push(hole(onY(y0 + CAST.y, x0 + 1.6, x0 + 5.4, z0 + 1.6, z0 + 4.4)))
  if (faces.includes('x')) out.push(hole(onX(x0 + CAST.x, y0 + 1.8, y0 + 4.6, z0 + 1.6, z0 + 4.4)))
  return out.join('')
}
put(1, S(box(-X1 + CAST.x, X1 - CAST.x, -Y1, -Y1 + 3, 0, RAIL, 0.4)))
put(1, casting(-X1, -Y1, 0, ''))
put(1, S(box(-X1, -X1 + 3, -Y1 + CAST.y, Y1 - CAST.y, 0, RAIL, 0.4)))
for (let x = -108; x <= 108; x += FT) {
  const pocket = Math.abs(Math.abs(x) - 36) < 1
  if (pocket) continue
  put(1, S(box(x - 1.2, x + 1.2, -Y1 + 3, Y1 - 3, 1, 5, 0.3), { tone: 'lo' }))
}
for (const x of [-41, 41]) {
  put(1, S(box(x - 7, x + 7, -Y1 + 3, Y1 - 3, 0.8, 5.2, 0.4)))
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
    if (Math.abs(Math.abs(x) - 36) > 1) for (const y of [-38, 0, 38]) screws.push(at([x, y, RAIL]))
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

// --- 5: Insulated lining and electrics on the rear and end walls -------------------------------
{
  const seams = [-72, -24, 24, 72]
    .map((x) => k.segment([x, -42.8, FLOOR], [x, -42.8, 107.4], P))
    .join('')
  put(
    5,
    S(box(-114.2, 114.2, -44.2, -42.8, FLOOR, 107.4), {
      tone: 'hi',
      crease: 'lo',
      inner: Ln(seams, { tone: 'faint' }),
    }),
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
  )
  // Duplex outlets low on the rear wall.
  for (const x of [-96, 6, 104])
    put(
      5,
      S(box(x - 1.6, x + 1.6, -42.8, -42.2, 17, 21.4), { tone: 'lo' }) +
        D([at([x, -42.2, 18.4]), at([x, -42.2, 20])], { size: 0.3, tone: 'mid' }),
    )
  // Conduit from the panel up the end wall and along to the LED channel.
  put(5, S(box(-114.2, -113, 27.4, 28.6, 70, 100), { tone: 'lo' }))
  put(5, S(box(-114.2, -113, -41.2, 28.6, 100, 101.2), { tone: 'lo' }))
  put(5, S(box(-114.2, 110, -42.8, -41.2, 101.4, 103), { tone: 'hi', crease: 'lo' }))
  put(
    5,
    S(box(-114.2, -111.2, 22, 34, 52, 70, 0.3)) +
      Ln(onX(-111.2, 23.2, 32.8, 53.2, 68.8), { tone: 'faint' }) +
      D([at([-111.2, 31.6, 61])], { size: 0.45, tone: 'hi' }),
  )
  // Wall-mounted mini-split high on the rear wall, with its discharge slot.
  put(
    5,
    S(box(52, 88, -42.8, -36.6, 84, 95, 0.5), { tone: 'hi', crease: 'lo' }) +
      Ln(onY(-36.6, 55, 85, 85.4, 86.8), { tone: 'lo' }) +
      D([at([84.8, -36.6, 92.6])], { size: 0.4, tone: 'hi' }),
  )
}

// --- 6: Rubber performance floor with 2′ tile joints ------------------------------------------
{
  const x0 = -114.2,
    x1 = 115.2,
    y0 = -42.8,
    y1 = 45
  const joints = []
  for (let x = -96; x < x1; x += 24) joints.push(k.lineOnTop([x, y0], [x, y1], FLOOR, P))
  for (let y = -24; y < y1; y += 24) joints.push(k.lineOnTop([x0, y], [x1, y], FLOOR, P))
  put(
    6,
    S(box(x0, x1, y0, y1, RAIL, FLOOR), {
      tone: 'lo',
      inner: Ln(joints.join(''), { tone: 'faint' }),
    }),
  )
}

// --- 7: Training equipment --------------------------------------------------------------------
// Mirror on the rear wall.
put(
  7,
  S(box(-14, 34, -42.8, -42, 14, 92, 0.3), {
    tone: 'hi',
    crease: 'lo',
    inner: Ln(
      k.segment([-6, -42, 14], [14, -42, 92], P) + k.segment([2, -42, 14], [22, -42, 92], P),
      { tone: 'faint' },
    ),
  }),
)
// Power rack: two feet, four uprights with hole rows, crossbars, J-hooks, safeties, pull-up bar.
{
  const XS = [-70, -27]
  for (const x of XS) put(7, S(box(x - 0.6, x + 3.6, -42, -14, FLOOR, 9.2, 0.3), { tone: 'lo' }))
  for (const x of XS) put(7, S(box(x, x + 3, -41, -38, 9.2, 96, 0.3)))
  put(7, S(box(-67, -27, -41, -38, 92, 95, 0.3)))
  for (const x of XS) put(7, S(box(x, x + 3, -38, -21, 92, 95, 0.3)))
  for (const x of XS) {
    const holes = []
    for (let z = 18; z <= 88; z += 3.5) holes.push(at([x + 1.5, -18, z]))
    put(7, S(box(x, x + 3, -21, -18, 9.2, 96, 0.3)) + D(holes, { size: 0.32, tone: 'lo' }))
    put(7, S(box(x, x + 3, -18, -6, 29, 31.6, 0.3)) + S(box(x - 0.4, x + 3.4, -7.2, -5.6, 29, 33)))
    put(
      7,
      S(box(x, x + 3, -18, -14.2, 52.6, 54.8, 0.3)) + S(box(x, x + 3, -15.2, -14.2, 54.8, 57.4)),
    )
  }
  put(7, S(box(-67, -27, -21, -18, 92, 95, 0.3)))
  put(7, S(G.disc(-71, -24, 0.8, alongX([0, -19.5, 95.8]), P)))
  // Barbell racked on the J-hooks: shaft, sleeves, collars and two bumper plates a side.
  const BAR = alongX([0, -16.2, 55.6])
  put(7, S(G.disc(-91, -6, 0.6, BAR, P), { tone: 'hi' }))
  for (const [a, b] of [
    [-91, -76],
    [-21, -6],
  ])
    put(7, S(G.disc(a, b, 1, BAR, P), { tone: 'hi' }))
  const plates = [
    [-80.4, -77.6],
    [-77.6, -74.8],
    [-22, -19.2],
    [-19.2, -16.4],
  ]
  put(7, S(G.disc(-74.8, -74, 1.5, BAR, P)))
  for (const [a, b] of plates.slice(0, 2).reverse())
    put(
      7,
      S(G.disc(a, b, 8.8, BAR, P), {
        tone: 'hi',
        inner: Ln(G.circleOf(BAR, b, 2.4, P) + G.circleOf(BAR, b, 7.6, P), { tone: 'faint' }),
      }),
    )
  put(7, S(G.disc(-23, -22, 1.5, BAR, P)))
  for (const [a, b] of plates.slice(2))
    put(
      7,
      S(G.disc(a, b, 8.8, BAR, P), {
        tone: 'hi',
        inner: Ln(G.circleOf(BAR, b, 2.4, P) + G.circleOf(BAR, b, 7.6, P), { tone: 'faint' }),
      }),
    )
}
// Dumbbell rack with two tiers of five pairs.
{
  const legs = [
    [40, -42.4],
    [96, -42.4],
    [40, -28],
    [96, -28],
  ]
  for (const [x, y] of legs.slice(0, 2)) put(7, S(box(x, x + 2, y, y + 2, FLOOR, 32, 0.3)))
  const tier = (z, r, stage) => {
    put(stage, S(box(40, 98, -42.4, -26, z, z + 1.6, 0.4)))
    for (let i = 4; i >= 0; i--) {
      const x = 46 + i * 11.6
      const F = alongY([x, 0, z + 1.6 + r])
      put(
        stage,
        S(G.disc(-41.4, -37.6, r, F, P)) +
          S(G.disc(-37.6, -31.4, 0.7, F, P), { tone: 'hi' }) +
          S(G.disc(-31.4, -27.6, r, F, P), {
            inner: Ln(G.circleOf(F, -27.6, r * 0.45, P), { tone: 'faint' }),
          }),
      )
    }
  }
  tier(13, 3.6, 7)
  tier(27.2, 2.8, 7)
  for (const [x, y] of legs.slice(2)) put(7, S(box(x, x + 2, y, y + 2, FLOOR, 32, 0.3)))
}
// Flat bench in front of the rack.
put(7, S(box(-53, -41, -7, -3, FLOOR, 9, 0.3), { tone: 'lo' }) + S(box(-48, -46, -6, -4, 9, 12.5)))
put(7, S(box(-48, -46, -6, 30, 12.5, 15.5, 0.3)))
put(7, S(box(-53, -41, 27, 31, FLOOR, 9, 0.3), { tone: 'lo' }) + S(box(-48, -46, 28, 30, 9, 12.5)))
put(
  7,
  S(k.slabOf(plan(-51.6, -42.4, -8, 32, 1.6), 15.5, 4, P, 4, 0.6), { tone: 'hi', crease: 'lo' }),
)
// Kettlebells by the door, heaviest first.
for (const [x, r] of [
  [64, 4.4],
  [76, 3.9],
  [87, 3.4],
]) {
  const y = 28
  const zc = FLOOR + r
  const horn = (dx) => S(k.cylinder(x + dx, y, 0.7, zc + r * 0.55, r * 0.75 + 2.4, P, 12))
  put(
    7,
    horn(-r * 0.55) +
      S(G.sphereOf([x, y, zc], r, P), { tone: 'hi' }) +
      horn(r * 0.55) +
      S(G.disc(-r * 0.55 - 0.7, r * 0.55 + 0.7, 0.75, alongX([x, y, zc + r * 1.3 + 2.4]), P)),
  )
}
// Plyometric box with a hand slot.
put(
  7,
  S(box(96, 112, 8, 26, FLOOR, 30, 0.5), {
    inner: Ln(onY(26, 100, 108, 24.2, 26.8), { tone: 'lo' }),
  }),
)

// --- 8: Roll-up door: guides, coil box and the shutter (redrawn live) --------------------------
const SH = { x0: -59, x1: 59, y0: 41.6, y1: 42.6, top: 88, slat: 2.8 }
const SHUTTER_REST = 85
for (const x of [-61.6, 59]) put(8, S(box(x, x + 2.6, 40.6, 43.8, FLOOR, 88, 0.3)))
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
put(9, corrugated('x', -115.2, -64, 45.6, RAIL, TOP0, 1))
put(9, corrugated('x', 64, 115.2, 45.6, RAIL, TOP0, 1))
put(9, S(box(-60, 60, 44.6, 48, RAIL, 7.2, 0.3)))
for (const x of [-64, 60]) put(9, S(box(x, x + 4, 44, 48, RAIL, 98, 0.4)))
put(
  9,
  S(box(-64, 64, 44, 48, 98, TOP0, 0.4)) +
    k.faceTextSvg(k.sideMatrix([0, 48], 101.6, P, 'left'), 'FURY', {
      size: 5,
      tone: 'hi',
      anchor: 'middle',
    }),
)
put(9, S(box(-X1 + CAST.x, X1 - CAST.x, Y1 - 2.9, Y1, TOP0, H, 0.4)))

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

// --- Page ---------------------------------------------------------------------------------------
const body = items.map(({ stage, svg }) => (stage < 0 ? svg : `<g data-s="${stage}">${svg}</g>`))
const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  className: 'cg-svg',
  label:
    'A 20-foot Fury container gym assembling itself on a concrete pad: piers, the steel base frame, end frames with corner posts, a plywood floor, the corrugated rear wall, an insulated lining with lights and power, a rubber floor, a power rack, bench, dumbbells and kettlebells, the roll-up door, the front wall with its 10-foot opening, the roof, and finally the cargo doors swinging shut.',
  body,
})

const css = `
.cg-hole{fill:var(--anatomy-shade-0);stroke:var(--anatomy-lo);stroke-width:var(--anatomy-weight);vector-effect:non-scaling-stroke}
.cg-svg [data-s]{transition:none}
.cg-svg [data-s] .iso-edge{transition:stroke .35s ease}
.cg-svg [data-s][data-on] .iso-edge{stroke:var(--anatomy-lit)}
.cg-stage{outline:none;touch-action:pan-y;cursor:ew-resize}
.cg-stage:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:6px}
.cg-steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:2px 16px;margin:0;padding:0;list-style:none;font-family:var(--anatomy-mono);font-size:11.5px;color:var(--anatomy-muted)}
.cg-steps li{transition:color .3s ease}
.cg-steps li[data-on]{color:var(--anatomy-strong)}
.cg-steps li[data-done]{color:var(--anatomy-text)}
`

const timeline = STAGES.map((stage, i) => ({ ...stage, start: FIRST + i * SPACING, dur: DUR }))
const BUILT = timeline[11].start + DUR + SWING
const live = `
${leafSvg.toString()}
${shutterSvg.toString()}
const K = { towardViewer, extrude, solidSvg, cylinder, slabOf, segment, lineSvg };
const P = ${JSON.stringify(P)};
const STAGES = ${JSON.stringify(timeline)};
const LEAF = ${JSON.stringify(LEAF)};
const SH = ${JSON.stringify(SH)};
const SHUTTER_REST = ${SHUTTER_REST}, SWING = ${SWING}, BUILT = ${BUILT.toFixed(2)}, HOLD = 2.6, CLEAR = 1.5, GAP = 0.5;
const SHUT = ${JSON.stringify(SHUTTER)};
const CYCLE = BUILT + HOLD + CLEAR + GAP;
const stage = document.querySelector(".cg-stage");
const svg = stage.querySelector("svg");
const readout = document.querySelector("[data-readout]");
const steps = [...document.querySelectorAll(".cg-steps li")];
const groups = STAGES.map((_, i) => [...svg.querySelectorAll('[data-s="' + i + '"]')]);
const leaves = [-1, 1].map((side) => ({ side, el: svg.querySelector('[data-leaf="' + side + '"]'), angle: -1 }));
const shutter = { el: svg.querySelector("[data-shutter]"), bottom: SHUTTER_REST };
const still = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (t) => t * t * (3 - 2 * t);
const OPEN_ANGLE = 1.45;

// Where every stage is at time t of the loop: its progress (0 → 1), the door angle and the shutter.
function poseAt(t) {
  const out = STAGES.map(() => 0);
  let angle = 0, bottom = SHUTTER_REST;
  if (t < BUILT + HOLD) {
    STAGES.forEach((s, i) => (out[i] = clamp((t - s.start) / s.dur)));
    const doors = STAGES[11];
    angle = OPEN_ANGLE * (1 - smooth(clamp((t - doors.start - doors.dur) / SWING)));
    const roll = clamp((t - STAGES[8].start - SHUT.from) / (SHUT.to - SHUT.from));
    bottom = roll < 0.5 ? SH.top - (SH.top - 40) * smooth(roll / 0.5) : 40 + (SHUTTER_REST - 40) * smooth((roll - 0.5) / 0.5);
    if (roll <= 0) bottom = SH.top;
  } else {
    const u = t - BUILT - HOLD;
    STAGES.forEach((s, i) => (out[i] = 1 - clamp((u - (11 - i) * 0.07) / 0.6)));
  }
  return { out, angle, bottom };
}

let shown = [], lit = [];
function draw(t) {
  const { out, angle, bottom } = poseAt(t);
  out.forEach((p, i) => {
    if (shown[i] === p) return;
    shown[i] = p;
    const lift = STAGES[i].drop * (1 - ease(p));
    const alpha = smooth(clamp(p / 0.45));
    for (const el of groups[i]) {
      el.setAttribute("transform", translateAlong(P, [0, 0, lift]));
      el.style.opacity = alpha.toFixed(3);
      el.style.visibility = p <= 0 ? "hidden" : "";
    }
  });
  const swinging = angle > 0.001 && angle < OPEN_ANGLE - 0.001 && out[11] === 1;
  out.forEach((p, i) => {
    const on = (p > 0 && p < 1) || (i === 11 && swinging);
    if (lit[i] === on) return;
    lit[i] = on;
    for (const el of groups[i]) el.toggleAttribute("data-on", on);
  });
  for (const leaf of leaves) {
    if (Math.abs(leaf.angle - angle) < 1e-4) continue;
    leaf.angle = angle;
    leaf.el.innerHTML = leafSvg(K, P, leaf.side, angle, { ...LEAF, pivot: [118.8, leaf.side * 42.4] });
  }
  if (Math.abs(shutter.bottom - bottom) > 0.01) {
    shutter.bottom = bottom;
    shutter.el.innerHTML = shutterSvg(K, P, bottom, SH);
  }
  // Readout and the step list come from the same pose.
  const started = out.reduce((last, p, i) => (p > 0 ? i : last), -1);
  const building = t < BUILT + HOLD;
  let text;
  if (!building) text = "clearing the pad";
  else if (t >= BUILT) text = "built · 20′ × 8′ × 9′6″ · 160 sq ft";
  else if (started < 0) text = "site ready";
  else text = String(started + 1).padStart(2, "0") + "/12 · " + STAGES[started].name;
  if (readout.textContent !== text) readout.textContent = text;
  steps.forEach((li, i) => {
    const active = building && out[i] > 0 && (out[i] < 1 || (i === 11 && swinging));
    li.toggleAttribute("data-on", active);
    li.toggleAttribute("data-done", building && out[i] >= 1 && !active);
  });
  return started;
}

let t = 0, target = 0, clock = 0, last = 0, frame = 0, visible = false, touring = !still.matches, idle = 0, said = -2;
function describe(started) {
  if (started === said) return;
  said = started;
  stage.setAttribute("aria-valuenow", String(started + 1));
  stage.setAttribute("aria-valuetext", started < 0 ? "Empty site" : "Step " + (started + 1) + " of 12: " + STAGES[started].name);
}
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  if (touring) {
    clock = (clock + dt) % CYCLE;
    t = clock;
  } else {
    t = still.matches ? target : t + (target - t) * (1 - Math.exp(-dt / 0.18));
    if (Math.abs(target - t) < 0.002) t = target;
  }
  describe(draw(t));
  const settled = !touring && t === target;
  frame = visible && !settled ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
const resume = (delay) => {
  clearTimeout(idle);
  if (still.matches) return;
  idle = setTimeout(() => { touring = true; clock = Math.min(t, BUILT); run(); }, delay);
};
const steer = (next) => { touring = false; target = clamp(next, 0, BUILT); resume(3600); run(); };
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
stage.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") return;
  const r = svg.getBoundingClientRect();
  steer(clamp(((event.clientX - r.left) / r.width - 0.12) / 0.76) * BUILT);
});
stage.addEventListener("pointerleave", () => resume(1400));
stage.addEventListener("click", () => { touring = !still.matches; clock = 0; t = target = still.matches ? BUILT : 0; run(); });
const ends = STAGES.map((s, i) => (i === 11 ? BUILT : s.start + s.dur));
stage.addEventListener("keydown", (event) => {
  const now = touring ? Math.min(t, BUILT) : target;
  const at = ends.findIndex((e) => e > now + 0.01);
  const here = at < 0 ? 12 : at;
  let to = null;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") to = here >= 12 ? BUILT : ends[here];
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = here - 2 >= 0 ? ends[here - 2] : 0;
  if (event.key === "Home") to = 0;
  if (event.key === "End") to = BUILT;
  if (event.key === " " || event.key === "Enter") { event.preventDefault(); stage.click(); return; }
  if (to === null) return;
  event.preventDefault();
  if (still.matches) t = to;
  steer(to);
});
if (still.matches) { touring = false; t = target = BUILT; }
describe(draw(still.matches ? BUILT : 0));
`

const stepsHtml = `<ol class="cg-steps">${STAGES.map((s, i) => `<li>${String(i + 1).padStart(2, '0')} ${s.name}</li>`).join('')}</ol>`
const plate = k.plateHtml({
  fig: 'Fig 1',
  title: 'Container gym · build',
  hint: 'Hover to scrub · click to replay',
  readout: 'site ready',
  keys: [
    { mark: 'lit', label: 'The assembly being set now' },
    { mark: 'raised', label: 'Steel frame and corrugated shell' },
    { mark: 'flat', label: 'Floor build-up: plywood under rubber' },
  ],
  caption:
    "How a 20-foot Fury Container Gym goes together, in about seven seconds: the base frame and end frames are set on piers, each corrugated side wall is welded in with its own top rail, the inside is lined, wired and floored, the gym is fitted out, and the roof and cargo doors close it up. Nominal 20′ × 8′ × 9′6″, 160 sq ft, with the featured 10′ roll-up door. Sizes follow Fury's published specs; part geometry is illustrative, not manufacturer CAD.",
  body: `<div class="cg-stage" tabindex="0" role="slider" aria-label="Container gym build sequence. Arrow keys step through the twelve stages, Home and End jump to the start and the finished gym, Enter replays." aria-valuemin="0" aria-valuemax="12" aria-valuenow="0">${svg}</div>`,
})
const page = k.pageHtml({
  title: 'How a Fury container gym is built',
  theme,
  width: 760,
  body:
    plate.replace('</figcaption>', `${stepsHtml}</figcaption>`).replace('<style>', '<style>') +
    `<style>${css}</style>`,
  script:
    readFileSync(join(HERE, '..', 'kit', 'iso-kit.mjs'), 'utf8').replace(/^export /gm, '') + live,
})
const name = theme === 'light' ? 'how-its-built-light.html' : 'how-its-built.html'
writeFileSync(join(OUT, name), page)
console.log(
  'wrote',
  join('public', name),
  `${(page.length / 1024).toFixed(0)} KB`,
  `${items.length} items`,
)
