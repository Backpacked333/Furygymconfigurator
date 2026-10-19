import { z } from 'zod'
import { ARRANGEMENT_CATALOG_VERSION, arrangementEquipment, arrangementFor } from './arrangements'

const productSchema = z
  .object({
    family: z.enum(['studio', 'container']),
    lengthFt: z.union([z.literal(20), z.literal(40)]),
  })
  .strict()

// A layout sub-contract, not the complete product/presentation v4 envelope.
export const fixedLayoutSchema = z
  .object({
    contract: z.literal('fury.fixed-layout'),
    contractVersion: z.literal(1),
    catalogVersion: z.literal(ARRANGEMENT_CATALOG_VERSION),
    product: productSchema,
    arrangementRef: z.string().max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.arrangementRef !== arrangementFor(value.product.family, value.product.lengthFt).id)
      context.addIssue({
        code: 'custom',
        path: ['arrangementRef'],
        message: 'The arrangement must match its catalog, family and size.',
      })
  })

export type FixedLayout = Readonly<
  Omit<z.infer<typeof fixedLayoutSchema>, 'product'> & {
    product: Readonly<z.infer<typeof productSchema>>
  }
>

export function parseFixedLayout(input: unknown): FixedLayout {
  const parsed = fixedLayoutSchema.parse(input)
  return Object.freeze({ ...parsed, product: Object.freeze(parsed.product) })
}

export function createFixedLayout(product: unknown): FixedLayout {
  const parsed = productSchema.parse(product)
  return parseFixedLayout({
    contract: 'fury.fixed-layout',
    contractVersion: 1,
    catalogVersion: ARRANGEMENT_CATALOG_VERSION,
    product: parsed,
    arrangementRef: arrangementFor(parsed.family, parsed.lengthFt).id,
  })
}

export function transitionFixedLayout(current: unknown, patch: unknown) {
  const previous = parseFixedLayout(current)
  const changes = productSchema.partial().parse(patch)
  const next = createFixedLayout({ ...previous.product, ...changes })
  return Object.freeze({
    previous,
    next,
    changed: serializeFixedLayout(previous) !== serializeFixedLayout(next),
    explanation:
      previous.arrangementRef === next.arrangementRef
        ? 'The fixed arrangement is unchanged.'
        : `The family/size change replaces ${previous.arrangementRef} with ${next.arrangementRef} in one step.`,
    warnings: arrangementFor(next.product.family, next.product.lengthFt).reviewHolds,
  })
}

export function serializeFixedLayout(input: unknown) {
  return JSON.stringify(parseFixedLayout(input))
}

export function deserializeFixedLayout(serialized: string): FixedLayout | null {
  if (serialized.length > 4096) return null
  try {
    return parseFixedLayout(JSON.parse(serialized))
  } catch {
    return null
  }
}

export function resolveFixedLayoutForReview(input: unknown) {
  const layout = parseFixedLayout(input)
  const arrangement = arrangementFor(layout.product.family, layout.product.lengthFt)
  return Object.freeze({
    layout,
    units: 'feet' as const,
    approval: arrangement.approval,
    items: arrangement.items,
    reviewHolds: arrangement.reviewHolds,
  })
}

export function fixedLayoutProductionGate(input: unknown) {
  const resolved = resolveFixedLayoutForReview(input)
  return Object.freeze({
    allowed: false as const,
    reason: 'arrangements-awaiting-product-approval' as const,
    catalogVersion: resolved.layout.catalogVersion,
    arrangementRef: resolved.layout.arrangementRef,
    reviewHolds: resolved.reviewHolds,
  })
}

export function canonicalResolvedLayout(input: unknown) {
  const resolved = resolveFixedLayoutForReview(input)
  return JSON.stringify({
    layout: resolved.layout,
    units: resolved.units,
    items: resolved.items.map((item) => ({
      ...item,
      dimensions: arrangementEquipment(item.sku),
    })),
  })
}

/** Layout identity only: not an image key, release approval or render authorization. */
export async function fixedLayoutDigest(input: unknown) {
  const bytes = new TextEncoder().encode(canonicalResolvedLayout(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
