import { defaultDesign, freezeDesignValue, parseDesign, type DesignEnvelope } from './design'

/** Local experiment selection only; never changes domain defaults or the product catalog. */
export const LOCAL_RENDER_SAMPLE_IDS = [
  'studio-20-front-left-wide',
  'studio-20-bronze-front-left-wide',
] as const
export type LocalRenderSampleId = (typeof LOCAL_RENDER_SAMPLE_IDS)[number]

const baseline = defaultDesign({ family: 'studio', lengthFt: 20 })
export const LOCAL_RENDER_SAMPLES = freezeDesignValue([
  { id: LOCAL_RENDER_SAMPLE_IDS[0], design: baseline },
  {
    id: LOCAL_RENDER_SAMPLE_IDS[1],
    design: parseDesign({
      ...baseline,
      config: {
        ...baseline.config,
        appearance: { ...baseline.config.appearance, finish: 'bronze' },
      },
    }),
  },
] as const)

/** Invalid envelopes throw; valid but unsupported designs return null. No approximate matching. */
export function matchLocalRenderSample(input: unknown) {
  const design = parseDesign(input)
  // Strict parsing establishes deterministic property order and semantic-set addon order.
  const serialized = JSON.stringify(design)
  return LOCAL_RENDER_SAMPLES.find((sample) => JSON.stringify(sample.design) === serialized) ?? null
}

export function localRenderDesign(finish: 'obsidian' | 'bronze'): DesignEnvelope {
  const sample = LOCAL_RENDER_SAMPLES.find(
    (entry) => entry.design.config.appearance.finish === finish,
  )
  if (!sample) throw new Error('Only Obsidian (default charcoal) and Bronze are supported.')
  return sample.design
}
