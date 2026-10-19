import { noise } from '../../lib/visuals'
import { cylinder } from '../../render/geometry'
import { palette } from '../../render/palette'
import { part, type Part } from '../../render/parts'
import type { Quality } from '../../render/quality'

/** Share of foliage and grass instances drawn at each quality tier. */
export const DENSITY: Record<Quality, number> = { ultra: 1, high: 0.65, lite: 0.25 }
/** Module-level so the lawn's grass material is not rebuilt on every render. */
export const LAWN_COLORS: [string, string] = ['#3d5126', '#93a258']

/** A low path bollard: powder-coated post with a warm lens that glows when the lights are on. */
export function bollard(x: number, z: number, lights: boolean): Part[] {
  const post = palette.powder('#2c2a27', false, 0.6)
  return [
    part(cylinder(0.11, 0.11, 1.05, 24), post, [x, 0.52, z]),
    part(
      cylinder(0.115, 0.115, 0.08, 24),
      lights ? palette.emitter('#ffd6a0', 3) : palette.plastic('#d9d3c6', 0.4),
      [x, 0.92, z],
      undefined,
      undefined,
      false,
    ),
    part(cylinder(0.12, 0.12, 0.05, 24), post, [x, 1.07, z]),
  ]
}

/** Lawn blades scattered over a rectangle, avoiding the given keep-out rectangles. */
export function lawnPlacer(
  area: { x0: number; x1: number; z0: number; z1: number },
  keepOut: { x0: number; x1: number; z0: number; z1: number }[],
) {
  return (i: number): [number, number] | null => {
    const x = area.x0 + noise(i, 13) * (area.x1 - area.x0)
    const z = area.z0 + noise(i, 14) * (area.z1 - area.z0)
    return keepOut.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) ? null : [x, z]
  }
}
