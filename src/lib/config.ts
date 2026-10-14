import { z } from 'zod'
import LZString from 'lz-string'

export const FINISHES = [
  { id: 'obsidian', name: 'Obsidian', color: '#262927', detail: 'Matte powder coat', price: 0 },
  { id: 'chalk', name: 'Chalk', color: '#e3e0d5', detail: 'Warm mineral white', price: 0 },
  { id: 'olive', name: 'Olive', color: '#66705a', detail: 'Grounded in nature', price: 1800 },
  { id: 'bronze', name: 'Bronze', color: '#807061', detail: 'A softer metallic', price: 2400 },
] as const
export const FLOORS = [
  { id: 'rubber', name: 'Performance rubber', color: '#353936', price: 0 },
  { id: 'oak', name: 'Natural oak', color: '#b08c61', price: 2600 },
  { id: 'stone', name: 'Mineral stone', color: '#acb1a5', price: 3200 },
] as const
export const ADDONS = [
  {
    id: 'deck',
    name: 'Front terrace',
    detail: 'An 8-foot extension to your everyday.',
    price: 8200,
  },
  {
    id: 'gazebo',
    name: 'Architectural pergola',
    detail: 'Slatted shade. A seamless outdoor room.',
    price: 12400,
  },
  { id: 'roof', name: 'Rooftop deck', detail: 'A new perspective, above it all.', price: 16800 },
  {
    id: 'stairs',
    name: 'Exterior staircase',
    detail: 'Access to your rooftop retreat.',
    price: 7600,
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
    price: 2400,
    clearance: 1.5,
  },
  {
    id: 'bench',
    name: 'Adjustable bench',
    category: 'Strength',
    w: 1.9,
    d: 4.3,
    h: 1.8,
    price: 650,
    clearance: 1,
  },
  {
    id: 'weights',
    name: 'Dumbbell station',
    category: 'Strength',
    w: 4.2,
    d: 1.8,
    h: 3,
    price: 1800,
    clearance: 1.5,
  },
  {
    id: 'bike',
    name: 'Indoor cycle',
    category: 'Cardio',
    w: 2,
    d: 4,
    h: 4.2,
    price: 1900,
    clearance: 1,
  },
  {
    id: 'treadmill',
    name: 'Running deck',
    category: 'Cardio',
    w: 2.7,
    d: 5.8,
    h: 4.5,
    price: 3200,
    clearance: 2,
  },
  {
    id: 'sauna',
    name: 'Two-person sauna',
    category: 'Recovery',
    w: 4.8,
    d: 4.4,
    h: 7,
    price: 8500,
    clearance: 1,
  },
  {
    id: 'plunge',
    name: 'Cold plunge',
    category: 'Recovery',
    w: 2.9,
    d: 5.2,
    h: 2.8,
    price: 5900,
    clearance: 1,
  },
  {
    id: 'mat',
    name: 'Movement mat',
    category: 'Movement',
    w: 2.2,
    d: 5.4,
    h: 0.08,
    price: 120,
    clearance: 0.5,
  },
  {
    id: 'reformer',
    name: 'Pilates reformer',
    category: 'Movement',
    w: 2.4,
    d: 6.5,
    h: 1.4,
    price: 3800,
    clearance: 0.5,
  },
  {
    id: 'lounge',
    name: 'Recovery lounger',
    category: 'Recovery',
    w: 2.6,
    d: 5,
    h: 2.4,
    price: 1400,
    clearance: 0.5,
  },
] as const
export const PACKAGES = [
  { id: 'strength', name: 'Strength', subtitle: 'Your daily pursuit.', icon: 'strength' },
  { id: 'recovery', name: 'Recovery', subtitle: 'Come back to yourself.', icon: 'recovery' },
  { id: 'movement', name: 'Movement', subtitle: 'Find your own flow.', icon: 'movement' },
  { id: 'cardio', name: 'Cardio', subtitle: 'Go a little further.', icon: 'cardio' },
  { id: 'empty', name: 'Empty studio', subtitle: 'Room for your vision.', icon: 'empty' },
] as const

const itemSchema = z.object({
  id: z.string().min(1).max(64),
  sku: z.enum(CATALOG.map((x) => x.id)),
  x: z.number().finite().min(-20).max(20),
  z: z.number().finite().min(-4).max(4),
  rotation: z.union([z.literal(0), z.literal(90)]),
})
export const configSchema = z
  .object({
    v: z.literal(1),
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
    if (c.addons.gazebo && !c.addons.deck)
      ctx.addIssue({ code: 'custom', message: 'A pergola requires a front terrace.' })
    if (c.addons.stairs && !c.addons.roof)
      ctx.addIssue({ code: 'custom', message: 'Stairs require a rooftop deck.' })
    if (new Set(c.items.map((i) => i.id)).size !== c.items.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate equipment identifiers.' })
  })
export type Config = z.infer<typeof configSchema>
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
    cardio: [item('treadmill', -4.5, 0), item('bike', 0, -0.6), item('bike', 4, -0.6)],
    empty: [],
  }
  return presets[kind].map((i) => ({ ...i, x: i.x + offset }))
}
export const DEFAULT_CONFIG: Config = {
  v: 1,
  length: 20,
  finish: 'obsidian',
  accent: true,
  addons: { deck: true, gazebo: false, roof: false, stairs: false },
  flooring: 'rubber',
  mirror: true,
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
export function footprint(item: PlacedItem) {
  const p = catalogItem(item.sku)
  return { w: item.rotation === 90 ? p.d : p.w, d: item.rotation === 90 ? p.w : p.d }
}
export function placementIssue(item: PlacedItem, config: Config): string | null {
  const { w, d } = footprint(item)
  if (Math.abs(item.x) + w / 2 > config.length / 2 - 0.7 || Math.abs(item.z) + d / 2 > 3.35)
    return 'Keep equipment inside the usable floor area.'
  if (Math.abs(item.x) < w / 2 + 1.6 && item.z + d / 2 > 2.3) return 'Keep the central entry clear.'
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
  const addons = { ...config.addons, [id]: !config.addons[id] }
  let notice: string | undefined
  if (id === 'gazebo' && addons.gazebo && !addons.deck) {
    addons.deck = true
    notice = 'Front terrace included: the pergola needs a supporting deck.'
  }
  if (id === 'deck' && !addons.deck && addons.gazebo) {
    addons.gazebo = false
    notice = 'Pergola removed with its supporting terrace.'
  }
  if (id === 'stairs' && addons.stairs && !addons.roof) {
    addons.roof = true
    notice = 'Rooftop deck included with exterior stairs.'
  }
  if (id === 'roof' && !addons.roof && addons.stairs) {
    addons.stairs = false
    notice = 'Stairs removed with the rooftop deck.'
  }
  return { config: { ...config, addons }, notice }
}
export const PRICE_VERSION = 'concept-2026-10'
export function estimate(config: Config) {
  const scale = config.length / 20
  const finish = FINISHES.find((f) => f.id === config.finish)!
  const floor = FLOORS.find((f) => f.id === config.flooring)!
  const lines = [
    { name: `S-${config.length} studio shell`, amount: config.length === 20 ? 68000 : 118000 },
    ...(finish.price ? [{ name: `${finish.name} finish`, amount: finish.price * scale }] : []),
    ...(config.accent ? [{ name: 'Cedar accent cladding', amount: 3800 * scale }] : []),
    ...ADDONS.filter((a) => config.addons[a.id]).map((a) => ({
      name: a.name,
      amount: a.price * (a.id === 'stairs' ? 1 : scale),
    })),
    ...(floor.price ? [{ name: floor.name, amount: floor.price * scale }] : []),
    ...(config.mirror ? [{ name: 'Mirror wall', amount: 1400 * scale }] : []),
    ...config.items.map((i) => ({
      name: catalogItem(i.sku).name,
      amount: catalogItem(i.sku).price,
    })),
  ]
  return { lines, total: lines.reduce((sum, l) => sum + l.amount, 0), version: PRICE_VERSION }
}
export function monthlyPayment(price: number, depositPercent: number, apr: number, months: number) {
  if (
    ![price, depositPercent, apr, months].every(Number.isFinite) ||
    price < 0 ||
    depositPercent < 0 ||
    depositPercent > 100 ||
    apr < 0 ||
    months <= 0
  )
    throw new Error('Invalid financing inputs')
  const principal = price * (1 - depositPercent / 100),
    r = apr / 1200
  return r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months))
}
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
const savedSchema = z
  .array(
    z.object({
      id: z.string().max(64),
      name: z.string().min(1).max(60),
      date: z.string(),
      config: configSchema,
    }),
  )
  .max(12)
export function readSaved(): SavedBuild[] {
  try {
    return savedSchema
      .parse(JSON.parse(localStorage.getItem('fury-builds-v1') || '[]'))
      .filter((x) => !layoutIssues(x.config).length)
  } catch {
    return []
  }
}
export function writeSaved(builds: SavedBuild[]) {
  localStorage.setItem('fury-builds-v1', JSON.stringify(savedSchema.parse(builds)))
}
export function initialConfig(): { config: Config; notice: string } {
  const encoded = new URLSearchParams(window.location.hash.slice(1)).get('c')
  if (encoded) {
    const config = decodeConfig(encoded)
    return {
      config: config ?? DEFAULT_CONFIG,
      notice: config
        ? 'Shared studio loaded. Make it your own.'
        : 'This share link is invalid or unsupported. Your default studio is ready.',
    }
  }
  try {
    const draft = localStorage.getItem('fury-draft-v1')
    const config = draft && decodeConfig(draft)
    if (config) return { config, notice: '' }
  } catch {
    /* Storage is optional in private browsing. */
  }
  return { config: DEFAULT_CONFIG, notice: '' }
}
