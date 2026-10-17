import { describe, expect, it } from 'vitest'
import {
  EMPTY_STAGE,
  initialStage,
  showsWanted,
  stageReducer,
  type Layer,
  type StageEvent,
  type StageState,
} from './stillStageState'

const run = (events: StageEvent[], from: StageState = EMPTY_STAGE) =>
  events.reduce(stageReducer, from)
const layer = (
  design: string,
  tier: Layer['tier'] = 'still',
  angle: Layer['angle'] = 'front-left',
) => ({
  design,
  angle,
  tier,
  url: `blob:${design}-${angle}-${tier}`,
})
const want = (design: string, angle: Layer['angle'] = 'front-left'): StageEvent => ({
  type: 'want',
  design,
  angle,
})
const offer = (l: Layer): StageEvent => ({ type: 'offer', layer: l })
const decoded = (l: Layer): StageEvent => ({ type: 'decoded', url: l.url })

describe('the still stage', () => {
  it('holds the old still until the new one has decoded, then swaps once', () => {
    const a = layer('a')
    const b = layer('b')
    const shown = run([want('a'), offer(a), decoded(a), { type: 'faded', swap: 1 }])
    expect(shown.shown).toEqual(a)
    expect(shown.swaps).toBe(1)
    // An edit: the still of design a stays while b's renders and decodes.
    const editing = run([want('b')], shown)
    expect(editing.shown).toEqual(a)
    expect(showsWanted(editing)).toBe(false)
    const decoding = run([offer(b)], editing)
    expect(decoding.shown).toEqual(a)
    expect(decoding.pending).toEqual(b)
    const swapped = run([decoded(b)], decoding)
    expect(swapped).toMatchObject({ shown: b, leaving: a, fading: true, swaps: 2 })
    expect(showsWanted(swapped)).toBe(true)
    expect(run([{ type: 'faded', swap: 2 }], swapped)).toMatchObject({
      leaving: null,
      fading: false,
    })
  })

  it('never replaces a still with a lesser tier of the same design and angle', () => {
    const exported = layer('a', 'export')
    const state = run([want('a'), offer(exported), decoded(exported)])
    expect(run([offer(layer('a', 'still'))], state)).toBe(state)
    expect(run([offer(layer('a', 'thumb'))], state)).toBe(state)
    // A better tier does replace it.
    const still = run([want('a'), offer(layer('a')), decoded(layer('a'))])
    const better = run([offer(exported), decoded(exported)], still)
    expect(better.shown).toEqual(exported)
    expect(better.swaps).toBe(2)
    // And a lesser one offered while a better one decodes waits behind it.
    const decoding = run([want('a'), offer(exported)])
    expect(run([offer(layer('a'))], decoding).pending).toEqual(exported)
  })

  it('keeps the latest of rapid edits, ignoring stills of designs the visitor has left', () => {
    const state = run([want('a'), offer(layer('a')), decoded(layer('a'))])
    const rapid = run([want('b'), offer(layer('b')), want('c')], state)
    // b's still was decoding: dropped, and its late decode changes nothing.
    expect(rapid.pending).toBeNull()
    expect(run([decoded(layer('b'))], rapid).shown).toEqual(layer('a'))
    // An offer for b now is ignored; c's swaps in.
    expect(run([offer(layer('b'))], rapid).pending).toBeNull()
    const latest = run([offer(layer('c')), decoded(layer('c'))], rapid)
    expect(latest.shown).toEqual(layer('c'))
    expect(latest.swaps).toBe(2)
  })

  it('takes the very image on screen for a new design without a crossfade', () => {
    const a = layer('a')
    const state = run([want('a'), offer(a), decoded(a), { type: 'faded', swap: 1 }])
    // An edit inside the room seen from outside: the same still, now the new design's.
    const same = { ...a, design: 'b' }
    const next = run([want('b'), offer(same)], state)
    expect(next.shown).toEqual(same)
    expect(next.swaps).toBe(1)
    expect(next.fading).toBe(false)
    expect(showsWanted(next)).toBe(true)
  })

  it('follows the angle the visitor picks, and drops a failed decode', () => {
    const front = layer('a')
    const rear = layer('a', 'still', 'rear')
    const state = run([want('a'), offer(front), decoded(front), want('a', 'rear')])
    expect(run([offer(layer('a', 'still', 'top'))], state).pending).toBeNull()
    const failed = run([offer(rear), { type: 'failed', url: rear.url }], state)
    expect(failed.pending).toBeNull()
    expect(failed.shown).toEqual(front)
    expect(run([offer(rear), decoded(rear)], state).shown).toEqual(rear)
  })

  it('takes a baked still as the top tier: on the stage from the start, and never replaced', () => {
    const baked: Layer = {
      ...layer('a', 'export'),
      url: '/stills/v1/a/front-left-wide-640.webp',
      srcset:
        '/stills/v1/a/front-left-wide-320.webp 320w, /stills/v1/a/front-left-wide-640.webp 640w',
      sizes: '100vw',
    }
    // The page's first render: in place, out of sight until it has decoded, covering the stage.
    const first = initialStage({ design: 'a', angle: 'front-left' }, baked)
    expect(first).toMatchObject({ shown: baked, loading: true, pending: null, fading: false })
    expect(showsWanted(first)).toBe(true)
    // Its own offer, made once the stage is mounted, changes nothing.
    expect(run([want('a'), offer(baked)], first)).toBe(first)
    // Shown at once when decoded: no crossfade from nothing, and no swap counted.
    const shown = run([decoded(baked)], first)
    expect(shown).toMatchObject({ shown: baked, loading: false, fading: false, swaps: 0 })
    // A still or an export rendered for the same design and angle never replaces it.
    expect(run([offer(layer('a', 'still'))], shown)).toBe(shown)
    expect(run([offer(layer('a', 'export'))], shown)).toBe(shown)
    expect(run([offer(layer('a', 'thumb'))], shown)).toBe(shown)
    // Another design's baked still swaps in as any still does: decoded, then one crossfade.
    const next = { ...baked, design: 'b', url: '/stills/v1/b/front-left-wide-640.webp' }
    const swapped = run([want('b'), offer(next), decoded(next)], shown)
    expect(swapped).toMatchObject({ shown: next, leaving: baked, fading: true, swaps: 1 })
  })

  it('starts empty without a baked still of what the visitor wants, and drops one that fails', () => {
    expect(initialStage({ design: 'a', angle: 'front-left' }, null)).toEqual({
      ...EMPTY_STAGE,
      want: { design: 'a', angle: 'front-left' },
    })
    const other = layer('b', 'export')
    expect(initialStage({ design: 'a', angle: 'front-left' }, other).shown).toBeNull()
    const baked = layer('a', 'export')
    const first = initialStage({ design: 'a', angle: 'front-left' }, baked)
    // Gone from the store: the stage has no still, and the live view shows until one renders.
    expect(run([{ type: 'failed', url: baked.url }], first)).toMatchObject({
      shown: null,
      loading: false,
    })
    // Something else decoded first replaces it with no crossfade from an image never seen.
    const rendered = layer('a', 'still', 'rear')
    const moved = run([want('a', 'rear'), offer(rendered), decoded(rendered)], first)
    expect(moved).toMatchObject({ shown: rendered, leaving: null, loading: false })
  })

  it('ends a crossfade only for its own swap', () => {
    const a = layer('a')
    const b = layer('b')
    const state = run([want('a'), offer(a), decoded(a), want('b'), offer(b), decoded(b)])
    expect(state.swaps).toBe(2)
    expect(run([{ type: 'faded', swap: 1 }], state).fading).toBe(true)
    expect(run([{ type: 'faded', swap: 2 }], state).fading).toBe(false)
  })
})
