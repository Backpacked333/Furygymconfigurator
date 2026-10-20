import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, SIGNATURES, addEquipment, decodeConfig, encodeConfig } from './config'
import { RENDER_VERSION, canonicalConfig, configKey, stableStringify, stillKey } from './stillKey'

describe('still keys', () => {
  it('are the same for a design however its equipment was placed', () => {
    const shuffled = { ...DEFAULT_CONFIG, items: [...DEFAULT_CONFIG.items].reverse() }
    expect(configKey(shuffled)).toBe(configKey(DEFAULT_CONFIG))
    const renamed = {
      ...DEFAULT_CONFIG,
      items: DEFAULT_CONFIG.items.map((item, i) => ({ ...item, id: `placed-${i}-later` })),
    }
    expect(configKey(renamed)).toBe(configKey(DEFAULT_CONFIG))
  })

  it('are the same for a design whose keys come in another order, or through a share link', () => {
    const reordered = Object.fromEntries(
      Object.entries(DEFAULT_CONFIG).reverse(),
    ) as typeof DEFAULT_CONFIG
    expect(configKey(reordered)).toBe(configKey(DEFAULT_CONFIG))
    const shared = decodeConfig(encodeConfig(SIGNATURES[2].config))!
    expect(configKey(shared)).toBe(configKey(SIGNATURES[2].config))
    expect(configKey({ ...DEFAULT_CONFIG, time: 16.5 + 1e-9 })).toBe(configKey(DEFAULT_CONFIG))
  })

  it('differ for anything the picture shows', () => {
    const base = configKey(DEFAULT_CONFIG)
    expect(configKey({ ...DEFAULT_CONFIG, finish: 'graphite' })).not.toBe(base)
    expect(configKey({ ...DEFAULT_CONFIG, time: 17 })).not.toBe(base)
    const moved = {
      ...DEFAULT_CONFIG,
      items: DEFAULT_CONFIG.items.map((item, i) => (i ? item : { ...item, x: item.x + 0.25 })),
    }
    expect(configKey(moved)).not.toBe(base)
    expect(configKey(addEquipment(DEFAULT_CONFIG, 'medball')!)).not.toBe(base)
    expect(new Set(SIGNATURES.map((s) => configKey(s.config))).size).toBe(SIGNATURES.length)
  })

  it('order equipment by kind, place and turn, with ids from that order', () => {
    const items = canonicalConfig(DEFAULT_CONFIG).items
    expect(items.map((i) => i.sku)).toEqual([...items.map((i) => i.sku)].sort())
    expect(items.map((i) => i.id)).toEqual(items.map((_, i) => `item-${i}`))
    // The design itself is left as it was.
    expect(DEFAULT_CONFIG.items[0].id).not.toBe('item-0')
  })

  it('name a still by version, design, angle and stage shape', () => {
    const key = stillKey(configKey(DEFAULT_CONFIG), 'front-left', 'wide')
    expect(key).toBe(`${RENDER_VERSION}/${configKey(DEFAULT_CONFIG)}/front-left/wide`)
    expect(stillKey('abc', 'rear', 'tall', 'v2')).toBe('v2/abc/rear/tall')
    expect(configKey(DEFAULT_CONFIG)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('write JSON with sorted keys', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined, e: 'x' }] })).toBe(
      '{"a":[{"d":2,"e":"x"}],"b":1}',
    )
  })
})
