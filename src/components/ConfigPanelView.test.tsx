// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfigPanel from './ConfigPanel'
import { ConfigPanelView } from './ConfigPanelView'
import { DesignPanel } from '../prototype/DesignPanel'
import { defaultDesign, parseDesign, serializeDesign } from '../domain/design'
import { transitionDesign } from '../domain/designTransitions'
import { SCENE_LANDSCAPES, sceneLook } from '../domain/presentation'
import { arrangementFor } from '../domain/arrangements'
import {
  ADDONS,
  CATALOG,
  DEFAULT_CONFIG,
  ENVIRONMENTS,
  FINISHES,
  FLOORS,
  INTERIORS,
  PACKAGES,
  SIGNATURES,
  layoutIssues,
  packageItems,
  setAddon,
  setFamily,
  type Config,
} from '../lib/config'
import { CONTAINER_OPENINGS, OPENING_INFILLS, STUDIO_DOORS } from '../lib/products'
import { boostOption, focusSection, showSections } from '../render/prefetch'
import { usePendingChoice } from '../render/stillStatus'

vi.mock('./ConfigPanelView', async (original) => {
  const actual = await original<typeof import('./ConfigPanelView')>()
  return { ...actual, ConfigPanelView: vi.fn(actual.ConfigPanelView) }
})
vi.mock('../render/prefetch', () => ({
  boostOption: vi.fn(),
  focusSection: vi.fn(),
  showSections: vi.fn(),
}))
vi.mock('../render/stillStatus', () => ({ usePendingChoice: vi.fn() }))

/** Event/DOM evidence only; this suite does not claim visual or browser parity. */
describe('shared Fury ConfigPanel presentation and its two adapters', () => {
  let host: HTMLDivElement, root: Root
  const onChange = vi.fn(),
    notify = vi.fn(),
    onAction = vi.fn(),
    onPlan = vi.fn()
  const setStep = vi.fn(),
    setUnit = vi.fn(),
    setQuality = vi.fn(),
    setTrace = vi.fn(),
    onSignature = vi.fn()
  const empty = (): Config => ({ ...DEFAULT_CONFIG, items: [], package: 'custom' })
  const legacy = (
    step = 0,
    config = empty(),
    extra: Partial<ComponentProps<typeof ConfigPanel>> = {},
  ) =>
    act(() =>
      root.render(
        <ConfigPanel
          config={config}
          onChange={onChange}
          step={step}
          setStep={setStep}
          unit="ft"
          setUnit={setUnit}
          quality="high"
          setQuality={setQuality}
          trace={false}
          setTrace={setTrace}
          traceSupported
          cloud={false}
          notify={notify}
          onPlan={onPlan}
          onSignature={onSignature}
          {...extra}
        />,
      ),
    )
  const draft = (step = 0, design = defaultDesign()) =>
    act(() =>
      root.render(
        <DesignPanel
          design={design}
          onAction={onAction}
          unit="ft"
          setUnit={setUnit}
          onPlan={onPlan}
          step={step}
          setStep={setStep}
        />,
      ),
    )
  function button(text: string, scope: ParentNode = host) {
    const found = [...scope.querySelectorAll('button')].find(
      (entry) => entry.getAttribute('aria-label') === text || entry.textContent?.includes(text),
    )
    if (!found) throw new Error(`Missing button: ${text}`)
    return found
  }
  const click = (text: string, scope?: ParentNode) => act(() => button(text, scope).click())
  const group = (label: string) => host.querySelector(`[role="group"][aria-label="${label}"]`)!
  const latestProps = () => vi.mocked(ConfigPanelView).mock.calls.at(-1)![0]
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.mocked(usePendingChoice).mockReturnValue(null)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the same actual presenter for both routes, preserving cards, Elevation, headings and footer', () => {
    legacy()
    expect(ConfigPanelView).toHaveBeenCalled()
    expect(latestProps().interactions).toBeDefined()
    expect(host.querySelectorAll('.family-card')).toHaveLength(2)
    expect(host.querySelectorAll('.size-card .mini-studio')).toHaveLength(2)
    expect(host.querySelectorAll('.signature-card')).toHaveLength(SIGNATURES.length)
    expect(host.textContent).toContain('Family from')
    expect(host.querySelector('.panel-next')?.textContent).toContain('MAKE ROOM FOR MORE.')
    vi.mocked(ConfigPanelView).mockClear()
    draft()
    expect(ConfigPanelView).toHaveBeenCalled()
    expect(latestProps().interactions).toBeUndefined()
    expect(latestProps().equipmentCatalog).toBeUndefined()
    expect(latestProps().renderSettings).toBeUndefined()
    expect(host.querySelectorAll('.family-card')).toHaveLength(2)
    expect(host.querySelectorAll('.size-card .mini-studio')).toHaveLength(2)
    expect(host.querySelectorAll('.signature-card')).toHaveLength(0)
    expect(host.textContent).not.toContain('Family from')
    expect(host.querySelector('.panel-next')?.textContent).toContain('MAKE ROOM FOR MORE.')
    expect(host.querySelectorAll('[role=tab]')).toHaveLength(4)
    expect(host.textContent).toContain('inquiry only')
    expect(host.querySelector('select')).toBeNull()
  })

  it('retains legacy family/size, inquiry and signature callbacks without importing them into v4', () => {
    const c = empty()
    legacy(0, c)
    click('Container Gym')
    expect(onChange).toHaveBeenLastCalledWith(setFamily(c, 'container'))
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining('Family-specific openings, doors, and additions are reset'),
    )
    click('40 ft Studio')
    expect(onChange).toHaveBeenLastCalledWith({ ...c, length: 40 })
    const select = host.querySelector('select')!
    act(() => {
      select.value = 'stacked'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({ ...c, studioLayout: 'stacked' })
    click(SIGNATURES[0].name)
    expect(onSignature).toHaveBeenLastCalledWith(SIGNATURES[0].id)
    legacy(0, { ...c, studioLayout: 'stacked' })
    expect(host.textContent).toContain('Custom inquiry recorded')
    expect(host.textContent).toContain('not the connected or stacked project')
  })

  it('retains legacy layout guards and explained rejections', () => {
    const c: Config = {
      ...empty(),
      length: 40,
      items: [{ id: 'far', sku: 'mat', x: 15, z: -1, rotation: 90 }],
    }
    legacy(0, c)
    click('20 ft Studio')
    expect(onChange).not.toHaveBeenCalled()
    expect(notify).toHaveBeenLastCalledWith(
      'Your equipment needs more room. Rearrange or remove items in the floor plan before choosing 20 feet.',
    )
    const obstructed: Config = {
      ...empty(),
      items: [{ id: 'blocked', sku: 'rack', x: 0, z: 2, rotation: 0 }],
    }
    legacy(1, obstructed)
    click('Sliding glass door')
    expect(onChange).not.toHaveBeenCalled()
    expect(notify).toHaveBeenLastCalledWith(
      'Rearrange equipment to keep the new door’s entry clear.',
    )
  })

  it('keeps renderer prefetch section, pointer/focus priority and pending ring connected only for v3', () => {
    vi.mocked(usePendingChoice).mockReturnValue({ field: 'finish', value: 'chalk' })
    legacy(1)
    expect(showSections).toHaveBeenLastCalledWith(['studioDoor', 'finish'])
    act(() => button('Chalk').focus())
    expect(focusSection).toHaveBeenLastCalledWith('finish')
    expect(boostOption).toHaveBeenLastCalledWith('finish', 'chalk')
    expect(button('Chalk').querySelector('.swatch-rendering')).not.toBeNull()
    act(() => button('Graphite').dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    expect(boostOption).toHaveBeenLastCalledWith('finish', 'graphite')
    legacy(1, { ...setFamily(empty(), 'container'), containerOpening: 'center' })
    expect(showSections).toHaveBeenLastCalledWith(['containerOpening', 'openingInfill', 'finish'])
    legacy(2)
    expect(showSections).toHaveBeenLastCalledWith(['interiorStyle', 'flooring'])
    legacy(3)
    expect(showSections).toHaveBeenLastCalledWith(['environment'])
    vi.clearAllMocks()
    draft(1)
    act(() => button('Chalk').focus())
    expect(showSections).not.toHaveBeenCalled()
    expect(focusSection).not.toHaveBeenCalled()
    expect(boostOption).not.toHaveBeenCalled()
    expect(usePendingChoice).not.toHaveBeenCalled()
    expect(host.querySelector('.swatch-rendering')).toBeNull()
  })

  it('preserves all legacy finish, door, addition, interior, floor and mirror mutations', () => {
    const c = empty()
    legacy(1, c)
    for (const finish of FINISHES) {
      click(finish.name)
      expect(onChange).toHaveBeenLastCalledWith({ ...c, finish: finish.id })
    }
    for (const door of STUDIO_DOORS) {
      click(door.name)
      expect(onChange).toHaveBeenLastCalledWith({ ...c, studioDoor: door.id })
    }
    click('Show the door open')
    expect(onChange).toHaveBeenLastCalledWith({ ...c, doorsOpen: !c.doorsOpen })
    click('Concept timber accent')
    expect(onChange).toHaveBeenLastCalledWith({ ...c, accent: !c.accent })
    for (const addon of ADDONS.filter((a) =>
      (a.families as readonly string[]).includes('studio'),
    )) {
      click(addon.name)
      expect(onChange).toHaveBeenLastCalledWith(setAddon(c, addon.id).config)
    }
    legacy(1, { ...c, addons: { ...c.addons, roof: true } })
    click('Steel cable rail')
    expect(onChange).toHaveBeenLastCalledWith({
      ...c,
      addons: { ...c.addons, roof: true },
      railing: 'cable',
    })
    legacy(2, c)
    for (const interior of INTERIORS) {
      click(interior.name)
      expect(onChange).toHaveBeenLastCalledWith({ ...c, interiorStyle: interior.id })
    }
    for (const floor of FLOORS) {
      click(floor.name)
      expect(onChange).toHaveBeenLastCalledWith({ ...c, flooring: floor.id })
    }
    click('Concept mirror wall')
    expect(onChange).toHaveBeenLastCalledWith({ ...c, mirror: !c.mirror })
    click('Make it fit your life')
    expect(onPlan).toHaveBeenCalledOnce()
  })

  it('retains legacy Container mutations, including roll-up infill reset', () => {
    const c: Config = {
      ...setFamily(empty(), 'container'),
      containerOpening: 'center',
      openingInfill: 'awning',
    }
    legacy(1, c)
    for (const opening of CONTAINER_OPENINGS) {
      click(opening.name)
      expect(onChange).toHaveBeenLastCalledWith({
        ...c,
        containerOpening: opening.id,
        openingInfill: opening.id === 'roll-up' ? 'none' : c.openingInfill,
      })
    }
    for (const infill of OPENING_INFILLS) {
      click(infill.name, group('Opening infill'))
      expect(onChange).toHaveBeenLastCalledWith({ ...c, openingInfill: infill.id })
    }
    click('Integrated exterior finish')
    expect(onChange).toHaveBeenLastCalledWith({ ...c, integratedFinish: !c.integratedFinish })
    click('Show the sashes propped open')
    expect(onChange).toHaveBeenLastCalledWith({ ...c, doorsOpen: !c.doorsOpen })
  })

  it('retains legacy package confirmation and equipment add callbacks', () => {
    const c = empty()
    const pkg = PACKAGES.find(
      (p) =>
        p.id !== 'empty' &&
        layoutIssues({ ...c, items: packageItems(p.id, c.length) }).length === 0,
    )!
    legacy(2, c)
    click(pkg.name, host.querySelector('.package-options')!)
    expect(onChange).toHaveBeenLastCalledWith({
      ...c,
      package: pkg.id,
      items: packageItems(pkg.id, c.length),
    })
    expect(notify).toHaveBeenLastCalledWith(
      `${pkg.name} layout applied. You can customize every item.`,
    )
    const populated = { ...c, items: packageItems(pkg.id, c.length) }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    legacy(2, populated)
    onChange.mockClear()
    click(pkg.name, host.querySelector('.package-options')!)
    expect(confirm).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    click(pkg.name, host.querySelector('.package-options')!)
    expect(onChange).toHaveBeenLastCalledWith({ ...populated, package: pkg.id })
    legacy(2, c)
    click(CATALOG.find((p) => p.id === 'mat')!.name, host.querySelector('.catalog-details')!)
    expect(onChange.mock.calls.at(-1)![0].items).toEqual([expect.objectContaining({ sku: 'mat' })])
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining('Drag it into place in the floor plan'),
    )
  })

  it('retains legacy environments, units, quality and trace callbacks', () => {
    const c = empty()
    legacy(3, c)
    for (const env of ENVIRONMENTS) {
      click(env.name)
      expect(onChange).toHaveBeenLastCalledWith({ ...c, environment: env.id })
    }
    expect(host.querySelector('input[type=range]')).not.toBeNull()
    click('Architectural lighting')
    expect(onChange).toHaveBeenLastCalledWith({ ...c, lights: !c.lights })
    click('Metric')
    expect(setUnit).toHaveBeenLastCalledWith('m')
    click('Ultra')
    expect(setQuality).toHaveBeenLastCalledWith('ultra')
    click('Path-traced stills')
    expect(setTrace).toHaveBeenLastCalledWith(true)
  })

  it('v4 family and size emit only canonical product requests, without applying resets prematurely', () => {
    const design = defaultDesign()
    const original = serializeDesign(design)
    draft(0, design)
    click('Container Gym')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'set-product',
      product: { family: 'container', lengthFt: 20 },
    })
    expect(transitionDesign(design, onAction.mock.calls.at(-1)![0]).requiresConfirmation).toBe(true)
    click('40 ft Studio')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'set-product',
      product: { family: 'studio', lengthFt: 40 },
    })
    expect(button('20 ft Studio').getAttribute('aria-pressed')).toBe('true')
    expect(serializeDesign(design)).toBe(original)
  })

  it('v4 rich Studio cards emit precise structure and appearance actions', () => {
    const design = defaultDesign()
    draft(1, design)
    for (const door of STUDIO_DOORS) {
      click(door.name)
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-structure',
        patch: { kind: 'studio', door: door.id },
      })
    }
    for (const finish of FINISHES) {
      click(finish.name)
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-appearance',
        patch: { finish: finish.id },
      })
    }
    click('Concept timber accent')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-appearance',
      patch: { accent: true },
    })
    click('Show the door open')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-presentation',
      patch: { doorPose: 'open' },
    })
    for (const addon of ['Front deck', 'Gazebo', 'Rooftop deck', 'Exterior staircase']) {
      click(addon)
      const id = ADDONS.find((a) => a.name === addon)!.id
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-structure',
        patch: { kind: 'studio', addons: [id] },
      })
    }
    const roof = transitionDesign(design, {
      type: 'update-structure',
      patch: { kind: 'studio', addons: ['roof', 'deck'] },
    }).next
    draft(1, roof)
    click('Steel cable rail')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-structure',
      patch: { kind: 'studio', railing: 'cable' },
    })
    click('Front deck')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-structure',
      patch: { kind: 'studio', addons: ['roof'] },
    })
    expect(host.querySelectorAll('.addon')).toHaveLength(4)
    expect(host.querySelectorAll('.finish-swatch')).toHaveLength(FINISHES.length)
  })

  it('v4 Container choices do not silently reset infill or door pose in the adapter', () => {
    const base = defaultDesign({ family: 'container', lengthFt: 20 })
    const design = parseDesign({
      ...base,
      config: {
        ...base.config,
        structure: { ...base.config.structure, opening: 'center', infill: 'awning' },
      },
      presentation: { ...base.presentation, doorPose: 'open' },
    })
    draft(1, design)
    for (const opening of CONTAINER_OPENINGS) {
      click(opening.name)
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-structure',
        patch: { kind: 'container', opening: opening.id },
      })
    }
    for (const infill of OPENING_INFILLS) {
      click(infill.name, group('Opening infill'))
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-structure',
        patch: { kind: 'container', infill: infill.id },
      })
    }
    click('Integrated exterior finish')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-structure',
      patch: { kind: 'container', integratedFinish: true },
    })
    click('Entry canopy')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-structure',
      patch: { kind: 'container', addons: ['canopy'] },
    })
    click('Show the sashes propped open')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-presentation',
      patch: { doorPose: 'closed' },
    })
    const openSide = transitionDesign(design, {
      type: 'update-structure',
      patch: { kind: 'container', infill: 'none' },
    }).next
    draft(1, openSide)
    expect(host.textContent).toContain('Door pose unavailable')
    expect(
      [...host.querySelectorAll('[role=switch]')].some((item) =>
        item.textContent?.includes('Show the'),
      ),
    ).toBe(false)
  })

  it('v4 retains rich interior/floor swatches and replaces editing with fixed inventory and holds', () => {
    draft(2)
    expect(host.querySelectorAll('.interior-swatch')).toHaveLength(INTERIORS.length)
    expect(host.querySelectorAll('.floor-options button')).toHaveLength(FLOORS.length)
    for (const interior of INTERIORS) {
      click(interior.name)
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-appearance',
        patch: { interior: interior.id },
      })
    }
    for (const floor of FLOORS) {
      click(floor.name)
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-appearance',
        patch: { floor: floor.id },
      })
    }
    click('Concept mirror wall')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-appearance',
      patch: { mirror: true },
    })
    click('View read-only plan & inventory')
    expect(onPlan).toHaveBeenCalledOnce()
    expect(host.querySelector('.package-options')).toBeNull()
    expect(host.querySelector('.catalog')).toBeNull()
    expect(host.textContent).not.toContain('Add individual equipment')
    expect(host.textContent).not.toContain('Edit your floor plan')
    expect(host.textContent).toContain('Ceiling, door and access holds remain unresolved')
    for (const item of arrangementFor('studio', 20).items)
      expect(host.textContent).toContain(CATALOG.find((p) => p.id === item.sku)!.name)
    expect(host.textContent).toContain('DRAFT, not an approved build specification')
  })

  it('v4 named look cards, composition and mock profile dispatch actions, with no renderer or arbitrary-light controls', () => {
    draft(3)
    expect(host.querySelectorAll('.environment-card')).toHaveLength(4)
    for (const landscape of SCENE_LANDSCAPES) {
      click(landscape.name)
      expect(onAction).toHaveBeenLastCalledWith({
        type: 'update-presentation',
        patch: { lookRef: sceneLook(landscape.id, 'day') },
      })
    }
    click('Night')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-presentation',
      patch: { lookRef: 'courtyard-night-draft@1' },
    })
    click('Portrait')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'update-presentation',
      patch: { aspect: 'tall' },
    })
    click('Thumbnail diagnostic')
    expect(onAction).toHaveBeenLastCalledWith({
      type: 'set-output-profile',
      outputProfile: 'web-thumbnail',
    })
    click('Metric')
    expect(setUnit).toHaveBeenLastCalledWith('m')
    expect(host.querySelector('input[type=range]')).toBeNull()
    expect(host.querySelector('[role=switch]')).toBeNull()
    expect(
      [...host.querySelectorAll('button')].some((item) =>
        /Ultra|Path-traced|Architectural lighting/.test(item.textContent ?? ''),
      ),
    ).toBe(false)
    expect(showSections).not.toHaveBeenCalled()
    expect(setQuality).not.toHaveBeenCalled()
    expect(setTrace).not.toHaveBeenCalled()
  })

  it('preserves keyboard tabs, focus targets and footer navigation with local or parent-controlled steps', () => {
    act(() =>
      root.render(
        <DesignPanel
          design={defaultDesign()}
          onAction={onAction}
          unit="ft"
          setUnit={setUnit}
          onPlan={onPlan}
        />,
      ),
    )
    const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')]
    act(() => {
      tabs()[0].focus()
      tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(tabs()[3].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[3])
    expect(host.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(
      'prototype-tab-3',
    )
    act(() =>
      tabs()[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    click('Exterior', host.querySelector('.panel-next')!)
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
    draft(2)
    click('Setting', host.querySelector('.panel-next')!)
    expect(setStep).toHaveBeenLastCalledWith(3)
    expect(tabs()[2].getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('#prototype-configuration')?.getAttribute('tabindex')).toBe('-1')
  })
})
