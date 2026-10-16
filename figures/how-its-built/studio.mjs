// Figs 2–5: the S-Series Studio on its own, with a front deck and gazebo, with a rooftop deck
// and exterior stairs, and stacked two high. Sizes follow src/render/architecture.ts and addons.ts:
// a 20′ × 8′ × 10′ rounded steel portal on a recessed plinth, a fully glazed front with a door in
// the middle bay, a 10.4′ stair of 17 risers, a 3.5′ glass balustrade. Geometry is illustrative.
//
// The build follows the structure: ribs and purlins first, the skin over them, the back closed
// panel by panel, joists and an insulated cassette, the lining, oak laid strip by strip, the
// fit-out, then the glazing pane by pane. Pieces within a step land one after another.
import * as k from '../kit/iso-kit.mjs'
import * as G from '../kit/lathe.mjs'
import {
  ACROSS_Y,
  condenserSvg,
  cutSection,
  equipment,
  faceOf,
  helpers,
  roundedSection,
  shellOf,
  sitePad,
} from './common.mjs'

const X1 = 120 // half of 20′
const BASE = 3.6 // recessed plinth
const HT = 120 // 10′ shell
const WALL = 4.3
const RADIUS = 13.2
const SY0 = -47.2 // back of the shell
const SY1 = 47.2 // front face of the shell
const BACK = -45.8 // inside face of the back skin
const FLOOR = 11.5 // finished floor above the shell bottom
const GLASS = [44.6, 45.8] // glazing frame depth
const MULLIONS = [-68.3, -22.8, 22.8, 68.3]

const VARIANTS = {
  single: {
    fig: 'Fig 2',
    title: 'S-Series Studio · build',
    done: 'built · 20′ × 8′ × 10′ · 160 sq ft',
    pad: { x0: -150, x1: 166, y0: -66, y1: 96 },
    caption:
      'The S-Series Studio: five steel ribs and their purlins stand on a recessed plinth, the rounded skin is set over them, the back is closed panel by panel, joists and an insulated cassette make the floor, the walls are lined and wired, oak goes down strip by strip, the gym is fitted out, and the front is glazed pane by pane with a door in the middle bay. Nominal 20′ × 8′ × 10′, 160 sq ft.',
  },
  deck: {
    fig: 'Fig 3',
    title: 'Studio + deck + gazebo',
    done: 'built · Studio + 8′ deck + gazebo',
    pad: { x0: -150, x1: 166, y0: -66, y1: 182 },
    caption:
      "The Studio with Fury's front deck and gazebo: an 8′ frame of joists on footings, teak boards laid one by one with a front step, then a steel portal that echoes the Studio's outline, tied back by two beams and roofed with tilted teak louvers set one at a time.",
  },
  roof: {
    fig: 'Fig 4',
    title: 'Studio + rooftop deck',
    done: 'built · Studio + rooftop deck + stairs',
    pad: { x0: -150, x1: 186, y0: -66, y1: 190 },
    caption:
      'The Studio with a rooftop deck and exterior stairs: teak boards on the roof, a 3.5′ glass balustrade set panel by panel with a steel top rail, and a 17-riser stair at the end, its treads set from the bottom up, climbing 10.4′ to a landing that meets the gap in the rail.',
  },
  stacked: {
    fig: 'Fig 5',
    title: 'Stacked Studios · build',
    done: 'built · 2 Studios stacked · 320 sq ft',
    pad: { x0: -150, x1: 188, y0: -170, y1: 128 },
    caption:
      'Two Studios stacked (a custom inquiry with Fury): the lower unit is framed, skinned, fitted out and glazed, the upper unit is built on its roof in turn, then an 18-riser stair climbs the end to a front balcony with a glass balustrade. Engineering for stacked units is by inquiry.',
  },
}

export function studioFigure(variant) {
  const meta = VARIANTS[variant]
  const tall = variant === 'stacked'
  const WIDTH = 600
  const HEIGHT = tall ? 560 : 420
  const pad = meta.pad
  const top = tall ? 2 * (BASE + HT) + 48 : variant === 'roof' ? BASE + HT + 48 : BASE + HT + 20
  const P = k.fitProjection(
    [
      ...k.boxCorners(
        { x: pad.x0, y: pad.y0, w: pad.x1 - pad.x0, d: pad.y1 - pad.y0, r: 0 },
        -16,
        -8,
      ),
      [-X1, SY0, top + 26],
      [X1, SY1, top],
    ],
    WIDTH,
    HEIGHT,
    { pad: 26, azimuth: 58 },
  )
  const h = helpers(P)
  const { at, S, Ln, D, box, depth } = h
  const items = []
  const put = (stage, svg, k = null) => items.push({ stage, svg, k })
  /** Puts a list of pieces into one stage, staggered in the order given. */
  const putEach = (stage, list) =>
    list.forEach((svg, i) => put(stage, svg, i / Math.max(1, list.length - 1)))
  const plain = (paths, tone = 'mid', extra = {}) => S(paths, { tone, ...extra })
  const prismY = (poly, y0, y1) => G.prismOf(ACROSS_Y, poly, y0, y1, P)
  const glassFace = (points) =>
    `<path class="cg-glass" d="${k.pathOf(
      points.map((p) => at(p)),
      true,
    )}"/>`

  sitePad(h, put, P, { ...pad, ruler: [-X1, X1, pad.y1 - 22] })

  const stages = []
  const stage = (name, drop = 46) => stages.push({ name, drop }) - 1

  /**
   * One Studio unit standing at height z0, its parts put into the given stages, in painter's order:
   * plinth, the cavity, back wall, ribs, lining, floor, services, equipment, glazing, then the
   * outside of the shell over all of it, so the inside shows only through the glazed front.
   */
  function unit(z0, st, { plinth = true, gear = 'rack', step = false } = {}) {
    const zTop = z0 + BASE + HT
    const OUTER = roundedSection(-X1, X1, z0 + BASE, zTop, RADIUS)
    const INNER = roundedSection(
      -X1 + WALL,
      X1 - WALL,
      z0 + BASE + WALL,
      zTop - WALL,
      RADIUS - WALL,
    )
    const shell = shellOf(ACROSS_Y, OUTER, INNER, SY0, SY1, P)
    const iz0 = z0 + BASE + WALL
    const floorTop = z0 + FLOOR
    const ix = X1 - WALL

    if (plinth) {
      const screws = [
        [-100, -34],
        [0, -34],
        [100, -34],
        [-100, 34],
        [0, 34],
        [100, 34],
      ].sort((a, b) => depth(a[0], a[1]) - depth(b[0], b[1]))
      putEach(
        st.plinth,
        screws.map(
          ([x, y]) =>
            plain(k.cylinder(x, y, 4.6, z0 - 8, 1.2, P, 20), 'lo') +
            plain(k.cylinder(x, y, 3, z0 - 6.8, 6.8, P, 20), 'lo') +
            D([at([x - 2, y, z0]), at([x + 2, y, z0])], { size: 0.4 }),
        ),
      )
      put(
        st.plinth,
        plain(box(-111.6, 111.6, -40.8, 40.8, z0, z0 + BASE, 0.3), 'lo', {
          inner: Ln(
            [-74, -37, 0, 37, 74]
              .map((x) => k.segment([x, 40.8, z0], [x, 40.8, z0 + BASE], P))
              .join(''),
            { tone: 'faint' },
          ),
        }),
        1,
      )
    }
    if (step)
      put(
        st.plinth,
        plain(box(-26, 26, SY1 - 1, 60, -8, 3.4, 0.4), 'lo') +
          Ln(k.lineOnTop([-26, 54], [26, 54], 3.4, P), { tone: 'faint' }),
        1,
      )
    put(st.skin, plain(shell.inner, 'mid', { crease: 'faint' }))

    // Back skin closing the portal, five panels from left to right.
    const backRing = roundedSection(-ix, ix, iz0, zTop - WALL, RADIUS - WALL)
    const cuts = [-ix, -68.3, -22.8, 22.8, 68.3, ix]
    putEach(
      st.back,
      cuts.slice(0, -1).map((x0, i) =>
        plain(
          faceOf(
            cutSection(backRing, x0, cuts[i + 1], 0).map(([x, z]) => [x, BACK, z]),
            P,
            2,
          ),
          'mid',
        ),
      ),
    )

    // Steel ribs, back to front, with purlins along the roof and rails along the end wall.
    const ribRing = roundedSection(-X1 + 0.6, X1 - 0.6, z0 + BASE + 0.6, zTop - 0.6, RADIUS - 0.6)
    const ribs = [-40, -20, 0, 20, 40].map((y) => {
      const r = shellOf(ACROSS_Y, ribRing, INNER, y - 1.4, y + 1.4, P)
      return plain(r.inner, 'hi', { crease: 'lo' }) + plain(r.outer, 'hi', { crease: 'lo' })
    })
    const purlins = [-84, -42, 0, 42, 84].map((x) =>
      plain(box(x - 1.6, x + 1.6, SY0 + 1, SY1 - 1, zTop - WALL, zTop - 0.6, 0.3)),
    )
    const rails = [
      plain(box(X1 - WALL, X1 - 0.6, SY0 + 1, SY1 - 1, z0 + 30, z0 + 33, 0.3)),
      plain(box(X1 - WALL, X1 - 0.6, SY0 + 1, SY1 - 1, z0 + 76, z0 + 79, 0.3)),
    ]
    putEach(st.frame, [...ribs, ...purlins, ...rails])

    // Lining: painted panels on the back and the end wall.
    const lineBack = roundedSection(-ix + 1, ix - 1, iz0 + 1, zTop - WALL - 1, RADIUS - WALL - 1)
    putEach(
      st.lining,
      cuts.slice(0, -1).map((x0, i) => {
        const x1 = cuts[i + 1]
        const poly = cutSection(lineBack, Math.max(x0, -ix + 1), Math.min(x1, ix - 1), 0)
        return S(
          faceOf(
            poly.map(([x, z]) => [x, BACK + 1, z]),
            P,
            3,
          ),
          { tone: 'hi', crease: 'lo' },
        )
      }),
    )
    // The cavity lined all round, over the ribs: walls, ceiling and the rounded corners.
    const LINED = roundedSection(-ix + 1, ix - 1, iz0 + 1, zTop - WALL - 1, RADIUS - WALL - 1)
    const lined = shellOf(ACROSS_Y, INNER, LINED, BACK + 1, GLASS[0] - 0.4, P)
    put(
      st.lining,
      S(lined.inner, { tone: 'hi', crease: 'lo' }) + plain(lined.outer, 'hi', { crease: 'lo' }),
      0.5,
    )

    // Floor: steel joists, then the insulated cassette over them.
    const cassette = cutSection(INNER, iz0, floorTop - 0.8)
    putEach(
      st.floor,
      [-96, -72, -48, -24, 0, 24, 48, 72, 96].map((x) =>
        plain(box(x - 1.2, x + 1.2, BACK, SY1 - 0.4, iz0, floorTop - 1.4, 0.2), 'lo'),
      ),
    )
    put(st.floor, plain(prismY(cassette, BACK, SY1 - 0.4), 'lo'), 1)

    // Services: LED cove, mini-split, room controller, outlets.
    put(
      st.lining,
      plain(box(-100, 100, BACK + 1, BACK + 2.6, z0 + 108, z0 + 109.6), 'hi', { crease: 'lo' }),
      0.7,
    )
    put(
      st.lining,
      plain(box(52, 88, BACK + 1, BACK + 7.2, z0 + 92, z0 + 103, 0.5), 'hi', { crease: 'lo' }) +
        Ln(h.onY(BACK + 7.2, 55, 85, z0 + 93.4, z0 + 94.8), { tone: 'lo' }) +
        D([at([84.8, BACK + 7.2, z0 + 100.6])], { size: 0.4, tone: 'hi' }),
      0.85,
    )
    put(
      st.lining,
      plain(box(-100, -94, BACK + 1, BACK + 1.6, z0 + 52, z0 + 61), 'lo') +
        D([at([-97, BACK + 1.6, z0 + 58.6])], { size: 0.45, tone: 'hi' }) +
        [-40, 40, 100]
          .map(
            (x) =>
              plain(box(x - 1.6, x + 1.6, BACK + 1, BACK + 1.5, z0 + 20, z0 + 24.4), 'lo') +
              D([at([x, BACK + 1.5, z0 + 21.4]), at([x, BACK + 1.5, z0 + 23])], { size: 0.3 }),
          )
          .join(''),
      1,
    )

    // Engineered oak, laid in six strips from the back wall to the glazing.
    const finish = cutSection(INNER, floorTop - 0.8, floorTop)
    const strips = []
    const span = (GLASS[0] - BACK) / 6
    for (let i = 0; i < 6; i++) {
      const y0 = BACK + i * span
      const y1 = y0 + span
      const joints = [-90, -54, -18, 18, 54, 90]
        .map((x) => k.lineOnTop([x + (i % 2) * 18, y0], [x + (i % 2) * 18, y1], floorTop, P))
        .join('')
      strips.push(S(prismY(finish, y0, y1), { tone: 'lo', inner: Ln(joints, { tone: 'faint' }) }))
    }
    putEach(st.finish, strips)

    // Fit-out: a wall screen beside the rack, then the equipment piece by piece.
    if (gear) {
      put(
        st.gear,
        plain(box(-108, -78, BACK + 1, BACK + 2.4, z0 + 66, z0 + 83, 0.3), 'lo') +
          Ln(h.onY(BACK + 2.4, -106.6, -79.4, z0 + 67.4, z0 + 81.6), { tone: 'faint' }) +
          D([at([-80.4, BACK + 2.4, z0 + 68.4])], { size: 0.35, tone: 'hi' }),
        0,
      )
      equipment(h, put, st.gear, P, [0, BACK + 1 + 42.8, floorTop - 6.8], { rack: gear === 'rack' })
    }

    // Glazing: the frame and mullions, then a pane in each bay, then the door.
    const GH = roundedSection(
      -ix + 1.9,
      ix - 1.9,
      iz0 + 1.9,
      zTop - WALL - 1.9,
      RADIUS - WALL - 1.9,
    )
    const frame = shellOf(ACROSS_Y, INNER, GH, GLASS[0], GLASS[1], P)
    const zb = iz0 + 1.9
    const zt = zTop - WALL - 1.9
    put(st.glazing, plain(frame.inner, 'mid'), 0)
    const edges = [-ix + 1.9, ...MULLIONS, ix - 1.9]
    const panes = edges.slice(0, -1).map((x0, i) => {
      const x1 = edges[i + 1]
      const poly = cutSection(GH, x0 + (i ? 1.2 : 0), x1 - (i < 4 ? 1.2 : 0), 0)
      const streak = x1 - x0 > 30 ? k.segment([x0 + 8, 45.2, zb], [x0 + 22, 45.2, zt], P) : ''
      return glassFace(poly.map(([x, z]) => [x, 45.2, z])) + Ln(streak, { tone: 'faint' })
    })
    ;[0, 4, 1, 3, 2].forEach((i, n) => put(st.glazing, panes[i], 0.25 + (n / 4) * 0.5))
    for (const x of MULLIONS)
      put(st.glazing, plain(box(x - 1.2, x + 1.2, GLASS[0], GLASS[1], zb, zt, 0.2)), 0.1)
    put(
      st.glazing,
      plain(box(-21.6, 21.6, GLASS[0], GLASS[1], z0 + 91, z0 + 93, 0.2)) +
        plain(box(-21.6, 21.6, GLASS[0], GLASS[1], floorTop, floorTop + 2, 0.2)),
      0.85,
    )
    put(st.glazing, plain(frame.outer, 'mid'), 0)
    put(
      st.glazing,
      plain(box(-21.6, 21.6, GLASS[1], SY1 + 2.4, floorTop - 1.2, floorTop, 0.3), 'hi', {
        crease: 'lo',
      }) +
        plain(box(13.4, 14.6, GLASS[1], GLASS[1] + 1.6, z0 + 50, z0 + 51.4)) +
        plain(box(13.4, 14.6, GLASS[1], GLASS[1] + 1.6, z0 + 68, z0 + 69.4)) +
        plain(k.cylinder(14, GLASS[1] + 2.2, 0.7, z0 + 46, 28, P, 12), 'hi'),
      1,
    )

    // The outside of the shell over everything inside it, with its standing seams across the roof
    // and along the end wall, FURY engraved small in the front face, gutter outlet and downpipe.
    const seams = []
    for (let x = -96; x <= 96; x += 24) seams.push(k.segment([x, SY0, zTop], [x, SY1, zTop], P))
    for (const z of [36, 66, 96]) seams.push(k.segment([X1, SY0, z0 + z], [X1, SY1, z0 + z], P))
    put(
      st.skin,
      S(shell.outer, {
        tone: 'mid',
        crease: 'faint',
        inner: Ln(seams.join(''), { tone: 'faint' }),
      }),
    )
    put(
      st.skin,
      plain(box(-91, 91, SY1 - 3, SY1 - 2, zTop, zTop + 0.6), 'mid', { crease: 'none' }) +
        k.faceTextSvg(k.sideMatrix([-96, SY1], z0 + 4.4, P, 'left'), 'FURY', {
          size: 2.6,
          tone: 'lo',
          anchor: 'start',
        }),
    )
    const foot = z0 ? z0 : -8
    put(
      st.skin,
      plain(box(X1 - 2, X1 + 3.2, -45, -41, zTop - 6, zTop - 2.4, 0.3)) +
        plain(k.cylinder(X1 + 1.6, -43, 1.3, foot, zTop - 6 - foot, P, 14)) +
        (z0 ? '' : plain(box(X1 - 2, X1 + 6, -48, -38, -8, -7, 0.3), 'lo')),
    )
  }

  /** A glass balustrade along a line on a deck: steel shoe, glass panels, a round top rail. */
  const balustrade = ([x0, y0], [x1, y1], z) => {
    const along = x0 === x1 ? 'y' : 'x'
    const shoe =
      along === 'x'
        ? box(Math.min(x0, x1), Math.max(x0, x1), y0 - 1.6, y0 + 1.6, z, z + 3.8, 0.3)
        : box(x0 - 1.6, x0 + 1.6, Math.min(y0, y1), Math.max(y0, y1), z, z + 3.8, 0.3)
    const zr = z + 42
    const corners = (a, b) =>
      along === 'x'
        ? [
            [a, y0, z + 3.8],
            [b, y0, z + 3.8],
            [b, y0, zr],
            [a, y0, zr],
          ]
        : [
            [x0, a, z + 3.8],
            [x0, b, z + 3.8],
            [x0, b, zr],
            [x0, a, zr],
          ]
    const [from, to] = along === 'x' ? [x0, x1] : [y0, y1]
    const count = Math.max(1, Math.round(Math.abs(to - from) / 48))
    const panes = []
    for (let i = 0; i < count; i++) {
      const a = from + ((to - from) * i) / count
      const b = from + ((to - from) * (i + 1)) / count
      const pane = corners(a, b)
      panes.push(
        glassFace(pane) +
          Ln(
            k.pathOf(
              pane.map((p) => at(p)),
              true,
            ),
            { tone: 'lo' },
          ),
      )
    }
    const length = Math.hypot(x1 - x0, y1 - y0)
    const F = G.frameAlong(
      [x0, y0, zr + 0.8],
      along === 'x' ? [Math.sign(x1 - x0), 0, 0] : [0, Math.sign(y1 - y0), 0],
    )
    return { shoe: plain(shoe, 'lo'), panes, rail: plain(G.disc(0, length, 0.85, F, P), 'hi') }
  }
  /** Balustrade runs set in one stage: shoes first, then panels one by one, rails last. */
  const balustrades = (st, runs) => {
    const list = runs.map(([a, b, z]) => balustrade(a, b, z))
    const total = list.reduce((n, r) => n + r.panes.length, 0)
    let n = 0
    for (const r of list) {
      put(st, r.shoe, 0)
      for (const pane of r.panes) put(st, pane, 0.15 + (0.7 * n++) / Math.max(1, total - 1))
      put(st, r.rail, 1)
    }
  }

  /** Teak boards running along x over a rectangle, laid one after another from the back. */
  const boardsOn = (st, x0, x1, y0, y1, z, t = 1.7) => {
    const list = []
    for (let y = y0; y < y1 - 0.5; y += 5.8) {
      const y1b = Math.min(y + 5.5, y1)
      list.push(
        plain(box(x0, x1, y, y1b, z, z + t, 0.2), 'hi', { crease: 'lo' }) +
          D(
            [x0 + 2, x0 + (x1 - x0) / 2, x1 - 2].map((x) => at([x, (y + y1b) / 2, z + t])),
            { size: 0.3, tone: 'lo' },
          ),
      )
    }
    putEach(st, list)
  }

  /**
   * A straight stair at x0 ± 21: treads set from the bottom up, stringers on both sides, and a
   * round handrail on posts. Drawn back to front so nearer treads cover farther ones.
   */
  function stair(st, railSt, { x0, yStart, dir, risers, rise, going }) {
    const treads = Array.from({ length: risers }, (_, i) => ({
      i,
      y: yStart + dir * i * going,
      z: (i + 1) * rise,
    }))
    const len = Math.hypot(risers * going, risers * rise)
    const a = G.unit3([0, dir * risers * going, risers * rise])
    const vv = G.unit3([0, -a[2] * dir, Math.abs(a[1])])
    const foot = [0, yStart - dir * going * 0.9, 0]
    const stringer = (x) =>
      G.prismOf(
        G.frameOf([x, foot[1], foot[2]], a, [1, 0, 0], vv),
        [
          [-0.5, -10],
          [0.5, -10],
          [0.5, 1.5],
          [-0.5, 1.5],
        ],
        0,
        len + 8,
        P,
      )
    put(
      st,
      plain(box(x0 - 20, x0 + 20, yStart - dir * 30 - 10, yStart - dir * 30 + 10, -8, -6.8), 'lo'),
      0,
    )
    put(st, plain(stringer(x0 - 21), 'mid'), 0)
    const order = [...treads].sort((p, q) => depth(0, p.y, p.z) - depth(0, q.y, q.z))
    for (const p of order)
      put(
        st,
        plain(box(x0 - 20.4, x0 + 20.4, p.y - 5.7, p.y + 5.7, p.z - 1.6, p.z, 0.3), 'hi', {
          crease: 'lo',
        }) + D([at([x0 - 18.6, p.y, p.z]), at([x0 + 18.6, p.y, p.z])], { size: 0.3, tone: 'lo' }),
        0.15 + (0.85 * p.i) / (risers - 1),
      )
    put(st, plain(stringer(x0 + 21), 'mid'), 0)
    const rail = (x) => {
      const F = G.frameOf([x, foot[1], foot[2] + 36], a, [1, 0, 0], vv)
      const posts = treads
        .filter((p) => p.i % 3 === 0)
        .map((p) => {
          const s = (p.y - foot[1]) / a[1]
          const zr = foot[2] + 36 + s * a[2]
          return plain(k.cylinder(x, p.y, 0.5, p.z, zr - p.z, P, 10))
        })
      return posts.join('') + plain(G.disc(2, len - 2, 0.8, F, P), 'hi')
    }
    put(railSt, rail(x0 - 21.8), 0.6)
    put(railSt, rail(x0 + 21.8), 1)
  }

  /** The unit's services outside: the condenser by the end wall, with its line set. */
  const outside = (st) => put(st, condenserSvg(h, P, 126, -40, X1), 1)

  const studioStages = (prefix = '') => ({
    plinth: stage(`${prefix}ground screws + steel plinth`, 26),
    frame: stage(`${prefix}steel ribs + purlins`, 50),
    skin: stage(`${prefix}rounded steel skin`, 56),
    back: stage(`${prefix}back wall panels`, 34),
    floor: stage(`${prefix}joists + insulated floor cassette`, 26),
    lining: stage(`${prefix}lining, light, climate + power`, 22),
    finish: stage(`${prefix}engineered oak floor`, 18),
    gear: stage(`${prefix}training equipment`, 24),
    glazing: stage(`${prefix}glazing pane by pane + door`, 30),
  })

  if (variant !== 'stacked') {
    const st = studioStages()
    unit(0, st, { step: variant !== 'deck' })
    outside(st.lining)
    if (variant === 'deck') {
      const frame = stage('deck footings + joists', 26)
      const deckBoards = stage('teak boards + front step', 20)
      const portal = stage('gazebo portal frame', 56)
      const louvers = stage('gazebo beams + teak louvers', 36)
      const footings = [-112, 0, 112].map((x) =>
        plain(box(x - 6, x + 6, 130, 142, -8, 0, 0.4), 'lo'),
      )
      const joists = []
      for (let x = -96; x <= 96; x += 24)
        joists.push(plain(box(x - 1, x + 1, SY1, 140, 1, 8.6, 0.2), 'lo'))
      putEach(frame, [
        ...footings,
        plain(box(-X1, -X1 + 3, SY1, 144, 0, 8.6, 0.3)),
        ...joists,
        plain(box(X1 - 3, X1, SY1, 144, 0, 8.6, 0.3)),
        plain(box(-X1, X1, 140, 144, 0, 8.6, 0.3)),
      ])
      boardsOn(deckBoards, -X1, X1, SY1 + 0.6, 144, 8.6)
      put(
        deckBoards,
        plain(box(-72, 72, 144, 156, -8, 2, 0.3)) +
          plain(box(-71, 71, 145, 155, 2, 3.2, 0.2), 'hi', { crease: 'lo' }),
        1,
      )
      const zt = BASE + HT
      put(louvers, plain(box(-X1, -X1 + 4.2, SY1, 136, zt - 4.2, zt, 0.3)), 0)
      const tilted = (xc) => {
        const c = Math.cos(0.42)
        const s = Math.sin(0.42)
        return [
          [-0.85, -2.5],
          [0.85, -2.5],
          [0.85, 2.5],
          [-0.85, 2.5],
        ].map(([u, w]) => [xc + u * c - w * s, zt - 3 + u * s + w * c])
      }
      const fins = []
      for (let x = -110; x <= 110; x += 7.44)
        fins.push(plain(prismY(tilted(x), SY1 + 1, 136), 'hi', { crease: 'lo' }))
      fins.forEach((svg, i) => put(louvers, svg, 0.1 + (0.9 * i) / (fins.length - 1)))
      put(louvers, plain(box(X1 - 4.2, X1, SY1, 136, zt - 4.2, zt, 0.3)), 0)
      const RING = shellOf(
        ACROSS_Y,
        roundedSection(-X1, X1, 8.6, zt, RADIUS),
        roundedSection(-X1 + 4.2, X1 - 4.2, 12.8, zt - 4.2, RADIUS - 4.2),
        136,
        140,
        P,
      )
      put(portal, plain(RING.inner, 'mid'))
      put(
        portal,
        plain(RING.outer, 'mid') +
          D(
            [-100, -60, -20, 20, 60, 100].map((x) => at([x, 140, zt - 2.1])),
            { size: 0.4 },
          ),
      )
    }
    if (variant === 'roof') {
      const roofBoards = stage('rooftop deck boards', 24)
      const glass = stage('glass balustrade', 26)
      const flight = stage('17-riser exterior stair', 44)
      const rails = stage('stair landing + handrails', 26)
      const zt = BASE + HT
      boardsOn(roofBoards, -109.8, 109.8, -43.8, 43.8, zt, 1.4)
      balustrades(glass, [
        [[-111, -43.2], [111, -43.2], zt],
        [[-111, -43.2], [-111, 43.2], zt],
      ])
      put(
        rails,
        plain(box(109.2, 164.4, -43.9, -16.3, zt - 4.6, zt, 0.3)) +
          plain(box(109.6, 164, -43.5, -16.7, zt, zt + 1.4, 0.2), 'hi', { crease: 'lo' }),
        0,
      )
      balustrades(glass, [
        [[111, -16.8], [111, 43.2], zt],
        [[-111, 43.2], [111, 43.2], zt],
      ])
      stair(flight, rails, { x0: 144, yStart: 138, dir: -1, risers: 17, rise: 7.34, going: 9.96 })
    }
  } else {
    const lower = studioStages('lower ')
    // The upper unit's steps share stages so the whole build stays near eight seconds.
    const upper = {
      frame: stage('upper ribs + skin', 64),
      back: stage('upper back wall + floor', 30),
      lining: stage('upper lining, oak + fit-out', 22),
      glazing: stage('upper glazing + door', 30),
    }
    upper.skin = upper.frame
    upper.floor = upper.back
    upper.finish = upper.lining
    upper.gear = upper.lining
    const flight = stage('18-riser exterior stair', 44)
    const balcony = stage('upper front balcony', 34)
    const glass = stage('glass balustrade + handrails', 26)
    unit(0, lower, { step: true })
    outside(lower.lining)
    unit(BASE + HT, upper, { plinth: false, gear: 'mats' })
    const zb = BASE + HT + FLOOR
    stair(flight, glass, { x0: 144, yStart: -125, dir: 1, risers: 18, rise: zb / 18, going: 10 })
    putEach(balcony, [
      ...[-116, 164].map((x) => plain(box(x - 3, x + 3, 88, 94, -8, zb - 6.2, 0.4))),
      plain(box(-X1, 170, SY1, 95, zb - 6.2, zb - 1.7, 0.4)),
    ])
    boardsOn(balcony, -X1 + 0.5, 169.5, SY1 + 0.5, 95, zb - 1.7)
    balustrades(glass, [
      [[-118, SY1 + 2], [-118, 93], zb],
      [[168, SY1 + 2], [168, 93], zb],
      [[-118, 93], [168, 93], zb],
    ])
  }

  // About eight seconds a build: the more steps, the quicker each one.
  const pace = Math.min(0.78, Math.max(0.5, 7.8 / stages.length))

  return {
    id: `studio-${variant}`,
    fig: meta.fig,
    title: meta.title,
    width: WIDTH,
    height: HEIGHT,
    P,
    stages,
    spacing: pace,
    first: 0.3,
    dur: pace,
    items,
    label: `${meta.title.replace(' · build', '')}, assembled step by step on a concrete pad: ${stages.map((s) => s.name).join(', ')}.`,
    caption: meta.caption,
    done: meta.done,
    keys: [
      { mark: 'lit', label: 'The pieces being set now' },
      { mark: 'raised', label: 'Steel ribs, skin, frames and stairs' },
      { mark: 'flat', label: 'Floors, decks and glazing' },
    ],
  }
}
