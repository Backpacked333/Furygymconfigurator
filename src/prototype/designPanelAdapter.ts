import type { ConfigPanelChange } from '../components/ConfigPanelView'
import { hasOperableDoor, type DesignEnvelope } from '../domain/design'
import { designActionSchema, type DesignAction } from '../domain/designTransitions'

/** Translate one supported visual-field intent, never diff or accept an edited projected Config.
 * Family/size/structure adjustments and confirmation remain the parent's domain transaction.
 */
export function designPanelAction(design: DesignEnvelope, change: ConfigPanelChange): DesignAction {
  const { product, structure } = design.config
  let action: DesignAction
  switch (change.field) {
    case 'family':
      action = { type: 'set-product', product: { ...product, family: change.value } }
      break
    case 'length':
      action = { type: 'set-product', product: { ...product, lengthFt: change.value } }
      break
    case 'studioDoor':
      if (structure.kind !== 'studio') throw new Error('Studio door requires a Studio design.')
      action = { type: 'update-structure', patch: { kind: 'studio', door: change.value } }
      break
    case 'containerOpening':
      if (structure.kind !== 'container')
        throw new Error('Container opening requires a Container design.')
      action = { type: 'update-structure', patch: { kind: 'container', opening: change.value } }
      break
    case 'openingInfill':
      if (structure.kind !== 'container' || structure.opening === 'roll-up')
        throw new Error('Separate infill requires an open-side Container design.')
      action = { type: 'update-structure', patch: { kind: 'container', infill: change.value } }
      break
    case 'integratedFinish':
      if (structure.kind !== 'container')
        throw new Error('Integrated finish requires a Container design.')
      action = {
        type: 'update-structure',
        patch: { kind: 'container', integratedFinish: change.value },
      }
      break
    case 'addon':
      action = {
        type: 'update-structure',
        patch: {
          kind: structure.kind,
          addons: structure.addons.includes(change.value)
            ? structure.addons.filter((id) => id !== change.value)
            : [...structure.addons, change.value],
        },
      }
      break
    case 'railing':
      action = { type: 'update-structure', patch: { kind: structure.kind, railing: change.value } }
      break
    case 'finish':
      action = { type: 'update-appearance', patch: { finish: change.value } }
      break
    case 'accent':
      if (structure.kind !== 'studio')
        throw new Error('The timber accent requires a Studio design.')
      action = { type: 'update-appearance', patch: { accent: change.value } }
      break
    case 'interiorStyle':
      action = { type: 'update-appearance', patch: { interior: change.value } }
      break
    case 'flooring':
      action = { type: 'update-appearance', patch: { floor: change.value } }
      break
    case 'mirror':
      action = { type: 'update-appearance', patch: { mirror: change.value } }
      break
    case 'doorsOpen':
      if (!hasOperableDoor(structure)) throw new Error('This open side has no operable door.')
      if (typeof change.value !== 'boolean') throw new Error('Door pose requires a boolean intent.')
      action = {
        type: 'update-presentation',
        patch: { doorPose: change.value ? 'open' : 'closed' },
      }
      break
    default: {
      const unsupported: never = change
      throw new Error(`Unsupported image-first panel field: ${JSON.stringify(unsupported)}`)
    }
  }
  return designActionSchema.parse(action)
}
