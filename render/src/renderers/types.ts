import type { RenderCapture, RenderJob } from '../../../src/render-harness/job'

export type { RenderCapture, RenderJob }

/**
 * Something that draws still layers. The WebGPU harness renderer is the first; a Blender Cycles
 * renderer can replace it behind this interface once CAD-derived models exist. Its `id` becomes
 * part of every key, so stills from different renderers never mix.
 */
export interface StillRenderer {
  readonly id: string
  init(): Promise<void>
  render(job: RenderJob): Promise<RenderCapture>
  close(): Promise<void>
}
