/**
 * Builds the same part lists the web scene draws and flattens them into world-space meshes, one
 * per material, for an offline renderer. Loaded through Vite (see export.mjs) so `import.meta.env`
 * and the app's module graph resolve exactly as in the browser.
 */
import { Matrix3, Matrix4, Vector3, type BufferGeometry, type Material } from 'three'
import { DEFAULT_CONFIG, packageItems, productHeight, type Config } from '../../src/lib/config'
import { sunAt } from '../../src/lib/visuals'
import {
  FLOOR_Y,
  containerInterior,
  containerShell,
  interiorBounds,
  studioGlazing,
  studioInterior,
  studioShell,
} from '../../src/render/architecture'
import { deck, pergola, roofDeck, stairs, timberAccent } from '../../src/render/addons'
import { equipmentParts } from '../../src/render/equipment'
import { box, cylinder, lathe } from '../../src/render/geometry'
import { TEXTURE_SETS, type MaterialSpec } from '../../src/render/materials'
import { palette } from '../../src/render/palette'
import { part, place, type Part } from '../../src/render/parts'

/** Light fixtures as InteriorLights draws them. In a path tracer the emitters are the lights. */
function fixtures(c: Config): Part[] {
  const b = interiorBounds(c)
  const L = c.length
  const columns = L === 20 ? [-6, -2, 2, 6] : [-16, -12, -8, -4, 0, 4, 8, 12, 16]
  const trim = palette.powder('#141515')
  const lens = c.lights ? palette.emitter('#fff3e2', 7) : palette.plastic('#d8d4cb', 0.3)
  const strip = c.lights ? palette.emitter('#ffd9ad', 5) : palette.plastic('#cfcac0', 0.4)
  const puck = lathe(
    'downlight',
    [
      [0, 0],
      [0.2, 0],
      [0.2, 0.03],
      [0.15, 0.05],
      [0.12, 0.2],
      [0, 0.2],
    ],
    32,
  )
  const parts: Part[] = []
  for (const x of columns)
    for (const z of [-1.3, 1.5]) {
      parts.push(part(puck, trim, [x + 0.12, b.ceiling - 0.03, z]))
      parts.push(part(cylinder(0.11, 0.11, 0.01, 24), lens, [x + 0.12, b.ceiling - 0.005, z]))
    }
  parts.push(part(box(L - 2.6, 0.04, 0.05), strip, [0, b.ceiling - 0.06, b.back + 0.08]))
  parts.push(part(box(L - 2.6, 0.12, 0.12), trim, [0, b.ceiling - 0.02, b.back + 0.1]))
  parts.push(part(box(L - 1.6, 0.025, 0.04), strip, [0, FLOOR_Y + 0.23, b.back + 0.05]))
  return parts
}

export function sceneParts(c: Config): Part[] {
  const studio = c.family === 'studio'
  const parts = [
    ...(studio ? studioShell(c) : containerShell(c)),
    ...(studio ? studioInterior(c) : containerInterior(c)),
    ...(studio ? studioGlazing(c) : []),
    ...fixtures(c),
  ]
  if (studio) {
    if (c.accent) parts.push(...timberAccent(c))
    if (c.addons.deck) parts.push(...deck(c))
    if (c.addons.gazebo) parts.push(...pergola(c))
    if (c.addons.roof) parts.push(...roofDeck(c))
    if (c.addons.stairs) parts.push(...stairs(c))
  }
  for (const item of c.items)
    parts.push(
      ...place(
        equipmentParts(item.sku),
        [item.x, FLOOR_Y, item.z],
        [0, (-item.rotation * Math.PI) / 180, 0],
      ),
    )
  return parts
}

type Accumulator = { spec: MaterialSpec; p: number[]; n: number[]; uv: number[]; i: number[] }

function append(acc: Accumulator, geometry: BufferGeometry, matrix: Matrix4) {
  const g = geometry
  const pos = g.getAttribute('position')
  const nor = g.getAttribute('normal')
  const uv = g.getAttribute('uv')
  const normalMatrix = new Matrix3().getNormalMatrix(matrix)
  const flip = matrix.determinant() < 0
  const base = acc.p.length / 3
  const v = new Vector3()
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(matrix)
    acc.p.push(v.x, v.y, v.z)
    if (nor) {
      v.fromBufferAttribute(nor, k).applyMatrix3(normalMatrix).normalize()
      acc.n.push(v.x, v.y, v.z)
    } else acc.n.push(0, 1, 0)
    if (uv) acc.uv.push(uv.getX(k), uv.getY(k))
    else acc.uv.push(0, 0)
  }
  const index = g.index
  const count = index ? index.count : pos.count
  for (let k = 0; k < count; k += 3) {
    const a = index ? index.getX(k) : k
    const b = index ? index.getX(k + 1) : k + 1
    const c = index ? index.getX(k + 2) : k + 2
    // Mirrored transforms reverse winding; keep faces pointing the way their normals do.
    if (flip) acc.i.push(base + a, base + c, base + b)
    else acc.i.push(base + a, base + b, base + c)
  }
}

const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer).toString('base64')
const u32 = (a: number[]) => Buffer.from(new Uint32Array(a).buffer).toString('base64')

/** The scene as JSON: meshes in feet, three.js axes (y up, front +z), plus camera and sun. */
export function exportScene(c: Config, view: 'exterior' | 'interior') {
  const groups = new Map<Material, Accumulator>()
  for (const p of sceneParts(c)) {
    const spec = p.material.userData.spec as MaterialSpec | undefined
    if (!spec) throw new Error(`Material without a spec: ${p.material.type}`)
    let acc = groups.get(p.material)
    if (!acc) groups.set(p.material, (acc = { spec, p: [], n: [], uv: [], i: [] }))
    append(acc, p.geometry, p.matrix)
  }
  const hasOutdoor = c.addons.deck || c.addons.gazebo || c.addons.stairs
  const look =
    view === 'interior'
      ? [-c.length / 4, 4.6, -0.7]
      : [c.addons.stairs ? 2 : 0, c.addons.roof ? 5 : 3.5, hasOutdoor ? 2.2 : 0]
  const position =
    view === 'interior'
      ? [c.length / 2 - 2.2, 5.8, 1.4]
      : (() => {
          const dir = new Vector3(0.48, 0.24, 0.84).normalize()
          const width = c.length + (c.addons.stairs ? 6 : 2)
          const depth = hasOutdoor ? 17 : 10
          const height = c.addons.roof || c.addons.stairs ? 14 : productHeight(c)
          const radius = Math.sqrt(width * width + depth * depth + height * height) / 2
          const d = (radius / Math.sin((32 * Math.PI) / 360)) * 0.94
          return [look[0] + dir.x * d, look[1] + dir.y * d, look[2] + dir.z * d]
        })()
  return {
    config: c,
    units: 'feet',
    camera: { position, look, fov: view === 'interior' ? 68 : 32 },
    sun: sunAt(c.time),
    textureSets: TEXTURE_SETS,
    meshes: [...groups.values()].map((g) => ({
      spec: g.spec,
      vertices: g.p.length / 3,
      position: f32(g.p),
      normal: f32(g.n),
      uv: f32(g.uv),
      index: u32(g.i),
    })),
  }
}

export const presets: Record<string, Config> = {
  'studio-strength': DEFAULT_CONFIG,
  'studio-full': {
    ...DEFAULT_CONFIG,
    length: 40,
    finish: 'olive',
    accent: true,
    addons: { deck: true, gazebo: true, roof: true, stairs: true },
    flooring: 'oak',
    package: 'recovery',
    items: packageItems('recovery', 40),
    time: 18.5,
  },
  'container-open': {
    ...DEFAULT_CONFIG,
    family: 'container',
    containerOpening: 'full',
    finish: 'bronze',
    package: 'cardio',
    items: packageItems('cardio', 20),
  },
}
