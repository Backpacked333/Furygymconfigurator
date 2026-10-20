import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, FINISHES, FLOORS, type Config } from '../lib/config'
import {
  activeSection,
  boostOption,
  focusSection,
  leaveSection,
  prefetchIntent,
  prefetchOn,
  prefetchSiblings,
  resetPrefetchIntent,
  showSections,
  siblingOptions,
} from './prefetch'

describe('what the visitor is choosing between', () => {
  afterEach(() => resetPrefetchIntent())

  it('is the section pointed at, else the first shown whose siblings can be prefetched', () => {
    const hide = showSections(['studioDoor', 'finish'])
    expect(activeSection(prefetchIntent())).toBe('finish')
    focusSection('studioDoor')
    expect(activeSection(prefetchIntent())).toBe('studioDoor')
    // An option pointed at opens its own section, and goes first there.
    boostOption('finish', 'olive')
    expect(prefetchIntent()).toMatchObject({
      focus: 'finish',
      boost: { field: 'finish', value: 'olive' },
    })
    // Another step: what was pointed at before is forgotten.
    const next = showSections(['interiorStyle', 'flooring'])
    expect(prefetchIntent()).toMatchObject({ focus: null, boost: null })
    expect(activeSection(prefetchIntent())).toBe('flooring')
    hide()
    expect(prefetchIntent().sections).toEqual(['interiorStyle', 'flooring'])
    next()
    expect(activeSection(prefetchIntent())).toBeNull()
  })

  it('takes a popover’s section away again when it closes', () => {
    showSections(['finish'])
    focusSection('environment')
    expect(activeSection(prefetchIntent())).toBe('environment')
    leaveSection('environment')
    expect(activeSection(prefetchIntent())).toBe('finish')
  })

  it('changes only when something in it does', () => {
    showSections(['finish'])
    const before = prefetchIntent()
    boostOption('finish', 'olive')
    const after = prefetchIntent()
    expect(after).not.toBe(before)
    boostOption('finish', 'olive')
    focusSection('finish')
    expect(prefetchIntent()).toBe(after)
  })
})

describe('siblings', () => {
  it('are the other options of the section, made as the panel makes them', () => {
    const finishes = siblingOptions(DEFAULT_CONFIG, 'finish')
    expect(finishes.map((o) => o.value)).toEqual(
      FINISHES.map((f) => f.id).filter((id) => id !== DEFAULT_CONFIG.finish),
    )
    for (const option of finishes)
      expect(option.config).toEqual({ ...DEFAULT_CONFIG, finish: option.value })
    expect(siblingOptions(DEFAULT_CONFIG, 'flooring').map((o) => o.value)).toEqual(
      FLOORS.map((f) => f.id).filter((id) => id !== DEFAULT_CONFIG.flooring),
    )
    // Options the design does not offer have none.
    expect(siblingOptions(DEFAULT_CONFIG, 'containerOpening')).toEqual([])
    expect(siblingOptions(DEFAULT_CONFIG, 'openingInfill')).toEqual([])
  })

  it('leave out an option the panel would turn away', () => {
    // A rack in front of the centre bay: the sliding door there would block the entry.
    const blocked: Config = {
      ...DEFAULT_CONFIG,
      items: [{ id: 'r', sku: 'rack', x: 0, z: 1.2, rotation: 0 }],
    }
    expect(siblingOptions(blocked, 'studioDoor')).toEqual([])
    expect(siblingOptions(DEFAULT_CONFIG, 'studioDoor').map((o) => o.value)).toEqual(['sliding'])
  })

  it('come nearest the chosen option first, the one pointed at before all', () => {
    const config = { ...DEFAULT_CONFIG, finish: 'bronze' as const }
    const order = (boost: string | null) =>
      prefetchSiblings(config, {
        sections: ['finish'],
        focus: null,
        boost: boost ? { field: 'finish', value: boost } : null,
      })!.options.map((o) => o.value)
    // obsidian, graphite, espresso, [bronze], olive, cloud, chalk
    expect(order(null)).toEqual(['olive', 'espresso', 'cloud', 'graphite', 'chalk', 'obsidian'])
    expect(order('chalk')).toEqual(['chalk', 'olive', 'espresso', 'cloud', 'graphite', 'obsidian'])
    expect(prefetchSiblings(config, { sections: [], focus: null, boost: null })).toBeNull()
  })

  it('are prefetched only from the cloud, never on Lite, never while baking', () => {
    expect(prefetchOn('high', true, false)).toBe(true)
    expect(prefetchOn('ultra', true, false)).toBe(true)
    expect(prefetchOn('lite', true, false)).toBe(false)
    expect(prefetchOn('high', false, false)).toBe(false)
    expect(prefetchOn('high', true, true)).toBe(false)
  })
})
