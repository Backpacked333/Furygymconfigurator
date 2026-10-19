import { z } from 'zod'
import LZString from 'lz-string'
import { archiveRawValue } from './recovery.js'
import {
  CONTAINER_OPENINGS,
  OPENING_INFILLS,
  PRODUCT_SOURCE_DATE,
  STUDIO_DOORS,
  STUDIO_LAYOUTS,
  productFamily,
  type ProductFamily,
} from './products.js'

export const FINISHES = [
  { id: 'obsidian', name: 'Obsidian', color: '#262927' },
  { id: 'graphite', name: 'Graphite', color: '#5f574d' },
  { id: 'espresso', name: 'Espresso', color: '#3b3128' },
  { id: 'bronze', name: 'Bronze', color: '#807061' },
  { id: 'olive', name: 'Olive', color: '#66705a' },
  { id: 'cloud', name: 'Cloud', color: '#cbcbc6' },
  { id: 'chalk', name: 'Chalk', color: '#e3e0d5' },
] as const
export const FLOORS = [
  { id: 'rubber', name: 'Rubber look', color: '#353936' },
  { id: 'oak', name: 'Oak look', color: '#b08c61' },
  { id: 'stone', name: 'Stone look', color: '#acb1a5' },
  { id: 'concrete', name: 'Polished concrete look', color: '#b9b8b2' },
] as const
export const INTERIORS = [
  {
    id: 'gallery',
    name: 'Gallery white',
    detail: 'White walls and ceiling with linear LED channels.',
  },
  {
    id: 'slatted',
    name: 'Oak slat ceiling',
    detail: 'White walls under oak slats with recessed downlights.',
  },
  {
    id: 'timber',
    name: 'Warm cedar',
    detail: 'Cedar-lined walls and ceiling with recessed downlights.',
  },
  {
    id: 'birch',
    name: 'Birch ply',
    detail: 'Plywood-lined walls and ceiling with linear LED channels.',
  },
] as const
export const RAILINGS = [
  { id: 'glass', name: 'Glass balustrade' },
  { id: 'cable', name: 'Steel cable rail' },
] as const
export const ENVIRONMENTS = [
  { id: 'residences', name: 'Residential courtyard' },
  { id: 'campus', name: 'Corporate campus' },
  { id: 'backyard', name: 'Private backyard' },
  { id: 'courtyard', name: 'Garden courtyard' },
  { id: 'desert', name: 'Desert retreat' },
  { id: 'studio', name: 'Studio backdrop' },
] as const
export const ADDONS = [
  {
    id: 'deck',
    name: 'Front deck',
    detail: 'Outdoor space for your Studio. Dimensions by inquiry.',
    containerDetail: 'A timber deck along the opening, as in Fury builds.',
    families: ['studio', 'container'],
  },
  {
    id: 'gazebo',
    name: 'Gazebo',
    detail: 'Covered outdoor space. Concept geometry shown.',
    containerDetail: '',
    families: ['studio'],
  },
  {
    id: 'roof',
    name: 'Rooftop deck',
    detail: 'Elevated outdoor space. Engineering by inquiry.',
    containerDetail: 'A railed deck on the container roof. Engineering by inquiry.',
    families: ['studio', 'container'],
  },
  {
    id: 'stairs',
    name: 'Exterior staircase',
    detail: 'Access to your rooftop retreat.',
    containerDetail: 'A steel stair to the rooftop deck.',
    families: ['studio', 'container'],
  },
  {
    id: 'canopy',
    name: 'Entry canopy',
    detail: '',
    containerDetail: 'A cantilevered shade over the opening with integrated downlights.',
    families: ['container'],
  },
] as const satisfies readonly {
  id: string
  name: string
  detail: string
  containerDetail: string
  families: readonly ProductFamily[]
}[]
export const CATALOG = [
  {
    id: 'rack',
    name: 'Power rack',
    category: 'Strength',
    w: 4.8,
    occupiedW: 7.3,
    d: 3.2,
    h: 7.5,
    clearance: 1.5,
  },
  {
    id: 'halfrack',
    name: 'Half rack',
    category: 'Strength',
    w: 4.6,
    occupiedW: 7.3,
    d: 4.2,
    h: 7.6,
    clearance: 1.5,
  },
  {
    id: 'trainer',
    name: 'Functional trainer',
    category: 'Strength',
    w: 5.6,
    d: 3.4,
    h: 7.7,
    clearance: 2,
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
    id: 'medball',
    name: 'Med ball tower',
    category: 'Strength',
    w: 1.7,
    d: 1.7,
    h: 4.7,
    clearance: 0.5,
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
    id: 'airbike',
    name: 'Air bike',
    category: 'Cardio',
    w: 2.1,
    d: 4.3,
    h: 4.4,
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
    id: 'plyo',
    name: 'Plyo box and ball',
    category: 'Cardio',
    w: 4.4,
    d: 2.2,
    h: 2.6,
    clearance: 1,
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
    id: 'lounge',
    name: 'Recovery lounger',
    category: 'Recovery',
    w: 2.6,
    d: 5,
    h: 2.4,
    clearance: 0.5,
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
    id: 'shelf',
    name: 'Open shelving',
    category: 'Movement',
    w: 3.6,
    d: 1.3,
    h: 6.2,
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
    openingInfill: z.enum(OPENING_INFILLS.map((o) => o.id)),
    integratedFinish: z.boolean(),
    studioLayout: z.enum(STUDIO_LAYOUTS.map((o) => o.id)),
    studioDoor: z.enum(STUDIO_DOORS.map((o) => o.id)),
    doorsOpen: z.boolean(),
    length: z.union([z.literal(20), z.literal(40)]),
    finish: z.enum(FINISHES.map((x) => x.id)),
    accent: z.boolean(),
    addons: z.object({
      deck: z.boolean(),
      gazebo: z.boolean(),
      roof: z.boolean(),
      stairs: z.boolean(),
      canopy: z.boolean(),
    }),
    railing: z.enum(RAILINGS.map((x) => x.id)),
    interiorStyle: z.enum(INTERIORS.map((x) => x.id)),
    flooring: z.enum(FLOORS.map((x) => x.id)),
    mirror: z.boolean(),
    package: z.enum([...PACKAGES.map((x) => x.id), 'custom']),
    items: z.array(itemSchema).max(16),
    environment: z.enum(ENVIRONMENTS.map((x) => x.id)),
    time: z.number().finite().min(6).max(21),
    lights: z.boolean(),
  })
  .superRefine((c, ctx) => {
    if (c.family === 'container' && (c.addons.gazebo || c.accent || c.studioLayout !== 'single'))
      ctx.addIssue({
        code: 'custom',
        message: 'Studio-only additions are not available on the Container planning model.',
      })
    if (
      c.family === 'studio' &&
      (c.containerOpening !== 'roll-up' ||
        c.integratedFinish ||
        c.openingInfill !== 'none' ||
        c.addons.canopy)
    )
      ctx.addIssue({ code: 'custom', message: 'Opening options apply only to Containers.' })
    if (c.containerOpening === 'roll-up' && c.openingInfill !== 'none')
      ctx.addIssue({ code: 'custom', message: 'The roll-up opening carries its own door.' })
    if (new Set(c.items.map((i) => i.id)).size !== c.items.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate equipment identifiers.' })
  })
/**
 * Older payloads migrate forward and are then validated like any other input. Version 2 Studios
 * keep a centered entry (the sliding door), so every saved layout stays valid; Containers keep
 * their opening shown open, as version 2 rendered the roll-up door.
 */
function migrate(input: unknown) {
  if (!input || typeof input !== 'object' || !('v' in input)) return input
  let value = input as Record<string, unknown>
  if (value.v === 1)
    value = {
      ...value,
      v: 2,
      family: 'studio',
      containerOpening: 'roll-up',
      integratedFinish: false,
      studioLayout: 'single',
    }
  if (value.v === 2) {
    const addons = value.addons && typeof value.addons === 'object' ? value.addons : {}
    value = {
      ...value,
      v: 3,
      openingInfill: 'none',
      studioDoor: 'sliding',
      doorsOpen: value.family === 'container',
      addons: { ...addons, canopy: false },
      railing: 'glass',
      interiorStyle: 'slatted',
    }
  }
  return value
}
export const configSchema = z.preprocess(migrate, currentConfigSchema)
export type Config = z.infer<typeof currentConfigSchema>
export type PlacedItem = z.infer<typeof itemSchema>
export type AddonId = (typeof ADDONS)[number]['id']
export type PackageId = (typeof PACKAGES)[number]['id']
export type EnvironmentId = (typeof ENVIRONMENTS)[number]['id']
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
  // Long items run along the back wall so every preset keeps any planned entry clear.
  const presets: Record<PackageId, PlacedItem[]> = {
    strength: [item('rack', -5, -0.8), item('bench', 0, -0.5), item('weights', 5.2, -1.9)],
    recovery: [item('sauna', -5.2, -0.9), item('plunge', 3.5, -1.2, 90)],
    movement: [item('mat', -4.5, -0.5), item('mat', 0, -0.5), item('reformer', 5.5, -2.1, 90)],
    cardio: [item('treadmill', 4.5, -2, 90), item('airbike', -1.5, -0.6), item('bike', -5.5, -0.6)],
    empty: [],
  }
  return presets[kind].map((i) => ({ ...i, x: i.x + offset }))
}
export const DEFAULT_CONFIG: Config = {
  v: 3,
  family: 'studio',
  containerOpening: 'roll-up',
  openingInfill: 'none',
  integratedFinish: false,
  studioLayout: 'single',
  studioDoor: 'hinged',
  doorsOpen: false,
  length: 20,
  finish: 'obsidian',
  accent: false,
  addons: { deck: false, gazebo: false, roof: false, stairs: false, canopy: false },
  railing: 'glass',
  interiorStyle: 'gallery',
  flooring: 'rubber',
  mirror: false,
  package: 'strength',
  items: packageItems('strength', 20),
  environment: 'residences',
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
export const environmentName = (id: EnvironmentId) => ENVIRONMENTS.find((e) => e.id === id)!.name

/**
 * The Studio's glazed front is divided into equal bays inside the 0.8-foot front bezel and its
 * glazing frame: five on a 20-foot unit, eleven on a 40-foot unit, so a sliding door can always
 * take the center bay.
 */
export function studioBays(length: 20 | 40) {
  const span = length - 1.6 - 0.32
  const count = length === 20 ? 5 : 11
  return { span, count, width: span / count }
}
export function studioDoorBay(config: Pick<Config, 'length' | 'studioDoor'>) {
  const { count } = studioBays(config.length)
  return config.studioDoor === 'hinged' ? count - 2 : (count - 1) / 2
}
export function studioDoorCenter(config: Pick<Config, 'length' | 'studioDoor'>) {
  const bays = studioBays(config.length)
  return -bays.span / 2 + (studioDoorBay(config) + 0.5) * bays.width
}
export const entryCenter = (config: Config) =>
  config.family === 'studio'
    ? studioDoorCenter(config)
    : config.containerOpening === 'partial'
      ? -config.length / 4
      : 0
export function openingGeometry(config: Config) {
  const widths = {
    'roll-up': 10,
    center: config.length * 0.6,
    partial: config.length / 2 - 0.6,
    full: config.length - 1.2,
  }
  return {
    width: widths[config.containerOpening],
    center:
      config.family === 'container' && config.containerOpening === 'partial'
        ? -config.length / 4
        : 0,
  }
}
export const addonAvailable = (family: ProductFamily, id: AddonId) =>
  (ADDONS.find((a) => a.id === id)!.families as readonly ProductFamily[]).includes(family)
export function setFamily(config: Config, family: ProductFamily): Config {
  if (config.family === family) return config
  const next: Config = {
    ...config,
    family,
    containerOpening: 'roll-up',
    openingInfill: 'none',
    integratedFinish: false,
    studioLayout: 'single',
    studioDoor: 'hinged',
    doorsOpen: family === 'container',
    accent: family === 'container' ? false : config.accent,
    addons: {
      ...config.addons,
      gazebo: family === 'container' ? false : config.addons.gazebo,
      canopy: family === 'studio' ? false : config.addons.canopy,
    },
  }
  // Prefer the hinged door, but keep an existing layout valid with the centered slider.
  if (family === 'studio' && layoutIssues(next).length) {
    const sliding = { ...next, studioDoor: 'sliding' as const }
    if (!layoutIssues(sliding).length) return sliding
  }
  return next
}
export function footprint(item: PlacedItem) {
  const p = catalogItem(item.sku)
  const w = 'occupiedW' in p ? p.occupiedW : p.w
  return { w: item.rotation === 90 ? p.d : w, d: item.rotation === 90 ? w : p.d }
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
  if (!addonAvailable(config.family, id))
    return {
      config,
      notice:
        config.family === 'studio'
          ? 'The entry canopy is shown on Container builds only.'
          : 'The gazebo is documented for Studios only.',
    }
  return { config: { ...config, addons: { ...config.addons, [id]: !config.addons[id] } } }
}

// --- Signature builds -------------------------------------------------------------------

export type SignatureId =
  'courtyard-pod' | 'campus-pod' | 'clubhouse' | 'garden-pilates' | 'rooftop'
export type Signature = {
  id: SignatureId
  name: string
  subtitle: string
  /** Direction from the subject toward the camera, matching the reference photograph. */
  camera: [number, number, number]
  config: Config
}
const placed = (id: string, items: [PlacedItem['sku'], number, number, (0 | 90)?][]) =>
  items.map(([sku, x, z, rotation = 0], i) => ({ id: `${id}-${i}-${sku}`, sku, x, z, rotation }))
/**
 * Five complete designs inspired by Fury's portfolio: shell, openings, additions, interior and
 * equipment arrangement. Presentation lighting and cameras favor legible materials and space.
 */
export const SIGNATURES: Signature[] = [
  {
    id: 'courtyard-pod',
    name: 'Courtyard pod',
    subtitle: 'Cloud S-Series, hinged door, functional strength',
    camera: [-0.62, 0.14, 0.78],
    config: {
      ...DEFAULT_CONFIG,
      finish: 'cloud',
      studioDoor: 'hinged',
      interiorStyle: 'gallery',
      flooring: 'stone',
      package: 'custom',
      items: placed('courtyard-pod', [
        ['weights', -6.8, -2.4],
        ['bench', -6.6, 0.4, 90],
        ['trainer', -0.6, -1.6],
        ['airbike', 7.2, -0.8],
      ]),
      environment: 'residences',
      time: 16,
      lights: true,
    },
  },
  {
    id: 'campus-pod',
    name: 'Campus pod',
    subtitle: 'Graphite S-Series, sliding door, oak floor',
    camera: [-0.62, 0.07, 0.78],
    config: {
      ...DEFAULT_CONFIG,
      finish: 'graphite',
      studioDoor: 'sliding',
      interiorStyle: 'gallery',
      flooring: 'oak',
      package: 'custom',
      items: placed('campus-pod', [
        ['trainer', -6.2, -1.6],
        ['weights', -1, -2.4],
        ['bench', 2.3, -0.4],
        ['plyo', 5.7, 0.8],
        ['medball', 8.4, -2.4],
      ]),
      environment: 'campus',
      time: 11,
      lights: true,
    },
  },
  {
    id: 'clubhouse',
    name: 'Clubhouse container',
    subtitle: 'Espresso, glass overhead door, canopy, cedar',
    camera: [-0.65, 0.14, 0.76],
    config: {
      ...DEFAULT_CONFIG,
      family: 'container',
      finish: 'espresso',
      containerOpening: 'full',
      openingInfill: 'glass-overhead',
      integratedFinish: true,
      studioDoor: 'hinged',
      doorsOpen: false,
      addons: { deck: false, gazebo: false, roof: false, stairs: false, canopy: true },
      interiorStyle: 'timber',
      flooring: 'concrete',
      package: 'custom',
      items: placed('clubhouse', [
        ['treadmill', -7.8, -0.2],
        ['halfrack', -2.6, -1.15],
        ['halfrack', 4.9, -1.15],
        ['bench', 4.5, 2.25, 90],
      ]),
      environment: 'residences',
      time: 16,
      lights: true,
    },
  },
  {
    id: 'garden-pilates',
    name: 'Garden Pilates',
    subtitle: 'Obsidian container, awning sashes, timber deck',
    camera: [-0.55, 0.72, 0.72],
    config: {
      ...DEFAULT_CONFIG,
      family: 'container',
      finish: 'obsidian',
      containerOpening: 'center',
      openingInfill: 'awning',
      integratedFinish: true,
      doorsOpen: true,
      addons: { deck: true, gazebo: false, roof: false, stairs: false, canopy: false },
      interiorStyle: 'birch',
      flooring: 'concrete',
      package: 'custom',
      items: placed('garden-pilates', [
        ['reformer', 1, 0.6, 90],
        ['shelf', -6.5, -2.6],
        ['mat', 6.8, -0.6],
      ]),
      environment: 'backyard',
      time: 9.5,
      lights: false,
    },
  },
  {
    id: 'rooftop',
    name: 'Rooftop container',
    subtitle: 'Obsidian, raised glass door, roof deck and stair',
    camera: [-0.5, 0.24, 0.84],
    config: {
      ...DEFAULT_CONFIG,
      family: 'container',
      finish: 'obsidian',
      containerOpening: 'full',
      openingInfill: 'glass-overhead',
      integratedFinish: true,
      doorsOpen: true,
      addons: { deck: false, gazebo: false, roof: true, stairs: true, canopy: false },
      railing: 'cable',
      interiorStyle: 'gallery',
      flooring: 'rubber',
      mirror: true,
      package: 'custom',
      items: placed('rooftop', [
        ['airbike', -5.8, -0.4, 90],
        ['rack', 0.4, -1.6],
        ['bench', 5.4, 1.35, 90],
        ['weights', 6.6, -2.4],
      ]),
      environment: 'backyard',
      time: 17,
      lights: true,
    },
  },
]
export const DEFAULT_CAMERA: [number, number, number] = [0.48, 0.24, 0.84]

// --- Pricing ----------------------------------------------------------------------------

export const PRICE_VERSION = `fury-published-${PRODUCT_SOURCE_DATE}`
export function estimate(config: Config) {
  const product = productFamily(config.family)
  const container = config.family === 'container'
  const names = [
    productName(config),
    ...(container
      ? [CONTAINER_OPENINGS.find((o) => o.id === config.containerOpening)!.name]
      : [`Portfolio: ${STUDIO_DOORS.find((d) => d.id === config.studioDoor)!.name}`]),
    ...(container && config.openingInfill !== 'none'
      ? [`Portfolio: ${OPENING_INFILLS.find((o) => o.id === config.openingInfill)!.name}`]
      : []),
    ...(config.integratedFinish ? ['Integrated exterior finish'] : []),
    ...(config.studioLayout !== 'single'
      ? [`Custom inquiry: ${STUDIO_LAYOUTS.find((o) => o.id === config.studioLayout)!.name}`]
      : []),
    ...ADDONS.filter((a) => config.addons[a.id]).map((a) =>
      container ? `Portfolio: ${a.name}` : a.name,
    ),
    ...((config.addons.roof || config.addons.stairs) && config.railing === 'cable'
      ? ['Portfolio: Steel cable rail']
      : []),
    `Concept finish: ${FINISHES.find((f) => f.id === config.finish)!.name}`,
    `Concept interior: ${INTERIORS.find((f) => f.id === config.interiorStyle)!.name}`,
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

// --- Sharing and persistence ------------------------------------------------------------

export function encodeConfig(config: Config) {
  return LZString.compressToEncodedURIComponent(JSON.stringify(configSchema.parse(config)))
}
export function decodeConfig(value: string): Config | null {
  if (!value || value.length > 12000) return null
  try {
    const decoded = LZString.decompressFromEncodedURIComponent(value)
    if (!decoded || decoded.length > 16000) return null
    const config = configSchema.parse(JSON.parse(decoded))
    return layoutIssues(config).length ? null : config
  } catch {
    return null
  }
}
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
function storedBuilds(serialized = localStorage.getItem('fury-builds-v1')) {
  const raw: unknown = JSON.parse(serialized ?? '[]')
  if (!Array.isArray(raw)) throw new Error('The saved library is not an array.')
  const builds: SavedBuild[] = []
  const unreadable: unknown[] = []
  for (const entry of raw) {
    const parsed = savedBuildSchema.safeParse(entry)
    if (parsed.success && !layoutIssues(parsed.data.config).length) builds.push(parsed.data)
    else unreadable.push(entry)
  }
  return { builds: builds.slice(0, 12), unreadable, hidden: builds.length > 12 }
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
  const previous = localStorage.getItem('fury-builds-v1')
  // Entries set aside on reading are written back as they were, so a save never deletes them.
  let unreadable: unknown[] = []
  let needsRecovery = false
  try {
    const stored = storedBuilds(previous)
    unreadable = stored.unreadable
    needsRecovery = stored.hidden || unreadable.length > 0
  } catch {
    needsRecovery = true
  }
  if (previous !== null && needsRecovery) archiveRawValue(localStorage, 'fury-builds-v1', previous)
  if (localStorage.getItem('fury-builds-v1') !== previous)
    throw new Error('The saved library changed. Reload before saving.')
  localStorage.setItem('fury-builds-v1', JSON.stringify([...valid, ...unreadable]))
}
export function initialConfig(): { config: Config; notice: string } {
  const encoded = new URLSearchParams(window.location.hash.slice(1)).get('c')
  let invalidShare = false
  if (encoded !== null) {
    const config = decodeConfig(encoded)
    if (config) return { config, notice: 'Shared design loaded. Make it your own.' }
    invalidShare = true
  }
  try {
    const draft = localStorage.getItem('fury-draft-v1')
    const config = draft && decodeConfig(draft)
    if (config)
      return {
        config,
        notice: invalidShare
          ? 'This share link is invalid or unsupported. Your previous draft is safe.'
          : '',
      }
  } catch {
    /* Storage is optional in private browsing. */
  }
  return {
    config: { ...DEFAULT_CONFIG, environment: 'studio', time: 12, lights: true },
    notice: invalidShare
      ? 'This share link is invalid or unsupported. No saved draft was available.'
      : '',
  }
}

export function writeDraft(encoded: string) {
  const previous = localStorage.getItem('fury-draft-v1')
  if (previous !== null && previous !== encoded && !decodeConfig(previous)) {
    // Preserve older layouts/schemas before autosave replaces an unreadable draft.
    archiveRawValue(localStorage, 'fury-draft-v1', previous, 'fury-draft-recovery-')
  }
  if (localStorage.getItem('fury-draft-v1') !== previous)
    throw new Error('The stored draft changed. Reload before saving.')
  localStorage.setItem('fury-draft-v1', encoded)
}
