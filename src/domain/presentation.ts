import { z } from 'zod'
import type { Config } from '../lib/config'

/** Proposals only. These scalar recipes are NOT a calibrated or approved content release. */
export const PRESENTATION_CATALOG_VERSION = 'fury-presentation-draft-1' as const
export const LOOK_REFS = [
  'courtyard-day-draft@1',
  'courtyard-night-draft@1',
  'campus-day-draft@1',
  'campus-night-draft@1',
  'desert-day-draft@1',
  'desert-night-draft@1',
  'studio-neutral-draft@1',
  'studio-day-draft@1',
  'studio-night-draft@1',
] as const
export const CAMERA_REFS = [
  'front-left-draft@1',
  'front-draft@1',
  'left-draft@1',
  'rear-left-draft@1',
  'top-draft@1',
  'entry-draft@1',
  'centre-draft@1',
] as const
export type LookRef = (typeof LOOK_REFS)[number]
export type CameraRef = (typeof CAMERA_REFS)[number]
export const SCENE_LANDSCAPES = Object.freeze([
  { id: 'residences', name: 'Residential courtyard' },
  { id: 'campus', name: 'Corporate campus' },
  { id: 'desert', name: 'Desert retreat' },
  { id: 'studio', name: 'Studio' },
] as const)
export type SceneLandscape = (typeof SCENE_LANDSCAPES)[number]['id']
export type SceneLighting = 'day' | 'night'
export type PreviewAngle =
  'front-left' | 'front' | 'left' | 'rear-left' | 'top' | 'entry' | 'centre'

function look(
  ref: LookRef,
  name: string,
  environment: Config['environment'],
  time: number,
  lights: boolean,
) {
  return Object.freeze({
    ref,
    version: 1 as const,
    catalogVersion: PRESENTATION_CATALOG_VERSION,
    name: `DRAFT — ${name}`,
    approval: 'draft' as const,
    productionAllowed: false as const,
    preview: Object.freeze({ environment, time, lights }),
    bindingStatus: 'unbound-assets-lighting-exposure' as const,
  })
}

export const DRAFT_LOOKS = Object.freeze([
  look(LOOK_REFS[0], 'Residential courtyard · day', 'residences', 16.5, true),
  look(LOOK_REFS[1], 'Residential courtyard · night', 'residences', 20.5, true),
  look(LOOK_REFS[2], 'Corporate campus · day', 'campus', 14, false),
  look(LOOK_REFS[3], 'Corporate campus · night', 'campus', 20.5, true),
  look(LOOK_REFS[4], 'Desert retreat · day', 'desert', 16, false),
  look(LOOK_REFS[5], 'Desert retreat · night', 'desert', 20.5, true),
  look(LOOK_REFS[7], 'Studio · day', 'studio', 12, true),
  look(LOOK_REFS[8], 'Studio · night', 'studio', 20.5, true),
])

const legacyStudio = look(LOOK_REFS[6], 'Neutral studio', 'studio', 12, true)

export function sceneSelection(ref: LookRef) {
  const selected = resolveLook(ref)
  return {
    landscape: selected.preview.environment as SceneLandscape,
    lighting: (selected.preview.time >= 20 ? 'night' : 'day') as SceneLighting,
  }
}

export function sceneLook(landscape: SceneLandscape, lighting: SceneLighting): LookRef {
  const found = DRAFT_LOOKS.find(
    (entry) =>
      entry.preview.environment === landscape && sceneSelection(entry.ref).lighting === lighting,
  )
  if (!found) throw new Error('Unsupported landscape or lighting.')
  return found.ref
}

function camera(
  ref: CameraRef,
  name: string,
  previewAngle: PreviewAngle,
  group: 'exterior' | 'interior',
) {
  return Object.freeze({
    ref,
    version: 1 as const,
    catalogVersion: PRESENTATION_CATALOG_VERSION,
    name: `DRAFT — ${name}`,
    group,
    previewAngle,
    approval: 'draft' as const,
    productionAllowed: false as const,
    // The scene adapter must bind actual pose/lens per family, size and aspect.
    bindingStatus: 'unbound-pose-lens-responsive-composition' as const,
  })
}

// Scalar IDs copied from render/gallery.ts; do not import renderer/framing into this authority.
export const DRAFT_CAMERAS = Object.freeze([
  camera(CAMERA_REFS[0], 'Front three-quarter', 'front-left', 'exterior'),
  camera(CAMERA_REFS[1], 'Front', 'front', 'exterior'),
  camera(CAMERA_REFS[2], 'Side', 'left', 'exterior'),
  camera(CAMERA_REFS[3], 'Rear three-quarter', 'rear-left', 'exterior'),
  camera(CAMERA_REFS[4], 'Elevated', 'top', 'exterior'),
  camera(CAMERA_REFS[5], 'Interior entry', 'entry', 'interior'),
  camera(CAMERA_REFS[6], 'Interior centre', 'centre', 'interior'),
])

/** Customer gallery only. Keep the full catalog above for historical designs and diagnostics. */
export const CUSTOMER_CAMERA_REFS = [
  'front-left-draft@1',
  'front-draft@1',
  'left-draft@1',
  'rear-left-draft@1',
  'entry-draft@1',
] as const
export type CustomerCameraRef = (typeof CUSTOMER_CAMERA_REFS)[number]
export const CUSTOMER_CAMERAS = Object.freeze(
  CUSTOMER_CAMERA_REFS.map((ref) => DRAFT_CAMERAS.find((entry) => entry.ref === ref)!),
)

export const presentationSchema = z
  .object({
    lookRef: z.enum(LOOK_REFS),
    doorPose: z.enum(['closed', 'open']),
    cameraRef: z.enum(CAMERA_REFS),
    aspect: z.enum(['wide', 'tall']),
  })
  .strict()
export type Presentation = Readonly<z.infer<typeof presentationSchema>>
export const outputProfileSchema = z.enum(['web-hero', 'web-thumbnail'])
export type OutputProfile = z.infer<typeof outputProfileSchema>
export const DRAFT_OUTPUT_PROFILES = Object.freeze([
  Object.freeze({ id: 'web-hero', version: 1, approval: 'draft', productionAllowed: false }),
  Object.freeze({ id: 'web-thumbnail', version: 1, approval: 'draft', productionAllowed: false }),
] as const)

export function parsePresentation(input: unknown): Presentation {
  return Object.freeze(presentationSchema.parse(input))
}
export function defaultPresentation(): Presentation {
  return parsePresentation({
    lookRef: 'studio-day-draft@1',
    doorPose: 'closed',
    cameraRef: CAMERA_REFS[0],
    aspect: 'wide',
  })
}
export function resolveLook(ref: unknown) {
  const parsed = z.enum(LOOK_REFS).parse(ref)
  if (parsed === legacyStudio.ref) return legacyStudio
  return DRAFT_LOOKS.find((entry) => entry.ref === parsed)!
}
export function resolveCamera(ref: unknown) {
  const parsed = z.enum(CAMERA_REFS).parse(ref)
  return DRAFT_CAMERAS.find((entry) => entry.ref === parsed)!
}
export function serializePresentation(input: unknown): string {
  return JSON.stringify(parsePresentation(input))
}
export function deserializePresentation(raw: string): Presentation | null {
  if (new TextEncoder().encode(raw).byteLength > 2048) return null
  try {
    return parsePresentation(JSON.parse(raw))
  } catch {
    return null
  }
}
