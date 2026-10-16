// The two parts that change shape while the gym is built: the cargo-door leaves swinging shut and
// the roll-up shutter unrolling. Both run at build time in Node and per frame in the page, so they
// take the kit as an argument instead of importing it. Keep them free of outside references.

/** One cargo-door leaf hinged at the +x end. `side` is +1 for the leaf on the +y hinge. */
export function leafSvg(k, P, side, angle, D) {
  const [vx, vy] = k.towardViewer(P)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const u = [s, -side * c]
  const n = [c, side * s]
  const at = (a, b) => [D.pivot[0] + u[0] * a + n[0] * b, D.pivot[1] + u[1] * a + n[1] * b]
  const box = (a0, a1, b0, b1, z0, z1, bevel = 0) =>
    k.extrude([at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)], z0, z1 - z0, P, { bevel })
  const S = (paths, tone = 'mid') => k.solidSvg(paths, { tone })
  const W = D.width
  const faceOut = n[0] * vx + n[1] * vy > 0

  const panel = S(box(0, W, -D.thick, 0, D.z0, D.z1, 0.4), 'mid')
  const details = []
  for (const z of D.pressings) details.push(S(box(1.6, W - 1.6, 0, 0.5, z, z + 5.2), 'mid'))
  for (const share of D.bars) {
    const [x, y] = at(W * share, 1.6)
    for (const z of [D.z0 + 1.2, D.z1 - 4.2])
      details.push(S(box(W * share - 1.7, W * share + 1.7, 0, 2.6, z, z + 3), 'mid'))
    details.push(S(k.cylinder(x, y, 0.75, D.z0 - 0.6, D.z1 - D.z0 + 1.2, P, 12), 'hi'))
    details.push(
      S(box(W * share - 1.2, W * share + 1.2, 0, 2.3, D.handle - 1, D.handle + 1), 'mid'),
    )
    details.push(S(box(W * share, W * share + 8.6, 1.6, 2.6, D.handle - 0.7, D.handle + 0.5), 'hi'))
  }
  const hinges = D.hinges.map((z) => {
    const [x, y] = at(-0.4, 0.4)
    return S(k.cylinder(x, y, 1, z, 4, P, 12), 'mid')
  })
  // Details sit on the outer face: in front of the panel when it faces the viewer, behind it when not.
  return faceOut
    ? panel + details.join('') + hinges.join('')
    : details.join('') + hinges.join('') + panel
}

/** The roll-up shutter hanging from its coil box down to `bottom`, with slat joints and a bottom bar. */
export function shutterSvg(k, P, bottom, D) {
  const top = D.top
  const h = Math.max(0, top - bottom)
  if (h < 0.4) return ''
  const plan = { x: D.x0, y: D.y0, w: D.x1 - D.x0, d: D.y1 - D.y0, r: 0 }
  const lines = []
  for (let z = top - D.slat; z > bottom + 2; z -= D.slat)
    lines.push(k.segment([D.x0, D.y1, z], [D.x1, D.y1, z], P))
  const sheet = k.solidSvg(k.slabOf(plan, bottom, h, P, 2), {
    tone: 'mid',
    inner: k.lineSvg(lines.join(''), { tone: 'faint' }),
  })
  const bar = k.solidSvg(
    k.slabOf(
      { x: D.x0 - 0.3, y: D.y0 - 0.3, w: D.x1 - D.x0 + 0.6, d: D.y1 - D.y0 + 0.9, r: 0.3 },
      bottom - 0.6,
      1.8,
      P,
      2,
      0.3,
    ),
    { tone: 'hi' },
  )
  return sheet + bar
}

/**
 * A worker in a hard hat and hi-vis vest, facing the container (−y). `w` gives the feet position,
 * the ground height, the stride (a signed swing of the feet along x) and the two hand positions
 * relative to the feet. Only the limbs are turned per frame: every rigid piece (boots, vest, head,
 * hat, hands) is drawn once at the origin and moved with a translate, which is exact in this camera.
 */
export function workerSvg(k, G, P, w) {
  const { x, y, g, swing, hands } = w
  const cache = workerSvg.cache || (workerSvg.cache = {})
  const S = (paths, tone = 'mid') => k.solidSvg(paths, { tone })
  const at = (key, make, point) =>
    `<g transform="${k.translateAlong(P, point)}">${cache[key] || (cache[key] = make())}</g>`
  const rod = (a, b, r) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len = Math.hypot(d[0], d[1], d[2]) || 1
    const F = G.frameAlong(a, [d[0] / len, d[1] / len, d[2] / len])
    return S(G.disc(0, len, r, F, P, { steps: 14 }))
  }
  const hip = g + 33
  const shoulder = g + 54
  const leg = (side) => {
    const fx = x + side * 2.6 + side * swing
    const boot = at(
      'boot',
      () => S(k.slabOf({ x: -2.6, y: -5, w: 5.2, d: 8.4, r: 1.4 }, 0, 3, P, 3), 'lo'),
      [fx, y, g],
    )
    return boot + rod([x + side * 2.6, y, hip], [fx, y, g + 3], 2.5)
  }
  const arm = (side) => {
    const [hx, hy, hz] = hands[side < 0 ? 0 : 1]
    const hand = at('hand', () => S(G.sphereOf([0, 0, 0], 2.1, P, { steps: 20 }), 'lo'), [
      x + hx,
      y + hy,
      g + hz,
    ])
    return rod([x + side * 7.2, y, shoulder], [x + hx, y + hy, g + hz], 1.8) + hand
  }
  const torso = at(
    'torso',
    () => {
      const vest = { x: -6, y: -3.6, w: 12, d: 7.2, r: 2 }
      const stripes = [10.5, 13.5].map((z) => k.sideSeam(vest, z, P, 3)).join('')
      return k.solidSvg(k.slabOf(vest, 0, 25, P, 3, 0.4), {
        tone: 'hi',
        crease: 'lo',
        inner: k.lineSvg(stripes, { tone: 'mid' }),
      })
    },
    [x, y, g + 31.5],
  )
  const head = at(
    'head',
    () =>
      S(k.cylinder(0, 0, 1.9, 0, 2.6, P, 12)) +
      S(G.sphereOf([0, 0, 5.5], 4.2, P, { steps: 32 })) +
      S(k.cylinder(0, 0.6, 6, 8.3, 0.8, P, 24), 'hi') +
      S(
        G.solidOf(
          [
            [0, 4.7],
            [1.6, 4.5, 1],
            [3.2, 3.6, 1],
            [4.4, 2, 1],
            [4.8, 0.4],
          ],
          G.frameOf([0, 0, 9.1], [0, 0, 1], [1, 0, 0], [0, 1, 0]),
          P,
          { steps: 28 },
        ),
        'hi',
      ),
    [x, y, g + 56.5],
  )
  // Hands reaching away from the viewer go behind the body.
  const back = [-1, 1].filter((side) => hands[side < 0 ? 0 : 1][1] < -3)
  const front = [-1, 1].filter((side) => !back.includes(side))
  return leg(-1) + leg(1) + back.map(arm).join('') + torso + front.map(arm).join('') + head
}

/**
 * The crane's lifting gear for one assembly: a cable running up out of the frame, the hook block,
 * two top slings to a spreader bar, and two drop slings down to the load's lifting points.
 */
export function hookSvg(k, P, h) {
  const [x, y, z] = h.at
  const a = h.axis === 'y' ? [0, 1] : [1, 0]
  const p = (s, dz) => [x + a[0] * s, y + a[1] * s, z + dz]
  const bar = h.span * 0.72
  const spreader =
    h.axis === 'y'
      ? { x: x - 1.2, y: y - bar - 1, w: 2.4, d: bar * 2 + 2, r: 0.6 }
      : { x: x - bar - 1, y: y - 1.2, w: bar * 2 + 2, d: 2.4, r: 0.6 }
  const out = []
  const drops = [-1, 1].map((side) => k.segment(p(side * bar, 22), p(side * h.span, 0), P)).join('')
  out.push(k.lineSvg(drops, { tone: 'mid' }))
  out.push(k.solidSvg(k.slabOf(spreader, z + 22, 2.4, P, 2, 0.3), { tone: 'mid' }))
  out.push(
    k.lineSvg([-1, 1].map((side) => k.segment(p(side * bar, 24.4), p(0, 40), P)).join(''), {
      tone: 'mid',
    }),
  )
  out.push(k.solidSvg(k.cylinder(x, y, 1.3, z + 38.6, 2.4, P, 12), { tone: 'mid' }))
  out.push(
    k.solidSvg(k.slabOf({ x: x - 3, y: y - 2.2, w: 6, d: 4.4, r: 1 }, z + 41, 8, P, 3, 0.4), {
      tone: 'hi',
    }),
  )
  const top = k.iso(p(0, 49), P)
  const sky = k.iso(p(0, 420), P)
  out.push(k.fadeLineSvg([top, sky], { fade: [0, 160], tone: 'mid' }))
  return out.join('')
}
