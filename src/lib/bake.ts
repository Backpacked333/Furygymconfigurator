import type { AspectClass } from '../render/gallery'
import { loopbackCloud } from '../render/traceStatus'
import {
  DEFAULT_CAMERA,
  DEFAULT_CONFIG,
  FINISHES,
  SIGNATURES,
  encodeConfig,
  type Config,
} from './config'
import { configKey } from './stillKey'
import type { BakedGains } from './stillsManifest'

/**
 * Bake mode: the page scripts/bake-stills.mjs drives in headless Chromium to render a design's
 * stills ahead of time. `?bake=1#c=<design>` builds the scene as any visit does, meters its
 * exposure, and asks the render server for every gallery angle at both stage shapes at the
 * export tier (RenderEffects with StillSession.bake), then hands the finished images to the
 * script on `window.__bake`. `?bake=list` only lists the designs there are to bake. Free of
 * three.js imports.
 *
 * Only an automated browser (navigator.webdriver) bakes, and only on a render server on its own
 * machine (a loopback `?cloud=`: the script's proxy to the server it was given): an ordinary visit
 * to `?bake=1` never sets a cloud GPU to work.
 */

type Vec3 = [number, number, number]

export type BakeMode = {
  /** `?bake=list`: the designs to bake are listed on `window.__bakeDesigns`, and nothing renders. */
  list: boolean
  /** `&quick=1`: small stills at a few samples, for CI and end-to-end checks. */
  quick: boolean
  /** `&hero=x,y,z`: the direction of the front three-quarter view (a signature's photograph). */
  hero: Vec3 | null
  /** `&aspects=wide,tall`: the stage shapes to bake, both by default. */
  aspects: AspectClass[]
}

/** Why `?bake` is not honoured here, or null when it is (or not asked for). */
export function bakeRefusal(search: string, automated: boolean): string | null {
  const params = new URLSearchParams(search)
  const value = params.get('bake')
  if (value === null || value === '0') return null
  if (!automated) return 'Bake mode runs only in a browser driven by scripts/bake-stills.mjs.'
  if (value !== 'list' && !loopbackCloud(params.get('cloud')))
    return 'Bake mode renders only on a render server on this machine: ?cloud=http://127.0.0.1:<port>.'
  return null
}

export function bakeMode(
  search = window.location.search,
  automated = typeof navigator !== 'undefined' && navigator.webdriver === true,
): BakeMode | null {
  const params = new URLSearchParams(search)
  const value = params.get('bake')
  if (value === null || value === '0' || bakeRefusal(search, automated)) return null
  const hero = params.get('hero')?.split(',').map(Number)
  const aspects = (params.get('aspects') ?? '')
    .split(',')
    .filter((aspect): aspect is AspectClass => aspect === 'wide' || aspect === 'tall')
  return {
    list: value === 'list',
    quick: params.get('quick') === '1',
    hero: hero?.length === 3 && hero.every(Number.isFinite) ? (hero as Vec3) : null,
    aspects: aspects.length ? [...new Set(aspects)] : ['wide', 'tall'],
  }
}

/** This page's bake mode, read once: null on any ordinary visit. */
export const BAKE = typeof window === 'undefined' ? null : bakeMode()

/**
 * The direction of a design's front three-quarter view: a signature build's photograph angle for
 * the build in any finish (as it is baked, `bakeDesigns`), the default otherwise. A share link or
 * a draft of a signature build is framed as the build applied in the panel is, so it finds its
 * baked stills.
 */
export function heroOf(config: Config): [number, number, number] {
  const signature = SIGNATURES.find(
    (s) => configKey({ ...config, finish: s.config.finish }) === configKey(s.config),
  )
  return signature?.camera ?? DEFAULT_CAMERA
}

/** A design to bake: the default design or a signature build, in its own finish or another. */
export type BakeDesign = {
  id: string
  name: string
  group: 'default' | 'signature'
  finish: Config['finish']
  /** Another finish than the build's own (`--finishes`). */
  variant: boolean
  /** The design as a share link carries it (config.ts encodeConfig). */
  encoded: string
  /** The front three-quarter view's direction, when it is not the default (DEFAULT_CAMERA). */
  hero: Vec3 | null
}

/**
 * Every design there is to bake: the default design and the signature builds, each in its own
 * finish and then every other. Signature builds are framed from their photograph's angle, as the
 * panel shows them when applied.
 */
export function bakeDesigns(): BakeDesign[] {
  const bases: Omit<BakeDesign, 'finish' | 'variant' | 'encoded'>[] = [
    { id: 'default', name: 'Default design', group: 'default', hero: null },
    ...SIGNATURES.map((s) => ({
      id: s.id,
      name: s.name,
      group: 'signature' as const,
      hero: s.camera,
    })),
  ]
  const configs: Record<string, Config> = {
    default: DEFAULT_CONFIG,
    ...Object.fromEntries(SIGNATURES.map((s) => [s.id, s.config])),
  }
  return bases.flatMap((base) => {
    const config = configs[base.id]
    const own = FINISHES.find((f) => f.id === config.finish)!
    return [own, ...FINISHES.filter((f) => f !== own)].map((finish): BakeDesign => ({
      ...base,
      id: finish === own ? base.id : `${base.id}+${finish.id}`,
      name: finish === own ? base.name : `${base.name}, ${finish.name}`,
      finish: finish.id,
      variant: finish !== own,
      encoded: encodeConfig({ ...config, finish: finish.id }),
    }))
  })
}

/** A still the bake rendered, as `window.__bake` hands it to the script. */
export type BakeResult = {
  /** Its key (stillKey.ts): renderer version, design, angle key, stage shape. */
  key: string
  angle: string
  angleKey: string
  aspect: AspectClass
  width: number
  height: number
  samples: number
  renderMs: number
  cached: boolean
  /** The finished WebP the server sent. */
  image: Blob
}

/** Where a bake stands, on `window.__bake`, polled by the script. */
export type BakeReport = {
  state: 'loading' | 'rendering' | 'done' | 'failed'
  /** The renderer version (stillKey.ts RENDER_VERSION) and the design (its config key). */
  version: string
  design: string
  /** The lighting look (pathtrace.ts lookKey) and the gains the stills were rendered with. */
  lighting: string
  gains: BakedGains | null
  total: number
  results: BakeResult[]
  error: string
}

declare global {
  interface Window {
    __bake?: BakeReport
    __bakeDesigns?: BakeDesign[]
    /** Gains of looks already baked, set by the script: one gain for a look across designs. */
    __bakeLooks?: Record<string, BakedGains>
  }
}

/** Updates the bake's report on `window.__bake`. */
export function reportBake(patch: Partial<BakeReport>) {
  window.__bake = {
    state: 'loading',
    version: '',
    design: '',
    lighting: '',
    gains: null,
    total: 0,
    results: [],
    error: '',
    ...window.__bake,
    ...patch,
  }
}
