import type { AspectClass } from '../render/gallery'
import { fingerprint } from '../render/hash'
import type { Config, PlacedItem } from './config'

/**
 * Keys for path-traced stills: one design, at one gallery angle, in one stage shape, by one
 * version of the renderer. The same design reached any way (equipment added in another order, a
 * shared link, a saved build) has the same key, so a still rendered once (or baked ahead of
 * time) serves it. Free of three.js imports, so the app shell can key a still before the 3D chunk
 * has loaded.
 */

/**
 * The renderer's version: stills made by another one are not this one's. A hash of the sources
 * that change how a still looks (scripts/render-version.ts), stamped by the build and the dev
 * server; 'test' in tests, 'dev' where nothing stamps it.
 */
export const RENDER_VERSION: string =
  typeof __RENDER_VERSION__ === 'string' ? __RENDER_VERSION__ : 'dev'

/** A number as JSON writes it, with -0 as 0 and float noise below 1e-6 rounded away. */
const tidy = (v: number) => {
  const rounded = Math.round(v * 1e6) / 1e6
  return rounded === 0 ? 0 : rounded
}

/**
 * The design as its picture sees it: equipment in a fixed order (by kind, then position and
 * turn) with ids that follow from that order, since ids are made when an item is placed and say
 * nothing about how the room looks.
 */
export function canonicalConfig(config: Config): Config {
  const items = [...config.items]
    .map((item) => ({ ...item, x: tidy(item.x), z: tidy(item.z) }))
    .sort(
      (a, b) =>
        (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0) ||
        a.x - b.x ||
        a.z - b.z ||
        a.rotation - b.rotation,
    )
    .map((item, i): PlacedItem => ({ ...item, id: `item-${i}` }))
  return { ...config, time: tidy(config.time), items }
}

/** JSON with every object's keys in sorted order, so key order never changes the text. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** The design's fingerprint: equal for designs that look the same, whatever their history. */
export function configKey(config: Config) {
  return fingerprint(stableStringify(canonicalConfig(config)))
}

/** Where a still is kept: renderer version, design, angle (gallery.ts angleKey), stage shape. */
export function stillKey(
  design: string,
  angle: string,
  aspect: AspectClass,
  renderVersion: string = RENDER_VERSION,
) {
  return `${renderVersion}/${design}/${angle}/${aspect}`
}
