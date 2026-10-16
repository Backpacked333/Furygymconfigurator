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
