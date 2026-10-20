/**
 * The baked stills' manifest (src/stills.manifest.json, written by scripts/bake-stills.mjs), and
 * how a stage picture asks for one: shared by the app, the bake script's page, and the build
 * (vite.config.ts), which preloads the hero still and splits the manifest so the entry chunk
 * carries only the hero's part. Free of imports.
 *
 * A still's files are named from its key and the hash of its master, so the manifest keeps four
 * numbers a still, whatever the number of its widths: a few dozen bytes each.
 */

/** A baked still: its master's hash (which names its files), its size, and its samples. */
export type BakedEntry = [hash: string, width: number, height: number, samples: number]

/** Exposure gains for a lighting look (stills.ts), outside and in the room. */
export type BakedGains = { exterior: number; interior: number }

export type StillsManifest = {
  /** The renderer version the stills were baked by (scripts/render-version.ts). */
  version: string
  /** Where the files are served: `<base>/<design>/<file>` (`/stills/<version>`, or Blob's). */
  base?: string
  /** The narrower widths written below each master, for `srcset`. */
  widths?: number[]
  /** The default design, by config key and share-link encoding: its hero still is preloaded. */
  hero?: { design: string; encoded: string }
  /**
   * The gains each lighting look was baked with: a visitor's session renders under the same, so
   * a still rendered for an edit matches the baked one it replaces.
   */
  looks?: Record<string, BakedGains>
  /** Baked stills by design (stillKey.ts configKey), then by angle key and stage shape. */
  stills: Record<string, Record<string, BakedEntry>>
}

/** The part of the manifest in the entry chunk: the hero design's stills, the rest to follow. */
export type ManifestHead = StillsManifest & { more: boolean }

export const EMPTY_MANIFEST: StillsManifest = { version: '', stills: {} }

/** The hero still's angle key: the default design's front three-quarter view. */
export const HERO_ANGLE = 'front-left'

/**
 * The export tier's samples (stills.ts QUALITY.export). A still baked with fewer (a quick bake,
 * for CI and end-to-end checks) is shown, but never counts as finished: anything rendered may
 * replace it, and a download renders the export.
 */
export const EXPORT_SAMPLES = 1024

/** The phone layout's stage (4:5), and the rest (16:10); styles.css switches at the same width. */
export const TALL_MEDIA = '(max-width: 820px)'

/**
 * How wide a stage's still is drawn, for the browser to choose a width before layout: the window
 * less the configuration panel on wider screens; on phones the stage is limited by its height
 * (about 0.8 of a third of the screen's, to a little more with the panel closed). A still a
 * little wider than the stage is no harm; the preload says the same, so it is reused.
 */
export const STILL_SIZES = {
  wide: 'calc(100vw - 420px)',
  tall: 'min(100vw - 24px, 36vh)',
} as const

/** A still's place in its design's entry: its angle key and stage shape. */
export const slotOf = (angleKey: string, aspect: 'wide' | 'tall') => `${angleKey}|${aspect}`

/** A still's file at a width: its angle key (made safe for a path), shape, width and hash. */
export const fileOf = (angleKey: string, aspect: string, width: number, hash: string) =>
  `${angleKey.replace(/[^a-z0-9-]+/gi, '_')}-${aspect}-${width}.${hash}.webp`

/** One width of a baked still, and where it is served. */
export type BakedSource = { w: number; url: string }

/** A still's widths, narrowest first (the master last), where they are served. */
export function sourcesOf(
  manifest: StillsManifest,
  design: string,
  angleKey: string,
  aspect: 'wide' | 'tall',
): { entry: BakedEntry; sources: BakedSource[] } | null {
  const entry = manifest.stills[design]?.[slotOf(angleKey, aspect)]
  if (!entry) return null
  const [hash, width] = entry
  const base = manifest.base ?? `/stills/${manifest.version}`
  const widths = [...(manifest.widths ?? []).filter((w) => w < width), width].sort((a, b) => a - b)
  return {
    entry,
    sources: widths.map((w) => ({
      w,
      url: `${base}/${design}/${fileOf(angleKey, aspect, w, hash)}`,
    })),
  }
}

/** Widths as an `srcset`: the same text for the stage's <img> and the preload. */
export const srcsetOf = (sources: BakedSource[]) =>
  sources.map(({ w, url }) => `${url} ${w}w`).join(', ')

/** How many stills a manifest lists. */
export const stillCount = (manifest: StillsManifest) =>
  Object.values(manifest.stills).reduce((sum, stills) => sum + Object.keys(stills).length, 0)

/**
 * A manifest's entry part (manifestHead) with the rest of its stills, merged design by design:
 * the hero design's other angles are in the rest alone, beside its hero stills in the entry.
 */
export function withRest(
  head: StillsManifest,
  rest: Pick<StillsManifest, 'stills'>,
): StillsManifest {
  const stills = { ...rest.stills }
  for (const [design, entries] of Object.entries(head.stills))
    stills[design] = { ...stills[design], ...entries }
  return { ...head, stills }
}

/**
 * The entry chunk's part of a manifest of this renderer version: the hero design's hero stills,
 * and whether there are more to load. A manifest of another version is nothing.
 */
export function manifestHead(manifest: StillsManifest, version: string): ManifestHead {
  if (!version || manifest.version !== version) return { ...EMPTY_MANIFEST, more: false }
  const { stills, ...rest } = manifest
  const hero = manifest.hero?.design
  const heroStills: Record<string, BakedEntry> = {}
  for (const aspect of ['wide', 'tall'] as const) {
    const slot = slotOf(HERO_ANGLE, aspect)
    const entry = hero ? stills[hero]?.[slot] : undefined
    if (entry) heroStills[slot] = entry
  }
  const head = hero && Object.keys(heroStills).length ? { [hero]: heroStills } : {}
  return {
    ...rest,
    // The hero's share link is the preload script's business (heroPreloadScript), not the app's.
    ...(rest.hero ? { hero: { design: rest.hero.design, encoded: '' } } : {}),
    stills: head,
    more: stillCount(manifest) > stillCount({ ...rest, stills: head }),
  }
}

/**
 * The script index.html carries to preload the hero still (vite.config.ts): the default design's
 * front three-quarter view at the stage's shape, at the highest priority, ahead of any script; but
 * only for a visit that will show it, with no share link and no draft of another design. Null
 * when the manifest is of another renderer version, or has no hero.
 */
export function heroPreloadScript(manifest: StillsManifest, version: string): string | null {
  const head = manifestHead(manifest, version)
  const hero = head.hero && manifest.hero
  if (!hero) return null
  const srcset = (aspect: 'wide' | 'tall') => {
    const found = sourcesOf(head, hero.design, HERO_ANGLE, aspect)
    return found ? srcsetOf(found.sources) : ''
  }
  const wide = srcset('wide')
  const tall = srcset('tall')
  if (!wide && !tall) return null
  const json = JSON.stringify
  // The design a visit opens: the share link's, else the draft's, else the default (useConfig).
  return [
    '(function () {',
    '  var shown = null',
    '  try {',
    '    var link = /(?:^#|&)c=([^&]*)/.exec(location.hash)',
    '    shown = link && link[1]',
    "    if (!shown) shown = localStorage.getItem('fury-draft-v1')",
    '  } catch (e) {}',
    `  if (shown && shown !== ${json(hero.encoded)}) return`,
    `  var tall = matchMedia(${json(TALL_MEDIA)}).matches`,
    `  var srcset = tall ? ${json(tall)} : ${json(wide)}`,
    '  if (!srcset) return',
    "  var preload = document.createElement('link')",
    "  preload.rel = 'preload'",
    "  preload.as = 'image'",
    "  preload.setAttribute('fetchpriority', 'high')",
    "  preload.setAttribute('imagesrcset', srcset)",
    `  preload.setAttribute('imagesizes', tall ? ${json(STILL_SIZES.tall)} : ${json(STILL_SIZES.wide)})`,
    '  document.head.appendChild(preload)',
    '})()',
  ].join('\n')
}

/**
 * What is wrong with shipping a manifest under this renderer version, for the build to warn of:
 * stills of another version (which the app ignores whole), or quick bakes (shown, but never
 * finished).
 */
export function manifestProblems(manifest: StillsManifest, version: string): string[] {
  const count = stillCount(manifest)
  if (!count) return []
  if (manifest.version !== version)
    return [
      `src/stills.manifest.json lists ${count} stills baked by renderer ${manifest.version}, but the render sources are now renderer ${version}: they are ignored, and every first visit renders live. Run \`npm run bake\` again (scripts/bake-stills.mjs).`,
    ]
  const quick = Object.values(manifest.stills).reduce(
    (sum, stills) =>
      sum + Object.values(stills).filter(([, , , samples]) => samples < EXPORT_SAMPLES).length,
    0,
  )
  return quick
    ? [
        `src/stills.manifest.json lists ${quick} quick-baked stills (fewer than ${EXPORT_SAMPLES} samples): they are shown until a rendered still replaces them. Bake at the export tier (\`npm run bake\`) before deploying, or reset the manifest to { "version": "", "stills": {} }.`,
      ]
    : []
}
