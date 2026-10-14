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
import {
  constructionOpening,
  EQUIPMENT_ENVELOPES,
  equipmentFootprint,
  occupiedEnvelope,
  placementIssues,
  spatialPlacementIssue,
  usableInterior,
  workingEnvelope,
  type SpatialConfig,
} from './spatial'
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
export const CATALOG = (
  [
    {
      id: 'rack',
      name: 'Power rack',
      category: 'Strength',
    },
    {
      id: 'bench',
      name: 'Adjustable bench',
      category: 'Strength',
    },
    {
      id: 'weights',
      name: 'Dumbbell station',
      category: 'Strength',
    },
    {
      id: 'bike',
      name: 'Indoor cycle',
      category: 'Cardio',
    },
    {
      id: 'treadmill',
      name: 'Running deck',
      category: 'Cardio',
    },
    {
      id: 'sauna',
      name: 'Two-person sauna',
      category: 'Recovery',
    },
    {
      id: 'plunge',
      name: 'Cold plunge',
      category: 'Recovery',
    },
    {
      id: 'mat',
      name: 'Movement mat',
      category: 'Movement',
    },
    {
      id: 'reformer',
      name: 'Pilates reformer',
      category: 'Movement',
    },
    {
      id: 'lounge',
      name: 'Recovery lounger',
      category: 'Recovery',
    },
  ] as const
).map((item) => {
  const bounds = EQUIPMENT_ENVELOPES[item.id]
  const placed = { id: item.id, sku: item.id, rotation: 0 as const, x: 0, z: 0 }
  const working = workingEnvelope(placed)
  return {
    ...item,
    ...equipmentFootprint(placed),
    h: bounds.max.y - bounds.min.y,
    clearance: bounds.min.x - working.min.x,
    dimensionLabel: 'Modeled occupied bounds, not manufacturer specifications',
    clearanceLabel: 'Illustrative working-space margin, not a certified clearance',
  }
})
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

export function packageItems(
  kind: PackageId,
  length: 20 | 40,
  context: Pick<SpatialConfig, 'family'> = { family: 'studio' },
): PlacedItem[] {
  const item = (
    sku: PlacedItem['sku'],
    x: number,
    z: number,
    rotation: 0 | 90 = 0,
  ): PlacedItem => ({ id: `${kind}-${sku}-${x}`, sku, x, z, rotation })
  const presets: Record<PackageId, PlacedItem[]> = {
    strength:
      context.family === 'studio'
        ? [item('rack', -4.9, -1.7), item('bench', 3, -2.4, 90), item('weights', 5.8, 1.8)]
        : [item('bench', -5, -2.4, 90), item('weights', 5.8, 1.3)],
    recovery: [item('sauna', -6, -1.2), item('plunge', 5, -0.5)],
    movement: [item('mat', -6, -0.5), item('mat', 0, -2, 90), item('reformer', 5, -0.1)],
    cardio: [item('treadmill', -6, -0.7), item('bike', 0, -0.6), item('bike', 5, -0.6)],
    empty: [],
  }
  return presets[kind].map((i) => ({ ...i, x: (i.x * length) / 20 }))
}
export function packageDefinition(kind: PackageId, config: Config) {
  const items = packageItems(kind, config.length, config)
  const candidate = { ...config, package: kind, items }
  const issues = layoutIssues(candidate)
  return {
    items,
    issues,
    available: issues.length === 0,
    label:
      kind === 'strength' && config.family === 'container'
        ? 'Strength — bench + dumbbells'
        : PACKAGES.find((p) => p.id === kind)!.name,
    notice:
      kind === 'strength' && config.family === 'container'
        ? 'Container Strength includes a bench and dumbbells. The modeled rack exceeds the Container ceiling; existing rack designs are never replaced automatically.'
        : undefined,
  }
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
export const entryCenter = (config: Config) => constructionOpening(config).center
export function openingGeometry(config: Config) {
  return constructionOpening(config)
}
export function changeFamily(
  config: Config,
  family: ProductFamily,
): { config: Config; accepted: boolean; notice?: string; issues: string[] } {
  if (config.family === family) return { config, accepted: true, issues: [] }
  const candidate = { ...config, family }
  const inspected = inspectDocument(candidate)
  const issues = inspected.issues
  return issues.length
    ? { config, accepted: false, notice: issues.join(' '), issues }
    : { config: candidate, accepted: true, issues }
}
export function setFamily(config: Config, family: ProductFamily): Config {
  return changeFamily(config, family).config
}
export function footprint(item: PlacedItem) {
  return equipmentFootprint(item)
}
export function placementIssue(item: PlacedItem, config: Config): string | null {
  return spatialPlacementIssue(item, config)
}
export function layoutDiagnostics(config: Config) {
  return config.items.flatMap((item) => placementIssues(item, config))
}
export function layoutIssues(config: Config) {
  return [
    ...(config.addons.stairs && !config.addons.roof
      ? ['Select a rooftop deck before adding its exterior staircase.']
      : []),
    ...new Set(
      layoutDiagnostics(config).map(
        (issue) =>
          `${catalogItem(config.items.find((item) => item.id === issue.itemId)!.sku).name}: ${issue.message}`,
      ),
    ),
  ]
}
export function addEquipment(config: Config, sku: PlacedItem['sku']): Config | null {
  if (config.items.length >= 16 || inspectDocument(config).status !== 'accepted') return null
  const room = usableInterior(config)
  const id = crypto.randomUUID()
  for (const rotation of [0, 90] as const) {
    const local = occupiedEnvelope({ id, sku, x: 0, z: 0, rotation })
    for (
      let z = Math.ceil((room.min.z - local.min.z) * 4) / 4;
      z <= room.max.z - local.max.z;
      z += 0.25
    ) {
      for (
        let x = Math.ceil((room.min.x - local.min.x) * 4) / 4;
        x <= room.max.x - local.max.x;
        x += 0.25
      ) {
        const candidate = { id, sku, x, z, rotation }
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
  const candidate = { ...config, addons: { ...config.addons, [id]: !config.addons[id] } }
  if (candidate.addons.stairs && !candidate.addons.roof)
    return {
      config,
      notice:
        'Select a rooftop deck before adding stairs; remove stairs before removing their rooftop deck.',
    }
  return { config: candidate }
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
