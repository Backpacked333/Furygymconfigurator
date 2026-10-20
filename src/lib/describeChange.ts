import {
  ADDONS,
  ENVIRONMENTS,
  FINISHES,
  FLOORS,
  INTERIORS,
  PACKAGES,
  RAILINGS,
  type Config,
} from './config'
import {
  CONTAINER_OPENINGS,
  OPENING_INFILLS,
  STUDIO_DOORS,
  STUDIO_LAYOUTS,
  productFamily,
} from './products'

/**
 * What an edit changed, in the words the status line uses ("Rendering Graphite"), and the option
 * it picked, so the swatch the visitor chose can show that its still is on its way.
 */
export type Change = {
  /** Reads after "Rendering": a name ("Graphite"), or a phrase ("the mirror wall"). */
  label: string
  /** The configuration field the visitor set, when one alone was; null otherwise. */
  field: keyof Config | null
  /** Its new value, as the panel's options name it. */
  value: string | null
}

const named = (list: readonly { id: string; name: string }[], id: string) =>
  list.find((option) => option.id === id)?.name ?? id

/** "4:30 pm" for 16.5. */
export function clockTime(time: number) {
  const hours = Math.floor(time)
  const minutes = Math.round((time - hours) * 60)
  const h = ((hours + 11) % 12) + 1
  return `${h}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'pm' : 'am'}`
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** How each field reads on its own when it is what changed. */
function label(field: keyof Config, next: Config, prev: Config): string {
  switch (field) {
    case 'family':
      return `the ${productFamily(next.family).shortName}`
    case 'length':
      return `the ${next.length} ft build`
    case 'finish':
      return named(FINISHES, next.finish)
    case 'accent':
      return 'the timber accent'
    case 'addons': {
      const toggled = ADDONS.find((addon) => next.addons[addon.id] !== prev.addons[addon.id])
      return toggled ? `the ${toggled.name.toLowerCase()}` : 'the additions'
    }
    case 'railing':
      return named(RAILINGS, next.railing)
    case 'interiorStyle':
      return named(INTERIORS, next.interiorStyle)
    case 'flooring':
      return named(FLOORS, next.flooring)
    case 'mirror':
      return 'the mirror wall'
    case 'package':
      return next.package === 'custom' ? 'your equipment' : named(PACKAGES, next.package)
    case 'items':
      return 'your equipment'
    case 'environment':
      return named(ENVIRONMENTS, next.environment)
    case 'time':
      return `the ${clockTime(next.time)} light`
    case 'lights':
      return 'the lighting'
    case 'doorsOpen':
      return next.doorsOpen ? 'the open doors' : 'the closed doors'
    case 'studioDoor':
      return named(STUDIO_DOORS, next.studioDoor)
    case 'containerOpening':
      return named(CONTAINER_OPENINGS, next.containerOpening)
    case 'openingInfill':
      return named(OPENING_INFILLS, next.openingInfill)
    case 'integratedFinish':
      return 'the integrated finish'
    case 'studioLayout':
      return named(STUDIO_LAYOUTS, next.studioLayout)
    default:
      return 'your design'
  }
}

/**
 * Describes the edit from `prev` to `next`. One field reads as its option's name; an interior
 * package (which sets its equipment too) as the package; a product family (which resets what
 * the other family lacks) as the family; anything wider, like a signature build, as "your
 * design". The first design of a page, with nothing before it, is "your gym".
 */
export function describeChange(prev: Config | null, next: Config): Change {
  if (!prev) return { label: 'your gym', field: null, value: null }
  const fields = (Object.keys(next) as (keyof Config)[]).filter((k) => !same(prev[k], next[k]))
  if (!fields.length) return { label: 'your gym', field: null, value: null }
  const only = (field: keyof Config): Change => ({
    label: label(field, next, prev),
    field,
    value: typeof next[field] === 'object' ? null : String(next[field]),
  })
  if (fields.includes('family')) return { ...only('family'), value: next.family }
  if (fields.length === 1) return only(fields[0])
  // Choosing a package lays out its equipment; adding equipment marks the package custom.
  if (fields.every((field) => field === 'package' || field === 'items')) return only('package')
  // A size change refits the equipment.
  if (fields.includes('length') && fields.every((f) => ['length', 'items', 'package'].includes(f)))
    return only('length')
  return { label: 'your design', field: null, value: null }
}
