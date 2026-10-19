import { catalogItem, type PlacedItem } from '../lib/config'
import type { ProductFamily } from '../lib/products'

export const ARRANGEMENT_CATALOG_VERSION = 'fury-arrangements-draft-1'

type DraftArrangement = Readonly<{
  id: string
  family: ProductFamily
  lengthFt: 20 | 40
  approval: 'draft'
  reviewHolds: readonly string[]
  items: readonly Readonly<PlacedItem>[]
}>

const commonHolds = [
  'Manufacturer dimensions and directional use/loading/service clearances are unapproved.',
  'Catalog clearance halos cross modeled floor boundaries.',
  'Access, egress, occupancy, anchors, floor loads and utilities require specialist review.',
] as const

function draft(
  family: ProductFamily,
  lengthFt: 20 | 40,
  placements: readonly (readonly [PlacedItem['sku'], number, number, 0 | 90])[],
): DraftArrangement {
  return Object.freeze({
    id: `${family}-${lengthFt}-review@1`,
    family,
    lengthFt,
    approval: 'draft',
    reviewHolds: Object.freeze([
      ...commonHolds,
      ...(family === 'container'
        ? ['Tall equipment conflicts with the modeled slat ceiling and some overhead-door cases.']
        : []),
    ]),
    items: Object.freeze(
      placements.map(([sku, x, z, rotation], index) =>
        Object.freeze({ id: `${family}-${lengthFt}-${index + 1}-${sku}`, sku, x, z, rotation }),
      ),
    ),
  })
}

// G0 arrangement-draft-1: proposals, never approved build specifications.
export const FIXED_ARRANGEMENTS = Object.freeze([
  draft('studio', 20, [
    ['trainer', -6.25, -1.5, 0],
    ['bench', 0, -2.1, 90],
    ['weights', 6.6, -2.3, 0],
  ]),
  draft('studio', 40, [
    ['trainer', -14, -1.5, 0],
    ['bench', -7, -2.1, 90],
    ['weights', -0.8, -2.3, 0],
    ['airbike', 5, -2, 90],
    ['mat', 11, -1.9, 90],
    ['shelf', 16.6, -2.55, 0],
  ]),
  draft('container', 20, [
    ['rack', -5.6, -1.6, 0],
    ['bench', 1.9, -2.2, 90],
    ['weights', 7, -2.3, 0],
  ]),
  draft('container', 40, [
    ['rack', -14.8, -1.6, 0],
    ['trainer', -6.7, -1.5, 0],
    ['weights', 0, -2.3, 0],
    ['bench', 5.8, -2.1, 90],
    ['airbike', 12, -2, 90],
    ['medball', 17, -2.4, 0],
  ]),
])

export function arrangementFor(family: ProductFamily, lengthFt: 20 | 40) {
  const arrangement = FIXED_ARRANGEMENTS.find(
    (entry) => entry.family === family && entry.lengthFt === lengthFt,
  )
  if (!arrangement) throw new Error('Unsupported family/size for the fixed-arrangement catalog.')
  return arrangement
}

const equipment = Object.freeze(
  Object.fromEntries(
    FIXED_ARRANGEMENTS.flatMap((arrangement) =>
      arrangement.items.map(({ sku }) => {
        const entry = catalogItem(sku)
        return [
          sku,
          Object.freeze({
            sku,
            widthFt: entry.w,
            occupiedWidthFt: 'occupiedW' in entry ? entry.occupiedW : entry.w,
            depthFt: entry.d,
            heightFt: entry.h,
            illustrativeClearanceFt: entry.clearance,
          }),
        ] as const
      }),
    ),
  ),
)

export function arrangementEquipment(sku: PlacedItem['sku']) {
  if (!Object.hasOwn(equipment, sku))
    throw new Error('Equipment is not used by a fixed draft arrangement.')
  return equipment[sku]
}
