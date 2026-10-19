import { z } from 'zod'
import LZString from 'lz-string'
import {
  CONTAINER_OPENINGS,
  PRODUCT_SOURCE_DATE,
  STUDIO_LAYOUTS,
  productFamily,
  type ProductFamily,
} from './products'
import { nightAt } from './visuals'

export const FINISHES = [
  { id: 'obsidian', name: 'Obsidian', color: '#262927' },
  { id: 'chalk', name: 'Chalk', color: '#e3e0d5' },
  { id: 'olive', name: 'Olive', color: '#66705a' },
  { id: 'bronze', name: 'Bronze', color: '#807061' },
] as const
export const FLOORS = [
  { id: 'rubber', name: 'Rubber look', color: '#353936' },
  { id: 'oak', name: 'Oak look', color: '#b08c61' },
  { id: 'stone', name: 'Stone look', color: '#acb1a5' },
] as const
export const ADDONS = [
  {
    id: 'deck',
    name: 'Front deck',
    detail: 'Outdoor space for your Studio. Dimensions by inquiry.',
  },
  {
    id: 'gazebo',
    name: 'Gazebo',
    detail: 'Covered outdoor space. Concept geometry shown.',
  },
  { id: 'roof', name: 'Rooftop deck', detail: 'Elevated outdoor space. Engineering by inquiry.' },
  {
    id: 'stairs',
    name: 'Exterior staircase',
    detail: 'Access to your rooftop retreat.',
  },
] as const
export const CATALOG = [
  {
    id: 'rack',
    name: 'Power rack',
    category: 'Strength',
    w: 4.8,
    d: 3.2,
    h: 7.5,
    clearance: 1.5,
  },
  {
    id: 'bench',
    name: 'Adjustable bench',
    category: 'Strength',
    w: 1.9,
    d: 4.3,
    h: 1.8,
    clearance: 1,
  },
  {
    id: 'weights',
    name: 'Dumbbell station',
    category: 'Strength',
    w: 4.2,
    d: 1.8,
    h: 3,
    clearance: 1.5,
  },
  {
    id: 'bike',
    name: 'Indoor cycle',
    category: 'Cardio',
    w: 2,
    d: 4,
    h: 4.2,
    clearance: 1,
  },
  {
    id: 'treadmill',
    name: 'Running deck',
    category: 'Cardio',
    w: 2.7,
    d: 5.8,
    h: 4.5,
    clearance: 2,
  },
  {
    id: 'sauna',
    name: 'Two-person sauna',
    category: 'Recovery',
    w: 4.8,
    d: 4.4,
    h: 7,
    clearance: 1,
  },
  {
    id: 'plunge',
    name: 'Cold plunge',
    category: 'Recovery',
    w: 2.9,
    d: 5.2,
    h: 2.8,
    clearance: 1,
  },
  {
    id: 'mat',
    name: 'Movement mat',
    category: 'Movement',
    w: 2.2,
    d: 5.4,
    h: 0.08,
    clearance: 0.5,
  },
  {
    id: 'reformer',
    name: 'Pilates reformer',
    category: 'Movement',
    w: 2.4,
    d: 6.5,
    h: 1.4,
    clearance: 0.5,
  },
  {
    id: 'lounge',
    name: 'Recovery lounger',
    category: 'Recovery',
    w: 2.6,
    d: 5,
    h: 2.4,
    clearance: 0.5,
  },
] as const
export const PACKAGES = [
  { id: 'strength', name: 'Strength', subtitle: 'Your daily pursuit.', icon: 'strength' },
  { id: 'recovery', name: 'Recovery', subtitle: 'Come back to yourself.', icon: 'recovery' },
  { id: 'movement', name: 'Movement', subtitle: 'Find your own flow.', icon: 'movement' },
  { id: 'cardio', name: 'Cardio', subtitle: 'Go a little further.', icon: 'cardio' },
  { id: 'empty', name: 'Empty space', subtitle: 'Room for your vision.', icon: 'empty' },
] as const

/** A piece of planning equipment placed by a package, in feet from the floor's center. */
export type PlacedItem = {
  id: string
  sku: (typeof CATALOG)[number]['id']
  x: number
  z: number
  rotation: 0 | 90
}
export const ENVIRONMENTS = [
  { id: 'courtyard', name: 'The courtyard', short: 'Courtyard' },
  { id: 'backyard', name: 'Suburban backyard', short: 'Backyard' },
  { id: 'rooftop', name: 'Urban rooftop', short: 'Rooftop' },
  { id: 'studio', name: 'Studio backdrop', short: 'Studio' },
] as const
export const LIGHTINGS = ['day', 'night'] as const
const currentConfigSchema = z
  .object({
    v: z.literal(3),
    family: z.enum(['studio', 'container']),
    containerOpening: z.enum(CONTAINER_OPENINGS.map((o) => o.id)),
    integratedFinish: z.boolean(),
    studioLayout: z.enum(STUDIO_LAYOUTS.map((o) => o.id)),
    length: z.union([z.literal(20), z.literal(40)]),
    finish: z.enum(FINISHES.map((x) => x.id)),
    accent: z.boolean(),
    addons: z.object({
      deck: z.boolean(),
      gazebo: z.boolean(),
      roof: z.boolean(),
      stairs: z.boolean(),
    }),
    flooring: z.enum(FLOORS.map((x) => x.id)),
    mirror: z.boolean(),
    // Equipment always comes from a planning package: every configuration has a finite set of
    // stills, and the floor plan only shows the package's layout.
    package: z.enum(PACKAGES.map((x) => x.id)),
    environment: z.enum(ENVIRONMENTS.map((x) => x.id)),
    lighting: z.enum(LIGHTINGS),
    /** Architectural lighting after dark. By day the lights are always on. */
    lights: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if (
      c.family === 'container' &&
      (Object.values(c.addons).some(Boolean) || c.accent || c.studioLayout !== 'single')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Studio additions are not available on the Container planning model.',
      })
    if (c.family === 'studio' && (c.containerOpening !== 'roll-up' || c.integratedFinish))
      ctx.addIssue({ code: 'custom', message: 'Opening options apply only to Containers.' })
  })
type Raw = Record<string, unknown>
const isRecord = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x)
/** Each step upgrades a stored configuration by one schema version. */
const MIGRATIONS: Record<number, (c: Raw) => Raw> = {
  1: (c) => ({
    ...c,
    v: 2,
    family: 'studio',
    containerOpening: 'roll-up',
    integratedFinish: false,
    studioLayout: 'single',
  }),
  2: ({ items, time, ...c }) => ({
    ...c,
    v: 3,
    package: migratedPackage(c.package, items),
    environment: c.environment === 'desert' ? 'rooftop' : c.environment,
    lighting: typeof time === 'number' && nightAt(time) > 0.5 ? 'night' : 'day',
  }),
}
/** The package whose equipment best matches a layout arranged by hand. */
function migratedPackage(pkg: unknown, items: unknown): unknown {
  if (pkg !== 'custom') return pkg
  const skus = Array.isArray(items) ? items.map((i) => (isRecord(i) ? i.sku : null)) : []
  let best: PackageId = 'strength',
    score = 0
  for (const p of PACKAGES) {
    const preset = packageItems(p.id, 20).map((i) => i.sku as unknown)
    const shared = preset.filter((sku) => skus.includes(sku)).length
    if (shared > score) {
      best = p.id
      score = shared
    }
  }
  return best
}
export function migrateConfig(input: unknown): unknown {
  let c = input
  while (isRecord(c) && typeof c.v === 'number' && MIGRATIONS[c.v]) c = MIGRATIONS[c.v](c)
  return c
}
/**
 * True when an older stored configuration had equipment arranged by hand, which is replaced by
 * the closest planning package on loading.
 */
export function hadCustomLayout(input: unknown): boolean {
  if (!isRecord(input) || typeof input.v !== 'number' || input.v >= 3) return false
  if (input.package === 'custom') return true
  if (!Array.isArray(input.items) || typeof input.package !== 'string') return false
  const preset = PACKAGES.some((p) => p.id === input.package)
    ? packageItems(input.package as PackageId, input.length === 40 ? 40 : 20)
    : []
  const key = (i: unknown) => (isRecord(i) ? `${i.sku}|${i.x}|${i.z}|${i.rotation}` : '')
  return JSON.stringify(input.items.map(key)) !== JSON.stringify(preset.map(key))
}
export const configSchema = z.preprocess(migrateConfig, currentConfigSchema)
export type Config = z.infer<typeof currentConfigSchema>
export type AddonId = (typeof ADDONS)[number]['id']
export type PackageId = (typeof PACKAGES)[number]['id']
export type Environment = Config['environment']
export type Lighting = Config['lighting']
export type View = 'exterior' | 'interior' | 'plan'
export type Unit = 'ft' | 'm'

export function packageItems(kind: PackageId, length: 20 | 40): PlacedItem[] {
  const item = (
    sku: PlacedItem['sku'],
    x: number,
    z: number,
    rotation: 0 | 90 = 0,
  ): PlacedItem => ({ id: `${kind}-${sku}-${x}`, sku, x, z, rotation })
  const offset = length === 40 ? -9 : 0
  const presets: Record<PackageId, PlacedItem[]> = {
    strength: [item('rack', -5, -0.8), item('bench', 0, -0.5), item('weights', 5.2, -1.9)],
    recovery: [item('sauna', -5.2, -0.9), item('plunge', 3.5, -1.2, 90)],
    movement: [item('mat', -4.5, -0.5), item('mat', 0, -0.5), item('reformer', 4.5, 0)],
    cardio: [item('treadmill', 4.5, 0), item('bike', 0, -0.6), item('bike', -4.5, -0.6)],
    empty: [],
  }
  return presets[kind].map((i) => ({ ...i, x: i.x + offset }))
}
const itemCache = new Map<string, PlacedItem[]>()
/** The equipment of a configuration: its package's layout, the same array for the same inputs. */
export function configItems(config: Pick<Config, 'package' | 'length'>): PlacedItem[] {
  const key = `${config.package}|${config.length}`
  let items = itemCache.get(key)
  if (!items) itemCache.set(key, (items = packageItems(config.package, config.length)))
  return items
}
export const DEFAULT_CONFIG: Config = {
  v: 3,
  family: 'studio',
  containerOpening: 'roll-up',
  integratedFinish: false,
  studioLayout: 'single',
  length: 20,
  finish: 'obsidian',
  accent: false,
  addons: { deck: false, gazebo: false, roof: false, stairs: false },
  flooring: 'rubber',
  mirror: false,
  package: 'strength',
  environment: 'courtyard',
  lighting: 'day',
  lights: true,
}
export const money = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n)
export const distance = (n: number, unit: Unit) =>
  unit === 'ft' ? `${Number(n.toFixed(1))}′` : `${(n * 0.3048).toFixed(2)} m`
export const area = (n: number, unit: Unit) =>
  unit === 'ft' ? `${n} sq ft` : `${(n * 0.092903).toFixed(1)} m²`
export const catalogItem = (sku: PlacedItem['sku']) => CATALOG.find((i) => i.id === sku)!
export const productName = (config: Config) =>
  `${config.length}′ ${productFamily(config.family).name}`
export const productHeight = (config: Config) => productFamily(config.family).height
export const entryCenter = (config: Config) =>
  config.family === 'container' && config.containerOpening === 'partial' ? -config.length / 4 : 0
export function openingGeometry(config: Config) {
  const widths = {
    'roll-up': 10,
    center: config.length * 0.6,
    partial: config.length / 2 - 0.6,
    full: config.length - 1.2,
  }
  return { width: widths[config.containerOpening], center: entryCenter(config) }
}
export function setFamily(config: Config, family: ProductFamily): Config {
  if (config.family === family) return config
  return {
    ...config,
    family,
    containerOpening: 'roll-up',
    integratedFinish: false,
    studioLayout: 'single',
    ...(family === 'container'
      ? { accent: false, addons: { deck: false, gazebo: false, roof: false, stairs: false } }
      : {}),
  }
}
export function footprint(item: PlacedItem) {
  const p = catalogItem(item.sku)
  return { w: item.rotation === 90 ? p.d : p.w, d: item.rotation === 90 ? p.w : p.d }
}
export function placementIssue(item: PlacedItem, config: Config): string | null {
  const { w, d } = footprint(item)
  if (Math.abs(item.x) + w / 2 > config.length / 2 - 0.7 || Math.abs(item.z) + d / 2 > 3.35)
    return 'Keep equipment inside the usable floor area.'
  if (Math.abs(item.x - entryCenter(config)) < w / 2 + 1.6 && item.z + d / 2 > 2.3)
    return 'Keep the planned entry clear.'
  for (const other of configItems(config)) {
    if (other.id === item.id) continue
    const f = footprint(other)
    if (
      Math.abs(item.x - other.x) < (w + f.w) / 2 + 0.12 &&
      Math.abs(item.z - other.z) < (d + f.d) / 2 + 0.12
    )
      return `That position overlaps ${catalogItem(other.sku).name.toLowerCase()}.`
  }
  return null
}
export function layoutIssues(config: Config) {
  return [
    ...new Set(
      configItems(config)
        .map((i) => placementIssue(i, config))
        .filter((v): v is string => !!v),
    ),
  ]
}
export function setAddon(config: Config, id: AddonId): { config: Config; notice?: string } {
  if (config.family !== 'studio')
    return { config, notice: 'These additions are documented for Studios only.' }
  return { config: { ...config, addons: { ...config.addons, [id]: !config.addons[id] } } }
}
export const PRICE_VERSION = `fury-published-${PRODUCT_SOURCE_DATE}`
export function estimate(config: Config) {
  const product = productFamily(config.family)
  const names = [
    productName(config),
    ...(config.family === 'container'
      ? [CONTAINER_OPENINGS.find((o) => o.id === config.containerOpening)!.name]
      : []),
    ...(config.integratedFinish ? ['Integrated exterior finish'] : []),
    ...(config.studioLayout !== 'single'
      ? [`Custom inquiry: ${STUDIO_LAYOUTS.find((o) => o.id === config.studioLayout)!.name}`]
      : []),
    ...ADDONS.filter((a) => config.addons[a.id]).map((a) => a.name),
    `Concept finish: ${FINISHES.find((f) => f.id === config.finish)!.name}`,
    `Concept floor: ${FLOORS.find((f) => f.id === config.flooring)!.name}`,
    ...(config.accent ? ['Concept timber accent'] : []),
    ...(config.mirror ? ['Concept mirror wall'] : []),
    ...configItems(config).map((i) => `Planning item: ${catalogItem(i.sku).name}`),
  ]
  return {
    lines: names.map((name) => ({ name, amount: null })),
    total: null,
    startingPrice: product.startingPrice,
    source: product.source,
    version: PRICE_VERSION,
  }
}
export function encodeConfig(config: Config) {
  return LZString.compressToEncodedURIComponent(JSON.stringify(configSchema.parse(config)))
}
/** A stored configuration, and whether a hand-arranged layout was replaced by a package. */
export function decodeStored(value: string): { config: Config; layoutReplaced: boolean } | null {
  if (!value || value.length > 12000) return null
  try {
    const decoded = LZString.decompressFromEncodedURIComponent(value)
    if (!decoded || decoded.length > 16000) return null
    const raw: unknown = JSON.parse(decoded)
    const config = configSchema.parse(raw)
    return layoutIssues(config).length ? null : { config, layoutReplaced: hadCustomLayout(raw) }
  } catch {
    return null
  }
}
export function decodeConfig(value: string): Config | null {
  return decodeStored(value)?.config ?? null
}
export const LAYOUT_REPLACED_NOTICE =
  'Equipment now comes from planning packages, so your hand-arranged layout was replaced by the closest package.'
export function shareUrl(config: Config) {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = `c=${encodeConfig(config)}`
  return url.toString()
}
export type SavedBuild = { id: string; name: string; date: string; config: Config }
const savedBuildSchema = z.object({
  id: z.string().max(64),
  name: z.string().min(1).max(60),
  date: z.string(),
  config: configSchema,
})
const savedSchema = z.array(savedBuildSchema).max(12)
/**
 * Stored builds, read one by one: an entry this version cannot use (corrupted, or written by a
 * newer schema) is set aside instead of hiding every other build.
 */
function storedBuilds() {
  const raw: unknown = JSON.parse(localStorage.getItem('fury-builds-v1') || '[]')
  const builds: SavedBuild[] = []
  const unreadable: unknown[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    const parsed = savedBuildSchema.safeParse(entry)
    if (parsed.success && !layoutIssues(parsed.data.config).length) builds.push(parsed.data)
    else unreadable.push(entry)
  }
  return { builds: builds.slice(0, 12), unreadable }
}
export function readSaved(): SavedBuild[] {
  try {
    return storedBuilds().builds
  } catch {
    return []
  }
}
export function writeSaved(builds: SavedBuild[]) {
  const valid = savedSchema.parse(builds)
  // Entries set aside on reading are written back as they were, so a save never deletes them.
  let unreadable: unknown[] = []
  try {
    unreadable = storedBuilds().unreadable
  } catch {
    /* Storage that is not JSON at all cannot be kept. */
  }
  localStorage.setItem('fury-builds-v1', JSON.stringify([...valid, ...unreadable]))
}
export function initialConfig(): { config: Config; notice: string } {
  const encoded = new URLSearchParams(window.location.hash.slice(1)).get('c')
  if (encoded) {
    const stored = decodeStored(encoded)
    return {
      config: stored?.config ?? DEFAULT_CONFIG,
      notice: !stored
        ? 'This share link is invalid or unsupported. Your default design is ready.'
        : stored.layoutReplaced
          ? `Shared design loaded. ${LAYOUT_REPLACED_NOTICE}`
          : 'Shared design loaded. Make it your own.',
    }
  }
  try {
    const draft = localStorage.getItem('fury-draft-v1')
    const stored = draft ? decodeStored(draft) : null
    if (stored)
      return { config: stored.config, notice: stored.layoutReplaced ? LAYOUT_REPLACED_NOTICE : '' }
  } catch {
    /* Storage is optional in private browsing. */
  }
  return { config: DEFAULT_CONFIG, notice: '' }
}
