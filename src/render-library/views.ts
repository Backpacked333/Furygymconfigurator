import { hasOperableDoor, parseDesign, type DesignEnvelope } from '../domain/design.js'
import {
  CUSTOMER_CAMERA_REFS,
  type CameraRef,
  type CustomerCameraRef,
} from '../domain/presentation.js'

export { CUSTOMER_CAMERAS, CUSTOMER_CAMERA_REFS } from '../domain/presentation.js'
export type { CustomerCameraRef } from '../domain/presentation.js'

export const CUSTOMER_ANGLES = ['front-left', 'front', 'left', 'rear-left', 'entry'] as const
export type CustomerAngle = (typeof CUSTOMER_ANGLES)[number]

export function customerCamera(ref: CameraRef): CustomerCameraRef {
  if (ref === 'top-draft@1') return 'front-left-draft@1'
  if (ref === 'centre-draft@1') return 'entry-draft@1'
  return ref
}

/** Customer presentation policy; historical parsers and saved source bytes remain unchanged. */
export function normalizeCustomerDesign(input: unknown): DesignEnvelope {
  const design = parseDesign(input)
  return parseDesign({
    ...design,
    presentation: {
      ...design.presentation,
      doorPose:
        design.config.product.family === 'container' && hasOperableDoor(design.config.structure)
          ? 'open'
          : design.presentation.doorPose,
      cameraRef: customerCamera(design.presentation.cameraRef),
      lookRef:
        design.presentation.lookRef === 'studio-neutral-draft@1'
          ? 'studio-day-draft@1'
          : design.presentation.lookRef,
    },
  })
}

export function customerAngle(angle: string): CustomerAngle {
  if (angle === 'centre' || angle === 'back') return 'entry'
  if (angle === 'rear') return 'rear-left'
  return CUSTOMER_ANGLES.includes(angle as CustomerAngle) ? (angle as CustomerAngle) : 'front-left'
}

export const INTERIOR_CAMERA_REF = 'entry-draft@1' as const
export const INTERIOR_KEYING = 'interior-visible@1' as const
export const VIEW_KEYING = 'camera-visible@1' as const

/**
 * The interior view is keyed only by what the room camera can see: family, size, interior wall,
 * floor, mirror, the Studio door or Container opening/infill/integrated finish, scene, door pose
 * and aspect. Exterior-only choices (finish, accent, additions, railing) collapse to one neutral
 * representative so an exterior-only change reuses the saved interior image.
 */
export function interiorDesign(input: unknown): DesignEnvelope {
  const design = parseDesign(input)
  return parseDesign({
    ...design,
    config: {
      ...design.config,
      structure: { ...design.config.structure, addons: [], railing: 'glass' },
      appearance: { ...design.config.appearance, finish: 'obsidian', accent: false },
    },
    presentation: { ...design.presentation, cameraRef: INTERIOR_CAMERA_REF },
  })
}

/**
 * Canonical photographic representatives, not a claim that hidden surfaces never bounce light.
 * Outdoor scenery and add-ons can reflect the room, so those rear views retain every room choice.
 * Front/side glass and openings also retain the room. See docs/render-library-contract.md.
 */
export function viewDesign(input: unknown, cameraRef: CameraRef): DesignEnvelope {
  const design = parseDesign(input)
  if (cameraRef === INTERIOR_CAMERA_REF) return interiorDesign(design)
  const { structure, appearance } = design.config
  const hasRailing = structure.addons.includes('roof') || structure.addons.includes('stairs')
  const canonicalRoom =
    cameraRef === 'rear-left-draft@1' &&
    structure.addons.length === 0 &&
    (design.presentation.lookRef === 'studio-day-draft@1' ||
      design.presentation.lookRef === 'studio-night-draft@1')
  return parseDesign({
    ...design,
    config: {
      ...design.config,
      structure: { ...structure, railing: hasRailing ? structure.railing : 'glass' },
      appearance: canonicalRoom
        ? { ...appearance, interior: 'gallery', floor: 'rubber', mirror: false }
        : appearance,
    },
    presentation: { ...design.presentation, cameraRef },
  })
}

export function fiveViewDesigns(input: unknown): readonly DesignEnvelope[] {
  const design = parseDesign(input)
  return CUSTOMER_CAMERA_REFS.map((cameraRef) => viewDesign(design, cameraRef))
}
