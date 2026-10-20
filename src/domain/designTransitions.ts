import { z } from 'zod'
import { ADDONS } from '../lib/config'
import { arrangementFor } from './arrangements'
import {
  appearanceSchema,
  containerStructureSchema,
  defaultDesign,
  designEnvelopeSchema,
  designReviewHolds,
  freezeDesignValue,
  hasOperableDoor,
  parseDesign,
  productSchema,
  serializeDesign,
  studioStructureSchema,
  type DesignEnvelope,
} from './design'
import { outputProfileSchema, presentationSchema } from './presentation'

export const designActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-product'), product: productSchema }).strict(),
  z
    .object({
      type: z.literal('update-structure'),
      patch: z.discriminatedUnion('kind', [
        studioStructureSchema.partial().required({ kind: true }),
        containerStructureSchema.partial().required({ kind: true }),
      ]),
    })
    .strict(),
  z.object({ type: z.literal('update-appearance'), patch: appearanceSchema.partial() }).strict(),
  z
    .object({ type: z.literal('update-presentation'), patch: presentationSchema.partial() })
    .strict(),
  z.object({ type: z.literal('set-output-profile'), outputProfile: outputProfileSchema }).strict(),
])
export type DesignAction = z.input<typeof designActionSchema>
export type DesignChange = Readonly<{ path: string; before: unknown; after: unknown }>

function differences(before: unknown, after: unknown, path = ''): DesignChange[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>
    const right = after as Record<string, unknown>
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .flatMap((key) => differences(left[key], right[key], path ? `${path}.${key}` : key))
  }
  return [
    {
      path,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
    },
  ]
}

/**
 * A proposal, not a mutation. `next` is not committed until applyDesignCommand succeeds.
 * Family/size and necessary option changes are one command/one history snapshot. Confirmation
 * acknowledges the explained change only, NEVER arrangement/engineering/production approval.
 */
export function transitionDesign(current: unknown, inputAction: unknown) {
  const previous = parseDesign(current)
  const action = designActionSchema.parse(inputAction)
  const candidate = designEnvelopeSchema.parse(previous)
  const adjustments: string[] = []
  let requiresConfirmation = false

  switch (action.type) {
    case 'set-product': {
      const familyChanged = action.product.family !== previous.config.product.family
      const sizeChanged = action.product.lengthFt !== previous.config.product.lengthFt
      if (familyChanged) {
        const structure = designEnvelopeSchema.parse(defaultDesign(action.product)).config.structure
        structure.addons = previous.config.structure.addons.filter((id) =>
          (ADDONS.find((entry) => entry.id === id)!.families as readonly string[]).includes(
            action.product.family,
          ),
        )
        structure.railing = previous.config.structure.railing
        const removed = previous.config.structure.addons.filter(
          (id) => !structure.addons.includes(id),
        )
        if (removed.length)
          adjustments.push(
            `Removed options that only apply to the previous model: ${removed.join(', ')}.`,
          )
        if (previous.config.structure.kind === 'studio') {
          adjustments.push(
            `The Studio's ${previous.config.structure.door} door becomes the Container's roll-up opening.`,
          )
        } else {
          adjustments.push(
            'The Container opening becomes a glazed Studio front with a hinged door.',
          )
          if (candidate.presentation.doorPose === 'open') {
            candidate.presentation.doorPose = 'closed'
            adjustments.push(
              'Reset the Studio door to closed instead of carrying over the Container door pose.',
            )
          }
        }
        candidate.config.structure = structure
        if (action.product.family === 'container' && candidate.config.appearance.accent) {
          candidate.config.appearance.accent = false
          adjustments.push('Turned off the Studio-only accent for the Container.')
        }
      }
      if (familyChanged || sizeChanged) {
        candidate.config.product = action.product
        candidate.config.arrangementRef = arrangementFor(
          action.product.family,
          action.product.lengthFt,
        ).id
        adjustments.push(
          `Layout switches to the ${action.product.family === 'studio' ? 'Studio' : 'Container'} ${action.product.lengthFt} ft arrangement.`,
        )
        requiresConfirmation = true
      }
      break
    }
    case 'update-structure': {
      if (action.patch.kind !== candidate.config.structure.kind)
        throw new Error(
          'Change family through set-product; a structure patch cannot change family.',
        )
      if (action.patch.kind === 'studio' && candidate.config.structure.kind === 'studio') {
        candidate.config.structure = { ...candidate.config.structure, ...action.patch }
      } else if (
        action.patch.kind === 'container' &&
        candidate.config.structure.kind === 'container'
      ) {
        candidate.config.structure = { ...candidate.config.structure, ...action.patch }
        if (
          candidate.config.structure.opening === 'roll-up' &&
          candidate.config.structure.infill !== 'none' &&
          action.patch.infill === undefined
        ) {
          candidate.config.structure.infill = 'none'
          adjustments.push(
            'Remove the separate infill because the roll-up opening carries its own door.',
          )
        }
      }
      if (
        !hasOperableDoor(candidate.config.structure) &&
        candidate.presentation.doorPose === 'open'
      ) {
        candidate.presentation.doorPose = 'closed'
        adjustments.push(
          'Reset door pose to neutral closed: the selected open side has no door to operate.',
        )
      }
      // Structural changes need an explicit preview acknowledgement, not a compatibility approval.
      requiresConfirmation =
        JSON.stringify(previous.config.structure) !== JSON.stringify(candidate.config.structure)
      break
    }
    case 'update-appearance':
      candidate.config.appearance = { ...candidate.config.appearance, ...action.patch }
      break
    case 'update-presentation':
      candidate.presentation = { ...candidate.presentation, ...action.patch }
      break
    case 'set-output-profile':
      candidate.outputProfile = action.outputProfile
      break
  }
  const next = parseDesign(candidate)
  const changes = differences(previous, next)
  const changed = changes.length > 0
  return freezeDesignValue({
    previous,
    next,
    changed,
    changes,
    adjustments,
    requiresConfirmation: changed && (requiresConfirmation || adjustments.length > 0),
    explanation: changed
      ? 'Apply all listed changes together as one provisional design revision. Review holds are not resolved by confirmation.'
      : 'The design is unchanged.',
    warnings: designReviewHolds(next),
    command: {
      type: 'design-transition' as const,
      previous: serializeDesign(previous),
      action,
    },
  })
}
export type DesignTransition = ReturnType<typeof transitionDesign>
export type AtomicDesignCommand = DesignTransition['command']
const atomicDesignCommandSchema = z
  .object({
    type: z.literal('design-transition'),
    previous: z.string().max(16 * 1024),
    action: designActionSchema,
  })
  .strict()

/** Recomputes proposals and rejects stale confirmation/history races; never trusts supplied next state. */
export function applyDesignCommand(
  current: unknown,
  inputCommand: unknown,
  confirmed = false,
): DesignEnvelope {
  const command = atomicDesignCommandSchema.parse(inputCommand)
  const previous = parseDesign(current)
  if (command.previous !== serializeDesign(previous))
    throw new Error(
      'The design changed after this proposal. Review a fresh transition before applying it.',
    )
  const result = transitionDesign(previous, command.action)
  if (result.requiresConfirmation && confirmed !== true)
    throw new Error('This transition requires explicit confirmation of the listed option changes.')
  return result.next
}
