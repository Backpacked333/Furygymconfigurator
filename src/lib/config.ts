import { z } from 'zod'
import LZString from 'lz-string'
import { boundedDecompress, DOCUMENT_LIMITS } from './documentCodec'
import {
  browserStorage,
  initializeRecovery,
  type DocumentInspection,
  type StorageAccess,
  type Outcome,
} from './recovery'
import { readSavedCompat, writeSavedCompat } from './legacyLibrary'
export { readSavedState } from './legacyLibrary'
import {
  CONTAINER_OPENINGS,
  PRODUCT_SOURCE_DATE,
  STUDIO_LAYOUTS,
  OPENING_CONCEPTS,
  productFamily,
  type ProductFamily,
} from './products'

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
    detail: 'Outdoor platform concept. Dimensions and engineering by inquiry.',
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

const itemSchema = z.object({
  id: z.string().min(1).max(64),
  sku: z.enum(CATALOG.map((x) => x.id)),
  x: z.number().finite().min(-20).max(20),
  z: z.number().finite().min(-4).max(4),
  rotation: z.union([z.literal(0), z.literal(90)]),
})
const currentConfigSchema = z
  .object({
    v: z.literal(3),
    family: z.enum(['studio', 'container']),
    containerOpening: z.enum(CONTAINER_OPENINGS.map((o) => o.id)),
    openingConcept: z.enum(OPENING_CONCEPTS.map((o) => o.id)),
    presentation: z.object({
      openingPose: z.enum(['open', 'closed']),
      context: z.enum(['product', 'custom-wellness', 'sunken-lounge']),
    }),
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
    package: z.enum([...PACKAGES.map((x) => x.id), 'custom']),
    items: z.array(itemSchema).max(16),
    environment: z.enum(['courtyard', 'desert', 'studio']),
    time: z.number().finite().min(6).max(21),
    lights: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if (c.family === 'container' && (c.addons.gazebo || c.accent || c.studioLayout !== 'single'))
      ctx.addIssue({
        code: 'custom',
        message:
          'Disable the Studio gazebo/timber accent and select Single unit before switching to Container.',
      })
    if (
      c.family === 'studio' &&
      (c.containerOpening !== 'roll-up' || c.integratedFinish || c.openingConcept !== 'standard')
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Select the standard roll-up reference and disable the integrated Container finish before switching to Studio.',
      })
    if (new Set(c.items.map((i) => i.id)).size !== c.items.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate equipment identifiers.' })
  })
export const configSchema = z.preprocess((input) => {
  if (input && typeof input === 'object' && 'v' in input && (input.v === 1 || input.v === 2)) {
    return {
      ...input,
      ...(input.v === 1
        ? {
            family: 'studio',
            containerOpening: 'roll-up',
            integratedFinish: false,
            studioLayout: 'single',
          }
        : {}),
      v: 3,
      openingConcept: 'standard',
      presentation: { openingPose: 'open', context: 'product' },
    }
  }
  return input
}, currentConfigSchema)
export type Config = z.infer<typeof currentConfigSchema>
export type PlacedItem = z.infer<typeof itemSchema>
export type AddonId = (typeof ADDONS)[number]['id']
export type PackageId = (typeof PACKAGES)[number]['id']
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
export const DEFAULT_CONFIG: Config = {
  v: 3,
  family: 'studio',
  containerOpening: 'roll-up',
  openingConcept: 'standard',
  presentation: { openingPose: 'open', context: 'product' },
  integratedFinish: false,
  studioLayout: 'single',
  length: 20,
  finish: 'obsidian',
  accent: false,
  addons: { deck: false, gazebo: false, roof: false, stairs: false },
  flooring: 'rubber',
  mirror: false,
  package: 'strength',
  items: packageItems('strength', 20),
  environment: 'courtyard',
  time: 16.5,
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
export function changeFamily(
  config: Config,
  family: ProductFamily,
): { config: Config; accepted: boolean; notice?: string; issues: string[] } {
  if (config.family === family) return { config, accepted: true, issues: [] }
  const candidate = { ...config, family }
  const parsed = configSchema.safeParse(candidate)
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
  return issues.length
    ? { config, accepted: false, notice: issues.join(' '), issues }
    : { config: parsed.data!, accepted: true, issues }
}
export function setFamily(config: Config, family: ProductFamily): Config {
  return changeFamily(config, family).config
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
  for (const other of config.items) {
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
    ...new Set(config.items.map((i) => placementIssue(i, config)).filter((v): v is string => !!v)),
  ]
}
export function addEquipment(config: Config, sku: PlacedItem['sku']): Config | null {
  if (config.items.length >= 16) return null
  for (const rotation of [0, 90] as const) {
    for (let z = -2; z <= 2; z += 0.5) {
      for (let x = -config.length / 2 + 2; x < config.length / 2 - 1; x += 0.5) {
        const candidate = { id: crypto.randomUUID(), sku, x, z, rotation }
        if (!placementIssue(candidate, config))
          return { ...config, package: 'custom', items: [...config.items, candidate] }
      }
    }
  }
  return null
}
export function setAddon(config: Config, id: AddonId): { config: Config; notice?: string } {
  if (config.family === 'container' && id === 'gazebo')
    return { config, notice: 'Gazebo is Studio-only. Switch to Studio to request this addition.' }
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
    ...(config.openingConcept !== 'standard'
      ? [
          `Reference opening concept: ${OPENING_CONCEPTS.find((o) => o.id === config.openingConcept)!.name}`,
        ]
      : []),
    ...(config.studioLayout !== 'single'
      ? [`Custom inquiry: ${STUDIO_LAYOUTS.find((o) => o.id === config.studioLayout)!.name}`]
      : []),
    ...ADDONS.filter((a) => config.addons[a.id]).map((a) => a.name),
    `Concept finish: ${FINISHES.find((f) => f.id === config.finish)!.name}`,
    `Concept floor: ${FLOORS.find((f) => f.id === config.flooring)!.name}`,
    ...(config.accent ? ['Concept timber accent'] : []),
    ...(config.mirror ? ['Concept mirror wall'] : []),
    ...config.items.map((i) => `Planning item: ${catalogItem(i.sku).name}`),
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
export function decodeConfig(value: string): Config | null {
  const inspection = inspectConfig(value)
  return inspection.status === 'accepted' ? inspection.config : null
}
export function inspectConfig(value: string): DocumentInspection<Config> {
  if (value.length > DOCUMENT_LIMITS.encodedChars)
    return {
      status: 'rejected',
      reason: 'too-large',
      issues: ['Encoded document exceeds the supported size.'],
    }
  try {
    const decoded = boundedDecompress(value)
    if (!decoded)
      return {
        status: 'rejected',
        reason: 'malformed',
        issues: ['Document cannot be decoded within the supported limits.'],
      }
    return inspectDocument(JSON.parse(decoded))
  } catch {
    return { status: 'rejected', reason: 'malformed', issues: ['Document is not valid JSON.'] }
  }
}
export function inspectDocument(value: unknown): DocumentInspection<Config> {
  if (value && typeof value === 'object' && 'v' in value && ![1, 2, 3].includes(value.v as number))
    return {
      status: 'rejected',
      reason: 'unsupported',
      issues: ['Unsupported document version; original input retained.'],
    }
  const parsed = configSchema.safeParse(value)
  if (!parsed.success)
    return {
      status: 'rejected',
      reason: 'schema',
      issues: parsed.error.issues.map((issue) => issue.message),
    }
  const issues = layoutIssues(parsed.data)
  const migratedFrom =
    value && typeof value === 'object' && 'v' in value && value.v !== 3
      ? (value.v as number)
      : undefined
  return {
    config: parsed.data,
    status: issues.length ? 'repair' : 'accepted',
    issues,
    normalized: JSON.stringify(value) !== JSON.stringify(parsed.data),
    ...(migratedFrom !== undefined ? { migratedFrom } : {}),
  }
}
export function shareUrl(config: Config) {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = `c=${encodeConfig(config)}`
  return url.toString()
}
export type SavedBuild = { id: string; name: string; date: string; config: Config }
export function readSaved(): SavedBuild[] {
  return readSavedCompat()
}
export function writeSaved(builds: SavedBuild[]) {
  writeSavedCompat(builds)
}
export function initialConfig(
  options: { storage?: StorageAccess; hash?: string; draft?: Outcome<string | null> } = {},
) {
  return initializeRecovery({
    fallback: structuredClone(DEFAULT_CONFIG),
    inspect: inspectConfig,
    hash: options.hash ?? (typeof window === 'undefined' ? '' : window.location.hash),
    storage: options.storage ?? browserStorage(),
    draft: options.draft,
  })
}
