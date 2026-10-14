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
  productHeight,
  setFamily,
  openingGeometry,
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
import { CONTAINER_OPENINGS, PRODUCT_FAMILIES, STUDIO_LAYOUTS } from './products'

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
    expect(decodeConfig(encoded({ ...config, v: 3 }))).toBe(null)
  })
  it('rejects cross-family options at the sharing boundary', () => {
    expect(
      decodeConfig(
        encoded({
          ...fresh(),
          family: 'container',
          addons: { deck: true, gazebo: false, stairs: false, roof: false },
        }),
      ),
    ).toBe(null)
    expect(
      decodeConfig(encoded({ ...fresh(), family: 'container', studioLayout: 'stacked' })),
    ).toBe(null)
  })
  it('detects a layout that cannot be downsized safely', () => {
    const c = { ...fresh(), items: packageItems('strength', 40) }
    expect(layoutIssues(c).length).toBeGreaterThan(0)
  })
})
describe('independent published add-on transitions', () => {
  it('allows individual Studio add-ons without invented dependency rules', () => {
    const c = { ...fresh(), addons: { deck: false, gazebo: false, roof: false, stairs: false } }
    const pergola = setAddon(c, 'gazebo'),
      stairs = setAddon(c, 'stairs')
    expect(pergola.config.addons.deck).toBe(false)
    expect(pergola.config.addons.gazebo).toBe(true)
    expect(stairs.config.addons.roof).toBe(false)
    expect(stairs.config.addons.stairs).toBe(true)
    expect(decodeConfig(encodeConfig(pergola.config))).toEqual(pergola.config)
    expect(decodeConfig(encodeConfig(stairs.config))).toEqual(stairs.config)
    expect(c.addons.deck).toBe(false)
  })
  it('toggles only the requested add-on without resetting finishes or equipment', () => {
    const c = {
      ...fresh(),
      finish: 'bronze' as const,
      addons: { deck: true, gazebo: true, roof: true, stairs: true },
    }
    const noDeck = setAddon(c, 'deck').config,
      noRoof = setAddon(c, 'roof').config
    expect(noDeck.addons.gazebo).toBe(true)
    expect(noRoof.addons.stairs).toBe(true)
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
describe('published pricing boundaries', () => {
  for (const family of PRODUCT_FAMILIES)
    for (const length of [20, 40] as const)
      it(`${family.id} ${length} uses a family starting price, never a configured total`, () => {
        const price = estimate({ ...setFamily(fresh(), family.id), length })
        expect(price.startingPrice).toBe(family.id === 'studio' ? 35000 : 20000)
        expect(price.source).toBe(family.source)
        expect(price.total).toBeNull()
        expect(price.lines.every((line) => line.amount === null)).toBe(true)
        expect(price.version).toBe('fury-published-2026-10-14')
      })
  it('keeps concept options unpriced, never free or added to the starting price', () => {
    const c: Config = {
      ...fresh(),
      studioLayout: 'connected',
      finish: 'bronze',
      accent: true,
      mirror: true,
      addons: { deck: true, gazebo: true, roof: true, stairs: true },
    }
    expect(estimate(c).startingPrice).toBe(35000)
    expect(estimate(c).lines.every((line) => line.amount === null)).toBe(true)
    expect(estimate(c).lines.map((line) => line.name)).toEqual(
      expect.arrayContaining([
        'Front deck',
        'Gazebo',
        'Custom inquiry: Connected units',
        'Concept timber accent',
        'Planning item: Power rack',
      ]),
    )
  })
})

describe('product families', () => {
  for (const length of [20, 40] as const)
    for (const opening of CONTAINER_OPENINGS)
      for (const pack of PACKAGES)
        it(`${length} ${opening.id} Container fits the ${pack.id} planning preset`, () => {
          const config: Config = {
            ...setFamily(fresh(), 'container'),
            length,
            containerOpening: opening.id,
            package: pack.id,
            items: packageItems(pack.id, length),
          }
          expect(layoutIssues(config)).toEqual([])
        })
  it('rejects Container settings on Studios and Studio accents on Containers', () => {
    expect(decodeConfig(encoded({ ...fresh(), containerOpening: 'full' }))).toBeNull()
    expect(decodeConfig(encoded({ ...fresh(), integratedFinish: true }))).toBeNull()
    expect(decodeConfig(encoded({ ...fresh(), family: 'container', accent: true }))).toBeNull()
  })
  it('clears family-only options while preserving the shared interior and finish', () => {
    const original: Config = {
      ...fresh(),
      length: 40,
      studioLayout: 'stacked',
      accent: true,
      addons: { deck: true, gazebo: true, roof: true, stairs: true },
    }
    const container = setFamily(original, 'container')
    expect(productHeight(container)).toBe(9.5)
    expect(container.length).toBe(40)
    expect(Object.values(container.addons).some(Boolean)).toBe(false)
    expect(container.accent).toBe(false)
    expect(container.studioLayout).toBe('single')
    expect(container.items).toEqual(original.items)
    expect(container.finish).toBe(original.finish)
    expect(original.addons.deck).toBe(true)
    const studio = setFamily(
      { ...container, containerOpening: 'partial', integratedFinish: true },
      'studio',
    )
    expect(studio.containerOpening).toBe('roll-up')
    expect(studio.integratedFinish).toBe(false)
    expect(productHeight(studio)).toBe(10)
    expect(setFamily(studio, 'studio')).toBe(studio)
    expect(setAddon(container, 'deck').config).toBe(container)
  })
  for (const length of [20, 40] as const)
    for (const opening of CONTAINER_OPENINGS)
      it(`round-trips the ${length} Container with ${opening.id} and integrated finish`, () => {
        const config: Config = {
          ...setFamily(fresh(), 'container'),
          length,
          containerOpening: opening.id,
          integratedFinish: true,
        }
        expect(decodeConfig(encodeConfig(config))).toEqual(config)
        expect(estimate(config).lines.map((line) => line.name)).toContain(opening.name)
        expect(estimate(config).lines.map((line) => line.name)).toContain(
          'Integrated exterior finish',
        )
        const geometry = openingGeometry(config)
        expect(geometry.width).toBeGreaterThan(0)
        expect(Math.abs(geometry.center) + geometry.width / 2).toBeLessThan(length / 2)
        if (opening.id === 'roll-up') expect(geometry.width).toBe(10)
      })
  for (const layout of STUDIO_LAYOUTS)
    it(`preserves the ${layout.id} Studio inquiry without inventing an assembly`, () => {
      const config = { ...fresh(), studioLayout: layout.id }
      expect(decodeConfig(encodeConfig(config))).toEqual(config)
      expect(estimate(config).total).toBeNull()
    })
  it('protects the selected partial opening entry rather than a closed wall', () => {
    const c: Config = { ...setFamily(fresh(), 'container'), containerOpening: 'partial', items: [] }
    const item = { ...fresh().items[1], x: -5, z: 1.2 }
    expect(placementIssue(item, c)).toContain('entry')
    expect(placementIssue({ ...item, x: 0 }, c)).toBe(null)
  })
  it('undoes and redoes family changes including cleared options', () => {
    const c = setAddon(fresh(), 'deck').config
    const state = configReducer(
      { past: [], present: c, future: [], notice: '' },
      { type: 'set', config: setFamily(c, 'container') },
    )
    const undone = configReducer(state, { type: 'undo' })
    expect(undone.present).toEqual(c)
    expect(configReducer(undone, { type: 'redo' }).present.family).toBe('container')
  })
})
describe('sharing and browser persistence', () => {
  const legacy = () => {
    const value: Record<string, unknown> = { ...fresh(), v: 1 }
    for (const key of ['family', 'studioLayout', 'containerOpening', 'integratedFinish'])
      delete value[key]
    return value
  }
  it('migrates version 1 links, drafts, and saved builds as Studios without losing choices', () => {
    const old = {
      ...legacy(),
      accent: true,
      addons: { deck: true, gazebo: true, roof: true, stairs: true },
    }
    const migrated = { ...fresh(), accent: true, addons: old.addons }
    expect(decodeConfig(encoded(old))).toEqual(migrated)
    localStorage.setItem('fury-draft-v1', encoded(old))
    expect(initialConfig().config).toEqual(migrated)
    localStorage.setItem(
      'fury-builds-v1',
      JSON.stringify([{ id: 'old', name: 'Legacy Studio', date: '2026-10-10', config: old }]),
    )
    expect(readSaved()[0].config).toEqual(migrated)
  })
  it('still validates legacy payloads instead of trusting the migration', () => {
    expect(decodeConfig(encoded({ ...legacy(), length: 50 }))).toBeNull()
    expect(
      decodeConfig(encoded({ ...legacy(), items: [{ ...fresh().items[0], x: 100 }] })),
    ).toBeNull()
  })
  it('saves and reloads different families with their configuration requests', () => {
    const builds = [
      {
        id: 'container',
        name: 'Open training',
        date: '2026-10-14',
        config: {
          ...setFamily(fresh(), 'container'),
          containerOpening: 'full' as const,
          integratedFinish: true,
        },
      },
      {
        id: 'studio',
        name: 'Connected',
        date: '2026-10-14',
        config: { ...fresh(), studioLayout: 'connected' as const },
      },
    ]
    writeSaved(builds)
    expect(readSaved()).toEqual(builds)
  })
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
  it('exports Container dimensions, openings, price provenance, and inquiry link', async () => {
    const c: Config = {
      ...setFamily(fresh(), 'container'),
      length: 40,
      containerOpening: 'full',
      integratedFinish: true,
    }
    const doc = await createBrief(c, null, { name: 'Container project', notes: '' })
    const pdf = doc.output()
    expect(pdf).toContain('FURY / CONTAINER')
    expect(pdf).toContain('9.5 ft H')
    expect(pdf).toContain('20,000')
    expect(pdf).toContain('Full open-side')
    expect(pdf).toContain('Integrated exterior finish')
    expect(pdf).toContain('https://www.furycogyms.com/gym-design/container')
    expect(pdf).toContain('https://www.furycogyms.com/start-a-project')
    expect(pdf).not.toContain('FURY / S-SERIES')
    expect(pdf).not.toContain('Illustrative total')
  })
  it('marks custom Studio requests as a single-unit reference in the PDF', async () => {
    const doc = await createBrief({ ...fresh(), studioLayout: 'stacked' }, null, {
      name: 'Stacked inquiry',
      notes: '',
    })
    expect(doc.output()).toContain('Configuration request: Stacked')
    expect(doc.output()).toContain('one reference unit only')
  })
  it('creates a multipage PDF with estimate, floor plan, link and honest limitations', async () => {
    const doc = await createBrief(fresh(), null, {
      name: 'Courtyard studio',
      notes: 'Confirm crane access.',
    })
    const pdf = doc.output()
    expect(pdf).toMatch(/^%PDF/)
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(2)
    expect(pdf).toContain('35,000')
    expect(pdf).not.toContain('86,250')
    expect(pdf).toContain('Quote required')
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
