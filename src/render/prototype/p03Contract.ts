import { z } from 'zod'
import { freezeDesignValue } from '../../domain/design'
// Same wire grammar as capture/contract.digestSchema; keep the shared recipe independent
// of the capture runtime (which itself consumes the recipe).
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** Private preparation handoff only. This is neither a renderer nor an admission protocol. */
export const P03_PREPARATION_PROTOCOL = 'fury.p03-private-preparation@1' as const
export const P03_REQUIRED_CONTROLS = Object.freeze([
  'arrangement',
  'structure',
  'finish',
  'interior',
  'floor',
  'mirror',
  'environment',
  'lightingLook',
  'doorPose',
  'camera',
  'aspect',
] as const)
export type P03Control = (typeof P03_REQUIRED_CONTROLS)[number]

export const P03_EXECUTION_POLICY = Object.freeze({
  mode: 'preparation-only',
  captureAllowed: false,
  paidExecutionAllowed: false,
  productionAllowed: false,
  referenceDispatchAllowed: false,
} as const)
export const p03ExecutionPolicySchema = z
  .object({
    mode: z.literal(P03_EXECUTION_POLICY.mode),
    captureAllowed: z.literal(false),
    paidExecutionAllowed: z.literal(false),
    productionAllowed: z.literal(false),
    referenceDispatchAllowed: z.literal(false),
  })
  .strict()

const noteSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    'Control characters are not allowed.',
  )
export const p03HoldSchema = z
  .object({
    gate: z.enum([
      'asset-rights',
      'product-approval',
      'art-quality',
      'renderer-conversion',
      'execution-authorization',
    ]),
    // An inventory ID or a descriptive scope, NEVER a path/URL to open or fetch.
    subject: noteSchema,
    reason: noteSchema,
  })
  .strict()
export type P03Hold = Readonly<z.infer<typeof p03HoldSchema>>

/**
 * Producer: provenance.validatePreparationAssets. Missing/unknown/changed bytes THROW;
 * only a fully verified inventory closure can produce this result. Rights holds are separate.
 * Parsing this shape does not verify bytes or confer rights; consumers must call the producer.
 */
export const p03AssetValidationSchema = z
  .object({
    contract: z.literal('fury.p03-asset-validation@1'),
    inventoryDigest: digestSchema,
    closureDigest: digestSchema,
    integrity: z.literal('verified'),
    rights: z.enum(['held', 'evidenced']),
    execution: p03ExecutionPolicySchema,
    holds: z.array(p03HoldSchema).min(1).max(20000),
  })
  .strict()
  .superRefine((value, context) => {
    const rightsHeld = value.holds.some((hold) => hold.gate === 'asset-rights')
    if (rightsHeld !== (value.rights === 'held'))
      context.addIssue({ code: 'custom', message: 'Rights status must agree with asset holds.' })
    if (!value.holds.some((hold) => hold.gate === 'execution-authorization'))
      context.addIssue({ code: 'custom', message: 'P03 execution remains unauthorized.' })
  })
export function parseP03AssetValidation(input: unknown) {
  return freezeDesignValue(p03AssetValidationSchema.parse(input))
}
export type P03AssetValidation = ReturnType<typeof parseP03AssetValidation>
