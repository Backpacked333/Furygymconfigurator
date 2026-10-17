import type { Config } from '../lib/config'
import { configKey, stillKey } from '../lib/stillKey'
import type { CloudCamera } from './cloud'
import {
  ASPECT_RATIO,
  GALLERY_ANGLES,
  angleKey,
  galleryCamera,
  type AngleId,
  type AspectClass,
} from './gallery'
import { QUALITY, cloudCamera, stillSize } from './stills'

/**
 * The stills a bake renders for one design (lib/bake.ts, scripts/bake-stills.mjs): every gallery
 * angle at every stage shape asked for, at the export tier, from the cameras a visitor's stage
 * uses, each keyed from the design alone (stillKey.ts) so the stage finds it before any 3D has
 * loaded.
 */

/** A quick bake (`npm run bake:quick`): small stills at a few samples, for CI and e2e checks. */
export const QUICK_QUALITY = { samples: 64, threshold: 0, timeLimit: 30 }
export const QUICK_LONG_EDGE = 640

export type BakeJob = {
  angle: AngleId
  /** gallery.ts angleKey: the angle, with the hero direction for a non-default front ¾ view. */
  angleKey: string
  aspect: AspectClass
  part: 'exterior' | 'interior'
  /** The still's key: renderer version, the design's config key, angle key, stage shape. */
  key: string
  camera: CloudCamera
  width: number
  height: number
  quality: { samples: number; threshold: number; timeLimit: number }
}

/** A quick still's size: its long edge QUICK_LONG_EDGE, in the stage's shape. */
function quickSize(aspect: AspectClass) {
  const ratio = ASPECT_RATIO[aspect]
  return ratio >= 1
    ? { width: QUICK_LONG_EDGE, height: Math.round(QUICK_LONG_EDGE / ratio) }
    : { width: Math.round(QUICK_LONG_EDGE * ratio), height: QUICK_LONG_EDGE }
}

/** Every still to bake for a design, by stage shape, in filmstrip order. */
export function bakeJobs({
  config,
  hero,
  aspects,
  near,
  far,
  quick = false,
}: {
  config: Config
  /** The front three-quarter view's direction (DEFAULT_CAMERA, or a signature's). */
  hero: [number, number, number]
  aspects: readonly AspectClass[]
  /** The view camera's clipping planes, as the stills of a visit are rendered with. */
  near: number
  far: number
  quick?: boolean
}): BakeJob[] {
  const design = configKey(config)
  return aspects.flatMap((aspect) =>
    GALLERY_ANGLES.map(({ id, group }): BakeJob => {
      const key = angleKey(id, hero)
      return {
        angle: id,
        angleKey: key,
        aspect,
        part: group,
        key: stillKey(design, key, aspect),
        camera: cloudCamera(galleryCamera(config, id, aspect, hero), near, far),
        ...(quick
          ? quickSize(aspect)
          : stillSize('export', aspect, { width: 1, height: 1, dpr: 1 })),
        quality: quick ? QUICK_QUALITY : QUALITY.export,
      }
    }),
  )
}
