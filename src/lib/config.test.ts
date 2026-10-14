import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LZString from 'lz-string'
import {
  ADDONS,
  CATALOG,
  DEFAULT_CONFIG,
  PACKAGES,
  addEquipment,
  configSchema,
  decodeConfig,
  encodeConfig,
  estimate,
  footprint,
  initialConfig,
  layoutIssues,
  monthlyPayment,
  packageItems,
  placementIssue,
  readSaved,
  setAddon,
  shareUrl,
  writeSaved,
  type Config,
} from './config'
import { configReducer } from './useConfig'
import { createBrief } from './export'

const fresh = (): Config => structuredClone(DEFAULT_CONFIG)
const encoded = (value: unknown) => LZString.compressToEncodedURIComponent(JSON.stringify(value))
beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  })
  vi.stubGlobal('window', {
    atob,
    btoa,
    location: { href: 'https://studio.example.com/app?tracking=1', hash: '' },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('configuration and packages', () => {
  it('starts with a valid layout', () => {
    expect(configSchema.parse(fresh())).toEqual(fresh())
    expect(layoutIssues(fresh())).toEqual([])
  })
  for (const length of [20, 40] as const)
    for (const pack of PACKAGES)
      it(`${length}-foot ${pack.id} preset fits, with unique IDs and a clear entry`, () => {
        const config = {
          ...fresh(),
          length,
          package: pack.id,
          items: packageItems(pack.id, length),
        }
        expect(configSchema.safeParse(config).success).toBe(true)
        expect(layoutIssues(config)).toEqual([])
        expect(decodeConfig(encodeConfig(config))).toEqual(config)
      })
  it('rejects repeated item IDs, unknown equipment, and unsupported schema versions', () => {
    const config = fresh()
    expect(
      configSchema.safeParse({ ...config, items: [config.items[0], config.items[0]] }).success,
    ).toBe(false)
    expect(
      decodeConfig(encoded({ ...config, items: [{ ...config.items[0], sku: 'invented' }] })),
    ).toBe(null)
    expect(decodeConfig(encoded({ ...config, v: 2 }))).toBe(null)
  })
  it('rejects incompatible dependencies at the sharing boundary', () => {
    expect(
      decodeConfig(
        encoded({ ...fresh(), addons: { deck: false, gazebo: true, stairs: false, roof: false } }),
      ),
    ).toBe(null)
    expect(
      decodeConfig(
        encoded({ ...fresh(), addons: { deck: false, gazebo: false, stairs: true, roof: false } }),
      ),
    ).toBe(null)
  })
  it('detects a layout that cannot be downsized safely', () => {
    const c = { ...fresh(), items: packageItems('strength', 40) }
    expect(layoutIssues(c).length).toBeGreaterThan(0)
  })
})
describe('add-on dependency transitions', () => {
  it('enables support structures and provides a notice', () => {
    const c = { ...fresh(), addons: { deck: false, gazebo: false, roof: false, stairs: false } }
    const pergola = setAddon(c, 'gazebo'),
      stairs = setAddon(c, 'stairs')
    expect(pergola.config.addons.deck).toBe(true)
    expect(pergola.notice).toBeTruthy()
    expect(stairs.config.addons.roof).toBe(true)
    expect(stairs.notice).toBeTruthy()
    expect(c.addons.deck).toBe(false)
  })
  it('removes dependents without resetting finishes or equipment', () => {
    const c = {
      ...fresh(),
      finish: 'bronze' as const,
      addons: { deck: true, gazebo: true, roof: true, stairs: true },
    }
    const noDeck = setAddon(c, 'deck').config,
      noRoof = setAddon(c, 'roof').config
    expect(noDeck.addons.gazebo).toBe(false)
    expect(noRoof.addons.stairs).toBe(false)
    expect(noDeck.items).toEqual(c.items)
    expect(noRoof.finish).toBe('bronze')
  })
  for (const a of ADDONS)
    for (const b of ADDONS)
      it(`keeps ${a.id} → ${b.id} transitions valid`, () => {
        const c = setAddon(setAddon(fresh(), a.id).config, b.id).config
        expect(configSchema.safeParse(c).success).toBe(true)
      })
})
describe('placement rules', () => {
  it('rejects wall intersections and entry obstruction', () => {
    const c = fresh(),
      item = c.items[1]
    expect(placementIssue({ ...item, x: 12 }, c)).toContain('usable floor')
    expect(placementIssue({ ...item, x: 0, z: 1 }, c)).toContain('entry')
  })
  it('rejects overlap but not an unchanged position', () => {
    const c = fresh(),
      item = c.items[1]
    expect(placementIssue(item, c)).toBe(null)
    expect(placementIssue({ ...item, x: -5, z: -0.8 }, c)).toContain('overlaps')
  })
  it('rotates the collision footprint', () => {
    const item = fresh().items[1]
    expect(footprint(item)).toEqual({ w: 1.9, d: 4.3 })
    expect(footprint({ ...item, rotation: 90 })).toEqual({ w: 4.3, d: 1.9 })
  })
  for (const product of CATALOG)
    it(`finds a valid location for ${product.id}`, () => {
      const c = addEquipment({ ...fresh(), items: [], package: 'empty' }, product.id)
      expect(c).not.toBe(null)
      expect(layoutIssues(c!)).toEqual([])
      expect(c!.package).toBe('custom')
    })
  it('never overfills the room', () => {
    let c: Config = { ...fresh(), items: [] }
    for (let i = 0; i < 20; i++) {
      const next = addEquipment(c, 'sauna')
      if (!next) break
      c = next
    }
    expect(addEquipment(c, 'sauna')).toBe(null)
    expect(layoutIssues(c)).toEqual([])
  })
  it('rejects invalid layouts supplied through a link', () => {
    const c = fresh()
    c.items[0].x = 19
    expect(decodeConfig(encoded(c))).toBe(null)
  })
})
describe('estimates and financing', () => {
  it('prices the default build exactly once per selected line', () => {
    expect(estimate(fresh()).total).toBe(86250)
    expect(estimate(fresh()).lines.reduce((s, l) => s + l.amount, 0)).toBe(86250)
    expect(estimate(fresh()).version).toBe('concept-2026-10')
  })
  it('scales finishes and decks but not equipment or staircases', () => {
    const c = {
      ...fresh(),
      length: 40 as const,
      finish: 'bronze' as const,
      addons: { deck: true, gazebo: true, roof: true, stairs: true },
    }
    const lines = Object.fromEntries(estimate(c).lines.map((x) => [x.name, x.amount]))
    expect(lines['S-40 studio shell']).toBe(118000)
    expect(lines['Bronze finish']).toBe(4800)
    expect(lines['Exterior staircase']).toBe(7600)
    expect(lines['Front terrace']).toBe(16400)
    expect(lines['Power rack']).toBe(2400)
  })
  it('handles zero APR, full deposits and standard amortization', () => {
    expect(monthlyPayment(100000, 20, 0, 120)).toBeCloseTo(666.6667, 3)
    expect(monthlyPayment(100000, 20, 8.5, 120)).toBeCloseTo(991.8855, 2)
    expect(monthlyPayment(100000, 100, 8.5, 120)).toBe(0)
  })
  it.each([
    [1, 0, 0, 0],
    [1, 101, 5, 120],
    [1, -1, 5, 120],
    [-1, 0, 5, 120],
    [1, 0, -1, 120],
    [NaN, 0, 5, 120],
  ])('rejects invalid financial assumptions (%s,%s,%s,%s)', (a, b, c, d) => {
    expect(() => monthlyPayment(a, b, c, d)).toThrow()
  })
})
describe('sharing and browser persistence', () => {
  it('round-trips without including unrelated query parameters', () => {
    const url = new URL(shareUrl(fresh()))
    expect(url.origin).toBe('https://studio.example.com')
    expect(url.pathname).toBe('/app')
    expect(url.search).toBe('')
    expect(decodeConfig(new URLSearchParams(url.hash.slice(1)).get('c')!)).toEqual(fresh())
  })
  it.each([
    '',
    'broken',
    'A'.repeat(12001),
    encoded({}),
    encoded({ ...DEFAULT_CONFIG, time: 100 }),
  ])('safely rejects malformed share input', (input) => {
    expect(decodeConfig(input)).toBe(null)
  })
  it('gives a valid shared build priority over the browser draft', () => {
    localStorage.setItem('fury-draft-v1', encodeConfig({ ...fresh(), finish: 'chalk' }))
    window.location.hash = `#c=${encodeConfig({ ...fresh(), finish: 'olive' })}`
    expect(initialConfig().config.finish).toBe('olive')
  })
  it('restores the draft and explains malformed links', () => {
    localStorage.setItem('fury-draft-v1', encodeConfig({ ...fresh(), finish: 'chalk' }))
    expect(initialConfig().config.finish).toBe('chalk')
    window.location.hash = '#c=broken'
    expect(initialConfig().notice).toContain('invalid')
  })
  it('saves named builds and safely rejects corrupted storage', () => {
    const builds = [{ id: 'one', name: 'Courtyard', date: '2026-10-14', config: fresh() }]
    writeSaved(builds)
    expect(readSaved()).toEqual(builds)
    localStorage.setItem('fury-builds-v1', '{')
    expect(readSaved()).toEqual([])
  })
  it('continues without storage access', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Denied')
      },
      setItem: () => {
        throw new Error('Denied')
      },
    })
    expect(initialConfig().config).toEqual(fresh())
    expect(readSaved()).toEqual([])
    expect(() => writeSaved([])).toThrow('Denied')
  })
})
describe('history', () => {
  it('undoes and redoes changes without duplicate history entries', () => {
    const initial = { past: [], present: fresh(), future: [], notice: '' }
    const changed = configReducer(initial, { type: 'set', config: { ...fresh(), finish: 'chalk' } })
    expect(configReducer(changed, { type: 'set', config: changed.present })).toBe(changed)
    const undone = configReducer(changed, { type: 'undo' })
    expect(undone.present).toEqual(initial.present)
    expect(configReducer(undone, { type: 'redo' }).present.finish).toBe('chalk')
    const branched = configReducer(undone, { type: 'set', config: { ...fresh(), finish: 'olive' } })
    expect(branched.future).toEqual([])
    expect(configReducer(initial, { type: 'undo' })).toBe(initial)
  })
  it('bounds the undo history to 50 entries', () => {
    let state = { past: [] as Config[], present: fresh(), future: [] as Config[], notice: '' }
    for (let i = 0; i < 100; i++)
      state = configReducer(state, {
        type: 'set',
        config: { ...state.present, lights: !state.present.lights },
      })
    expect(state.past).toHaveLength(50)
  })
})
describe('PDF brief', () => {
  it('creates a multipage PDF with estimate, floor plan, link and honest limitations', async () => {
    const doc = await createBrief(fresh(), null, {
      name: 'Courtyard studio',
      notes: 'Confirm crane access.',
    })
    const pdf = doc.output()
    expect(pdf).toMatch(/^%PDF/)
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(2)
    expect(pdf).toContain('86,250')
    expect(pdf).toContain('Not a quotation or an offer')
    expect(pdf).toContain('Confirm crane access.')
    expect(pdf).toContain('https://studio.example.com/app#c=')
    expect(pdf).toContain('NOT FOR CONSTRUCTION')
  })
  it('paginates multiline notes without losing later sections', async () => {
    const c = { ...fresh(), length: 40 as const, items: packageItems('strength', 40) }
    const doc = await createBrief(c, null, {
      name: 'A'.repeat(60),
      notes: 'Check this detail.\n'.repeat(100),
    })
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(3)
    expect(doc.output()).toContain('Continue this design')
  })
})
