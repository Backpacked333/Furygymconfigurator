import { parseDesign, projectDesignToConfig } from '../domain/design'
import { resolveCamera } from '../domain/presentation'
import { openingGeometry, productHeight } from '../lib/config'
import { FLOOR_Y, interiorBounds } from './envelope'
import { ASPECT_RATIO, composition, galleryCamera, type GalleryCamera } from './gallery'

/** Shared native-image/live-entry camera, without private capture or service dependencies. */
export function resolveNativeCamera(input: unknown) {
  const design = parseDesign(input)
  const config = projectDesignToConfig(design)
  const selected = resolveCamera(design.presentation.cameraRef)
  let camera: GalleryCamera
  if (selected.ref === 'entry-draft@1' && config.family === 'container') {
    const opening = openingGeometry(config)
    const fov = design.presentation.aspect === 'wide' ? 60 : 76
    const tanV = Math.tan((fov * Math.PI) / 360)
    const distance = Math.max(
      5,
      (opening.width * 0.6) / (tanV * ASPECT_RATIO[design.presentation.aspect]),
      (productHeight(config) * 0.6) / tanV,
    )
    camera = {
      position: [opening.center, FLOOR_Y + 4.5, 4 + distance],
      target: [opening.center, FLOOR_Y + 3.2, -2.5],
      fov,
    }
  } else if (selected.ref === 'entry-draft@1') {
    const bounds = interiorBounds(config)
    const candidates = [1, -1].map((side): GalleryCamera => ({
      position: [
        side * (bounds.halfWidth - 0.55),
        Math.min(FLOOR_Y + 5.6, bounds.ceiling - 0.8),
        bounds.front - 0.65,
      ],
      target: [0, FLOOR_Y + 3.2, bounds.back * 0.45],
      fov: design.presentation.aspect === 'wide' ? 64 : 86,
    }))
    const score = (view: GalleryCamera) => {
      const seen = composition(config, view, design.presentation.aspect)
      return seen.subject - 2 * seen.crowding - seen.intrusion - seen.empty
    }
    camera = candidates.sort((a, b) => score(b) - score(a))[0]
  } else camera = galleryCamera(config, selected.previewAngle, design.presentation.aspect)
  return {
    ...camera,
    up: [0, 1, 0] as [0, 1, 0],
    near: 0.1 as const,
    far: 2000 as const,
    units: 'feet' as const,
  }
}
