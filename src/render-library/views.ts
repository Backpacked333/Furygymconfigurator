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

export function fiveViewDesigns(input: unknown): readonly DesignEnvelope[] {
  const design = parseDesign(input)
  return CUSTOMER_CAMERA_REFS.map((cameraRef) =>
    parseDesign({ ...design, presentation: { ...design.presentation, cameraRef } }),
  )
}
