import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, layoutIssues, type PlacedItem } from '../lib/config'
import { FIXED_ARRANGEMENTS, arrangementEquipment, arrangementFor } from './arrangements'
import {
  canonicalResolvedLayout,
  createFixedLayout,
  deserializeFixedLayout,
  fixedLayoutDigest,
  fixedLayoutProductionGate,
  parseFixedLayout,
  resolveFixedLayoutForReview,
  serializeFixedLayout,
  transitionFixedLayout,
} from './fixedLayout'

const selections = FIXED_ARRANGEMENTS.map(({ family, lengthFt }) => ({ family, lengthFt }))

describe('fixed arrangement authority', () => {
  it('has exactly one immutable draft per family/size and 18 catalog items', () => {
    expect(selections).toEqual([
      { family: 'studio', lengthFt: 20 },
      { family: 'studio', lengthFt: 40 },
      { family: 'container', lengthFt: 20 },
      { family: 'container', lengthFt: 40 },
    ])
    expect(FIXED_ARRANGEMENTS.map((a) => a.items.length)).toEqual([3, 6, 3, 6])
    expect(Object.isFrozen(FIXED_ARRANGEMENTS)).toBe(true)
    for (const arrangement of FIXED_ARRANGEMENTS) {
      expect(Object.isFrozen(arrangement)).toBe(true)
      expect(Object.isFrozen(arrangement.items)).toBe(true)
      expect(Object.isFrozen(arrangement.reviewHolds)).toBe(true)
      expect(arrangement.approval).toBe('draft')
      expect(new Set(arrangement.items.map((item) => item.id)).size).toBe(arrangement.items.length)
      for (const item of arrangement.items) {
        expect(Object.isFrozen(item)).toBe(true)
        expect(Object.isFrozen(arrangementEquipment(item.sku))).toBe(true)
      }
    }
  })

  it('retains the occupied bar width rather than treating the rack body as its footprint', () => {
    expect(arrangementEquipment('rack')).toMatchObject({ widthFt: 4.8, occupiedWidthFt: 7.3 })
    expect(() => arrangementEquipment('constructor' as PlacedItem['sku'])).toThrow()
  })

  for (const product of selections)
    it(`resolves ${product.family}-${product.lengthFt} without accepting caller equipment`, () => {
      const layout = createFixedLayout(product)
      const resolved = resolveFixedLayoutForReview(layout)
      expect(resolved.items).toEqual(arrangementFor(product.family, product.lengthFt).items)
      expect(resolved.units).toBe('feet')
      expect(resolved.approval).toBe('draft')
      expect(
        layoutIssues({
          ...DEFAULT_CONFIG,
          family: product.family,
          length: product.lengthFt,
          items: resolved.items.map((item) => ({ ...item })),
        }),
      ).toEqual([])
      expect(fixedLayoutProductionGate(layout)).toMatchObject({
        allowed: false,
        reason: 'arrangements-awaiting-product-approval',
      })
      expect(fixedLayoutProductionGate(layout).reviewHolds.length).toBeGreaterThan(0)
    })

  it('preserves the outstanding Container compatibility holds', () => {
    expect(fixedLayoutProductionGate(createFixedLayout(selections[2])).reviewHolds).toContain(
      'Tall equipment conflicts with the modeled slat ceiling and some overhead-door cases.',
    )
  })
})

describe('strict fixed-layout contract', () => {
  const layout = createFixedLayout({ family: 'studio', lengthFt: 20 })

  for (const extra of [
    { items: [] },
    { package: 'empty' },
    { x: 0, z: 0, rotation: 90 },
    { approval: 'approved' },
    { allowUnapproved: true },
    { renderer: 'cycles', samples: 1 },
  ])
    it(`rejects caller overrides ${Object.keys(extra).join(', ')}`, () => {
      expect(() => parseFixedLayout({ ...layout, ...extra })).toThrow()
      expect(() => resolveFixedLayoutForReview({ ...layout, ...extra })).toThrow()
      expect(() => fixedLayoutProductionGate({ ...layout, ...extra })).toThrow()
      expect(deserializeFixedLayout(JSON.stringify({ ...layout, ...extra }))).toBeNull()
    })

  for (const invalid of [
    { ...layout, contractVersion: 2 },
    { ...layout, catalogVersion: 'invented' },
    { ...layout, arrangementRef: 'studio-40-review@1' },
    { ...layout, arrangementRef: 'container-20-review@1' },
    { ...layout, product: { family: 'studio', lengthFt: '20' } },
    { ...layout, product: { family: 'studio', lengthFt: 30 } },
    { ...layout, product: { family: 'studio', lengthFt: 20, items: [] } },
    { ...layout, product: { family: 'invented', lengthFt: 20 } },
    DEFAULT_CONFIG,
    null,
  ])
    it(`rejects unsupported or mismatched input ${JSON.stringify(invalid).slice(0, 110)}`, () => {
      expect(() => parseFixedLayout(invalid)).toThrow()
    })

  it('returns immutable state without freezing or changing the caller object', () => {
    const original = JSON.parse(serializeFixedLayout(layout))
    const result = parseFixedLayout(original)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.product)).toBe(true)
    original.product.lengthFt = 40
    expect(result.product.lengthFt).toBe(20)
  })

  it('rejects malformed and oversized serialized layouts', () => {
    for (const raw of ['', 'not-json', '{', ' '.repeat(4097)])
      expect(deserializeFixedLayout(raw)).toBeNull()
  })

  for (const product of selections)
    it(`round-trips ${product.family}-${product.lengthFt} canonically`, async () => {
      const state = createFixedLayout(product)
      expect(deserializeFixedLayout(serializeFixedLayout(state))).toEqual(state)
      const reordered = {
        arrangementRef: state.arrangementRef,
        product: { lengthFt: product.lengthFt, family: product.family },
        catalogVersion: state.catalogVersion,
        contractVersion: state.contractVersion,
        contract: state.contract,
      }
      expect(serializeFixedLayout(reordered)).toBe(serializeFixedLayout(state))
      expect(await fixedLayoutDigest(reordered)).toBe(await fixedLayoutDigest(state))
      const expected = createHash('sha256').update(canonicalResolvedLayout(state)).digest('hex')
      expect(await fixedLayoutDigest(state)).toBe(`sha256:${expected}`)
    })

  it('binds the resolved layout and dimensions, with distinct identities for all four mappings', async () => {
    const identities = await Promise.all(
      selections.map((p) => fixedLayoutDigest(createFixedLayout(p))),
    )
    expect(new Set(identities).size).toBe(4)
    const canonical = JSON.parse(canonicalResolvedLayout(createFixedLayout(selections[2])))
    expect(canonical.items[0]).toMatchObject({
      sku: 'rack',
      x: -5.6,
      z: -1.6,
      rotation: 0,
      dimensions: { occupiedWidthFt: 7.3, heightFt: 7.5 },
    })
  })
})

describe('atomic family/size transitions', () => {
  for (const from of selections)
    for (const to of selections)
      it(`${from.family}-${from.lengthFt} to ${to.family}-${to.lengthFt}`, () => {
        const original = createFixedLayout(from)
        const transition = transitionFixedLayout(original, to)
        expect(transition.previous).toEqual(original)
        expect(transition.next).toEqual(createFixedLayout(to))
        expect(transition.changed).toBe(from.family !== to.family || from.lengthFt !== to.lengthFt)
        expect(transition.warnings.length).toBeGreaterThan(0)
        expect(transitionFixedLayout(transition.next, from).next).toEqual(original)
      })

  it('supports a no-op and rejects edits or caller-selected references in a command', () => {
    const original = createFixedLayout(selections[0])
    expect(transitionFixedLayout(original, {}).changed).toBe(false)
    for (const patch of [
      { items: [] },
      { arrangementRef: 'other' },
      { lengthFt: 30 },
      { family: null },
    ])
      expect(() => transitionFixedLayout(original, patch)).toThrow()
    expect(original.product).toEqual(selections[0])
  })
})
