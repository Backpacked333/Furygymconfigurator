import type { RenderCapture, RenderJob, StillRenderer } from './types'

/**
 * Placeholder for path-traced stills from Blender Cycles, once Fury's CAD-derived glTF models
 * replace the procedural geometry. The plan: export each layer's scene to glTF from the same
 * builders, map the TSL material library to Principled BSDF, render with the same camera presets
 * and lighting moods, and return the same captures (color plus mattes). Its id ('cycles-…')
 * keys a separate set of stills, so switching renderers never mixes images.
 */
export class CyclesRenderer implements StillRenderer {
  readonly id = 'cycles-4'
  async init() {
    throw new Error('The Cycles renderer is not implemented yet.')
  }
  async render(job: RenderJob): Promise<RenderCapture> {
    throw new Error(`Cannot render ${job.id}: the Cycles renderer is not implemented yet.`)
  }
  async close() {}
}
