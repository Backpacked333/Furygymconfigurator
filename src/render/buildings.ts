import { DoubleSide } from 'three'
import { noise } from '../lib/visuals'
import { box, cylinder, roundedBox } from './geometry'
import { material } from './materials'
import { palette } from './palette'
import { part, place, type Part, type V3 } from './parts'

/**
 * Background architecture for the portfolio settings, modeled at real scale (feet). Each builder
 * returns a part list in local coordinates: origin at the ground under the center of the main
 * facade, facade facing +z. Windows are surface-mounted frames over the wall planes, which reads
 * correctly at the distances these buildings are seen from and keeps every facade a few boxes.
 */

/** Reflective double glazing; non-transmissive, so it costs no more than any opaque surface. */
export const facadeGlass = (tint = '#1e2729') =>
  material({
    color: tint,
    roughness: 0.04,
    metalness: 0.2,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envIntensity: 1.35,
  })
/** A window lit from inside: warm, curtained light whose strength follows dusk. */
export const litWindow = (strength: number, color = '#ffcf98') =>
  material({
    color: '#2a2622',
    roughness: 0.2,
    emissive: color,
    emissiveIntensity: Math.max(0.05, strength),
  })

type Window = {
  x: number
  y: number
  w: number
  h: number
  z: number
  frame: ReturnType<typeof material>
  lit: boolean
  glow: number
  mullion?: boolean
  sill?: ReturnType<typeof material>
}
/** A framed window (or glazed door) standing proud of a wall plane at depth z. */
function windowParts({ x, y, w, h, z, frame, lit, glow, mullion = true, sill }: Window): Part[] {
  const f = 0.22
  const parts: Part[] = [
    part(
      box(w, h, 0.06),
      lit && glow > 0.05 ? litWindow(glow) : facadeGlass(),
      [x, y + h / 2, z + 0.06],
      undefined,
      undefined,
      false,
    ),
    part(box(w + f, f, 0.24), frame, [x, y + h + f / 2 - 0.02, z + 0.1]),
    part(box(w + f, f, 0.24), frame, [x, y - f / 2 + 0.02, z + 0.1]),
    part(box(f, h, 0.24), frame, [x - w / 2, y + h / 2, z + 0.1]),
    part(box(f, h, 0.24), frame, [x + w / 2, y + h / 2, z + 0.1]),
  ]
  if (mullion) {
    parts.push(
      part(box(0.12, h, 0.16), frame, [x, y + h / 2, z + 0.12], undefined, undefined, false),
    )
    parts.push(
      part(box(w, 0.12, 0.16), frame, [x, y + h * 0.62, z + 0.12], undefined, undefined, false),
    )
  }
  if (sill) parts.push(part(box(w + 0.7, 0.28, 0.6), sill, [x, y - 0.3, z + 0.3]))
  return parts
}

/** Black steel picket railing along x at a balcony edge. */
function picketRail(
  x0: number,
  x1: number,
  y: number,
  z: number,
  rail: ReturnType<typeof material>,
) {
  const parts: Part[] = [
    part(box(x1 - x0, 0.16, 0.16), rail, [(x0 + x1) / 2, y + 3.4, z]),
    part(box(x1 - x0, 0.1, 0.1), rail, [(x0 + x1) / 2, y + 0.35, z]),
  ]
  const picket = box(0.06, 3.0, 0.06)
  for (let x = x0 + 0.2; x < x1 - 0.1; x += 0.36)
    parts.push(part(picket, rail, [x, y + 1.85, z], undefined, undefined, false))
  return parts
}

export type ApartmentStyle = 'brick' | 'timber'

/**
 * A four-story apartment block: alternating brick (or cedar) piers with punched windows and
 * recessed stucco (or graphite panel) bays carrying balconies, a base course, and a parapet.
 */
export function apartmentBlock(opts: {
  length: number
  floors?: number
  depth?: number
  style?: ApartmentStyle
  seed?: number
  glow: number
}): Part[] {
  const { length, floors = 4, depth = 46, style = 'brick', seed = 1, glow } = opts
  const ground = 12,
    storey = 10.5
  const H = ground + (floors - 1) * storey + 3
  const bay = 13
  const bays = Math.max(3, Math.round(length / bay))
  const width = bays * bay
  const brick = style === 'brick'
  const pier = brick ? palette.brick('#ffffff') : palette.cedar(false, '#c79f7c')
  const infill = brick ? palette.stucco('#d5cabd') : palette.powder('#4a4d4b', false, 0.7)
  const trim = brick ? palette.plastic('#ebe8e1', 0.5) : palette.powder('#1d1f1e', false, 0.6)
  const sill = brick ? palette.concrete() : trim
  const rail = palette.powder('#141615', false, 0.5)
  const slab = material({ set: 'concrete_wall_001', color: '#d9d4cb', roughness: 1 })
  const parts: Part[] = []
  // Massing behind the facade, roof slab, and parapet coping.
  parts.push(part(box(width, H, depth - 4), infill, [0, H / 2, -4 - (depth - 4) / 2]))
  parts.push(part(box(width + 0.6, 0.5, 1.4), sill, [0, H + 0.25, -0.4]))
  parts.push(part(box(width, 1.6, 0.6), pier, [0, 0.8, 0.3]))
  let index = 0
  for (let b = 0; b < bays; b++) {
    const cx = -width / 2 + bay * (b + 0.5)
    const recessed = b % 2 === 1
    if (!recessed) {
      // Pier bay: full-depth masonry with two punched windows per floor.
      parts.push(part(box(bay, H, 4), pier, [cx, H / 2, -2]))
      for (let f = 0; f < floors; f++) {
        const y = f === 0 ? 3 : ground + (f - 1) * storey + 2.6
        for (const dx of [-3, 3]) {
          const lit = noise(seed * 31 + index++, 7) < 0.38
          parts.push(
            ...windowParts({
              x: cx + dx,
              y,
              w: 3.4,
              h: f === 0 ? 6.4 : 5.6,
              z: 0,
              frame: trim,
              lit,
              glow,
              sill,
            }),
          )
        }
        if (brick && f > 0)
          // Soldier-course lintel band.
          parts.push(
            part(box(bay - 0.4, 0.55, 0.12), palette.brick('#b8a59a'), [cx, y + 6.2, 0.06]),
          )
      }
    } else {
      // Recessed bay with French doors and a balcony on every upper floor.
      parts.push(part(box(bay, H, 0.6), infill, [cx, H / 2, -3.9]))
      for (let f = 0; f < floors; f++) {
        const y = f === 0 ? 1.6 : ground + (f - 1) * storey
        for (const dx of [-2.5, 2.5]) {
          const lit = noise(seed * 31 + index++, 9) < 0.42
          parts.push(
            ...windowParts({
              x: cx + dx,
              y: y + 0.4,
              w: 3.2,
              h: 7.6,
              z: -3.6,
              frame: trim,
              lit,
              glow,
              mullion: true,
            }),
          )
        }
        if (f > 0) {
          parts.push(part(box(bay - 0.3, 0.45, 4.2), slab, [cx, y - 0.2, -1.8]))
          if (brick) parts.push(...picketRail(cx - bay / 2 + 0.3, cx + bay / 2 - 0.3, y, 0.1, rail))
          else
            parts.push(
              part(
                box(bay - 0.6, 3.3, 0.06),
                palette.glass(),
                [cx, y + 1.7, 0.15],
                undefined,
                undefined,
                false,
              ),
              part(box(bay - 0.4, 0.14, 0.2), rail, [cx, y + 3.4, 0.15]),
            )
        }
      }
    }
  }
  // Rooftop mechanical screen.
  parts.push(
    part(box(width * 0.3, 5, 12), palette.powder('#6d6f6c', false, 0.8), [
      width * 0.12,
      H + 2.5,
      -depth / 2,
    ]),
  )
  return parts
}

/** A glass curtain-wall office: reflective glazing, aluminum mullions, and spandrel bands. */
export function curtainWallOffice(opts: { length: number; floors: number; depth: number }): Part[] {
  const { length, floors, depth } = opts
  const storey = 13.5
  const H = floors * storey + 4
  const glass = facadeGlass('#2b4246')
  const alu = palette.anodized('#8f9798')
  const spandrel = material({
    color: '#334448',
    roughness: 0.25,
    metalness: 0.5,
    envIntensity: 1.2,
  })
  const parts: Part[] = [part(box(length, H, depth), glass, [0, H / 2, -depth / 2])]
  for (const face of [
    { axis: 'z' as const, at: 0, span: length },
    { axis: 'x' as const, at: length / 2, span: depth },
  ]) {
    const pitch = 5
    const count = Math.floor(face.span / pitch)
    for (let i = 0; i <= count; i++) {
      const t = -face.span / 2 + i * pitch
      parts.push(
        face.axis === 'z'
          ? part(box(0.25, H, 0.6), alu, [t, H / 2, 0.3], undefined, undefined, false)
          : part(
              box(0.6, H, 0.25),
              alu,
              [face.at + 0.3, H / 2, -depth / 2 + t],
              undefined,
              undefined,
              false,
            ),
      )
    }
    for (let f = 1; f <= floors; f++) {
      const y = f * storey - 0.9
      parts.push(
        face.axis === 'z'
          ? part(box(face.span, 1.8, 0.4), spandrel, [0, y, 0.2], undefined, undefined, false)
          : part(
              box(0.4, 1.8, face.span),
              spandrel,
              [face.at + 0.2, y, -depth / 2],
              undefined,
              undefined,
              false,
            ),
      )
    }
  }
  parts.push(part(box(length + 0.6, 3, depth + 0.6), alu, [0, H + 1.5, -depth / 2]))
  return parts
}

/** A precast-concrete office with deep punched windows on a regular grid. */
export function precastOffice(opts: {
  length: number
  floors: number
  depth: number
  glow: number
}): Part[] {
  const { length, floors, depth, glow } = opts
  const storey = 13
  const H = floors * storey + 3.5
  const precast = palette.stucco('#dccdb4')
  const joint = material({ color: '#a89a83', roughness: 1 })
  const frame = palette.anodized('#3a3f40')
  const parts: Part[] = [part(box(length, H, depth), precast, [0, H / 2, -depth / 2])]
  const pitch = 8
  const cols = Math.floor((length - 6) / pitch)
  let index = 0
  for (let f = 0; f < floors; f++) {
    const y = f * storey + 3.4
    parts.push(
      part(box(length, 0.08, 0.05), joint, [0, f * storey, 0.02], undefined, undefined, false),
    )
    for (let i = 0; i < cols; i++) {
      const x = -((cols - 1) * pitch) / 2 + i * pitch
      const lit = noise(index++, 19) < 0.3
      parts.push(...windowParts({ x, y, w: 5.2, h: 7, z: 0, frame, lit, glow, mullion: false }))
      // Deep reveal: a shadowed return above each window.
      parts.push(part(box(5.6, 0.5, 0.9), precast, [x, y + 7.45, 0.45]))
    }
  }
  parts.push(part(box(length + 1, 1.2, depth + 1), precast, [0, H + 0.6, -depth / 2]))
  return parts
}

/**
 * A two-story modern house: a glazed ground floor under a cedar-clad upper volume, thin white
 * roof plates with deep overhangs, and a timber terrace.
 */
export function modernHouse(opts: { glow: number }): Part[] {
  const { glow } = opts
  const cedar = palette.cedar(false, '#c9a07c')
  const render = palette.stucco('#ece9e3')
  const roof = palette.plastic('#f1efea', 0.5)
  const frame = palette.anodized('#1a1c1b')
  const parts: Part[] = []
  // Ground floor: 64 x 11 ft glazed volume set back behind a terrace.
  parts.push(part(box(64, 11, 34), render, [0, 5.5, -17]))
  const glass = glow > 0.05 ? litWindow(glow * 0.8, '#ffd9a8') : facadeGlass('#273032')
  for (let i = 0; i < 8; i++) {
    const x = -24 + i * 6.8
    parts.push(part(box(6.6, 9.4, 0.08), glass, [x, 5.6, 0.08], undefined, undefined, false))
    parts.push(part(box(0.25, 9.6, 0.3), frame, [x - 3.4, 5.6, 0.15]))
  }
  parts.push(part(box(55, 0.3, 0.3), frame, [-0.2, 10.4, 0.15]))
  parts.push(part(box(55, 0.3, 0.3), frame, [-0.2, 0.85, 0.15]))
  // Cedar-clad end of the ground floor.
  parts.push(part(box(9, 11, 0.5), cedar, [27.5, 5.5, 0.25]))
  // Upper volume, cantilevered toward the garden, with a ribbon window.
  parts.push(part(box(44, 10.5, 30), cedar, [-8, 16.25, -13]))
  parts.push(
    part(
      box(30, 4.2, 0.08),
      glow > 0.05 ? litWindow(glow * 0.6) : facadeGlass(),
      [-12, 16.8, 2.08],
      undefined,
      undefined,
      false,
    ),
  )
  parts.push(part(box(30.6, 4.8, 0.3), frame, [-12, 16.8, 2.0]))
  // Thin roof plates with overhangs.
  parts.push(part(box(68, 0.8, 38), roof, [0, 11.4, -16]))
  parts.push(part(box(48, 0.8, 34), roof, [-8, 21.9, -12.5]))
  // Terrace and steps.
  const deckBoards = palette.teak()
  parts.push(part(box(58, 1.0, 10), palette.powder('#2a2b29', false, 0.9), [-3, 0.5, 5]))
  for (let z = 0.4; z < 10; z += 0.5)
    parts.push(
      part(
        roundedBox(58, 0.09, 0.46, 0.015, 1),
        deckBoards,
        [-3, 1.05, z],
        undefined,
        undefined,
        false,
      ),
    )
  for (let i = 0; i < 2; i++)
    parts.push(
      part(roundedBox(14, 0.5, 1.4, 0.03, 1), deckBoards, [-8, 0.25 + i * 0, 10.7 + i * 1.3]),
    )
  // Planters on the terrace.
  for (const x of [-26, 20])
    parts.push(part(cylinder(1.2, 0.95, 2.6, 32), palette.plastic('#efece6', 0.6), [x, 2.3, 7]))
  return parts
}

/** Outdoor lounge: teak-framed sofa and chairs around a linear concrete fire table. */
export function loungeSet(opts: { flame: boolean }): Part[] {
  const teak = palette.teak()
  const cushion = palette.fabric('#dcd6ca')
  const parts: Part[] = []
  const sofa = (x: number, z: number, ry: number, width: number) => {
    const seat: Part[] = [
      part(roundedBox(width, 1.2, 2.8, 0.08, 2), teak, [0, 0.6, 0]),
      part(roundedBox(width - 0.3, 0.55, 2.4, 0.2, 3), cushion, [0, 1.45, 0.15]),
      part(roundedBox(width - 0.3, 1.6, 0.6, 0.25, 3), cushion, [0, 2.2, -1.05], [-0.15, 0, 0]),
    ]
    parts.push(...place(seat, [x, 0, z], [0, ry, 0]))
  }
  sofa(0, -4.5, 0, 7)
  sofa(-5.2, 0, Math.PI / 2, 3)
  sofa(5.2, 0, -Math.PI / 2, 3)
  const concrete = material({ set: 'concrete_wall_001', color: '#bdb6aa', roughness: 0.9 })
  parts.push(part(roundedBox(5.6, 1.3, 2.4, 0.06, 2), concrete, [0, 0.65, 0]))
  parts.push(part(box(4.2, 0.12, 0.6), palette.black(), [0, 1.33, 0]))
  if (opts.flame)
    parts.push(
      part(
        box(3.8, 0.55, 0.12),
        material({
          color: '#000000',
          emissive: '#ff9a3c',
          emissiveIntensity: 6,
          roughness: 1,
          side: DoubleSide,
        }),
        [0, 1.65, 0],
        undefined,
        undefined,
        false,
      ),
    )
  return parts
}

/** A slatted stainless bench on two plinth legs (corporate plaza). */
export function slatBench(): Part[] {
  const steel = palette.brushed(false, '#c8cbcc')
  const parts: Part[] = []
  for (let i = 0; i < 9; i++)
    parts.push(part(roundedBox(6, 0.1, 0.16, 0.03, 1), steel, [0, 1.55, -0.65 + i * 0.165]))
  for (const x of [-2.4, 2.4]) parts.push(part(box(0.25, 1.5, 1.5), steel, [x, 0.75, 0]))
  return parts
}

/** A rectangular raised planter with a stone coping and dark soil. */
export function planter(w: number, d: number, h: number): Part[] {
  const stone = material({ set: 'concrete_wall_001', color: '#c9c3b7', roughness: 0.95 })
  const cap = material({ set: 'granite_tile_04', color: '#d2d0c9', roughness: 0.7 })
  const soil = material({ set: 'dry_ground_01', color: '#5e5143', roughness: 1 })
  return [
    part(box(w, h, d), stone, [0, h / 2, 0]),
    part(box(w + 0.3, 0.3, d + 0.3), cap, [0, h + 0.15, 0]),
    part(box(w - 0.6, 0.1, d - 0.6), soil, [0, h + 0.26, 0], undefined, undefined, false),
  ]
}

export type { V3 }
