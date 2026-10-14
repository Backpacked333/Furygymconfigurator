import {
  CanvasTexture,
  CylinderGeometry,
  DodecahedronGeometry,
  MeshPhysicalMaterial,
  SRGBColorSpace,
} from 'three'
import type { PlacedItem } from '../lib/config'
import { noise } from '../lib/visuals'
import {
  box,
  custom,
  cylinder,
  cylinderProjectUV,
  extrude,
  lathe,
  roundedBox,
  roundedRectShape,
  tube,
  boxProjectUV,
} from './geometry'
import { material } from './materials'
import { palette } from './palette'
import { part, place, type Part, type V3 } from './parts'

/**
 * Generic, procedurally modeled equipment at real-world dimensions (feet). Local origin is the
 * floor at the footprint center; +z is the item's front unless noted. Every builder returns parts
 * that are statically batched per material.
 */

const AXIS_X: V3 = [0, 0, Math.PI / 2]
const AXIS_Z: V3 = [Math.PI / 2, 0, 0]
const frame = () => palette.powder('#1d1f1e')
const black = () => palette.black()

// --- Shared components ------------------------------------------------------------------

/** Olympic bumper plate (450 mm) around the X axis: rubber body with recessed faces + steel hub. */
function bumper(thickness = 0.24, radius = 0.738, color = '#1c1d1d'): Part[] {
  const t = thickness / 2
  const body = lathe(`bumper:${thickness}:${radius}`, [
    [0.086, -t],
    [radius - 0.03, -t],
    [radius, -t + 0.03],
    [radius, t - 0.03],
    [radius - 0.03, t],
    [radius - 0.12, t],
    [radius - 0.14, t - 0.025],
    [0.24, t - 0.025],
    [0.22, t],
    [0.086, t],
    [0.086, -t],
  ])
  const hub = lathe('bumper-hub', [
    [0.083, -0.135],
    [0.2, -0.135],
    [0.2, -0.115],
    [0.15, -0.105],
    [0.15, 0.105],
    [0.2, 0.115],
    [0.2, 0.135],
    [0.083, 0.135],
  ])
  return [
    part(body, palette.rubber(color), [0, 0, 0], AXIS_X),
    part(hub, palette.brushed(), [0, 0, 0], AXIS_X, undefined, false),
  ]
}

/** 7.2 ft men's Olympic bar along X: knurled 28 mm shaft, sleeves, collars, end caps. */
function barbell(): Part[] {
  const knurl = palette.knurl()
  const chrome = palette.brushed()
  const parts: Part[] = [
    part(cylinder(0.0459, 0.0459, 4.3, 24), chrome, [0, 0, 0], AXIS_X),
    part(cylinder(0.0462, 0.0462, 1.35, 24), knurl, [-1.12, 0, 0], AXIS_X, undefined, false),
    part(cylinder(0.0462, 0.0462, 1.35, 24), knurl, [1.12, 0, 0], AXIS_X, undefined, false),
  ]
  for (const side of [-1, 1]) {
    parts.push(part(cylinder(0.11, 0.11, 0.09, 32), chrome, [side * 2.19, 0, 0], AXIS_X))
    parts.push(
      part(cylinder(0.0825, 0.0825, 1.38, 32), palette.polished(), [side * 2.92, 0, 0], AXIS_X),
    )
    parts.push(
      part(cylinder(0.07, 0.07, 0.02, 24), black(), [side * 3.62, 0, 0], AXIS_X, undefined, false),
    )
  }
  return parts
}

/** Hexagonal rubber dumbbell along Z with a knurled chrome handle; flats rest on the tray. */
function hexDumbbell(head: number, headLength: number): Part[] {
  const hex = custom(`hex:${head}:${headLength}`, () =>
    cylinderProjectUV(new CylinderGeometry(head, head, headLength, 6, 1, false, Math.PI / 6)),
  )
  const handle = 0.42
  const offset = handle / 2 + headLength / 2
  return [
    part(hex, palette.rubber('#1b1c1c'), [0, 0, -offset], AXIS_Z),
    part(hex, palette.rubber('#1b1c1c'), [0, 0, offset], AXIS_Z),
    part(
      cylinder(0.052, 0.052, handle + 0.02, 20),
      palette.knurl(),
      [0, 0, 0],
      AXIS_Z,
      undefined,
      false,
    ),
    part(
      cylinder(head * 0.55, head * 0.55, 0.012, 24),
      palette.brushed(),
      [0, 0, -offset - headLength / 2 - 0.004],
      AXIS_Z,
      undefined,
      false,
    ),
    part(
      cylinder(head * 0.55, head * 0.55, 0.012, 24),
      palette.brushed(),
      [0, 0, offset + headLength / 2 + 0.004],
      AXIS_Z,
      undefined,
      false,
    ),
  ]
}

/** A dark glass console with a softly glowing workout UI. */
let screenMaterial: MeshPhysicalMaterial | null = null
function consoleScreen() {
  if (screenMaterial) return screenMaterial
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 320
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#05080a'
    ctx.fillRect(0, 0, 512, 320)
    ctx.fillStyle = '#f2efe8'
    ctx.font = '600 92px sans-serif'
    ctx.fillText('7:42', 34, 130)
    ctx.font = '500 26px sans-serif'
    ctx.fillStyle = '#9bb7a8'
    ctx.fillText('PACE / MI', 38, 172)
    ctx.fillText('3.10 MI', 330, 70)
    ctx.fillText('148 BPM', 330, 120)
    ctx.strokeStyle = '#d9b48a'
    ctx.lineWidth = 5
    ctx.beginPath()
    for (let i = 0; i <= 40; i++) {
      const x = 34 + i * 11
      const y = 268 - Math.sin(i * 0.35) * 24 - noise(i, 3) * 26
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    }
    ctx.stroke()
  }
  const map = new CanvasTexture(canvas)
  map.colorSpace = SRGBColorSpace
  screenMaterial = new MeshPhysicalMaterial({
    color: '#050707',
    emissive: '#ffffff',
    emissiveMap: map,
    emissiveIntensity: 1.4,
    roughness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
  })
  return screenMaterial
}

/** Flat UV-mapped plane facing +z, for screens. */
function screen(w: number, h: number) {
  return custom(`screen:${w}:${h}`, () => {
    const g = box(w, h, 0.01).clone()
    const uv = g.getAttribute('uv')
    const pos = g.getAttribute('position')
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5)
    return g
  })
}

// --- Strength -----------------------------------------------------------------------------

function rack(): Part[] {
  const steel = frame()
  const parts: Part[] = []
  const X = 2.15,
    Z = 1.35,
    S = 0.25
  const holeDisc = cylinder(0.042, 0.042, 0.012, 14)
  const hole = black()
  for (const x of [-X, X])
    for (const z of [-Z, Z]) {
      parts.push(part(roundedBox(S, 7.2, S, 0.015, 1), steel, [x, 3.8, z]))
      // Westside hole spacing: 2 in. through the bench zone, 4 in. above and below.
      for (let y = 0.9; y < 7.1; y += y > 1.6 && y < 3.7 ? 1 / 6 : 1 / 3) {
        parts.push(part(holeDisc, hole, [x, y, z + S / 2 + 0.002], AXIS_Z, undefined, false))
        parts.push(part(holeDisc, hole, [x, y, z - S / 2 - 0.002], AXIS_Z, undefined, false))
      }
      parts.push(
        part(cylinder(0.05, 0.06, 0.06, 16), palette.rubber(), [x, 0.03, z + Math.sign(z) * 0.2]),
      )
    }
  for (const x of [-X, X]) {
    parts.push(part(roundedBox(S, 0.2, 3.3, 0.015, 1), steel, [x, 0.16, 0]))
    parts.push(part(roundedBox(S, S, 2.45, 0.015, 1), steel, [x, 7.38, 0]))
  }
  for (const z of [-Z, Z]) parts.push(part(roundedBox(4.55, S, S, 0.015, 1), steel, [0, 7.38, z]))
  parts.push(part(roundedBox(4.05, S, S, 0.015, 1), steel, [0, 0.33, -Z]))
  // Pull-up bar on forward brackets.
  parts.push(part(cylinder(0.052, 0.052, 4.5, 24), palette.knurl(), [0, 7.1, Z + 0.06], AXIS_X))
  // J-hooks with UHMW liners and the loaded bar.
  const hookY = 4.55
  for (const x of [-X, X]) {
    parts.push(part(roundedBox(0.28, 0.55, 0.06, 0.01, 1), steel, [x, hookY + 0.05, Z - 0.155]))
    parts.push(part(roundedBox(0.12, 0.08, 0.36, 0.01, 1), steel, [x, hookY - 0.18, Z - 0.33]))
    parts.push(part(roundedBox(0.12, 0.18, 0.05, 0.01, 1), steel, [x, hookY - 0.06, Z - 0.49]))
    parts.push(
      part(
        box(0.13, 0.03, 0.3),
        palette.plastic('#111212', 0.6),
        [x, hookY - 0.125, Z - 0.33],
        undefined,
        undefined,
        false,
      ),
    )
  }
  const barY = hookY - 0.06
  parts.push(...place(barbell(), [0, barY, Z - 0.5]))
  for (const side of [-1, 1]) parts.push(...place(bumper(), [side * 2.62, barY, Z - 0.5]))
  // Safety straps between the uprights.
  for (const x of [-X, X]) {
    parts.push(part(box(0.05, 0.12, 2.5), palette.nylon(), [x - Math.sign(x) * 0.16, 3.25, 0]))
    for (const z of [-Z + 0.18, Z - 0.18])
      parts.push(
        part(roundedBox(0.08, 0.2, 0.12, 0.02, 1), palette.zinc(), [
          x - Math.sign(x) * 0.16,
          3.25,
          z,
        ]),
      )
  }
  // Band pegs at the base of the front uprights.
  for (const x of [-X, X])
    parts.push(part(cylinder(0.05, 0.05, 0.3, 16), palette.brushed(), [x, 0.55, Z + 0.05], AXIS_Z))
  return parts
}

function bench(): Part[] {
  const steel = frame()
  const vinyl = palette.vinyl('#2b2d2c')
  const base = palette.plastic('#121313', 0.7)
  const parts: Part[] = [
    part(roundedBox(0.25, 0.25, 3.5, 0.02, 2), steel, [0, 0.92, -0.05]),
    part(roundedBox(1.85, 0.2, 0.25, 0.02, 2), steel, [0, 0.1, 1.72]),
    part(roundedBox(1.7, 0.2, 0.25, 0.02, 2), steel, [0, 0.1, -1.8]),
    part(roundedBox(0.25, 0.75, 0.25, 0.02, 2), steel, [0, 0.52, 1.55], [0.18, 0, 0]),
    part(roundedBox(0.25, 0.75, 0.25, 0.02, 2), steel, [0, 0.52, -1.62], [-0.18, 0, 0]),
    // Seat and back pads on plywood bases.
    part(roundedBox(1.02, 0.28, 1.12, 0.11, 3), vinyl, [0, 1.48, 1.22]),
    part(roundedBox(1.02, 0.28, 2.72, 0.11, 3), vinyl, [0, 1.48, -0.75]),
    part(box(0.94, 0.06, 1.04), base, [0, 1.31, 1.22], undefined, undefined, false),
    part(box(0.94, 0.06, 2.64), base, [0, 1.31, -0.75], undefined, undefined, false),
    part(roundedBox(0.3, 0.2, 2.9, 0.02, 1), steel, [0, 1.18, -0.6]),
    // Incline ladder and pop-pin.
    part(box(0.1, 0.06, 0.95), steel, [0, 1.05, -1.25]),
    part(
      cylinder(0.045, 0.045, 0.18, 16),
      palette.plastic('#b33a2e', 0.4),
      [0.2, 1.0, 0.75],
      AXIS_X,
    ),
  ]
  for (let i = 0; i < 5; i++)
    parts.push(part(box(0.12, 0.08, 0.05), steel, [0, 1.1, -1.65 + i * 0.18]))
  // Transport wheels, rubber feet, and a rear handle.
  for (const x of [-0.82, 0.82]) {
    parts.push(
      part(cylinder(0.13, 0.13, 0.09, 24), palette.rubber('#151616'), [x, 0.13, 1.95], AXIS_X),
    )
    parts.push(
      part(
        cylinder(0.05, 0.05, 0.1, 16),
        palette.brushed(),
        [x, 0.13, 1.95],
        AXIS_X,
        undefined,
        false,
      ),
    )
    parts.push(part(roundedBox(0.2, 0.06, 0.28, 0.02, 1), palette.rubber(), [x, 0.03, -1.8]))
  }
  parts.push(
    part(
      tube(
        'bench-handle',
        [
          [-0.3, 0.2, -1.95],
          [-0.25, 0.55, -2.12],
          [0.25, 0.55, -2.12],
          [0.3, 0.2, -1.95],
        ],
        0.04,
      ),
      steel,
      [0, 0, 0],
    ),
  )
  return parts
}

function dumbbellRack(): Part[] {
  const steel = frame()
  const parts: Part[] = []
  for (const x of [-1.95, 1.95]) {
    parts.push(part(roundedBox(0.2, 0.14, 1.75, 0.02, 1), steel, [x, 0.07, 0]))
    parts.push(part(roundedBox(0.18, 2.75, 0.18, 0.02, 1), steel, [x, 1.45, 0.35], [0.16, 0, 0]))
    parts.push(part(roundedBox(0.18, 2.75, 0.18, 0.02, 1), steel, [x, 1.45, -0.35], [-0.16, 0, 0]))
    parts.push(part(roundedBox(0.2, 0.06, 0.32, 0.02, 1), palette.rubber(), [x, 0.02, 0.75]))
    parts.push(part(roundedBox(0.2, 0.06, 0.32, 0.02, 1), palette.rubber(), [x, 0.02, -0.75]))
  }
  // Two saddle tiers with rubber liners: five lighter pairs above, four heavier pairs below.
  const tiers = [
    { y: 1.25, z: 0.12, weights: [5, 6, 7, 8] },
    { y: 2.35, z: -0.08, weights: [0, 1, 2, 3, 4] },
  ]
  for (const tier of tiers) {
    for (const dz of [-0.28, 0.28]) {
      parts.push(part(roundedBox(3.95, 0.12, 0.12, 0.015, 1), steel, [0, tier.y, tier.z + dz]))
      parts.push(
        part(
          box(3.8, 0.02, 0.1),
          palette.rubber('#101111'),
          [0, tier.y + 0.07, tier.z + dz],
          undefined,
          undefined,
          false,
        ),
      )
    }
    const bells = tier.weights.flatMap((w) => [w, w])
    const radius = (w: number) => 0.12 + w * 0.012
    const gap = 0.05
    const width = bells.reduce((sum, w) => sum + radius(w) * 2 + gap, -gap)
    let x = -width / 2
    for (const w of bells) {
      const r = radius(w)
      parts.push(
        ...place(hexDumbbell(r, 0.2 + w * 0.018), [
          x + r,
          tier.y + 0.08 + r * Math.cos(Math.PI / 6),
          tier.z,
        ]),
      )
      x += r * 2 + gap
    }
  }
  return parts
}

// --- Recovery -----------------------------------------------------------------------------

function sauna(): Part[] {
  const wood = palette.hinoki()
  const vertical = (w: number, h: number, d: number) => roundedBox(w, h, d, 0.02, 1, { swap: true })
  const dark = palette.powder('#2a2420')
  const parts: Part[] = [
    part(vertical(4.8, 7, 0.22), wood, [0, 3.5, -2.09]),
    part(vertical(0.22, 7, 4.4), wood, [-2.29, 3.5, 0]),
    part(vertical(0.22, 7, 4.4), wood, [2.29, 3.5, 0]),
    part(roundedBox(4.9, 0.26, 4.4, 0.04, 2), wood, [0, 6.87, 0]),
    part(box(4.6, 0.18, 4.2), dark, [0, 0.09, 0]),
    // Front posts, header, and the bronze glass front with a full-height door.
    part(vertical(0.22, 7, 0.22), wood, [-2.29, 3.5, 2.09]),
    part(vertical(0.22, 7, 0.22), wood, [2.29, 3.5, 2.09]),
    part(roundedBox(4.8, 0.55, 0.22, 0.02, 1), wood, [0, 6.68, 2.09]),
    part(box(4.36, 6.22, 0.03), palette.tintedGlass(), [0, 3.3, 2.12], undefined, undefined, false),
    part(box(0.05, 6.22, 0.06), dark, [0.1, 3.3, 2.13]),
    part(roundedBox(0.09, 1.5, 0.12, 0.03, 2), palette.oak(), [0.32, 3.3, 2.16]),
    // Two-tier benches with slatted backrest.
    part(roundedBox(4.3, 0.14, 1.55, 0.02, 1), wood, [0, 3.0, -1.2]),
    part(roundedBox(4.3, 0.14, 1.0, 0.02, 1), wood, [0, 1.62, 0.05]),
    part(box(4.3, 1.45, 0.12), wood, [0, 2.3, -0.45]),
    part(box(4.3, 3.0, 0.12), wood, [0, 1.5, -1.95]),
  ]
  for (let i = 0; i < 6; i++)
    parts.push(part(roundedBox(4.2, 0.14, 0.06, 0.02, 1), wood, [0, 3.6 + i * 0.36, -1.94]))
  // Heater with a basket of stones.
  parts.push(part(roundedBox(0.95, 1.6, 0.75, 0.05, 2), palette.brushed(), [-1.55, 0.95, 1.2]))
  const rock = custom('sauna-rock', () => boxProjectUV(new DodecahedronGeometry(0.09, 0)))
  const stone = material({
    set: 'concrete_wall_001',
    color: '#6e6a66',
    roughness: 1,
    interior: true,
  })
  for (let i = 0; i < 28; i++) {
    const a = noise(i, 41) * Math.PI * 2,
      r = noise(i, 42) * 0.3
    parts.push(
      part(
        rock,
        stone,
        [-1.55 + Math.cos(a) * r, 1.8 + noise(i, 43) * 0.12, 1.2 + Math.sin(a) * r * 0.8],
        [noise(i, 44) * 3, noise(i, 45) * 3, 0],
        [1 + noise(i, 46) * 0.4, 0.8, 1],
        false,
      ),
    )
  }
  parts.push(
    part(
      box(4.2, 0.03, 0.03),
      palette.emitter('#ffb978', 3.2),
      [0, 2.9, -0.45],
      undefined,
      undefined,
      false,
    ),
  )
  return parts
}

function plunge(): Part[] {
  const W = 2.9,
    D = 5.2,
    H = 2.7
  const cladding = material({
    set: 'oak_veneer_01',
    color: '#7a6450',
    roughness: 0.9,
    interior: true,
  })
  const rim = palette.plastic('#262827', 0.55)
  const liner = palette.plastic('#e9ecea', 0.18)
  const shell = extrude(
    'plunge-shell',
    () => {
      const s = roundedRectShape(W, D, 0.32)
      s.holes.push(roundedRectShape(W - 0.4, D - 0.4, 0.14))
      return s
    },
    H - 0.12,
    0.02,
    16,
    { swap: true },
  )
  const parts: Part[] = [
    part(shell, cladding, [0, (H - 0.12) / 2 + 0.02, 0], [Math.PI / 2, 0, 0]),
    part(
      extrude(
        'plunge-rim',
        () => {
          const s = roundedRectShape(W + 0.04, D + 0.04, 0.34)
          s.holes.push(roundedRectShape(W - 0.44, D - 0.44, 0.12))
          return s
        },
        0.12,
        0.03,
        16,
      ),
      rim,
      [0, H - 0.06, 0],
      [Math.PI / 2, 0, 0],
    ),
    part(
      extrude('plunge-floor', () => roundedRectShape(W - 0.4, D - 0.4, 0.14), 0.1, 0.02, 12),
      liner,
      [0, 0.4, 0],
      [Math.PI / 2, 0, 0],
    ),
    part(
      extrude(
        'plunge-liner',
        () => {
          const s = roundedRectShape(W - 0.4, D - 0.4, 0.14)
          s.holes.push(roundedRectShape(W - 0.5, D - 0.5, 0.1))
          return s
        },
        H - 0.6,
        0,
        12,
      ),
      liner,
      [0, 0.45 + (H - 0.6) / 2, 0],
      [Math.PI / 2, 0, 0],
      undefined,
      false,
    ),
    // Chilled water: deep teal by absorption over the tub depth.
    part(
      extrude('plunge-water', () => roundedRectShape(W - 0.5, D - 0.5, 0.1), 0.02, 0, 12),
      material({
        color: '#ffffff',
        transmission: 1,
        roughness: 0.04,
        ior: 1.333,
        thickness: 2,
        attenuationColor: '#a8dcd6',
        attenuationDistance: 3.2,
        interior: true,
      }),
      [0, H - 0.3, 0],
      [Math.PI / 2, 0, 0],
      undefined,
      false,
    ),
    // Control pad and temperature display.
    part(roundedBox(0.5, 0.06, 0.3, 0.03, 2), palette.screen(), [
      W / 2 - 0.45,
      H + 0.02,
      D / 2 - 0.12,
    ]),
    part(
      box(0.22, 0.01, 0.08),
      palette.emitter('#8fd8ff', 1.6),
      [W / 2 - 0.45, H + 0.055, D / 2 - 0.12],
      undefined,
      undefined,
      false,
    ),
  ]
  for (const x of [-W / 2 + 0.3, W / 2 - 0.3])
    for (const z of [-D / 2 + 0.3, D / 2 - 0.3])
      parts.push(part(box(0.3, 0.06, 0.3), black(), [x, 0.03, z]))
  return parts
}

function lounger(): Part[] {
  const oak = palette.oakOiled()
  const fabric = palette.fabric('#cfc3ad')
  const parts: Part[] = []
  // Bent-oak runners and stretchers.
  const runner: V3[] = [
    [0, 0.06, 2.2],
    [0, 0.35, 1.2],
    [0, 0.95, 0.2],
    [0, 0.8, -0.9],
    [0, 1.6, -2.0],
    [0, 2.1, -2.35],
  ]
  for (const x of [-1.05, 1.05])
    parts.push(part(tube('lounger-runner', runner, 0.075, 10), oak, [x, 0, 0]))
  for (const z of [1.6, -0.2, -1.8])
    parts.push(
      part(cylinder(0.05, 0.05, 2.1, 16), oak, [0, z > 1 ? 0.45 : z > -1 ? 0.85 : 1.4, z], AXIS_X),
    )
  parts.push(part(roundedBox(2.1, 0.32, 1.7, 0.14, 3), fabric, [0, 0.7, 1.1], [-0.38, 0, 0]))
  parts.push(part(roundedBox(2.1, 0.36, 1.9, 0.15, 3), fabric, [0, 1.08, -0.2], [0.08, 0, 0]))
  parts.push(part(roundedBox(2.1, 0.34, 1.75, 0.15, 3), fabric, [0, 1.75, -1.65], [0.72, 0, 0]))
  parts.push(
    part(
      roundedBox(1.15, 0.28, 0.55, 0.13, 3),
      palette.fabric('#b9ac95'),
      [0, 2.32, -2.05],
      [0.72, 0, 0],
    ),
  )
  return parts
}

// --- Cardio -------------------------------------------------------------------------------

function bike(): Part[] {
  const steel = palette.powder('#202221')
  const chrome = palette.brushed()
  const parts: Part[] = [
    part(roundedBox(1.9, 0.16, 0.26, 0.06, 2), steel, [0, 0.1, -1.55]),
    part(roundedBox(1.8, 0.16, 0.26, 0.06, 2), steel, [0, 0.1, 1.55]),
    part(
      tube(
        'bike-main',
        [
          [0, 0.18, 1.5],
          [0, 0.7, 0.95],
          [0, 1.25, 0.45],
          [0, 1.9, -0.35],
          [0, 2.6, -0.95],
          [0, 3.15, -1.2],
        ],
        0.11,
        14,
      ),
      steel,
      [0, 0, 0],
    ),
    part(
      tube(
        'bike-down',
        [
          [0, 0.18, -1.5],
          [0, 0.8, -1.3],
          [0, 1.4, -1.05],
          [0, 2.05, -0.75],
        ],
        0.09,
        12,
      ),
      steel,
      [0, 0, 0],
    ),
    // Polished flywheel inside a guard.
    part(
      lathe(
        'flywheel',
        [
          [0, -0.07],
          [0.7, -0.07],
          [0.74, -0.04],
          [0.74, 0.04],
          [0.7, 0.07],
          [0, 0.07],
        ],
        48,
      ),
      palette.polished(),
      [0, 1.15, -0.95],
      AXIS_X,
    ),
    part(
      extrude(
        'flywheel-guard',
        () => {
          const s = roundedRectShape(1.75, 0.95, 0.45)
          return s
        },
        0.06,
        0.02,
        16,
      ),
      steel,
      [0.12, 1.15, -0.95],
      [0, Math.PI / 2, 0],
    ),
    part(
      extrude('flywheel-guard', () => roundedRectShape(1.75, 0.95, 0.45), 0.06, 0.02, 16),
      steel,
      [-0.12, 1.15, -0.95],
      [0, Math.PI / 2, 0],
    ),
    // Crank, arms, pedals with straps.
    part(cylinder(0.14, 0.14, 0.36, 24), steel, [0, 1.15, 0.05], AXIS_X),
    part(roundedBox(0.06, 0.6, 0.1, 0.02, 1), chrome, [0.23, 1.0, 0.25], [0.7, 0, 0]),
    part(roundedBox(0.06, 0.6, 0.1, 0.02, 1), chrome, [-0.23, 1.3, -0.15], [0.7, 0, 0]),
    part(roundedBox(0.38, 0.06, 0.17, 0.02, 1), black(), [0.42, 0.82, 0.45]),
    part(roundedBox(0.38, 0.06, 0.17, 0.02, 1), black(), [-0.42, 1.48, -0.35]),
    // Seat post, saddle, handlebar mast, bars, console.
    part(cylinder(0.06, 0.06, 1.35, 20), chrome, [0, 2.45, 0.62], [-0.3, 0, 0]),
    part(roundedBox(0.58, 0.14, 0.62, 0.07, 3), palette.vinyl('#1e201f'), [0, 3.12, 0.85]),
    part(roundedBox(0.26, 0.12, 0.5, 0.06, 3), palette.vinyl('#1e201f'), [0, 3.12, 0.38]),
    part(cylinder(0.06, 0.06, 0.95, 20), chrome, [0, 3.45, -1.28], [0.18, 0, 0]),
    part(
      tube(
        'bike-bars',
        [
          [-0.75, 3.8, -1.05],
          [-0.45, 3.9, -1.25],
          [0, 3.92, -1.36],
          [0.45, 3.9, -1.25],
          [0.75, 3.8, -1.05],
        ],
        0.05,
        12,
      ),
      palette.rubber('#191a1a'),
      [0, 0, 0],
    ),
    part(roundedBox(0.62, 0.42, 0.08, 0.03, 2), steel, [0, 4.12, -1.5], [-0.35, 0, 0]),
    part(screen(0.5, 0.3), consoleScreen(), [0, 4.13, -1.45], [-0.35, 0, 0], undefined, false),
  ]
  for (const x of [-0.85, 0.85]) {
    parts.push(part(cylinder(0.08, 0.1, 0.06, 16), palette.rubber(), [x, 0.03, -1.55]))
    parts.push(part(cylinder(0.08, 0.1, 0.06, 16), palette.rubber(), [x, 0.03, 1.55]))
  }
  return parts
}

function treadmill(): Part[] {
  const body = palette.powder('#1e201f')
  const rail = palette.anodized('#4d524f', true)
  const parts: Part[] = [
    part(roundedBox(2.7, 0.42, 5.45, 0.12, 3), body, [0, 0.27, 0.1]),
    part(
      roundedBox(2.0, 0.035, 4.75, 0.015, 1),
      material({
        set: 'rubberized_track',
        color: '#262827',
        roughness: 0.85,
        normalScale: 0.5,
        interior: true,
      }),
      [0, 0.5, 0.35],
    ),
    part(roundedBox(0.3, 0.07, 4.9, 0.02, 1), rail, [-1.18, 0.49, 0.35]),
    part(roundedBox(0.3, 0.07, 4.9, 0.02, 1), rail, [1.18, 0.49, 0.35]),
    part(roundedBox(2.65, 0.62, 0.95, 0.24, 3), body, [0, 0.52, -2.35]),
    part(cylinder(0.14, 0.14, 2.06, 24), palette.brushed(), [0, 0.38, 2.75], AXIS_X),
    // Uprights, handrails, and console with a live workout display.
    part(
      tube(
        'tm-upright',
        [
          [0, 0.6, -2.45],
          [0, 2.2, -2.35],
          [0, 3.75, -2.15],
        ],
        0.1,
        12,
      ),
      body,
      [-1.12, 0, 0],
    ),
    part(
      tube(
        'tm-upright',
        [
          [0, 0.6, -2.45],
          [0, 2.2, -2.35],
          [0, 3.75, -2.15],
        ],
        0.1,
        12,
      ),
      body,
      [1.12, 0, 0],
    ),
    part(
      tube(
        'tm-rail',
        [
          [0, 3.6, -2.2],
          [0, 3.55, -1.6],
          [0, 3.4, -1.15],
        ],
        0.055,
        12,
      ),
      palette.rubber('#191a1a'),
      [-1.18, 0, 0],
    ),
    part(
      tube(
        'tm-rail',
        [
          [0, 3.6, -2.2],
          [0, 3.55, -1.6],
          [0, 3.4, -1.15],
        ],
        0.055,
        12,
      ),
      palette.rubber('#191a1a'),
      [1.18, 0, 0],
    ),
    part(roundedBox(2.45, 0.95, 0.28, 0.12, 3), body, [0, 4.05, -2.18], [-0.32, 0, 0]),
    part(screen(1.3, 0.72), consoleScreen(), [0, 4.1, -2.03], [-0.32, 0, 0], undefined, false),
  ]
  for (const x of [-1.2, 1.2])
    parts.push(part(roundedBox(0.3, 0.07, 0.4, 0.03, 1), palette.rubber(), [x, 0.03, 2.55]))
  return parts
}

// --- Movement -----------------------------------------------------------------------------

function mat(): Part[] {
  return [
    part(
      roundedBox(2.05, 0.025, 5.3, 0.012, 1),
      material({
        set: 'rubberized_track',
        color: '#a7b391',
        roughness: 0.95,
        normalScale: 0.35,
        interior: true,
      }),
      [0, 0.013, 0],
      undefined,
      undefined,
      false,
    ),
    part(
      roundedBox(0.72, 0.3, 0.48, 0.04, 2),
      material({ set: 'rubberized_track', color: '#b48d62', roughness: 0.95, interior: true }),
      [0.35, 0.18, -2.15],
      [0, 0.25, 0],
    ),
    part(cylinder(0.24, 0.24, 1.45, 32), palette.rubber('#2c2e2d'), [-0.35, 0.25, -2.0], AXIS_X),
    part(cylinder(0.17, 0.17, 1.15, 28), palette.fabric('#e3ddd1'), [0.1, 0.18, 2.2], AXIS_X),
  ]
}

function reformer(): Part[] {
  const ash = palette.oakOiled()
  const alu = palette.anodized('#a9adaa', true)
  const pad = palette.vinyl('#5f6a55')
  const parts: Part[] = []
  for (const x of [-1.05, 1.05]) {
    parts.push(part(roundedBox(0.24, 0.42, 6.4, 0.04, 2), ash, [x, 0.72, 0]))
    parts.push(part(box(0.06, 0.05, 6.2), alu, [x - Math.sign(x) * 0.15, 0.95, 0]))
    for (const z of [-2.9, 2.9])
      parts.push(part(roundedBox(0.24, 0.52, 0.24, 0.04, 2), ash, [x, 0.26, z]))
  }
  parts.push(part(roundedBox(2.34, 0.4, 0.24, 0.04, 2), ash, [0, 0.72, -3.08]))
  parts.push(part(roundedBox(2.34, 0.4, 0.24, 0.04, 2), ash, [0, 0.72, 3.08]))
  // Carriage, shoulder rests, headrest.
  parts.push(part(roundedBox(1.78, 0.28, 2.6, 0.1, 3), pad, [0, 1.08, 0.75]))
  parts.push(part(box(1.7, 0.08, 2.5), palette.powder('#2b2d2b'), [0, 0.92, 0.75]))
  for (const x of [-0.42, 0.42])
    parts.push(part(roundedBox(0.32, 0.42, 0.3, 0.12, 3), pad, [x, 1.4, -0.45]))
  parts.push(part(roundedBox(0.95, 0.12, 0.62, 0.05, 2), pad, [0, 1.28, -0.85], [-0.25, 0, 0]))
  // Springs under the carriage to the spring bar.
  const coil: V3[] = []
  for (let i = 0; i <= 120; i++) {
    const t = i / 120
    coil.push([
      Math.cos(t * Math.PI * 44) * 0.045,
      Math.sin(t * Math.PI * 44) * 0.045,
      -0.55 - t * 1.85,
    ])
  }
  const springColors = ['#d9b23a', '#c0392b', '#c0392b', '#3462a8', '#5c9a4f']
  springColors.forEach((c, i) =>
    parts.push(
      part(
        tube('reformer-spring', coil, 0.012, 6),
        palette.plastic(c, 0.35),
        [-0.5 + i * 0.25, 0.8, 0],
        undefined,
        undefined,
        false,
      ),
    ),
  )
  parts.push(part(cylinder(0.04, 0.04, 1.9, 16), palette.brushed(), [0, 0.8, -2.45], AXIS_X))
  // Chrome footbar and the standing platform.
  parts.push(
    part(
      tube(
        'footbar',
        [
          [-0.95, 0.95, -2.75],
          [-0.95, 1.45, -2.95],
          [0, 1.6, -3.0],
          [0.95, 1.45, -2.95],
          [0.95, 0.95, -2.75],
        ],
        0.055,
        14,
      ),
      palette.polished(),
      [0, 0, 0],
    ),
  )
  parts.push(part(roundedBox(1.75, 0.1, 0.55, 0.04, 2), pad, [0, 0.98, -2.72]))
  // Risers with ropes and loops at the head end.
  for (const x of [-0.95, 0.95]) {
    parts.push(part(cylinder(0.05, 0.05, 0.8, 16), palette.brushed(), [x, 1.26, 3.0]))
    parts.push(
      part(cylinder(0.08, 0.08, 0.06, 20), black(), [x, 1.64, 3.0], AXIS_X, undefined, false),
    )
    parts.push(
      part(
        tube(
          `rope:${x}`,
          [
            [x, 1.64, 3.0],
            [x * 0.7, 1.6, 2.2],
            [x * 0.55, 1.25, 1.6],
          ],
          0.012,
          6,
        ),
        palette.nylon('#e6e1d6'),
        [0, 0, 0],
        undefined,
        undefined,
        false,
      ),
    )
  }
  return parts
}

const BUILDERS: Record<PlacedItem['sku'], () => Part[]> = {
  rack,
  bench,
  weights: dumbbellRack,
  sauna,
  plunge,
  bike,
  treadmill,
  mat,
  reformer,
  lounge: lounger,
}

const cache = new Map<PlacedItem['sku'], Part[]>()
/** Part list for a catalog item (shared by every placed copy). */
export function equipmentParts(sku: PlacedItem['sku']) {
  let parts = cache.get(sku)
  if (!parts) {
    parts = BUILDERS[sku]()
    cache.set(sku, parts)
  }
  return parts
}
