import type { Config } from '../lib/config'
import type { AngleId } from '../lib/cameras'
import type { LayerKind } from '../lib/stills'
import type { Quality } from '../render/quality'

/**
 * One still layer for the headless harness (`?render`) to draw. Shared by the page and the Node
 * render worker that drives it.
 */
export type RenderJob = {
  id: string
  config: Config
  angle: AngleId
  kind: LayerKind
  /** Canvas size in CSS pixels; the image is `width * scale` by `height * scale`. */
  width: number
  height: number
  /** Supersampling: rendered above the published size and downscaled by the worker. */
  scale: number
  quality: Quality
  /** Frames accumulated after the scene is ready, for temporal AA, AO, and GI to converge. */
  frames: number
}

/**
 * The harness's answer: PNG data URLs. Layers with a see-through region also return two matte
 * renders, linear and untone-mapped, with a black and then a mid-grey backstop filling the room;
 * their difference is the transmittance through the glazing or opening at each pixel.
 */
export type RenderCapture = {
  color: string
  matteBlack?: string
  matteGrey?: string
  backend: 'webgpu' | 'webgl2'
  ms: number
}

/** The backstop's grey level in the second matte (kept below 1 so reflections never clip). */
export const MATTE_GREY = 0.5

export type HarnessState = 'booting' | 'idle' | 'loading' | 'accumulating' | 'error'

export type HarnessApi = {
  state: HarnessState
  error?: string
  backend?: 'webgpu' | 'webgl2'
  run: (job: RenderJob) => Promise<RenderCapture>
  /** What a job is waiting for, for diagnosing a render that never finishes. */
  debug?: () => unknown
}

declare global {
  interface Window {
    __fury?: HarnessApi
  }
}
