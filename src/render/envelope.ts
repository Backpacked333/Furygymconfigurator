import { productHeight, type Config } from '../lib/config'

/**
 * The building's measurements that camera framing needs: free of three.js imports, so the gallery
 * cameras (gallery.ts) can be worked out in the app shell, before the 3D chunk has loaded. The
 * geometry builders (architecture.ts, addons.ts) take their numbers from here too.
 */

/** Top of the finished floor; equipment stands on it. */
export const FLOOR_Y = 0.96
/**
 * Studio portal (feet): base height, shell wall thickness, outer corner radius, depth, and the
 * width of the front face (proud lip plus recessed bezel) around the glazing.
 */
export const STUDIO = { base: 0.3, wall: 0.36, radius: 1.6, depth: 8, bezel: 0.8, lip: 0.3 }
/** Inner face of the Container's back wall. */
export const CONTAINER_BACK = -3.62
/** Container decks sit at grade, a step below the opening sill. */
export const GRADE_DECK = { top: 0.5, depth: 5.5 }
/** Height of the Container roof deck's timber-clad frame above the roof. */
export const ROOF_FRAME = 1.1

/** Walking surface of the rooftop deck for either family. */
export function roofTop(c: Config) {
  return c.family === 'studio'
    ? STUDIO.base + productHeight(c) + 0.12
    : productHeight(c) + ROOF_FRAME
}
/** Front edge of the grade or raised deck, for dimension lines and camera framing. */
export const deckFront = (c: Config) => (c.family === 'studio' ? 13 : 4 + GRADE_DECK.depth)

/** Interior geometry the lights, the probe and the gallery's interior cameras need. */
export function interiorBounds(c: Config) {
  const H = productHeight(c)
  const slatted = c.interiorStyle === 'slatted'
  if (c.family === 'studio') {
    const top = STUDIO.base + H - STUDIO.wall - 0.08
    return {
      ceiling: slatted ? top - 0.42 : top,
      back: -3.74,
      front: 3.62,
      halfWidth: c.length / 2 - 0.62,
    }
  }
  return {
    ceiling: slatted ? H - 1.1 : H - 0.72,
    back: CONTAINER_BACK,
    front: 3.6,
    halfWidth: c.length / 2 - 0.62,
  }
}
