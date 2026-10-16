import type { AngleId } from '../render/gallery'
import { TIER_RANK, type Tier } from '../render/plan'

/**
 * What the gallery's stage shows, as a pure state machine, so its rules can be tested on their
 * own (StillStage.tsx drives it):
 *
 * - The stage holds a still until its replacement has decoded, then swaps once (one crossfade).
 * - A still is never replaced by a lesser tier of the same design and angle.
 * - Only what the visitor wants now is taken: an offer for a design or angle they have since left
 *   is ignored, and one decoding for it is dropped, so rapid edits end on the latest.
 */

/** A still on the stage, or on its way there. */
export type Layer = { design: string; angle: AngleId; tier: Tier; url: string }

export type StageState = {
  /** The design and angle the visitor wants on the stage. */
  want: { design: string; angle: AngleId } | null
  /** On screen (fading in while `fading`). */
  shown: Layer | null
  /** The still it replaced, fading out under it until `faded`. */
  leaving: Layer | null
  /** Decoding: swapped in once decoded, unless something better or newer comes first. */
  pending: Layer | null
  /** A swap's crossfade is under way. */
  fading: boolean
  /** Swaps so far: each one crossfade. */
  swaps: number
}

export type StageEvent =
  | { type: 'want'; design: string; angle: AngleId }
  | { type: 'offer'; layer: Layer }
  | { type: 'decoded'; url: string }
  | { type: 'failed'; url: string }
  /** The crossfade of swap number `swap` is over (one for an earlier swap is ignored). */
  | { type: 'faded'; swap: number }

export const EMPTY_STAGE: StageState = {
  want: null,
  shown: null,
  leaving: null,
  pending: null,
  fading: false,
  swaps: 0,
}

const sameShot = (
  a: { design: string; angle: AngleId } | null,
  b: { design: string; angle: AngleId } | null,
) => !!a && !!b && a.design === b.design && a.angle === b.angle

export function stageReducer(state: StageState, event: StageEvent): StageState {
  switch (event.type) {
    case 'want': {
      const want = { design: event.design, angle: event.angle }
      if (sameShot(state.want, want)) return state
      // A still decoding for what the visitor has left is no longer wanted.
      const pending = sameShot(state.pending, want) ? state.pending : null
      return { ...state, want, pending }
    }
    case 'offer': {
      const { layer } = event
      if (!sameShot(layer, state.want)) return state
      const { shown, pending } = state
      if (shown && shown.url === layer.url) {
        // The very image on screen, now named for this design (an edit it does not show):
        // nothing to fade.
        if (sameShot(shown, layer) && shown.tier === layer.tier) return state
        return { ...state, shown: layer, pending: null }
      }
      if (sameShot(shown, layer) && TIER_RANK[layer.tier] <= TIER_RANK[shown!.tier]) return state
      if (pending && sameShot(pending, layer)) {
        if (pending.url === layer.url) return state
        if (TIER_RANK[layer.tier] < TIER_RANK[pending.tier]) return state
      }
      return { ...state, pending: layer }
    }
    case 'decoded': {
      const { pending } = state
      if (!pending || pending.url !== event.url || !sameShot(pending, state.want)) return state
      return {
        ...state,
        shown: pending,
        leaving: state.shown,
        pending: null,
        fading: true,
        swaps: state.swaps + 1,
      }
    }
    case 'failed':
      return state.pending?.url === event.url ? { ...state, pending: null } : state
    case 'faded':
      if (event.swap !== state.swaps || (!state.fading && !state.leaving)) return state
      return { ...state, fading: false, leaving: null }
  }
}

/** Whether the stage shows what the visitor wants (a still of their design, at their angle). */
export const showsWanted = (state: StageState) => sameShot(state.shown, state.want)
