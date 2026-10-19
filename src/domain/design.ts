import { z } from 'zod'
import {
  ADDONS,
  FINISHES,
  FLOORS,
  INTERIORS,
  RAILINGS,
  configSchema,
  type Config,
} from '../lib/config'
import { CONTAINER_OPENINGS, OPENING_INFILLS, STUDIO_DOORS, STUDIO_LAYOUTS } from '../lib/products'
import { ARRANGEMENT_CATALOG_VERSION, arrangementEquipment, arrangementFor } from './arrangements'
import {
  defaultPresentation,
  outputProfileSchema,
  presentationSchema,
  resolveCamera,
  resolveLook,
  PRESENTATION_CATALOG_VERSION,
} from './presentation'

export const DESIGN_SCHEMA_VERSION = 4 as const
export const DESIGN_CATALOG_VERSION = 'fury-design-draft-1' as const
export const MAX_SERIALIZED_DESIGN_BYTES = 16 * 1024
export const productSchema = z
  .object({
    family: z.enum(['studio', 'container']),
    lengthFt: z.union([z.literal(20), z.literal(40)]),
  })
  .strict()
export type DesignProduct = Readonly<z.infer<typeof productSchema>>
export const addonSchema = z.enum(ADDONS.map((entry) => entry.id))
export type DesignAddon = z.infer<typeof addonSchema>

/** Duplicate additions reject; order is semantic-set order, normalized lexicographically. */
export const addonsSchema = z
  .array(addonSchema)
  .max(ADDONS.length)
  .superRefine((items, context) => {
    if (new Set(items).size !== items.length)
      context.addIssue({ code: 'custom', message: 'Duplicate additions are not allowed.' })
  })
  .transform((items) => [...items].sort())
const railingSchema = z.enum(RAILINGS.map((entry) => entry.id))
export const studioStructureSchema = z
  .object({
    kind: z.literal('studio'),
    layout: z.literal('single'),
    door: z.enum(STUDIO_DOORS.map((entry) => entry.id)),
    addons: addonsSchema,
    railing: railingSchema,
  })
  .strict()
export const containerStructureSchema = z
  .object({
    kind: z.literal('container'),
    opening: z.enum(CONTAINER_OPENINGS.map((entry) => entry.id)),
    infill: z.enum(OPENING_INFILLS.map((entry) => entry.id)),
    integratedFinish: z.boolean(),
    addons: addonsSchema,
    railing: railingSchema,
  })
  .strict()
export const structureSchema = z.discriminatedUnion('kind', [
  studioStructureSchema,
  containerStructureSchema,
])
export const appearanceSchema = z
  .object({
    finish: z.enum(FINISHES.map((entry) => entry.id)),
    accent: z.boolean(),
    interior: z.enum(INTERIORS.map((entry) => entry.id)),
    floor: z.enum(FLOORS.map((entry) => entry.id)),
    mirror: z.boolean(),
  })
  .strict()

/** Retain inquiry choices separately in the UI; none has modeled multi-unit geometry. */
export const INQUIRY_ONLY_STUDIO_LAYOUTS = Object.freeze(
  STUDIO_LAYOUTS.filter((entry) => entry.id !== 'single'),
)

export const designConfigSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
    catalogVersion: z.literal(DESIGN_CATALOG_VERSION),
    product: productSchema,
    structure: structureSchema,
    appearance: appearanceSchema,
    arrangementRef: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const { structure, product } = value
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message })
    if (structure.kind !== product.family)
      issue(['structure', 'kind'], 'Structure must match the product family.')
    if (value.arrangementRef !== arrangementFor(product.family, product.lengthFt).id)
      issue(
        ['arrangementRef'],
        'The fixed arrangement must match the family, size and draft catalog.',
      )
    for (const addon of structure.addons) {
      const authority = ADDONS.find((entry) => entry.id === addon)!
      if (!(authority.families as readonly string[]).includes(structure.kind))
        issue(['structure', 'addons'], `${addon} is not modeled for ${structure.kind}.`)
    }
    if (product.family === 'container' && value.appearance.accent)
      issue(['appearance', 'accent'], 'The accent is modeled for Studio only.')
    if (
      structure.kind === 'container' &&
      structure.opening === 'roll-up' &&
      structure.infill !== 'none'
    )
      issue(
        ['structure', 'infill'],
        'The roll-up opening carries its own door; infill must be none.',
      )
  })

export const designEnvelopeSchema = z
  .object({
    config: designConfigSchema,
    presentation: presentationSchema,
    outputProfile: outputProfileSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!hasOperableDoor(value.config.structure) && value.presentation.doorPose !== 'closed')
      context.addIssue({
        code: 'custom',
        path: ['presentation', 'doorPose'],
        message: 'An open side has no operable door; use the neutral closed pose.',
      })
  })

type DeepReadonly<T> = T extends readonly (infer V)[]
  ? readonly DeepReadonly<V>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T
export type DesignConfig = DeepReadonly<z.infer<typeof designConfigSchema>>
export type DesignEnvelope = DeepReadonly<z.infer<typeof designEnvelopeSchema>>
export type DesignStructure = DesignEnvelope['config']['structure']
export type DesignAppearance = DesignEnvelope['config']['appearance']

export function freezeDesignValue<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => freezeDesignValue(entry))
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}
export function hasOperableDoor(structure: DesignStructure): boolean {
  return (
    structure.kind === 'studio' || structure.opening === 'roll-up' || structure.infill !== 'none'
  )
}
export function parseDesign(input: unknown): DesignEnvelope {
  return freezeDesignValue(designEnvelopeSchema.parse(input))
}
export function defaultDesign(
  product: unknown = { family: 'studio', lengthFt: 20 },
): DesignEnvelope {
  const parsed = productSchema.parse(product)
  return parseDesign({
    config: {
      schemaVersion: DESIGN_SCHEMA_VERSION,
      catalogVersion: DESIGN_CATALOG_VERSION,
      product: parsed,
      structure:
        parsed.family === 'studio'
          ? { kind: 'studio', layout: 'single', door: 'hinged', addons: [], railing: 'glass' }
          : {
              kind: 'container',
              opening: 'roll-up',
              infill: 'none',
              integratedFinish: false,
              addons: [],
              railing: 'glass',
            },
      appearance: {
        finish: 'obsidian',
        accent: false,
        interior: 'gallery',
        floor: 'rubber',
        mirror: false,
      },
      arrangementRef: arrangementFor(parsed.family, parsed.lengthFt).id,
    },
    presentation: defaultPresentation(),
    outputProfile: 'web-hero',
  })
}
export function serializeDesign(input: unknown): string {
  return JSON.stringify(parseDesign(input))
}
export function deserializeDesign(raw: string): DesignEnvelope | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_SERIALIZED_DESIGN_BYTES) return null
  try {
    return parseDesign(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Advisory holds NEVER certify access/ceiling/engineering compatibility. */
export function designReviewHolds(input: unknown): readonly string[] {
  const design = parseDesign(input)
  const { product, structure } = design.config
  return Object.freeze([
    ...arrangementFor(product.family, product.lengthFt).reviewHolds,
    'All arrangements, looks, cameras and output profiles are DRAFT; no product, rights or spend approval.',
    'Door sweeps, openings and overhead clearance have not been approved for the fixed arrangement.',
    'Named look recipes and camera mappings are preview interpretations, not calibrated art or exact imagery.',
    ...(structure.addons.length
      ? ['Additions show concept geometry only; dimensions, access and engineering are by inquiry.']
      : []),
    ...(structure.addons.includes('stairs') && !structure.addons.includes('roof')
      ? [
          'Stairs without a rooftop deck remain a concept option; access/structure compatibility requires review.',
        ]
      : []),
  ])
}
export function designProductionGate(input: unknown) {
  const design = parseDesign(input)
  return freezeDesignValue({
    allowed: false as const,
    paidExecutionAllowed: false as const,
    reason: 'provisional-catalog-production-denied' as const,
    catalogVersion: design.config.catalogVersion,
    reviewHolds: designReviewHolds(design),
  })
}

/**
 * Deliberate one-way projection for a preview/scene adapter ONLY, never persistence or migration.
 * Every v3 field is assigned explicitly: no legacy defaults can silently add equipment/options.
 * Look owns time/fixtures; camera/aspect/profile remain in the envelope, not the legacy Config.
 */
export function projectDesignToConfig(input: unknown): Config {
  const { config, presentation } = parseDesign(input)
  const { product, structure, appearance } = config
  const look = resolveLook(presentation.lookRef)
  const value: Config = {
    v: 3,
    family: product.family,
    length: product.lengthFt,
    containerOpening: structure.kind === 'container' ? structure.opening : 'roll-up',
    openingInfill: structure.kind === 'container' ? structure.infill : 'none',
    integratedFinish: structure.kind === 'container' ? structure.integratedFinish : false,
    studioLayout: 'single',
    studioDoor: structure.kind === 'studio' ? structure.door : 'hinged',
    doorsOpen: presentation.doorPose === 'open',
    finish: appearance.finish,
    accent: appearance.accent,
    addons: {
      deck: structure.addons.includes('deck'),
      gazebo: structure.addons.includes('gazebo'),
      roof: structure.addons.includes('roof'),
      stairs: structure.addons.includes('stairs'),
      canopy: structure.addons.includes('canopy'),
    },
    railing: structure.railing,
    interiorStyle: appearance.interior,
    flooring: appearance.floor,
    mirror: appearance.mirror,
    package: 'custom',
    items: arrangementFor(product.family, product.lengthFt).items.map((item) => ({ ...item })),
    environment: look.preview.environment,
    time: look.preview.time,
    lights: look.preview.lights,
  }
  return configSchema.parse(value)
}

/** Trusted logical input to a future adapter, NOT a render authorization or artifact identity. */
export function resolveDesignManifest(input: unknown) {
  const design = parseDesign(input)
  const arrangement = arrangementFor(design.config.product.family, design.config.product.lengthFt)
  return freezeDesignValue({
    contract: 'fury.resolved-design' as const,
    contractVersion: 1 as const,
    design,
    catalogVersions: {
      design: DESIGN_CATALOG_VERSION,
      arrangement: ARRANGEMENT_CATALOG_VERSION,
      presentation: PRESENTATION_CATALOG_VERSION,
    },
    units: 'feet' as const,
    geometryStatus: 'single-unit-concept-only' as const,
    arrangement: {
      ref: arrangement.id,
      approval: arrangement.approval,
      items: arrangement.items.map((item) => ({
        ...item,
        dimensions: arrangementEquipment(item.sku),
      })),
    },
    look: resolveLook(design.presentation.lookRef),
    camera: resolveCamera(design.presentation.cameraRef),
    outputProfile: { id: design.outputProfile, version: 1, approval: 'draft' as const },
    renderBinding: {
      status: 'unbound' as const,
      assetManifestDigest: null,
      rendererBuild: null,
      artifactDigest: null,
    },
    productionGate: designProductionGate(design),
  })
}
export type ResolvedDesignManifest = ReturnType<typeof resolveDesignManifest>
