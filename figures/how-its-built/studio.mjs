// Figs 2–5: the S-Series Studio on its own, with a front deck and gazebo, with a rooftop deck
// and exterior stairs, and stacked two high. Sizes follow src/render/architecture.ts and addons.ts:
// a 20′ × 8′ × 10′ rounded steel portal on a recessed plinth, a fully glazed front with a door in
// the middle bay, a 10.4′ stair of 17 risers, a 3.5′ glass balustrade. Geometry is illustrative.
import * as k from '../kit/iso-kit.mjs'
import * as G from '../kit/lathe.mjs'
import {
  ACROSS_Y,
  bollardLampSvg,
  bollardSvg,
  condenserSvg,
  cutSection,
  equipment,
  faceOf,
  glowSvg,
  helpers,
  planterSvg,
  roundedSection,
  shellOf,
  sitePad,
  stonesSvg,
  treeSvg,
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

const VARIANTS = {
  single: {
    fig: 'Fig 2',
    title: 'S-Series Studio · build',
    done: 'built · 20′ × 8′ × 10′ · 160 sq ft',
    caption:
      'The S-Series Studio: a rounded steel shell is set on a recessed plinth, closed at the back, floored, insulated and lined, wired for light and climate, finished in oak, fitted out, and glazed full height across the front with a door in the middle bay. Nominal 20′ × 8′ × 10′, 160 sq ft.',
  },
  deck: {
    fig: 'Fig 3',
    title: 'Studio + deck + gazebo',
    done: 'built · Studio + 8′ deck + gazebo',
    caption:
      "The same Studio with Fury's front deck and gazebo: an 8′ framed deck boarded in teak with a front step, then a steel portal that echoes the Studio's outline, tied back by two beams and roofed with tilted teak louvers.",
  },
  roof: {
    fig: 'Fig 4',
    title: 'Studio + rooftop deck',
    done: 'built · Studio + rooftop deck + stairs',
    caption:
      'The Studio with a rooftop deck and exterior stairs: teak boards on the roof, a 3.5′ glass balustrade with a steel top rail, and a 17-riser stair at the end climbing 10.4′ to a landing that meets the gap in the rail.',
  },
  stacked: {
    fig: 'Fig 5',
    title: 'Stacked Studios · build',
    done: 'built · 2 Studios stacked · 320 sq ft',
    caption:
      'Two Studios stacked (a custom inquiry with Fury): the lower unit is built and glazed, the upper shell is set on its roof and fitted out in turn, then an 18-riser stair climbs the end to a front balcony with a glass balustrade. Engineering for stacked units is by inquiry.',
  },
}

export function studioFigure(variant) {
  const meta = VARIANTS[variant]
  const tall = variant === 'stacked'
  const WIDTH = 600
  const HEIGHT = tall ? 560 : 420
  // The pad, where the path runs out to, and where the trees and planters stand.
  const SITE = {
    single: {
      pad: { x0: -156, x1: 166, y0: -100, y1: 114 },
      path: [64, 88],
      trees: [
        [-150, 32, 1.2, 0.3],
        [136, -72, 1, 1.4],
      ],
      planters: [
        [-122, 84],
        [118, 70],
      ],
    },
    deck: {
      pad: { x0: -156, x1: 166, y0: -100, y1: 200 },
      path: [162, 174],
      trees: [
        [-150, 32, 1.2, 0.3],
        [136, -72, 1, 1.4],
      ],
      planters: [
        [-128, 170],
        [140, 150],
      ],
    },
    roof: {
      pad: { x0: -156, x1: 186, y0: -100, y1: 198 },
      path: [64, 172],
      trees: [[-150, 32, 1.2, 0.3]],
      planters: [
        [-122, 84],
        [-122, 150],
      ],
    },
    stacked: {
      pad: { x0: -156, x1: 188, y0: -178, y1: 142 },
      path: [100, 116],
      trees: [
        [-150, 14, 1.3, 0.3],
        [-148, 70, 0.85, 2.1],
      ],
      planters: [
        [-128, 112],
        [96, 112],
      ],
    },
  }[variant]
  const pad = SITE.pad
  const ruler = pad.y1 - 22
  const top = tall ? 2 * (BASE + HT) + 48 : variant === 'roof' ? BASE + HT + 48 : BASE + HT + 24
  const P = k.fitProjection(
    [
      ...k.boxCorners(
        { x: pad.x0, y: pad.y0, w: pad.x1 - pad.x0, d: pad.y1 - pad.y0, r: 0 },
        -16,
        -8,
      ),
      [-X1, SY0, top + 26],
      [X1, SY1, top],
      ...SITE.trees.map(([x, y, s]) => [x, y, 64 * s + 22]),
    ],
    WIDTH,
    HEIGHT,
    { pad: 26, azimuth: 58 },
  )
  const h = helpers(P)
  const { at, S, Ln, D, box, depth } = h
  const items = []
  const put = (stage, svg) => items.push({ stage, svg })
  const plain = (paths, tone = 'mid', extra = {}) => S(paths, { tone, ...extra })
  const prismY = (poly, y0, y1) => G.prismOf(ACROSS_Y, poly, y0, y1, P)
  const glassFace = (points) =>
    `<path class="cg-glass" d="${k.pathOf(
      points.map((p) => at(p)),
      true,
    )}"/>`

  sitePad(h, put, P, { ...pad, ruler: [-X1, X1, ruler] })

  const stages = []
  const stage = (name, drop = 46) => stages.push({ name, drop }) - 1
  // The last two steps of every Studio figure, put into their stages as their parts are drawn.
  let LAND = -1
  let LIGHTS = -1
  const finale = () => {
    LAND = stage('landscaping + path', -16)
    LIGHTS = stage('lights on', 0)
  }
  // Trees behind the unit go down first, so the unit is drawn over them.
  const backTrees = []

  /**
   * One Studio unit standing at height z0, its parts put into the given stages, in painter's order:
   * plinth, the shell's cavity, back wall, lining, floor, services, equipment, glazing, then the
   * outside of the shell over all of it, so the inside shows only through the glazed front.
   */
  function unit(z0, st, { plinth = true, gear = 'rack', step = false } = {}) {
    const OUTER = roundedSection(-X1, X1, z0 + BASE, z0 + BASE + HT, RADIUS)
    const INNER = roundedSection(
      -X1 + WALL,
      X1 - WALL,
      z0 + BASE + WALL,
      z0 + BASE + HT - WALL,
      RADIUS - WALL,
    )
    const shell = shellOf(ACROSS_Y, OUTER, INNER, SY0, SY1, P)
    const iz0 = z0 + BASE + WALL // 7.9 above z0
    const floorTop = z0 + FLOOR
    const ix = X1 - WALL // 115.7

    if (plinth) {
      for (const [x, y] of [
        [-100, -34],
        [0, -34],
        [100, -34],
        [-100, 34],
        [0, 34],
        [100, 34],
      ].sort((a, b) => depth(a[0], a[1]) - depth(b[0], b[1])))
        put(
          st.plinth,
          plain(k.cylinder(x, y, 4, z0 - 8, 8, P, 20), 'lo') + D([at([x, y, z0])], { size: 0.45 }),
        )
      put(st.plinth, plain(box(-111.6, 111.6, -40.8, 40.8, z0, z0 + BASE, 0.3), 'lo'))
    }
    if (step)
      put(
        st.plinth,
        plain(box(-26, 26, SY1 - 1, 60, -8, 3.4, 0.4), 'lo') +
          Ln(k.lineOnTop([-26, 54], [26, 54], 3.4, P), { tone: 'faint' }),
      )
    put(st.shell, plain(shell.inner, 'mid', { crease: 'faint' }))
    // Back skin closing the portal, seen from inside.
    const backRing = roundedSection(-ix, ix, iz0, z0 + BASE + HT - WALL, RADIUS - WALL).map(
      ([x, z]) => [x, BACK, z],
    )
    put(st.back, plain(faceOf(backRing, P, 2), 'mid'))
    // Insulated lining: painted panels on the back and the end wall, with their joints.
    const lineBack = roundedSection(
      -ix + 1,
      ix - 1,
      iz0 + 1,
      z0 + BASE + HT - WALL - 1,
      RADIUS - WALL - 1,
    ).map(([x, z]) => [x, BACK + 1, z])
    const seams = [-72, -24, 24, 72]
      .map((x) => k.segment([x, BACK + 1, floorTop], [x, BACK + 1, z0 + 112], P))
      .join('')
    put(
      st.lining,
      S(faceOf(lineBack, P, 3), { tone: 'hi', crease: 'lo', inner: Ln(seams, { tone: 'faint' }) }),
    )
    const endSeams = [-14, 14]
      .map((y) => k.segment([-ix + 1, y, z0 + 18], [-ix + 1, y, z0 + 108], P))
      .join('')
    put(
      st.lining,
      S(box(-ix, -ix + 1, BACK + 1, GLASS[0] - 0.4, z0 + 18, z0 + 108), {
        tone: 'hi',
        crease: 'lo',
        inner: Ln(endSeams, { tone: 'faint' }),
      }),
    )
    // Floor cassette inside the bottom of the portal, then the finished floor on top.
    const cassette = cutSection(INNER, iz0, floorTop - 0.8)
    put(st.floor, plain(prismY(cassette, BACK, SY1 - 0.4), 'lo'))
    const finish = cutSection(INNER, floorTop - 0.8, floorTop)
    const boards = []
    for (let x = -96; x < ix; x += 24)
      boards.push(k.lineOnTop([x, BACK], [x, GLASS[0]], floorTop, P))
    for (let y = -30; y < GLASS[0]; y += 15)
      boards.push(k.lineOnTop([-ix + 2, y], [ix - 2, y], floorTop, P))
    put(
      st.finish,
      S(prismY(finish, BACK, GLASS[0]), {
        tone: 'lo',
        inner: Ln(boards.join(''), { tone: 'faint' }),
      }),
    )
    // Services: LED cove along the back, wall-mounted mini-split, room controller.
    put(
      st.lining,
      plain(box(-100, 100, BACK + 1, BACK + 2.6, z0 + 108, z0 + 109.6), 'hi', { crease: 'lo' }),
    )
    put(
      LIGHTS_SLOT,
      S(box(-100, 100, BACK + 1, BACK + 2.6, z0 + 108, z0 + 109.6), { tone: 'hi', lit: true }),
    )
    put(
      st.lining,
      plain(box(52, 88, BACK + 1, BACK + 7.2, z0 + 92, z0 + 103, 0.5), 'hi', { crease: 'lo' }) +
        Ln(h.onY(BACK + 7.2, 55, 85, z0 + 93.4, z0 + 94.8), { tone: 'lo' }) +
        D([at([84.8, BACK + 7.2, z0 + 100.6])], { size: 0.4, tone: 'hi' }),
    )
    put(
      st.lining,
      plain(box(-100, -94, BACK + 1, BACK + 1.6, z0 + 52, z0 + 61), 'lo') +
        D([at([-97, BACK + 1.6, z0 + 58.6])], { size: 0.45, tone: 'hi' }),
    )
    // A wall-mounted screen for class timers, beside the rack.
    if (gear)
      put(
        st.gear,
        plain(box(-108, -78, BACK + 1, BACK + 2.4, z0 + 66, z0 + 83, 0.3), 'lo') +
          Ln(h.onY(BACK + 2.4, -106.6, -79.4, z0 + 67.4, z0 + 81.6), { tone: 'faint' }) +
          D([at([-80.4, BACK + 2.4, z0 + 68.4])], { size: 0.35, tone: 'hi' }),
      )
    // Fit-out on the finished floor.
    if (gear)
      equipment(h, put, st.gear, P, [0, BACK + 1 + 42.8, floorTop - 6.8], { rack: gear === 'rack' })
    // Full-height glazing: frame, glass, four mullions, and the door in the middle bay.
    const GH = roundedSection(
      -ix + 1.9,
      ix - 1.9,
      iz0 + 1.9,
      z0 + BASE + HT - WALL - 1.9,
      RADIUS - WALL - 1.9,
    )
    const frame = shellOf(ACROSS_Y, INNER, GH, GLASS[0], GLASS[1], P)
    put(st.glazing, plain(frame.inner, 'mid'))
    const zb = iz0 + 1.9
    const zt = z0 + BASE + HT - WALL - 1.9
    put(
      st.glazing,
      glassFace(GH.map(([x, z]) => [x, 45.2, z])) +
        Ln(
          k.segment([-100, 45.2, zb], [-74, 45.2, zt], P) +
            k.segment([-92, 45.2, zb], [-66, 45.2, zt], P) +
            k.segment([40, 45.2, zb], [64, 45.2, zt], P),
          { tone: 'faint' },
        ),
    )
    const mullions = [-68.3, -22.8, 22.8, 68.3]
    for (const x of mullions)
      put(st.glazing, plain(box(x - 1.2, x + 1.2, GLASS[0], GLASS[1], zb, zt, 0.2)))
    put(st.glazing, plain(box(-21.6, 21.6, GLASS[0], GLASS[1], z0 + 91, z0 + 93, 0.2)))
    put(st.glazing, plain(box(-21.6, 21.6, GLASS[0], GLASS[1], floorTop, floorTop + 2, 0.2)))
    // Interior light through the glass once the lights come on, and the LED cove lit.
    put(
      LIGHTS_SLOT,
      glowSvg(
        P,
        GH.map(([x, z]) => [x, 45.3, z]),
        [0, 45.3, zt],
        [0, 45.3, zb],
        0.9,
      ),
    )
    put(st.glazing, plain(frame.outer, 'mid'))
    // Threshold plate under the door.
    put(
      st.glazing,
      plain(box(-21.6, 21.6, GLASS[1], SY1 + 2.4, floorTop - 1.2, floorTop, 0.3), 'hi', {
        crease: 'lo',
      }),
    )
    // Pull handle on the outside of the door.
    put(
      st.glazing,
      plain(box(13.4, 14.6, GLASS[1], GLASS[1] + 1.6, z0 + 50, z0 + 51.4)) +
        plain(box(13.4, 14.6, GLASS[1], GLASS[1] + 1.6, z0 + 68, z0 + 69.4)) +
        plain(k.cylinder(14, GLASS[1] + 2.2, 0.7, z0 + 46, 28, P, 12), 'hi'),
    )
    // The outside of the shell, over everything inside it, with its standing seams: across the roof
    // front to back, and along the end wall.
    const roofZ = z0 + BASE + HT
    const seams2 = []
    for (let x = -96; x <= 96; x += 24) seams2.push(k.segment([x, SY0, roofZ], [x, SY1, roofZ], P))
    for (const z of [36, 66, 96]) seams2.push(k.segment([X1, SY0, z0 + z], [X1, SY1, z0 + z], P))
    put(
      st.shell,
      S(shell.outer, {
        tone: 'mid',
        crease: 'faint',
        inner: Ln(seams2.join(''), { tone: 'faint' }),
      }),
    )
    // FURY, engraved small in the bottom band of the front face.
    put(
      st.shell,
      k.faceTextSvg(k.sideMatrix([-96, SY1], z0 + 4.4, P, 'left'), 'FURY', {
        size: 2.6,
        tone: 'lo',
        anchor: 'start',
      }),
    )
    // Gutter outlet and downpipe at the back of the end wall.
    put(
      st.shell,
      plain(box(X1 - 2, X1 + 3.2, -45, -41, roofZ - 6, roofZ - 2.4, 0.3)) +
        plain(k.cylinder(X1 + 1.6, -43, 1.3, z0 ? z0 : -8, roofZ - 6 - (z0 ? z0 : -8), P, 14)) +
        (z0 ? '' : plain(box(X1 - 2, X1 + 6, -48, -38, -8, -7, 0.3), 'lo')),
    )
    // Drip edge along the roof front.
    put(
      st.shell,
      plain(box(-91, 91, SY1 - 3, SY1 - 2, z0 + BASE + HT, z0 + BASE + HT + 0.6), 'mid', {
        crease: 'none',
      }),
    )
  }

  /** A glass balustrade along a line on a deck: steel shoe, glass, and a round steel top rail. */
  function balustrade(stage, [x0, y0], [x1, y1], z) {
    const along = x0 === x1 ? 'y' : 'x'
    const shoe =
      along === 'x'
        ? box(Math.min(x0, x1), Math.max(x0, x1), y0 - 1.6, y0 + 1.6, z, z + 3.8, 0.3)
        : box(x0 - 1.6, x0 + 1.6, Math.min(y0, y1), Math.max(y0, y1), z, z + 3.8, 0.3)
    const zr = z + 42
    const pane =
      along === 'x'
        ? [
            [x0, y0, z + 3.8],
            [x1, y0, z + 3.8],
            [x1, y0, zr],
            [x0, y0, zr],
          ]
        : [
            [x0, y0, z + 3.8],
            [x0, y1, z + 3.8],
            [x0, y1, zr],
            [x0, y0, zr],
          ]
    const length = Math.hypot(x1 - x0, y1 - y0)
    const F = G.frameAlong(
      [x0, y0, zr + 0.8],
      along === 'x' ? [Math.sign(x1 - x0), 0, 0] : [0, Math.sign(y1 - y0), 0],
    )
    put(
      stage,
      plain(shoe, 'lo') +
        glassFace(pane) +
        Ln(
          k.pathOf(
            pane.map((p) => at(p)),
            true,
          ),
          { tone: 'lo' },
        ) +
        plain(G.disc(0, length, 0.85, F, P), 'hi'),
    )
  }

  /** Teak boards running along x over a rectangle, laid on a frame top at z. */
  function boardsOn(stage, x0, x1, y0, y1, z, t = 1.7) {
    const list = []
    for (let y = y0; y < y1 - 0.5; y += 5.8)
      list.push({
        y,
        svg: plain(box(x0, x1, y, Math.min(y + 5.5, y1), z, z + t, 0.2), 'hi', { crease: 'lo' }),
      })
    put(stage, list.map((b) => b.svg).join(''))
  }

  /**
   * A straight stair at x0 ± 21: treads from (yStart, first rise) stepping `dir` in y, stringers on
   * both sides, and a round handrail on posts. Drawn back to front so nearer treads cover farther.
   */
  function stair(stage, railStage, { x0, yStart, dir, risers, rise, going }) {
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
    const order = [...treads].sort((p, q) => depth(0, p.y, p.z) - depth(0, q.y, q.z))
    put(
      stage,
      plain(box(x0 - 20, x0 + 20, yStart - dir * 30 - 10, yStart - dir * 30 + 10, -8, -6.8), 'lo'),
    )
    put(stage, plain(stringer(x0 - 21), 'mid'))
    put(
      stage,
      order
        .map((p) =>
          plain(box(x0 - 20.4, x0 + 20.4, p.y - 5.7, p.y + 5.7, p.z - 1.6, p.z, 0.3), 'hi', {
            crease: 'lo',
          }),
        )
        .join(''),
    )
    put(stage, plain(stringer(x0 + 21), 'mid'))
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
    put(railStage, rail(x0 - 21.8))
    put(railStage, rail(x0 + 21.8))
  }

  // Items for the finale stages are put before those stages exist; they carry a placeholder that is
  // resolved once the finale has been numbered.
  const LIGHTS_SLOT = 'lights'
  const LAND_SLOT = 'land'
  for (const [x, y, size, seed] of SITE.trees) backTrees.push(treeSvg(h, P, x, y, size, seed))
  put(LAND_SLOT, backTrees.join(''))

  /** The unit's services outside: the condenser by the end wall, with its line set. */
  const outside = (st) => put(st.lining, condenserSvg(h, P, 126, -40, X1))

  if (variant !== 'stacked') {
    const st = {
      plinth: stage('ground screws + steel plinth', 30),
      shell: stage('rounded steel shell', 60),
      back: stage('back wall skin', 40),
      floor: stage('insulated floor cassette', 30),
      lining: stage('insulated lining + services', 24),
      finish: stage('engineered oak floor', 20),
      gear: stage('training equipment', 26),
      glazing: stage('full-height glazing + door', 36),
    }
    unit(0, st, { step: variant !== 'deck' })
    outside(st)
    if (variant === 'deck') {
      const frame = stage('front deck frame', 30)
      const deckBoards = stage('teak deck boards + step', 24)
      const portal = stage('gazebo portal frame', 60)
      const louvers = stage('gazebo beams + teak louvers', 40)
      // Deck frame on footings: two side rims, joists every 2′, a front rim.
      for (const [x, y] of [
        [-112, 136],
        [0, 136],
        [112, 136],
      ])
        put(frame, plain(box(x - 6, x + 6, y - 6, y + 6, -8, 0, 0.4), 'lo'))
      put(frame, plain(box(-X1, -X1 + 3, SY1, 144, 0, 8.6, 0.3)))
      for (let x = -96; x <= 96; x += 24)
        put(frame, plain(box(x - 1, x + 1, SY1, 140, 1, 8.6, 0.2), 'lo'))
      put(frame, plain(box(X1 - 3, X1, SY1, 144, 0, 8.6, 0.3)))
      put(frame, plain(box(-X1, X1, 140, 144, 0, 8.6, 0.3)))
      boardsOn(deckBoards, -X1, X1, SY1 + 0.6, 144, 8.6)
      put(
        LIGHTS_SLOT,
        glowSvg(
          P,
          [
            [-104, SY1 + 1, 10.4],
            [104, SY1 + 1, 10.4],
            [118, 136, 10.4],
            [-118, 136, 10.4],
          ],
          [0, SY1 + 1, 10.4],
          [0, 136, 10.4],
        ),
      )
      put(
        deckBoards,
        plain(box(-72, 72, 144, 156, -8, 2, 0.3)) +
          plain(box(-71, 71, 145, 155, 2, 3.2, 0.2), 'hi', { crease: 'lo' }),
      )
      // Gazebo: two beams back to the Studio, louvers, then the portal at the front of the deck.
      const zt = BASE + HT
      put(louvers, plain(box(-X1, -X1 + 4.2, SY1, 136, zt - 4.2, zt, 0.3)))
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
      put(louvers, fins.join(''))
      put(louvers, plain(box(X1 - 4.2, X1, SY1, 136, zt - 4.2, zt, 0.3)))
      const RING = shellOf(
        ACROSS_Y,
        roundedSection(-X1, X1, 8.6, zt, RADIUS),
        roundedSection(-X1 + 4.2, X1 - 4.2, 12.8, zt - 4.2, RADIUS - 4.2),
        136,
        140,
        P,
      )
      put(portal, plain(RING.inner, 'mid'))
      put(portal, plain(RING.outer, 'mid'))
    }
    if (variant === 'roof') {
      const roofBoards = stage('rooftop deck boards', 30)
      const glass = stage('glass balustrade', 30)
      const flight = stage('17-riser exterior stair', 50)
      const rails = stage('stair landing + handrails', 30)
      const zt = BASE + HT
      boardsOn(roofBoards, -109.8, 109.8, -43.8, 43.8, zt, 1.4)
      balustrade(glass, [-111, -43.2], [111, -43.2], zt)
      balustrade(glass, [-111, -43.2], [-111, 43.2], zt)
      // Landing over the roof edge, level with the deck, meeting the gap in the rail.
      put(
        rails,
        plain(box(109.2, 164.4, -43.9, -16.3, zt - 4.6, zt, 0.3)) +
          plain(box(109.6, 164, -43.5, -16.7, zt, zt + 1.4, 0.2), 'hi', { crease: 'lo' }),
      )
      balustrade(glass, [111, -16.8], [111, 43.2], zt)
      balustrade(glass, [-111, 43.2], [111, 43.2], zt)
      stair(flight, rails, { x0: 144, yStart: 138, dir: -1, risers: 17, rise: 7.34, going: 9.96 })
    }
  } else {
    const lower = {
      plinth: stage('ground screws + steel plinth', 30),
      shell: stage('lower steel shell', 60),
      back: stage('lower back wall + floor', 36),
      lining: stage('lower lining, oak floor + fit-out', 26),
      glazing: stage('lower glazing + door', 36),
    }
    lower.floor = lower.back
    lower.finish = lower.lining
    lower.gear = lower.lining
    const upper = {
      shell: stage('upper shell set on top', 70),
      back: stage('upper back wall + floor', 36),
      lining: stage('upper lining, floor + fit-out', 26),
      glazing: stage('upper glazing + door', 36),
    }
    upper.floor = upper.back
    upper.finish = upper.lining
    upper.gear = upper.lining
    const flight = stage('18-riser exterior stair', 50)
    const balcony = stage('upper front balcony', 40)
    const glass = stage('glass balustrade + handrails', 30)
    unit(0, lower, { step: true })
    outside(lower)
    unit(BASE + HT, upper, { plinth: false, gear: 'mats' })
    const zb = BASE + HT + FLOOR // upper finished floor, 135.1
    stair(flight, glass, { x0: 144, yStart: -125, dir: 1, risers: 18, rise: zb / 18, going: 10 })
    // Balcony across the front at the upper floor level, on two steel columns.
    for (const x of [-116, 164]) put(balcony, plain(box(x - 3, x + 3, 88, 94, -8, zb - 6.2, 0.4)))
    put(balcony, plain(box(-X1, 170, SY1, 95, zb - 6.2, zb - 1.7, 0.4)))
    boardsOn(balcony, -X1 + 0.5, 169.5, SY1 + 0.5, 95, zb - 1.7)
    balustrade(glass, [-118, SY1 + 2], [-118, 93], zb)
    balustrade(glass, [168, SY1 + 2], [168, 93], zb)
    balustrade(glass, [-118, 93], [168, 93], zb)
  }

  // Finale: the path, planters and bollards in front, light spilling out onto the ground.
  finale()
  if (variant !== 'deck')
    put(
      LIGHTS_SLOT,
      glowSvg(
        P,
        [
          [-100, SY1 + 1, -7.9],
          [100, SY1 + 1, -7.9],
          [128, SY1 + 54, -7.9],
          [-128, SY1 + 54, -7.9],
        ],
        [0, SY1 + 1, -7.9],
        [0, SY1 + 54, -7.9],
        0.8,
      ),
    )
  const [p0, p1] = SITE.path
  put(LAND_SLOT, stonesSvg(h, P, 0, p0, p1))
  const lamps = [
    [-22, p0 + 4],
    [22, p0 + 4],
  ]
  for (const [x, y] of lamps) put(LAND_SLOT, bollardSvg(h, P, x, y))
  for (const [x, y] of lamps) put(LIGHTS_SLOT, bollardLampSvg(h, P, x, y))
  for (const [x, y] of SITE.planters) put(LAND_SLOT, planterSvg(h, P, x, y))
  for (const item of items) {
    if (item.stage === LAND_SLOT) item.stage = LAND
    if (item.stage === LIGHTS_SLOT) item.stage = LIGHTS
  }
  // About ten seconds a build: the more steps, the quicker each one.
  const pace = Math.min(0.9, Math.max(0.64, 9.4 / stages.length))

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
      { mark: 'lit', label: 'The assembly being set now' },
      { mark: 'raised', label: 'Steel shell, frames and stairs' },
      { mark: 'flat', label: 'Floors, decks and glazing' },
    ],
  }
}
