import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import { FIXED_ARRANGEMENTS } from './arrangements'
import { inspectLegacyEquipment } from './legacy'

describe('non-destructive legacy equipment inspection', () => {
  for (const arrangement of FIXED_ARRANGEMENTS)
    it(`matches ${arrangement.id} by transforms, ignoring labels, IDs and array order`, () => {
      const raw = JSON.stringify(
        {
          ...DEFAULT_CONFIG,
          family: arrangement.family,
          length: arrangement.lengthFt,
          package: 'custom',
          items: [...arrangement.items]
            .reverse()
            .map((item, index) => ({ ...item, id: `old-${index}` })),
        },
        null,
        2,
      )
      expect(inspectLegacyEquipment(raw)).toMatchObject({
        original: { format: 'json', raw },
        status: 'legacy',
        candidateRef: arrangement.id,
        equipmentEquivalent: true,
        otherSettingsAssessed: false,
        autoMigrate: false,
        readOnly: true,
      })
    })

  for (const v of [1, 2, 3])
    it(`keeps v${v} raw bytes even when the old parser normalizes defaults`, () => {
      const value = { ...DEFAULT_CONFIG, v }
      const raw = ` \n ${JSON.stringify(value)}  `
      expect(inspectLegacyEquipment(raw)).toMatchObject({
        status: 'legacy',
        original: { raw },
        readOnly: true,
        autoMigrate: false,
      })
      expect(JSON.parse(raw).v).toBe(v)
    })

  it('does not trust a package label or convert changed layouts', () => {
    const arrangement = FIXED_ARRANGEMENTS[0]
    const base = { ...DEFAULT_CONFIG, package: 'strength', items: arrangement.items }
    expect(inspectLegacyEquipment(JSON.stringify(base))).toMatchObject({
      equipmentEquivalent: true,
    })
    for (const items of [
      arrangement.items.slice(1),
      [...arrangement.items, { ...arrangement.items[0], id: 'extra' }],
      arrangement.items.map((item, i) => (i === 0 ? { ...item, x: item.x + 0.01 } : item)),
      arrangement.items.map((item, i) => (i === 0 ? { ...item, rotation: 90 } : item)),
    ])
      expect(inspectLegacyEquipment(JSON.stringify({ ...base, items }))).toMatchObject({
        equipmentEquivalent: false,
        autoMigrate: false,
      })
  })

  it('never treats matching equipment as full semantic equivalence', () => {
    const raw = JSON.stringify({
      ...DEFAULT_CONFIG,
      time: 17.37,
      items: FIXED_ARRANGEMENTS[0].items,
    })
    expect(inspectLegacyEquipment(raw)).toMatchObject({
      equipmentEquivalent: true,
      otherSettingsAssessed: false,
      autoMigrate: false,
    })
  })

  for (const [raw, status] of [
    ['not-json', 'unreadable'],
    ['{"v":3,"items":[]}', 'unreadable'],
    ['{"v":99,"future":"preserve me"}', 'unsupported-version'],
    ['null', 'unsupported-version'],
    ['[]', 'unsupported-version'],
    ['x'.repeat(16001), 'too-large'],
  ])
    it(`preserves ${status} input without substituting another layout`, () => {
      const inspected = inspectLegacyEquipment(raw)
      expect(inspected).toEqual({
        original: { format: 'json', raw },
        readOnly: true,
        autoMigrate: false,
        status,
      })
    })
})
