import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react'
import { bakedRevision, bakedStill, onBakedChange, type BakedStill } from '../lib/bakedStills'
import { DEFAULT_CAMERA } from '../lib/config'
import { bench } from '../render/bench'
import { angleKey, galleryAngle, type AngleId, type AspectClass } from '../render/gallery'
import type { StillsSnapshot } from '../render/stillStatus'
import { initialStage, showsWanted, stageReducer, type Layer } from './stillStageState'

/** The one crossfade a new still makes. */
export const FADE_MS = 450

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
const subscribeMotion = (listener: () => void) => {
  reducedMotion?.addEventListener('change', listener)
  return () => reducedMotion?.removeEventListener('change', listener)
}
const prefersReduced = () => reducedMotion?.matches ?? false

/** Whether the visitor asked for less motion: crossfades become cuts, rings stand still. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribeMotion, prefersReduced, () => false)
}

/** A baked still as a layer of the stage, for the design and angle it shows. */
const bakedLayer = (baked: BakedStill | null, design: string, angle: AngleId): Layer | null =>
  baked && {
    design,
    angle,
    tier: baked.tier,
    url: baked.url,
    srcset: baked.srcset,
    sizes: baked.sizes,
    samples: baked.samples,
  }

/**
 * The baked still (bakedStills.ts) of a design at an angle and stage shape, or null; looked up
 * again when one fails to load. A lookup of a small table: cheap on every render.
 */
export function useBakedStill(
  design: string,
  angle: AngleId,
  aspect: AspectClass,
  hero: [number, number, number] = DEFAULT_CAMERA,
) {
  useSyncExternalStore(onBakedChange, bakedRevision)
  return bakedStill(design, angleKey(angle, hero), aspect)
}

/**
 * The gallery stage's state: which still is on screen, which one is decoding to replace it, and
 * whether the live canvas under them is covered. `design` is the visitor's (stillKey.ts
 * configKey), `snapshot` what the 3D view has rendered (stillStatus.ts), and `hero` the direction
 * of the front three-quarter view (gallery.ts angleKey). A baked still of the design is taken at
 * once, as the top tier: on the page's first render it is on the stage already, before anything
 * of the 3D view has loaded. `instant` swaps without a crossfade: something else covers the stage
 * and makes the one visible transition.
 */
export function useStillStage({
  design,
  angle,
  aspect,
  hero,
  snapshot,
  instant = false,
}: {
  design: string
  angle: AngleId
  aspect: AspectClass
  hero?: [number, number, number]
  snapshot: StillsSnapshot
  instant?: boolean
}) {
  // A still is of one stage shape: the other shape's is another still.
  const wanted = `${design}|${aspect}`
  const baked = useBakedStill(design, angle, aspect, hero)
  const [state, dispatch] = useReducer(stageReducer, null, () =>
    initialStage({ design: wanted, angle }, bakedLayer(baked, wanted, angle)),
  )
  const reduced = useReducedMotion()
  useEffect(() => dispatch({ type: 'want', design: wanted, angle }), [wanted, angle])
  // Offered once for each baked still (the lookup is a new object on every render).
  const bakedUrl = baked?.url
  const bakedSrcset = baked?.srcset
  const bakedSizes = baked?.sizes
  const bakedTier = baked?.tier
  const bakedSamples = baked?.samples
  useEffect(() => {
    if (!bakedUrl || !bakedTier) return
    dispatch({
      type: 'offer',
      layer: {
        design: wanted,
        angle,
        tier: bakedTier,
        url: bakedUrl,
        srcset: bakedSrcset,
        sizes: bakedSizes,
        samples: bakedSamples,
      },
    })
  }, [bakedUrl, bakedSrcset, bakedSizes, bakedTier, bakedSamples, wanted, angle])
  const ready = snapshot.design === design && snapshot.aspect === aspect
  const offered = ready ? snapshot.images[angle]?.still : undefined
  const offeredUrl = offered?.url
  const offeredTier = offered?.tier
  const offeredSamples = offered?.samples
  useEffect(() => {
    if (!offeredUrl || !offeredTier) return
    dispatch({
      type: 'offer',
      layer: { design: wanted, angle, tier: offeredTier, url: offeredUrl, samples: offeredSamples },
    })
  }, [offeredUrl, offeredTier, offeredSamples, wanted, angle])
  // The page's first still, baked, is on the stage once it has decoded.
  const wasLoading = useRef(state.loading)
  useEffect(() => {
    if (wasLoading.current && !state.loading && state.shown) bench.mark('firstStill')
    wasLoading.current = state.loading
  }, [state.loading, state.shown])
  // One crossfade per swap; with reduced motion, or under something covering the stage, a cut.
  const cut = reduced || instant
  useEffect(() => {
    if (!state.fading) return
    if (state.swaps === 1) bench.mark('firstStill')
    const swap = state.swaps
    const timer = setTimeout(() => dispatch({ type: 'faded', swap }), cut ? 0 : FADE_MS)
    return () => clearTimeout(timer)
  }, [state.fading, state.swaps, cut])
  return {
    state,
    dispatch,
    /** The stage shows the visitor's design at their angle. */
    current: showsWanted(state),
    /**
     * A still covers the canvas entirely: nothing of the live view shows. The first still fades
     * in over the live view; any later one over the still it replaces, which stays whole under it.
     * The page's first, baked, covers it while it loads too (the stage shows its loading
     * treatment meanwhile), so no live frame comes before it.
     */
    covered: state.shown !== null && (!state.fading || state.leaving !== null),
    /** A still is on screen, whole: not the page's first while it is still loading. */
    visible: state.shown !== null && !state.loading,
  }
}

/** The words for a still's alternative text: "front three-quarter view". */
export const stillLabel = (angle: AngleId) =>
  `Path-traced still of your gym: ${galleryAngle(angle).phrase.replace(/^the /, '')}`
