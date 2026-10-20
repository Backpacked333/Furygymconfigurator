import { useSyncExternalStore } from 'react'
import { ENVIRONMENTS, FINISHES, FLOORS, INTERIORS, layoutIssues, type Config } from '../lib/config'
import { CONTAINER_OPENINGS, OPENING_INFILLS, STUDIO_DOORS } from '../lib/products'

/**
 * What the visitor is choosing between, for the stills' prefetch (stills.ts): the option sections
 * the configuration panel shows, the one they last pointed at or focused, and the option there
 * they last pointed at. Its siblings (the design with that one option changed) are rendered ahead
 * at the current angle, so a click on one finds its still ready. Kept outside React state and free
 * of three.js imports, like stillStatus.ts: the panel writes it, the 3D view reads it.
 */

export type PrefetchField =
  | 'finish'
  | 'flooring'
  | 'interiorStyle'
  | 'environment'
  | 'studioDoor'
  | 'containerOpening'
  | 'openingInfill'

/**
 * Sections whose siblings differ from the design by surfaces alone, which the prefetch can
 * describe without re-rendering the scene (siblings.ts). The others change what is built, where
 * the camera stands, or the light, so their siblings are not prefetched.
 */
export const SURFACE_FIELDS: readonly PrefetchField[] = ['finish', 'flooring']

export type PrefetchIntent = {
  /** The sections the panel shows, top to bottom. */
  sections: readonly PrefetchField[]
  /** The section last pointed at or focused, or none. */
  focus: PrefetchField | null
  /** The option last pointed at or focused there. */
  boost: { field: PrefetchField; value: string } | null
}

const NOTHING: PrefetchIntent = { sections: [], focus: null, boost: null }
let intent = NOTHING
const listeners = new Set<() => void>()

function publish(next: PrefetchIntent) {
  if (
    next.focus === intent.focus &&
    next.boost?.field === intent.boost?.field &&
    next.boost?.value === intent.boost?.value &&
    next.sections.join() === intent.sections.join()
  )
    return
  intent = next
  listeners.forEach((listener) => listener())
}

/**
 * The panel shows these sections (a step of it opened); what was pointed at in the ones before is
 * forgotten. Returns the call that takes them away again.
 */
export function showSections(sections: readonly PrefetchField[]) {
  publish({ sections, focus: null, boost: null })
  return () => {
    if (intent.sections === sections) publish(NOTHING)
  }
}

/** The visitor pointed at or focused a section: its siblings are the ones prefetched. */
export function focusSection(field: PrefetchField) {
  if (intent.focus === field) return
  publish({ ...intent, focus: field, boost: intent.boost?.field === field ? intent.boost : null })
}

/** A section that was focused is gone (a popover closed). */
export function leaveSection(field: PrefetchField) {
  if (intent.focus === field) publish({ ...intent, focus: null, boost: null })
}

/** The visitor pointed at or focused an option: its still is prefetched first. */
export function boostOption(field: PrefetchField, value: string) {
  publish({ ...intent, focus: field, boost: { field, value } })
}

export const prefetchIntent = () => intent

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePrefetchIntent() {
  return useSyncExternalStore(subscribe, prefetchIntent, prefetchIntent)
}

/** Back to nothing shown (tests). */
export function resetPrefetchIntent() {
  publish(NOTHING)
}

/**
 * Whether this page prefetches at all: only from a cloud renderer (this device's tracer renders
 * the stage's still alone), never on Lite (a light device, or a slow one, keeps its GPU and its
 * data to itself), never while baking.
 */
export function prefetchOn(quality: string, cloud: boolean, bake: boolean) {
  return cloud && quality !== 'lite' && !bake
}

/**
 * The section whose siblings are prefetched: the one the visitor last pointed at, else the first
 * section shown whose siblings can be prefetched, else the first shown. One at a time.
 */
export function activeSection(state: PrefetchIntent): PrefetchField | null {
  return (
    state.focus ??
    state.sections.find((field) => SURFACE_FIELDS.includes(field)) ??
    state.sections[0] ??
    null
  )
}

/**
 * Each other option of a section, and the design a click on it makes, as the panel makes it (an
 * option the panel would turn away, one that blocks the planned entry, is left out); in panel
 * order. None for a section the design does not offer.
 */
export function siblingOptions(config: Config, field: PrefetchField) {
  const studio = config.family === 'studio'
  const set = (value: string, next: Config) => ({ value, config: next })
  let options: { value: string; config: Config }[]
  switch (field) {
    case 'finish':
      options = FINISHES.map((f) => set(f.id, { ...config, finish: f.id }))
      break
    case 'flooring':
      options = FLOORS.map((f) => set(f.id, { ...config, flooring: f.id }))
      break
    case 'interiorStyle':
      options = INTERIORS.map((f) => set(f.id, { ...config, interiorStyle: f.id }))
      break
    case 'environment':
      options = ENVIRONMENTS.map((f) => set(f.id, { ...config, environment: f.id }))
      break
    case 'studioDoor':
      options = studio ? STUDIO_DOORS.map((d) => set(d.id, { ...config, studioDoor: d.id })) : []
      break
    case 'containerOpening':
      options = studio
        ? []
        : CONTAINER_OPENINGS.map((o) =>
            set(o.id, {
              ...config,
              containerOpening: o.id,
              openingInfill: o.id === 'roll-up' ? 'none' : config.openingInfill,
            }),
          )
      break
    case 'openingInfill':
      options =
        studio || config.containerOpening === 'roll-up'
          ? []
          : OPENING_INFILLS.map((o) => set(o.id, { ...config, openingInfill: o.id }))
      break
  }
  return options.filter(
    (option) => option.value !== String(config[field]) && !layoutIssues(option.config).length,
  )
}

/**
 * The siblings to prefetch, most wanted first: the option last pointed at, then the others by
 * their distance in the panel from the one chosen, the next before the one before it.
 */
export function prefetchSiblings(config: Config, state: PrefetchIntent) {
  const field = activeSection(state)
  if (!field) return null
  const order = optionOrder(field)
  const at = order.indexOf(String(config[field]))
  const boosted = state.boost?.field === field ? state.boost.value : null
  const rank = (value: string) => {
    if (value === boosted) return -1
    const i = order.indexOf(value)
    return Math.abs(i - at) * 2 + (i > at ? 0 : 1)
  }
  const options = siblingOptions(config, field).sort((a, b) => rank(a.value) - rank(b.value))
  return { field, options }
}

/** A section's options in panel order. */
function optionOrder(field: PrefetchField): string[] {
  switch (field) {
    case 'finish':
      return FINISHES.map((f) => f.id)
    case 'flooring':
      return FLOORS.map((f) => f.id)
    case 'interiorStyle':
      return INTERIORS.map((f) => f.id)
    case 'environment':
      return ENVIRONMENTS.map((f) => f.id)
    case 'studioDoor':
      return STUDIO_DOORS.map((d) => d.id)
    case 'containerOpening':
      return CONTAINER_OPENINGS.map((o) => o.id)
    case 'openingInfill':
      return OPENING_INFILLS.map((o) => o.id)
  }
}
