import type { Node } from 'three/webgpu'
import { max, positionWorld, step } from 'three/tsl'
import type { Config } from '../lib/config'
import { FLOOR_Y, interiorBounds } from './architecture'

/**
 * Where the unit's own lights shine in the live view. A raster light passes through walls: the
 * room's ceiling washes lit the paving all round the unit through its shell, about a third as
 * strongly as the sun, and filled in its shadow, where the traced stills keep that light inside.
 */

/** The room's walls and floor are this far inside the box its lights reach (feet). */
const MARGIN = 0.25

type Vec3 = [number, number, number]
/**
 * Where the room's lights reach (world feet: the unit stands at the origin): the room, a little
 * beyond its inner faces, and, past its glazing (z ≥ `front`), the view out through it. The outer
 * faces of its shell, its roof, and the ground beside and behind it are out of reach.
 */
export function roomReach(c: Config) {
  const b = interiorBounds(c)
  return {
    low: [-b.halfWidth - MARGIN, FLOOR_Y - MARGIN, b.back - MARGIN] as Vec3,
    high: [b.halfWidth + MARGIN, b.ceiling + MARGIN] as [number, number],
    front: b.front,
  }
}
export type RoomReach = ReturnType<typeof roomReach>

/** Whether a point is in reach: what `roomMask` computes for each pixel. */
export function inReach({ low, high, front }: RoomReach, [x, y, z]: Vec3) {
  const across = x >= low[0] && x <= high[0]
  const inside = z >= low[2] && y <= high[1]
  return across && inside && (y >= low[1] || z >= front)
}

/** 1 where the room's lights reach, 0 elsewhere (`inReach` per pixel; the corners as uniforms). */
export function roomMask(low: Node<'vec3'>, high: Node<'vec3'>, front: Node<'float'>) {
  const p = positionWorld
  const across = step(low.x, p.x).mul(step(p.x, high.x))
  const inside = step(low.z, p.z).mul(step(p.y, high.y))
  // Above the floor in the room, or anywhere in front of the glazing: the light out through it.
  const reached = max(step(low.y, p.y), step(front, p.z))
  return across.mul(inside).mul(reached)
}
