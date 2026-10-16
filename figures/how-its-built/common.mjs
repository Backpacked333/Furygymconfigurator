// Drawing helpers shared by every "how it's built" figure. World units are inches (1 ft = 12):
// x along the unit's length, y across its width with the front at +y, z up.
import * as k from '../kit/iso-kit.mjs'
import * as G from '../kit/lathe.mjs'

export const FT = 12

/** Helpers bound to one projection. */
export function helpers(P) {
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

  return { at, S, Ln, D, plan, box, depth, onY, onX, hole, alongX, alongY, corrugated }
}

// --- Rounded sections along any axis ------------------------------------------------------------
const area = (ring) => {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}
const ccw = (ring) => (area(ring) < 0 ? [...ring].reverse() : ring)
const screenWound = (points, sign = 1) =>
  Math.sign(area(points)) === sign ? points : [...points].reverse()

/** The frame for a section drawn in the x–z plane and pushed along +y: u = x, v = z, s = y. */
export const ACROSS_Y = G.frameOf([0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1])

/** A rounded rectangle in a section plane, as points. */
export const roundedSection = (x0, x1, z0, z1, r, steps = 10) =>
  k.roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, steps)

/** Cuts a convex section to the band lo ≤ v ≤ hi (the second coordinate, or the first with axis 0). */
export function cutSection(ring, lo, hi, axis = 1) {
  const clip = (points, keep, cross) => {
    const out = []
    for (let i = 0; i < points.length; i++) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      if (keep(a)) out.push(a)
      if (keep(a) !== keep(b)) out.push(cross(a, b))
    }
    return out
  }
  const o = 1 - axis
  const at = (z) => (a, b) => {
    const t = (z - a[axis]) / (b[axis] - a[axis])
    const p = []
    p[axis] = z
    p[o] = a[o] + (b[o] - a[o]) * t
    return p
  }
  return clip(
    clip(ring, (p) => p[axis] >= lo, at(lo)),
    (p) => p[axis] <= hi,
    at(hi),
  )
}

/**
 * A section with a hole (a portal, a frame) pushed along F.a from s0 to s1. Returns the visible
 * faces of the cavity (`inner`, drawn before anything inside it) and the outside with its front
 * face (`outer`, drawn after), so whatever sits inside is seen only through the opening. Faces are
 * shaded in the kit's four tones by facing, and rounded corners carry no crease.
 */
export function shellOf(F, outer, hole, s0, s1, P) {
  const V = G.viewOf(P)
  const L = G.lightOf(P)
  const pt = (s, [x, y]) => [
    F.o[0] + F.a[0] * s + F.u[0] * x + F.v[0] * y,
    F.o[1] + F.a[1] * s + F.u[1] * x + F.v[1] * y,
    F.o[2] + F.a[2] * s + F.u[2] * x + F.v[2] * y,
  ]
  const P2 = (p) => k.iso(p, P)
  const sharpAt = (ring, j) => {
    const n = ring.length
    const a = [ring[j][0] - ring[(j - 1 + n) % n][0], ring[j][1] - ring[(j - 1 + n) % n][1]]
    const b = [ring[(j + 1) % n][0] - ring[j][0], ring[(j + 1) % n][1] - ring[j][1]]
    const c = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b) || 1)
    return c < Math.cos(0.35)
  }
  const faces = (ring, sign) => {
    const n = ring.length
    const low = ring.map((p) => P2(pt(s0, p)))
    const high = ring.map((p) => P2(pt(s1, p)))
    const list = []
    for (let j = 0; j < n; j++) {
      const [x0, y0] = ring[j]
      const [x1, y1] = ring[(j + 1) % n]
      const normal = G.mul3(G.unit3(G.add3(G.mul3(F.u, y1 - y0), G.mul3(F.v, -(x1 - x0)))), sign)
      const seen = G.dot3(normal, V) > 1e-6
      list.push({
        seen,
        band: G.bandOf(G.dot3(normal, L)),
        quad: [low[j], low[(j + 1) % n], high[(j + 1) % n], high[j]],
      })
    }
    return { list, low, high }
  }
  const pack = (list) => {
    const buckets = [[], [], [], [], []]
    for (const f of list) if (f.seen) buckets[f.band].push(k.pathOf(screenWound(f.quad), true))
    return buckets
  }

  const out = ccw(outer)
  const inn = hole ? ccw(hole) : null
  const result = {}
  if (inn) {
    const f = faces(inn, -1)
    const buckets = pack(f.list)
    const back = []
    const crease = []
    f.list.forEach((face, j) => {
      if (!face.seen) return
      back.push(k.pathOf([f.low[j], f.low[(j + 1) % inn.length]]))
      if (sharpAt(inn, j) && f.list[(j - 1 + inn.length) % inn.length].seen)
        crease.push(k.pathOf([f.low[j], f.high[j]]))
    })
    result.inner = {
      fill: f.list
        .filter((x) => x.seen)
        .map((x) => k.pathOf(screenWound(x.quad), true))
        .join(''),
      outline: back.join(''),
      crease: crease.join(''),
      top: buckets[4].join(''),
      shades: buckets.slice(0, 4).map((list) => list.join('')),
    }
  }
  const f = faces(out, 1)
  const buckets = pack(f.list)
  const capSeen = G.dot3(F.a, V) > 1e-6
  const capRing = capSeen ? f.high : f.low
  const holeRing = inn ? inn.map((p) => P2(pt(capSeen ? s1 : s0, p))) : null
  const cap =
    k.pathOf(screenWound(capRing), true) +
    (holeRing ? k.pathOf(screenWound(holeRing, -1), true) : '')
  buckets[G.bandOf(G.dot3(capSeen ? F.a : G.mul3(F.a, -1), L))].push(cap)
  const hull = G.hullOf([...f.low, ...f.high])
  const crease = []
  f.list.forEach((face, j) => {
    if (!face.seen) return
    crease.push(k.pathOf([capRing[j], capRing[(j + 1) % out.length]]))
    if (sharpAt(out, j) && f.list[(j - 1 + out.length) % out.length].seen)
      crease.push(k.pathOf([f.low[j], f.high[j]]))
  })
  result.outer = {
    fill:
      k.pathOf(screenWound(hull), true) +
      (holeRing ? k.pathOf(screenWound(holeRing, -1), true) : ''),
    outline: k.pathOf(hull, true) + (holeRing ? k.pathOf(holeRing, true) : ''),
    crease: crease.join(''),
    top: buckets[4].join(''),
    shades: buckets.slice(0, 4).map((list) => list.join('')),
  }
  return result
}

/** A flat polygon on a plane, painted like a face: fill, one shade and an outline. */
export function faceOf(points, P, tone = 2) {
  const ring = points.map((p) => k.iso(p, P))
  const d = k.pathOf(ring, true)
  const shades = ['', '', '', '']
  shades[tone] = d
  return { fill: d, outline: d, crease: '', top: '', shades }
}

// --- The site: concrete pad, foot ruler and label plate ------------------------------------------
export function sitePad(h, put, P, { x0, x1, y0, y1, ruler }) {
  const { S, Ln, D, plan, at } = h
  const PAD = plan(x0, x1, y0, y1, 3)
  put(-1, `<path class="iso-halo" d="${k.haloOf(PAD, -16, 8, P)}"/>`)
  put(-1, S(k.slabOf(PAD, -16, 8, P, 4, 1.2), { tone: 'lo' }))
  const [rx0, rx1, ry] = ruler
  const strip = plan(rx0, rx1, ry, ry + 6, 0.6)
  put(-1, S(k.slabOf(strip, -8, 0.6, P, 3), { tone: 'lo', crease: 'none' }))
  const ticks = k.topTicks(rx0, rx1, FT, 5, ry, -7.4, [2.2, 4], P)
  put(-1, Ln(ticks.minor, { tone: 'lo' }) + Ln(ticks.major, { tone: 'mid' }))
  put(-1, D([at([rx0 + 1.5, ry + 4.5, -7.4]), at([rx1 - 1.5, ry + 4.5, -7.4])], { size: 0.45 }))
  const lx = x1 - 50
  const ly = ry + 9
  const label = plan(lx, lx + 34, ly, ly + 10, 0.8)
  put(
    -1,
    S(k.slabOf(label, -8, 0.8, P, 3), { tone: 'lo' }) +
      Ln(k.planOutline(k.insetPlan(label, 1.4), -7.2, P, 3), { tone: 'faint' }),
  )
  put(
    -1,
    Ln(
      k.lineOnTop([lx + 4, ly + 3], [lx + 24, ly + 3], -7.2, P) +
        k.lineOnTop([lx + 4, ly + 5.4], [lx + 18, ly + 5.4], -7.2, P) +
        k.lineOnTop([lx + 4, ly + 7.8], [lx + 27, ly + 7.8], -7.2, P),
      { tone: 'lo', free: true },
    ),
  )
  put(-1, D([at([lx + 2.4, ly + 2.4, -7.2]), at([lx + 31.6, ly + 7.6, -7.2])], { size: 0.4 }))
}

// --- Training equipment, drawn against a back wall at y = -42.8 on a floor at z = 6.8 ------------
// `place` shifts the whole set (exact in this camera), so the Studio reuses it on its own floor.
export function equipment(h, put, stage, P, shift = [0, 0, 0], { rack = true } = {}) {
  const { S, Ln, D, plan, box, at, onY, alongX, alongY } = h
  const FLOOR = 6.8
  const move = k.translateAlong(P, shift)
  // Pieces are carried in one after another: each gets its place in the stage's stagger.
  const pieces = []
  const add = (svg) => pieces.push(`<g transform="${move}">${svg}</g>`)
  // Mirror on the rear wall.
  add(
    S(box(-14, 34, -42.8, -42, 14, 92, 0.3), {
      tone: 'hi',
      crease: 'lo',
      inner: Ln(
        k.segment([-6, -42, 14], [14, -42, 92], P) + k.segment([2, -42, 14], [22, -42, 92], P),
        { tone: 'faint' },
      ),
    }),
  )
  if (rack) {
    // Power rack: two feet, four uprights with hole rows, crossbars, J-hooks, safeties, pull-up bar.
    const XS = [-70, -27]
    for (const x of XS) add(S(box(x - 0.6, x + 3.6, -42, -14, FLOOR, 9.2, 0.3), { tone: 'lo' }))
    for (const x of XS) add(S(box(x, x + 3, -41, -38, 9.2, 96, 0.3)))
    add(S(box(-67, -27, -41, -38, 92, 95, 0.3)))
    for (const x of XS) add(S(box(x, x + 3, -38, -21, 92, 95, 0.3)))
    for (const x of XS) {
      const holes = []
      for (let z = 18; z <= 88; z += 3.5) holes.push(at([x + 1.5, -18, z]))
      add(S(box(x, x + 3, -21, -18, 9.2, 96, 0.3)) + D(holes, { size: 0.32, tone: 'lo' }))
      add(S(box(x, x + 3, -18, -6, 29, 31.6, 0.3)) + S(box(x - 0.4, x + 3.4, -7.2, -5.6, 29, 33)))
      add(
        S(box(x, x + 3, -18, -14.2, 52.6, 54.8, 0.3)) + S(box(x, x + 3, -15.2, -14.2, 54.8, 57.4)),
      )
    }
    add(S(box(-67, -27, -21, -18, 92, 95, 0.3)))
    add(S(G.disc(-71, -24, 0.8, alongX([0, -19.5, 95.8]), P)))
    // Barbell racked on the J-hooks: shaft, sleeves, collars and two bumper plates a side.
    const BAR = alongX([0, -16.2, 55.6])
    add(S(G.disc(-91, -6, 0.6, BAR, P), { tone: 'hi' }))
    for (const [a, b] of [
      [-91, -76],
      [-21, -6],
    ])
      add(S(G.disc(a, b, 1, BAR, P), { tone: 'hi' }))
    const plate = (a, b) =>
      S(G.disc(a, b, 8.8, BAR, P), {
        tone: 'hi',
        inner: Ln(G.circleOf(BAR, b, 2.4, P) + G.circleOf(BAR, b, 7.6, P), { tone: 'faint' }),
      })
    add(S(G.disc(-74.8, -74, 1.5, BAR, P)))
    add(plate(-77.6, -74.8))
    add(plate(-80.4, -77.6))
    add(S(G.disc(-23, -22, 1.5, BAR, P)))
    add(plate(-22, -19.2))
    add(plate(-19.2, -16.4))
  } else {
    // Mats for mobility and recovery, rolled flat in front of the mirror.
    for (const x of [-70, -40])
      add(
        S(k.slabOf(plan(x, x + 24, -36, 36, 2), FLOOR, 0.6, P, 3), {
          tone: 'hi',
          crease: 'lo',
        }),
      )
  }
  // Dumbbell rack with two tiers of five pairs.
  const legs = [
    [40, -42.4],
    [96, -42.4],
    [40, -28],
    [96, -28],
  ]
  for (const [x, y] of legs.slice(0, 2)) add(S(box(x, x + 2, y, y + 2, FLOOR, 32, 0.3)))
  const tier = (z, r) => {
    add(S(box(40, 98, -42.4, -26, z, z + 1.6, 0.4)))
    for (let i = 4; i >= 0; i--) {
      const x = 46 + i * 11.6
      const F = alongY([x, 0, z + 1.6 + r])
      add(
        S(G.disc(-41.4, -37.6, r, F, P)) +
          S(G.disc(-37.6, -31.4, 0.7, F, P), { tone: 'hi' }) +
          S(G.disc(-31.4, -27.6, r, F, P), {
            inner: Ln(G.circleOf(F, -27.6, r * 0.45, P), { tone: 'faint' }),
          }),
      )
    }
  }
  tier(13, 3.6)
  tier(27.2, 2.8)
  for (const [x, y] of legs.slice(2)) add(S(box(x, x + 2, y, y + 2, FLOOR, 32, 0.3)))
  if (rack) {
    // Flat bench in front of the rack.
    add(S(box(-53, -41, -7, -3, FLOOR, 9, 0.3), { tone: 'lo' }) + S(box(-48, -46, -6, -4, 9, 12.5)))
    add(S(box(-48, -46, -6, 30, 12.5, 15.5, 0.3)))
    add(S(box(-53, -41, 27, 31, FLOOR, 9, 0.3), { tone: 'lo' }) + S(box(-48, -46, 28, 30, 9, 12.5)))
    add(
      S(k.slabOf(plan(-51.6, -42.4, -8, 32, 1.6), 15.5, 4, P, 4, 0.6), {
        tone: 'hi',
        crease: 'lo',
      }),
    )
  }
  // Kettlebells, heaviest first.
  for (const [x, r] of [
    [64, 4.4],
    [76, 3.9],
    [87, 3.4],
  ]) {
    const y = 28
    const zc = FLOOR + r
    const horn = (dx) => S(k.cylinder(x + dx, y, 0.7, zc + r * 0.55, r * 0.75 + 2.4, P, 12))
    add(
      horn(-r * 0.55) +
        S(G.sphereOf([x, y, zc], r, P), { tone: 'hi' }) +
        horn(r * 0.55) +
        S(G.disc(-r * 0.55 - 0.7, r * 0.55 + 0.7, 0.75, alongX([x, y, zc + r * 1.3 + 2.4]), P)),
    )
  }
  // Plyometric box with a hand slot.
  add(
    S(box(96, 112, 8, 26, FLOOR, 30, 0.5), {
      inner: Ln(onY(26, 100, 108, 24.2, 26.8), { tone: 'lo' }),
    }),
  )
  pieces.forEach((svg, i) => put(stage, svg, i / Math.max(1, pieces.length - 1)))
}

/** An outdoor condenser for the mini-split: louvred case, fan grille on top, line set to the wall. */
export function condenserSvg(h, P, x0, y0, wallX = null) {
  const { S, Ln, box, D, at } = h
  const g = -8
  const x1 = x0 + 26
  const y1 = y0 + 13
  const top = g + 4 + 25
  const out = [S(box(x0 + 1, x1 - 1, y0 + 1, y1 - 1, g, g + 4, 0.3), { tone: 'lo' })]
  const louvres = []
  for (let z = g + 8; z < top - 3; z += 2.6)
    louvres.push(k.segment([x0, y1, z], [x1, y1, z], P), k.segment([x1, y0, z], [x1, y1, z], P))
  out.push(
    S(box(x0, x1, y0, y1, g + 4, top, 0.5), {
      tone: 'mid',
      inner: Ln(louvres.join(''), { tone: 'faint' }),
    }),
  )
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  out.push(Ln(k.ring(cx, cy, 5.6, top, P, 40) + k.ring(cx, cy, 3.6, top, P, 32), { tone: 'lo' }))
  const spokes = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    spokes.push(
      k.lineOnTop(
        [cx + Math.cos(a) * 1.2, cy + Math.sin(a) * 1.2],
        [cx + Math.cos(a) * 5.6, cy + Math.sin(a) * 5.6],
        top,
        P,
      ),
    )
  }
  out.push(Ln(k.ring(cx, cy, 1.2, top, P, 16) + spokes.join(''), { tone: 'lo' }))
  out.push(
    D(
      [
        at([x0 + 2, y0 + 2, top]),
        at([x1 - 2, y0 + 2, top]),
        at([x0 + 2, y1 - 2, top]),
        at([x1 - 2, y1 - 2, top]),
      ],
      { size: 0.4 },
    ),
  )
  if (wallX !== null) {
    // Insulated line set and a power whip running to the wall.
    const [a, b] = wallX < x0 ? [wallX, x0] : [x1, wallX]
    out.push(S(box(a, b, y0 + 3, y0 + 5.4, g + 14, g + 16.4, 0.3), { tone: 'lo' }))
    out.push(S(box(a, b, y0 + 7, y0 + 8.6, g + 10, g + 11.6, 0.2), { tone: 'lo' }))
  }
  return out.join('')
}
