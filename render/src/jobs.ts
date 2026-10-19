import { STILL_ASPECT } from '../../src/lib/cameras'
import type { Layer } from '../../src/lib/stills'
import type { Quality } from '../../src/viewer/quality'
import type { RenderJob } from './renderers/types'

export type JobSettings = {
  quality: Quality
  /** Frames accumulated per layer. */
  frames: number
  /** Published width; rendered at `width * scale` and downscaled. */
  width: number
  scale: number
}

/** Published stills: Ultra, 2048 wide from a 1.5x supersampled render, 256 frames. */
export const PUBLISH: JobSettings = { quality: 'ultra', frames: 256, width: 2048, scale: 1.5 }

/** Settings from command-line strings, falling back to the published ones. */
export function settingsFrom(args: Partial<Record<keyof JobSettings, unknown>>): JobSettings {
  return {
    quality: (args.quality as Quality) ?? PUBLISH.quality,
    frames: Number(args.frames ?? PUBLISH.frames),
    width: Number(args.width ?? PUBLISH.width),
    scale: Number(args.scale ?? PUBLISH.scale),
  }
}

export function jobFor(layer: Layer, settings: JobSettings, id = layer.key): RenderJob {
  return {
    id,
    config: layer.config,
    angle: layer.angle,
    kind: layer.kind,
    width: settings.width,
    height: Math.round(settings.width / STILL_ASPECT),
    scale: settings.scale,
    quality: settings.quality,
    frames: settings.frames,
  }
}
