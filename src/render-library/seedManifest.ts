import { z } from 'zod'
import { designEnvelopeSchema, serializeDesign } from '../domain/design.js'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
export const nativeEntrySchema = z.object({
  id: z.string().regex(/^design-\d{2}-[1-8]$/),
  configId: z.string().regex(/^design-\d{2}$/),
  design: designEnvelopeSchema,
  requestKey: sha256,
  imageSha256: sha256,
  imageBytes: z
    .number()
    .int()
    .min(1000)
    .max(8 * 1024 * 1024),
  recipeDigest: sha256,
  manifestSha256: sha256,
  workerSha256: sha256,
  width: z.literal(1920),
  height: z.literal(1200),
  samples: z.literal(1024),
  renderSeconds: z.number().nonnegative().max(1800),
  productionAllowed: z.literal(false),
  visuallyQualified: z.literal(false),
  strictReference: z.literal(false),
})
export const nativeLibrarySchema = z
  .object({
    version: z.literal(1),
    revision: sha256,
    renderer: z.literal('Blender 4.5.0 / Cycles OptiX / NVIDIA L40S'),
    entries: z.array(nativeEntrySchema).min(1).max(400),
  })
  .superRefine(({ entries }, context) => {
    if (
      new Set(entries.map((entry) => entry.requestKey)).size !== entries.length ||
      new Set(entries.map((entry) => serializeDesign(entry.design))).size !== entries.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate image request in library.' })
  })
export type NativeEntry = z.infer<typeof nativeEntrySchema>
export type NativeLibrary = z.infer<typeof nativeLibrarySchema>
