import { z } from 'zod'
import { designEnvelopeSchema, freezeDesignValue, type DesignEnvelope } from '../../domain/design'
import { digest, canonical } from './identity'
import { P03_EXECUTION_POLICY, p03ExecutionPolicySchema } from './p03Contract'

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const bindingSchema = z
  .object({
    preparationDigest: sha,
    rendererInputDigest: sha,
    assetValidationDigest: sha,
    geometryDigest: sha,
    materialDigest: sha,
    assetsDigest: sha,
    sourcesDigest: sha,
    lookDigest: sha,
    cameraDigest: sha,
  })
  .strict()
export type ReferenceCase = {
  id: string
  fixtureId: string
  view: string
  aspect: 'wide' | 'tall'
  design: DesignEnvelope
  compositionDigest: string
  binding: z.infer<typeof bindingSchema>
  exposure: number
}

export const STRICT_REFERENCE_SETTINGS = freezeDesignValue({
  renderer: 'Cycles',
  blenderVersion: '4.5.0',
  engineSelection: 'reference-only-not-display-engine-decision',
  requestedSamplesPerPixel: 1024,
  minimumCompletedSamplesPerPixel: 1024,
  adaptiveSampling: false,
  nativeTimeLimitSeconds: 0,
  externalTimeout: 'cancel-and-fail-never-publish-partial',
  partialSuccessAllowed: false,
  lowerTierFallbackAllowed: false,
  seed: 0,
  animatedSeed: false,
  bounces: { max: 6, diffuse: 6, glossy: 6, transmission: 6, volume: 0, transparent: 32 },
  clamp: { direct: 0, indirect: 10, glossyBlur: 0.5 },
  denoising: {
    method: 'OPENIMAGEDENOISE',
    device: 'CPU',
    passes: 'RGB_ALBEDO_NORMAL',
    prefilter: 'FAST',
    fallbackAllowed: false,
  },
  intermediate: {
    format: 'OPEN_EXR',
    color: 'RGBA',
    depth: 16,
    compression: 'NONE',
    viewTransform: 'Standard',
    look: 'None',
  },
  finishing: {
    source: 'render-server/fury_render/finishing.py',
    exposure: 'per-camera-bound',
    gain: 1,
    glow: true,
    transform: 'Three-style-AgX-to-sRGB',
  },
  resolutionPx: { wide: { width: 1920, height: 1200 }, tall: { width: 1200, height: 1500 } },
  resolutionApproval: false,
  acceptanceEvidence: [
    'verified-completed-samples',
    'exact-scene-source-asset-camera-identity',
    'independent-image-decode-and-hash',
    'no-fallback-or-truncation',
  ],
})

const referenceJobSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+--(?:front-left|entry|centre|top)--(?:wide|tall)$/),
    fixtureId: z.string().regex(/^[a-z0-9-]+$/),
    view: z.enum(['front-left', 'entry', 'centre', 'top']),
    aspect: z.enum(['wide', 'tall']),
    design: designEnvelopeSchema,
    compositionDigest: sha,
    scene: bindingSchema,
    exposure: z.number().finite().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sceneFile: z.string().regex(/^[a-z0-9-]+\.scene\.json$/),
    execution: p03ExecutionPolicySchema,
    jobDigest: sha,
  })
  .strict()

export const strictReferenceManifestSchema = z
  .object({
    contract: z.literal('fury.strict-reference-preparation@1'),
    status: z.literal('draft-blocked-not-dispatchable'),
    execution: p03ExecutionPolicySchema,
    // Exact comparison, including unknown/missing settings, forbids weakened strict profiles.
    settings: z.unknown().refine((value) => {
      try {
        return canonical(value) === canonical(STRICT_REFERENCE_SETTINGS)
      } catch {
        return false
      }
    }, 'Strict reference settings must match exactly.'),
    jobs: z.array(referenceJobSchema).length(28),
    holds: z.array(z.string().min(1)),
    manifestDigest: sha,
  })
  .strict()
export type StrictReferenceManifest = ReturnType<typeof createStrictReferenceManifest>

export function createStrictReferenceManifest(cases: readonly ReferenceCase[]) {
  if (cases.length !== 28 || new Set(cases.map((c) => c.id)).size !== 28)
    throw new Error('Strict references require exactly 28 unique prepared cases.')
  const jobs = cases.map((c) => {
    const body = {
      id: c.id,
      fixtureId: c.fixtureId,
      view: c.view,
      aspect: c.aspect,
      design: c.design,
      compositionDigest: c.compositionDigest,
      scene: bindingSchema.parse(c.binding),
      exposure: c.exposure,
      ...STRICT_REFERENCE_SETTINGS.resolutionPx[c.aspect],
      sceneFile: `${c.id}.scene.json`,
      execution: P03_EXECUTION_POLICY,
    }
    return { ...body, jobDigest: digest(body) }
  })
  const body = {
    contract: 'fury.strict-reference-preparation@1' as const,
    status: 'draft-blocked-not-dispatchable' as const,
    execution: P03_EXECUTION_POLICY,
    settings: STRICT_REFERENCE_SETTINGS,
    jobs,
    holds: [
      'Asset-rights and product/arrangement approvals in every prepared scene remain required.',
      'Draft resolution, denoising, bounce/clamp and finishing choices require art-direction review.',
      'Trusted Three reconstruction is not a Cycles payload: faithful geometry/material/sky/light/unit conversion and its digest are not implemented or qualified.',
      'Legacy Cycles enables adaptive sampling and time bounds; it must not execute this manifest without a strict adapter and completed-sample verification.',
      'Pin worker image, OCIO/OIDN/driver/device/font dependencies and lossless output encoding before execution.',
      'No engine execution, hardware allocation, spending or production authorization exists.',
    ],
  }
  const manifest = { ...body, manifestDigest: digest(body) }
  strictReferenceManifestSchema.parse(manifest)
  return freezeDesignValue(manifest)
}

/** Trusted cases must come from current configuration-only preparation, never from the input. */
export function validateStrictReferenceManifest(input: unknown, cases: readonly ReferenceCase[]) {
  strictReferenceManifestSchema.parse(input)
  const expected = createStrictReferenceManifest(cases)
  if (canonical(input) !== canonical(expected))
    throw new Error('Strict reference identity mismatch.')
  return expected
}
