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
  entryCenter,
  SIGNATURES,
  studioDoorCenter,
  shareUrl,
  writeSaved,
  writeDraft,
  type Config,
} from './config'
import { configReducer } from './useConfig'
import { createBrief } from './export'
import {
  CONTAINER_OPENINGS,
  OPENING_INFILLS,
  PRODUCT_FAMILIES,
  STUDIO_DOORS,
  STUDIO_LAYOUTS,
} from './products'

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
  for (const raw of ['{', '', '{"v":99,"future":"keep me"}', 'null', '42'])
    it(`archives non-library data before replacing it: ${JSON.stringify(raw)}`, () => {
      localStorage.setItem('fury-builds-v1', raw)
      const save = vi.spyOn(localStorage, 'setItem')
      writeSaved([])
      const archive = save.mock.calls.find(([key]) => key.startsWith('fury-builds-v1-recovery-'))
      expect(archive).toBeDefined()
      expect(localStorage.getItem(archive![0])).toBe(raw)
      expect(localStorage.getItem('fury-builds-v1')).toBe('[]')
      expect(save.mock.calls.at(-1)).toEqual(['fury-builds-v1', '[]'])
      save.mockRestore()
    })

  it('never replaces a malformed library when recovery fails or silently drops the archive', () => {
    const originalSave = localStorage.setItem
    const save = vi.spyOn(localStorage, 'setItem')
    for (const silent of [false, true]) {
      originalSave('fury-builds-v1', 'unreadable original')
      save.mockImplementation((key, value) => {
        if (key.startsWith('fury-builds-v1-recovery-')) {
          if (!silent) throw new Error('quota')
          return
        }
        originalSave(key, value)
      })
      expect(() => writeSaved([])).toThrow()
      expect(localStorage.getItem('fury-builds-v1')).toBe('unreadable original')
    }
    save.mockRestore()
  })

  it('retains the raw future entry and entries hidden by the twelve-build display limit', () => {
    const builds = Array.from({ length: 13 }, (_, i) => ({
      id: `${i}`,
      name: `Build ${i}`,
      date: '',
      config: fresh(),
    }))
    const future = { id: 'future', config: { v: 99 }, extra: 'retain raw' }
    const raw = JSON.stringify([...builds, future], null, 2)
    localStorage.setItem('fury-builds-v1', raw)
    const save = vi.spyOn(localStorage, 'setItem')
    expect(readSaved()).toHaveLength(12)
    writeSaved([])
    const archive = save.mock.calls.find(([key]) => key.startsWith('fury-builds-v1-recovery-'))
    expect(localStorage.getItem(archive![0])).toBe(raw)
    expect(JSON.parse(localStorage.getItem('fury-builds-v1')!)).toEqual([future])
    save.mockRestore()
  })

  it('does not overwrite a library changed while its recovery copy is being written', () => {
    localStorage.setItem('fury-builds-v1', '{')
    const originalSave = localStorage.setItem
    const save = vi.spyOn(localStorage, 'setItem')
    save.mockImplementation((key, value) => {
      originalSave(key, value)
      if (key.startsWith('fury-builds-v1-recovery-'))
        originalSave('fury-builds-v1', 'newer external write')
    })
    expect(() => writeSaved([])).toThrow('library changed')
    expect(localStorage.getItem('fury-builds-v1')).toBe('newer external write')
    save.mockRestore()
  })

  it('preserves an empty draft and verifies its archive before autosave', () => {
    localStorage.setItem('fury-draft-v1', '')
    const save = vi.spyOn(localStorage, 'setItem')
    writeDraft(encodeConfig(fresh()))
    const archive = save.mock.calls.find(([key]) => key.startsWith('fury-draft-recovery-'))
    expect(localStorage.getItem(archive![0])).toBe('')
    save.mockRestore()
  })

  it('archives unreadable draft data before autosaving and never overwrites it if recovery storage fails', () => {
    const save = vi.spyOn(localStorage, 'setItem')
    localStorage.setItem('fury-draft-v1', 'old-unreadable-design')
    writeDraft(encodeConfig(fresh()))
    expect(
      save.mock.calls.some(
        ([key, value]) =>
          key.startsWith('fury-draft-recovery-') && value === 'old-unreadable-design',
      ),
    ).toBe(true)
    localStorage.setItem('fury-draft-v1', 'another-old-design')
    save.mockImplementation((key) => {
      if (key.startsWith('fury-draft-recovery-')) throw new Error('storage full')
    })
    expect(() => writeDraft(encodeConfig(fresh()))).toThrow('storage full')
    expect(localStorage.getItem('fury-draft-v1')).toBe('another-old-design')
    save.mockRestore()
  })
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
    expect(decodeConfig(encoded({ ...config, v: 4 }))).toBe(null)
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
    const c = {
      ...fresh(),
      addons: { deck: false, gazebo: false, roof: false, stairs: false, canopy: false },
    }
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
      addons: { deck: true, gazebo: true, roof: true, stairs: true, canopy: false },
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
    expect(placementIssue({ ...item, x: entryCenter(c), z: 1 }, c)).toContain('entry')
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
  it.each(['rack', 'halfrack'] as const)('keeps the %s loaded bar inside walls', (sku) => {
    const item = { id: 'loaded-rack', sku, x: 6, z: -0.8, rotation: 0 as const }
    const c = { ...fresh(), items: [item] }
    expect(footprint(item).w).toBe(7.3)
    expect(placementIssue(item, c)).toContain('usable floor')
    expect(placementIssue({ ...item, x: -5 }, c)).toBeNull()
    expect(placementIssue({ ...item, x: -5, rotation: 90 }, c)).toContain('usable floor')
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
      addons: { deck: true, gazebo: true, roof: true, stairs: true, canopy: false },
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
      addons: { deck: true, gazebo: true, roof: true, stairs: true, canopy: false },
    }
    const container = setFamily(original, 'container')
    expect(productHeight(container)).toBe(9.5)
    expect(container.length).toBe(40)
    // Decks, roof decks, and stairs appear on Container builds too; the gazebo does not.
    expect(container.addons).toEqual({
      deck: true,
      gazebo: false,
      roof: true,
      stairs: true,
      canopy: false,
    })
    expect(container.accent).toBe(false)
    expect(container.studioLayout).toBe('single')
    expect(container.doorsOpen).toBe(true)
    expect(container.items).toEqual(original.items)
    expect(container.finish).toBe(original.finish)
    expect(original.addons.gazebo).toBe(true)
    const studio = setFamily(
      {
        ...container,
        containerOpening: 'partial',
        openingInfill: 'glass-overhead',
        integratedFinish: true,
        addons: { ...container.addons, canopy: true },
      },
      'studio',
    )
    expect(studio.containerOpening).toBe('roll-up')
    expect(studio.openingInfill).toBe('none')
    expect(studio.integratedFinish).toBe(false)
    expect(studio.addons.canopy).toBe(false)
    expect(studio.doorsOpen).toBe(false)
    expect(productHeight(studio)).toBe(10)
    expect(setFamily(studio, 'studio')).toBe(studio)
    expect(setAddon(container, 'gazebo').config).toBe(container)
    expect(setAddon(studio, 'canopy').config).toBe(studio)
    expect(setAddon(container, 'canopy').config.addons.canopy).toBe(true)
  })
  it('falls back to the centered sliding door when the hinged entry would be obstructed', () => {
    const blocked: Config = {
      ...setFamily(fresh(), 'container'),
      items: [{ id: 'bike', sku: 'treadmill', x: 3.6, z: 0, rotation: 0 }],
    }
    expect(layoutIssues(blocked)).toEqual([])
    const studio = setFamily(blocked, 'studio')
    expect(studio.studioDoor).toBe('sliding')
    expect(layoutIssues(studio)).toEqual([])
    expect(setFamily(setFamily(fresh(), 'container'), 'studio').studioDoor).toBe('hinged')
  })
  it('rejects infill on the roll-up opening and portfolio options on the wrong family', () => {
    const container = setFamily(fresh(), 'container')
    expect(decodeConfig(encoded({ ...container, openingInfill: 'awning' }))).toBeNull()
    expect(
      decodeConfig(encoded({ ...container, containerOpening: 'full', openingInfill: 'awning' })),
    ).not.toBeNull()
    expect(decodeConfig(encoded({ ...fresh(), openingInfill: 'glass-overhead' }))).toBeNull()
    expect(
      decodeConfig(encoded({ ...fresh(), addons: { ...fresh().addons, canopy: true } })),
    ).toBeNull()
    expect(
      decodeConfig(encoded({ ...container, addons: { ...container.addons, gazebo: true } })),
    ).toBeNull()
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
describe('portfolio options', () => {
  for (const length of [20, 40] as const)
    for (const door of STUDIO_DOORS)
      for (const pack of PACKAGES)
        it(`${length} Studio with a ${door.id} door fits the ${pack.id} planning preset`, () => {
          const config: Config = {
            ...fresh(),
            length,
            studioDoor: door.id,
            package: pack.id,
            items: packageItems(pack.id, length),
          }
          expect(layoutIssues(config)).toEqual([])
        })
  it('places the hinged door in the second bay from the end and the slider at center', () => {
    expect(studioDoorCenter({ length: 20, studioDoor: 'sliding' })).toBeCloseTo(0)
    expect(studioDoorCenter({ length: 40, studioDoor: 'sliding' })).toBeCloseTo(0)
    expect(studioDoorCenter({ length: 20, studioDoor: 'hinged' })).toBeCloseTo(3.616, 2)
    expect(studioDoorCenter({ length: 40, studioDoor: 'hinged' })).toBeGreaterThan(13)
    expect(entryCenter({ ...fresh(), studioDoor: 'hinged' })).toBeCloseTo(3.616, 2)
  })
  for (const infill of OPENING_INFILLS)
    for (const open of [false, true])
      it(`prices the ${infill.id} infill (${open ? 'open' : 'closed'}) as quote-only`, () => {
        const config: Config = {
          ...setFamily(fresh(), 'container'),
          containerOpening: 'full',
          openingInfill: infill.id,
          doorsOpen: open,
          addons: { deck: true, gazebo: false, roof: true, stairs: true, canopy: true },
          railing: 'cable',
        }
        expect(decodeConfig(encodeConfig(config))).toEqual(config)
        const names = estimate(config).lines.map((line) => line.name)
        if (infill.id !== 'none') expect(names).toContain(`Portfolio: ${infill.name}`)
        expect(names).toEqual(
          expect.arrayContaining([
            'Portfolio: Entry canopy',
            'Portfolio: Rooftop deck',
            'Portfolio: Steel cable rail',
          ]),
        )
        expect(estimate(config).total).toBeNull()
      })
})

describe('signature builds', () => {
  for (const build of SIGNATURES)
    it(`${build.id} is a valid, shareable, collision-free design`, () => {
      expect(configSchema.parse(build.config)).toEqual(build.config)
      expect(layoutIssues(build.config)).toEqual([])
      expect(decodeConfig(encodeConfig(build.config))).toEqual(build.config)
      expect(estimate(build.config).total).toBeNull()
      expect(new Set(build.config.items.map((i) => i.id)).size).toBe(build.config.items.length)
    })
  it('reproduces the photographed builds', () => {
    const by = Object.fromEntries(SIGNATURES.map((s) => [s.id, s.config]))
    expect(by['courtyard-pod']).toMatchObject({
      family: 'studio',
      finish: 'cloud',
      studioDoor: 'hinged',
      environment: 'residences',
    })
    expect(by['campus-pod']).toMatchObject({
      family: 'studio',
      finish: 'graphite',
      studioDoor: 'sliding',
      flooring: 'oak',
      environment: 'campus',
    })
    expect(by.clubhouse).toMatchObject({
      family: 'container',
      finish: 'espresso',
      containerOpening: 'full',
      openingInfill: 'glass-overhead',
      doorsOpen: false,
      interiorStyle: 'timber',
    })
    expect(by.clubhouse.addons.canopy).toBe(true)
    expect(by['garden-pilates']).toMatchObject({
      openingInfill: 'awning',
      doorsOpen: true,
      environment: 'backyard',
    })
    expect(by['garden-pilates'].addons.deck).toBe(true)
    expect(by.rooftop).toMatchObject({ railing: 'cable', doorsOpen: true, mirror: true })
    expect(by.rooftop.addons).toMatchObject({ roof: true, stairs: true })
  })
})

describe('sharing and browser persistence', () => {
  /** A payload as version 1 or 2 stored it: no portfolio fields, no canopy. */
  const legacy = (v: 1 | 2 = 1) => {
    const value: Record<string, unknown> = {
      ...fresh(),
      v,
      environment: 'courtyard',
      addons: { deck: false, gazebo: false, roof: false, stairs: false },
    }
    const removed = ['openingInfill', 'studioDoor', 'doorsOpen', 'railing', 'interiorStyle']
    if (v === 1) removed.push('family', 'studioLayout', 'containerOpening', 'integratedFinish')
    for (const key of removed) delete value[key]
    return value
  }
  /** What a legacy Studio becomes: a centered slider and the original slatted interior. */
  const upgraded = (addons: Config['addons']): Config => ({
    ...fresh(),
    environment: 'courtyard',
    studioDoor: 'sliding',
    interiorStyle: 'slatted',
    addons,
  })
  it('migrates version 1 links, drafts, and saved builds as Studios without losing choices', () => {
    const old = {
      ...legacy(),
      accent: true,
      addons: { deck: true, gazebo: true, roof: true, stairs: true },
    }
    const migrated = { ...upgraded({ ...old.addons, canopy: false }), accent: true }
    expect(decodeConfig(encoded(old))).toEqual(migrated)
    localStorage.setItem('fury-draft-v1', encoded(old))
    expect(initialConfig().config).toEqual(migrated)
    localStorage.setItem(
      'fury-builds-v1',
      JSON.stringify([{ id: 'old', name: 'Legacy Studio', date: '2026-10-10', config: old }]),
    )
    expect(readSaved()[0].config).toEqual(migrated)
  })
  it('migrates version 2 Containers with their opening shown open and layouts intact', () => {
    const old = {
      ...legacy(2),
      family: 'container',
      containerOpening: 'partial',
      items: packageItems('cardio', 20),
    }
    const migrated = decodeConfig(encoded(old))!
    expect(migrated).not.toBeNull()
    expect(migrated.v).toBe(3)
    expect(migrated.openingInfill).toBe('none')
    expect(migrated.doorsOpen).toBe(true)
    expect(migrated.items).toEqual(old.items)
    expect(decodeConfig(encoded(legacy(2)))!.studioDoor).toBe('sliding')
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
    expect(initialConfig().config.finish).toBe('chalk')
    expect(localStorage.getItem('fury-draft-v1')).toBe(
      encodeConfig({ ...fresh(), finish: 'chalk' }),
    )
    window.location.hash = '#c='
    expect(initialConfig().config.finish).toBe('chalk')
    expect(initialConfig().notice).toContain('previous draft is safe')
  })
  it('saves named builds and safely rejects corrupted storage', () => {
    const builds = [{ id: 'one', name: 'Courtyard', date: '2026-10-14', config: fresh() }]
    writeSaved(builds)
    expect(readSaved()).toEqual(builds)
    localStorage.setItem('fury-builds-v1', '{')
    expect(readSaved()).toEqual([])
  })
  it('keeps every readable build when one stored entry is not', () => {
    const good = { id: 'one', name: 'Courtyard', date: '2026-10-14', config: fresh() }
    const bad = { id: 'two', name: 'From a newer version', date: '2026-10-14', config: { v: 9 } }
    localStorage.setItem('fury-builds-v1', JSON.stringify([bad, good]))
    expect(readSaved()).toEqual([good])
  })
  it('never deletes entries it cannot read when saving', () => {
    const bad = { id: 'two', name: 'From a newer version', date: '2026-10-14', config: { v: 9 } }
    localStorage.setItem('fury-builds-v1', JSON.stringify([bad]))
    const good = { id: 'one', name: 'Courtyard', date: '2026-10-14', config: fresh() }
    writeSaved([good])
    expect(JSON.parse(localStorage.getItem('fury-builds-v1')!)).toEqual([good, bad])
    expect(readSaved()).toEqual([good])
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
  it.each([0, 8, 12, 16, 20, 24, 28, 32, 36])(
    'keeps each final link and its disclaimer together after %i lines of notes',
    async (lines) => {
      const doc = await createBrief(fresh(), null, {
        name: 'Pagination regression',
        notes: 'Project detail.\n'.repeat(lines),
      })
      const streams = [...doc.output().matchAll(/stream\n([\s\S]*?)\nendstream/g)]
      const continuation = streams.find((stream) => stream[1].includes('Continue this design'))?.[1]
      expect(continuation).toContain('Open the interactive configuration')
      expect(continuation).toContain('The link works wherever')
      expect(continuation).toContain('sales team.')
      const inquiry = streams.find((stream) => stream[1].includes('Request an official quote'))?.[1]
      expect(inquiry).toContain('Start a project with Fury Co Gyms')
      expect(inquiry).toContain('Opening this link does not send your design.')
      expect(inquiry).toContain('https://www.furycogyms.com/gym-design/studio')
    },
  )
})
