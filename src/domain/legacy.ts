import { configSchema, type PlacedItem } from '../lib/config'
import { arrangementFor } from './arrangements'

function equipmentSignature(items: readonly Readonly<PlacedItem>[]) {
  return JSON.stringify(
    items.map(({ sku, x, z, rotation }) => JSON.stringify([sku, x, z, rotation])).sort(),
  )
}

/** Equipment-only comparison. It never converts, saves or approves a legacy design. */
export function inspectLegacyEquipment(raw: string) {
  const original = Object.freeze({ format: 'json' as const, raw })
  const base = { original, readOnly: true as const, autoMigrate: false as const }
  if (raw.length > 16000) return Object.freeze({ ...base, status: 'too-large' as const })
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return Object.freeze({ ...base, status: 'unreadable' as const })
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('v' in value) ||
    ![1, 2, 3].includes(value.v as number)
  )
    return Object.freeze({ ...base, status: 'unsupported-version' as const })
  const parsed = configSchema.safeParse(value)
  if (!parsed.success) return Object.freeze({ ...base, status: 'unreadable' as const })
  const { family, length, items } = parsed.data
  const arrangement = arrangementFor(family, length)
  return Object.freeze({
    ...base,
    status: 'legacy' as const,
    candidateRef: arrangement.id,
    equipmentEquivalent: equipmentSignature(items) === equipmentSignature(arrangement.items),
    otherSettingsAssessed: false as const,
    reviewHolds: arrangement.reviewHolds,
  })
}
