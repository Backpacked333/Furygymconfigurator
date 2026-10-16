import { useEffect, useReducer, useSyncExternalStore } from 'react'
import { bench } from '../render/bench'
import { galleryAngle, type AngleId, type AspectClass } from '../render/gallery'
import type { StillsSnapshot } from '../render/stillStatus'
import { EMPTY_STAGE, showsWanted, stageReducer } from './stillStageState'

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

/**
 * The gallery stage's state: which still is on screen, which one is decoding to replace it, and
 * whether the live canvas under them is covered. `design` is the visitor's (stillKey.ts
 * configKey), `snapshot` what the 3D view has rendered (stillStatus.ts). `instant` swaps without
 * a crossfade: something else covers the stage and makes the one visible transition.
 */
export function useStillStage({
  design,
  angle,
  aspect,
  snapshot,
  instant = false,
}: {
  design: string
  angle: AngleId
  aspect: AspectClass
  snapshot: StillsSnapshot
  instant?: boolean
}) {
  const [state, dispatch] = useReducer(stageReducer, EMPTY_STAGE)
  const reduced = useReducedMotion()
  // A still is of one stage shape: the other shape's is another still.
  const wanted = `${design}|${aspect}`
  useEffect(() => dispatch({ type: 'want', design: wanted, angle }), [wanted, angle])
  const ready = snapshot.design === design && snapshot.aspect === aspect
  const offered = ready ? snapshot.images[angle]?.still : undefined
  const offeredUrl = offered?.url
  const offeredTier = offered?.tier
  useEffect(() => {
    if (!offeredUrl || !offeredTier) return
    dispatch({
      type: 'offer',
      layer: { design: wanted, angle, tier: offeredTier, url: offeredUrl },
    })
  }, [offeredUrl, offeredTier, wanted, angle])
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
     */
    covered: state.shown !== null && (!state.fading || state.leaving !== null),
  }
}

/** The words for a still's alternative text: "front three-quarter view". */
export const stillLabel = (angle: AngleId) =>
  `Path-traced still of your gym: ${galleryAngle(angle).phrase.replace(/^the /, '')}`
