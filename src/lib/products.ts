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

/**
 * Options seen in Fury's built portfolio (client-supplied reference photography reviewed on the
 * source date above), rather than on the published product pages. They are modeled so a design
 * can match those builds; none of them carries a published price, and all require a quote.
 */
export const PORTFOLIO_NOTE =
  'Seen in Fury builds. Geometry is a concept interpretation; specification and price by quote.'
export const OPENING_INFILLS = [
  {
    id: 'none',
    name: 'Open side',
    detail: 'An unobstructed connection to outdoor training.',
  },
  {
    id: 'glass-overhead',
    name: 'Glass overhead door',
    detail: 'Full-view sectional door in aluminum frames that lifts into ceiling tracks.',
  },
  {
    id: 'awning',
    name: 'Top-hung glass sashes',
    detail: 'Glazed sashes hinge at the head and prop open on gas struts.',
  },
] as const
export const STUDIO_DOORS = [
  {
    id: 'hinged',
    name: 'Hinged glass door',
    detail: 'A black-framed door in the second bay from the end.',
  },
  {
    id: 'sliding',
    name: 'Sliding glass door',
    detail: 'The center bay slides behind its neighbor.',
  },
] as const
