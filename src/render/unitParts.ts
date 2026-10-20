import type { Config } from '../lib/config'
import { canopy, deck, pergola, roofDeck, stairs, timberAccent } from './addons'
import {
  containerInterior,
  containerShell,
  studioGlazing,
  studioInterior,
  studioShell,
} from './architecture'
import type { Part } from './parts'

/**
 * The unit's part lists, as StudioModel renders them: each built from the design, rebuilt only
 * when the inputs its key names change, and merged into a few meshes per material (Parts). One
 * table for the model and for the stills' prefetch (siblings.ts), which builds a design the
 * visitor has not chosen from the same lists to learn what a click on it would change.
 */
export type UnitList = {
  name: string
  /**
   * Where it sits: seen from both sides (the shell and its glazing: an edit there costs the
   * stills outside and inside), in the room (only the interior's), or outside alone.
   */
  scope: 'shared' | 'interior' | 'outside'
  build: (c: Config) => Part[]
  /** The inputs it is built from: rebuilt when this changes. */
  key: (c: Config) => string
  shown: (c: Config) => boolean
}

const shellKey = (c: Config) =>
  `${c.family}|${c.length}|${c.finish}|${c.containerOpening}|${c.integratedFinish}`
const openingKey = (c: Config) => `${shellKey(c)}|${c.openingInfill}|${c.doorsOpen}|${c.studioDoor}`
const studio = (c: Config) => c.family === 'studio'
const always = () => true

export const UNIT_LISTS: readonly UnitList[] = [
  {
    name: 'shell',
    scope: 'shared',
    build: (c) => (studio(c) ? studioShell(c) : containerShell(c)),
    key: openingKey,
    shown: always,
  },
  {
    name: 'glazing',
    scope: 'shared',
    build: (c) => (studio(c) ? studioGlazing(c) : []),
    key: openingKey,
    shown: always,
  },
  {
    name: 'interior',
    scope: 'interior',
    build: (c) => (studio(c) ? studioInterior(c) : containerInterior(c)),
    key: (c) => `${shellKey(c)}|${c.flooring}|${c.interiorStyle}|${c.openingInfill}`,
    shown: always,
  },
  {
    name: 'accent',
    scope: 'outside',
    build: timberAccent,
    key: shellKey,
    shown: (c) => studio(c) && c.accent,
  },
  {
    name: 'deck',
    scope: 'outside',
    build: deck,
    key: (c) => `${shellKey(c)}|${c.lights}`,
    shown: (c) => c.addons.deck,
  },
  {
    name: 'pergola',
    scope: 'outside',
    build: pergola,
    key: shellKey,
    shown: (c) => studio(c) && c.addons.gazebo,
  },
  {
    name: 'roof',
    scope: 'outside',
    build: roofDeck,
    key: (c) => `${shellKey(c)}|${c.addons.stairs}|${c.railing}`,
    shown: (c) => c.addons.roof,
  },
  {
    name: 'stairs',
    scope: 'outside',
    build: stairs,
    key: (c) => `${shellKey(c)}|${c.railing}`,
    shown: (c) => c.addons.stairs,
  },
  {
    name: 'canopy',
    scope: 'outside',
    build: canopy,
    key: (c) => `${shellKey(c)}|${c.addons.roof}|${c.lights}`,
    shown: (c) => !studio(c) && c.addons.canopy,
  },
]
