export const PRODUCT_SOURCE_DATE = '2026-10-14'
export const PROJECT_URL = 'https://www.furycogyms.com/start-a-project'
export const PRODUCT_FAMILIES = [
  {
    id: 'studio',
    name: 'S-Series Studio',
    shortName: 'Studio',
    description: 'Refined fitness, wellness, and recovery.',
    height: 10,
    startingPrice: 35000,
    source: 'https://www.furycogyms.com/gym-design/studio',
    features:
      'Steel construction · Insulated interior · Performance flooring · Electrical + lighting · Climate controllable',
  },
  {
    id: 'container',
    name: 'Container Gym',
    shortName: 'Container',
    description: 'Rugged strength and group training.',
    height: 9.5,
    startingPrice: 20000,
    source: 'https://www.furycogyms.com/gym-design/container',
    features:
      'Steel construction · Wind + watertight · Finished interior + exterior · Performance flooring · Electrical + lighting',
  },
] as const
export type ProductFamily = (typeof PRODUCT_FAMILIES)[number]['id']
export const productFamily = (id: ProductFamily) => PRODUCT_FAMILIES.find((p) => p.id === id)!
export const CONTAINER_OPENINGS = [
  {
    id: 'roll-up',
    name: '10′ roll-up door',
    detail: 'Featured width. Other sizes and colors by inquiry.',
  },
  { id: 'center', name: 'Center opening', detail: 'A central connection to outdoor training.' },
  {
    id: 'partial',
    name: 'Partial open-side',
    detail: 'An opening toward one end of the training space.',
  },
  { id: 'full', name: 'Full open-side', detail: 'An open connection along the training floor.' },
] as const
export const STUDIO_LAYOUTS = [
  { id: 'single', name: 'Single unit' },
  { id: 'connected', name: 'Connected units' },
  { id: 'double-wide', name: 'Double-wide' },
  { id: 'multi-level', name: 'Multi-level' },
  { id: 'stacked', name: 'Stacked' },
  { id: 'custom', name: 'Custom configuration' },
] as const

export const OPENING_CONCEPTS = [
  { id: 'standard', name: 'Standard sourced opening' },
  { id: 'sectional-glazed', name: 'Sectional glazed concept' },
  { id: 'raised-glazed', name: 'Raised glazed concept' },
  { id: 'open-front', name: 'Open front concept' },
  { id: 'hinged-solid', name: 'Hinged solid concept' },
] as const
export type EvidenceCategory = 'published' | 'reference' | 'illustrative'
export type FeatureEvidence = {
  id: string
  category: EvidenceCategory
  families: readonly ProductFamily[]
  references: readonly string[]
  source?: string
  scope: 'design' | 'presentation' | 'site-context'
  wording: string
}
const studioSource = PRODUCT_FAMILIES[0].source
const containerSource = PRODUCT_FAMILIES[1].source
export const FEATURE_EVIDENCE: readonly FeatureEvidence[] = [
  {
    id: 'studio',
    category: 'published',
    families: ['studio'],
    references: [],
    source: studioSource,
    scope: 'design',
    wording: 'S-Series Studio; published family starting price, not a configured quote.',
  },
  {
    id: 'container',
    category: 'published',
    families: ['container'],
    references: [],
    source: containerSource,
    scope: 'design',
    wording: 'Container Gym; published family starting price, not a configured quote.',
  },
  ...CONTAINER_OPENINGS.map((opening): FeatureEvidence => ({
    id: `opening:${opening.id}`,
    category: 'published',
    families: ['container'],
    references: [],
    source: containerSource,
    scope: 'design',
    wording: `${opening.name}; dimensions and feasibility by inquiry.`,
  })),
  {
    id: 'sectional-glazed',
    category: 'reference',
    families: ['container'],
    references: ['R04'],
    scope: 'design',
    wording:
      'Reference-backed glazed sectional-looking concept; mechanism and engineering unverified.',
  },
  {
    id: 'raised-glazed',
    category: 'reference',
    families: ['container'],
    references: ['R05'],
    scope: 'design',
    wording:
      'Reference-backed raised glazing concept; endpoints and supports are illustrative, not certified motion.',
  },
  {
    id: 'open-front',
    category: 'reference',
    families: ['container'],
    references: ['R07'],
    scope: 'design',
    wording:
      'Reference-backed open-front concept; overhead structure and feasibility require confirmation.',
  },
  {
    id: 'hinged-solid',
    category: 'reference',
    families: ['container'],
    references: ['R09'],
    scope: 'design',
    wording: 'Reference-backed hinged solid leaves; hardware and swing clearance are illustrative.',
  },
  ...(['deck', 'roof', 'stairs', 'gazebo'] as const).map((id): FeatureEvidence => ({
    id: `studio:${id}`,
    category: 'published',
    families: ['studio'],
    references: id === 'gazebo' ? [] : ['R01'],
    source: studioSource,
    scope: 'design',
    wording: `Studio ${id} inquiry; modeled dimensions, connections and engineering are illustrative.`,
  })),
  ...(['deck', 'roof', 'stairs'] as const).map((id): FeatureEvidence => ({
    id: `container:${id}`,
    category: 'reference',
    families: ['container'],
    references: id === 'deck' ? ['R05'] : ['R07'],
    scope: 'design',
    wording: `Container ${id} reference concept, not a published option or approved engineering.`,
  })),
  {
    id: 'custom-wellness',
    category: 'reference',
    families: ['studio', 'container'],
    references: ['R08'],
    scope: 'site-context',
    wording:
      'Custom architectural/wellness inquiry context; surrounding building is not a standardized family or included scope.',
  },
  {
    id: 'sunken-lounge',
    category: 'reference',
    families: ['studio', 'container'],
    references: ['R09'],
    scope: 'site-context',
    wording:
      'Illustrative sunken lounge/site context; landscaping and fire feature are not bundled or priced.',
  },
  {
    id: 'openingPose',
    category: 'illustrative',
    families: ['studio', 'container'],
    references: ['R04', 'R05', 'R07', 'R09'],
    scope: 'presentation',
    wording: 'Persisted opening pose only; no certified door motion or capacity claim.',
  },
  {
    id: 'equipment',
    category: 'illustrative',
    families: ['studio', 'container'],
    references: ['R05', 'R06'],
    scope: 'design',
    wording:
      'Generic planning equipment, including reformer, sauna and plunge; dimensions and working space are illustrative, not manufacturer specifications.',
  },
  {
    id: 'finishes',
    category: 'illustrative',
    families: ['studio', 'container'],
    references: [],
    scope: 'design',
    wording:
      'Illustrative finish, timber accent, mirror and floor swatches; not verified manufacturer colors.',
  },
]
export function featureEvidence(id: string) {
  return FEATURE_EVIDENCE.find((feature) => feature.id === id)
}
