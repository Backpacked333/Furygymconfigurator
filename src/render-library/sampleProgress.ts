import { z } from 'zod'
import { cameraRefSchema, imageKeySchema, uuidSchema } from './contracts.js'

export const sampleProgressSchema = z
  .object({
    jobId: uuidSchema,
    attemptId: uuidSchema,
    fence: z.number().int().positive(),
    cameraRef: cameraRefSchema,
    imageKey: imageKeySchema,
    completed: z.number().int().min(0).max(1024),
    total: z.literal(1024),
    observedAt: z.iso.datetime(),
  })
  .strict()
export type SampleProgress = z.infer<typeof sampleProgressSchema>
export const sampleStatusSchema = z.object({ sample: sampleProgressSchema.nullable() }).strict()
