import head from 'virtual:fury-stills'
import type { AspectClass } from '../render/gallery'
import { RENDER_VERSION } from './stillKey'
import {
  EXPORT_SAMPLES,
  STILL_SIZES,
  sourcesOf,
  srcsetOf,
  withRest,
  type BakedGains,
  type StillsManifest,
} from './stillsManifest'

/**
 * Stills baked ahead of time (scripts/bake-stills.mjs), found from the design alone: its config
 * key, the angle (gallery.ts angleKey), the stage's shape and the renderer version, with no scene
 * to look at. The stage asks before the 3D chunk has loaded, so the first picture of a baked
 * design is its finished still. A manifest baked by another version of the renderer is ignored
 * whole. Free of three.js imports.
 *
 * The entry chunk carries the default design's hero stills and the looks' gains alone (the
 * build's `virtual:fury-stills`, vite.config.ts); the rest of the manifest loads at once beside
 * it, as a chunk of its own, so the entry stays the same size however much is baked. Until it
 * has, a share link to another baked design finds nothing: its still is offered when it lands
 * (`onBakedChange`).
 */

export type BakedStill = {
  /** The widest image: the still's identity on the stage, and what a download takes. */
  url: string
  /** Every width, for the browser to choose from at the stage's size. */
  srcset: string
  sizes: string
  /** The narrowest: the filmstrip's thumbnail. */
  thumb: string
  width: number
  height: number
  samples: number
  /**
   * 'export' for a still baked at the export tier: nothing rendered replaces it. A quick bake (a
   * few samples, for CI and end-to-end checks) counts as a thumbnail: shown until a rendered
   * still replaces it, and never taken for a download.
   */
  tier: 'export' | 'thumb'
}

let manifest: StillsManifest = head
/** Stills whose image failed to load (by `url`): rendered as if they had never been baked. */
const broken = new Set<string>()
const listeners = new Set<() => void>()
let revision = 0

function changed() {
  revision++
  listeners.forEach((listener) => listener())
}

// The rest of the manifest, beside the entry: only when there is more than the hero.
if (head.more)
  void import('virtual:fury-stills/all').then(
    ({ default: all }) => {
      manifest = withRest(manifest, all)
      changed()
    },
    (error: unknown) => console.warn('The baked stills could not be loaded.', error),
  )

/** The manifest as far as it has loaded. */
export const bakedManifest = () => manifest

/** The baked still of a design at an angle and stage shape, or null when there is none. */
export function bakedStill(
  design: string,
  angle: string,
  aspect: AspectClass,
  from: StillsManifest = manifest,
  version: string = RENDER_VERSION,
): BakedStill | null {
  if (!design || from.version !== version) return null
  const found = sourcesOf(from, design, angle, aspect)
  if (!found?.sources.length) return null
  const { entry, sources } = found
  const url = sources[sources.length - 1].url
  if (broken.has(url)) return null
  const [, width, height, samples] = entry
  return {
    url,
    srcset: srcsetOf(sources),
    sizes: STILL_SIZES[aspect],
    thumb: sources[0].url,
    width,
    height,
    samples,
    tier: samples >= EXPORT_SAMPLES ? 'export' : 'thumb',
  }
}

/** The exposure gains a lighting look (pathtrace.ts lookKey) was baked with, or null. */
export function bakedGains(
  lighting: string,
  from: StillsManifest = manifest,
  version: string = RENDER_VERSION,
): BakedGains | null {
  if (from.version !== version) return null
  return from.looks?.[lighting] ?? null
}

/**
 * A baked still whose image could not be loaded (gone from the store, a network failure): from
 * now on it is rendered like any other.
 */
export function forgetBaked(url: string) {
  if (broken.has(url)) return
  broken.add(url)
  changed()
}

/** Counts the changes to what is baked (the rest loaded, a still forgotten): a plan made before is stale. */
export const bakedRevision = () => revision

export function onBakedChange(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
