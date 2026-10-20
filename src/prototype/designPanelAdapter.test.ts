import { describe, expect, it } from 'vitest'
import type { ConfigPanelChange } from '../components/ConfigPanelView'
import { defaultDesign, parseDesign, serializeDesign } from '../domain/design'
import { applyDesignCommand, transitionDesign } from '../domain/designTransitions'
import { designPanelAction } from './designPanelAdapter'

const studio = defaultDesign()
const container = defaultDesign({ family: 'container', lengthFt: 20 })

describe('canonical v4 panel adapter', () => {
  it.each([
    { field: 'items', value: [] },
    { field: 'package', value: 'strength' },
    { field: 'studioLayout', value: 'stacked' },
    { field: 'environment', value: 'backyard' },
    { field: 'time', value: 14 },
    { field: 'lights', value: true },
    { field: 'quality', value: 'ultra' },
    { field: 'unknown', value: 'future' },
  ])('rejects unsupported $field intents instead of coercing a Config', (unsupported) => {
    expect(() => designPanelAction(studio, unsupported as ConfigPanelChange)).toThrow(
      'Unsupported image-first panel field',
    )
  })

  it.each([
    { field: 'containerOpening', value: 'center' },
    { field: 'integratedFinish', value: true },
    { field: 'openingInfill', value: 'awning' },
  ] as const)('rejects Container-only $field on Studio', (change) => {
    expect(() => designPanelAction(studio, change)).toThrow()
  })

  it('rejects Studio-only fields, roll-up infill and inoperable door pose, including would-be no-ops', () => {
    expect(() => designPanelAction(container, { field: 'studioDoor', value: 'hinged' })).toThrow()
    expect(() => designPanelAction(container, { field: 'accent', value: false })).toThrow()
    expect(() => designPanelAction(container, { field: 'openingInfill', value: 'none' })).toThrow()
    const openSide = transitionDesign(container, {
      type: 'update-structure',
      patch: { kind: 'container', opening: 'full' },
    }).next
    expect(() => designPanelAction(openSide, { field: 'doorsOpen', value: false })).toThrow(
      'no operable door',
    )
    expect(() =>
      designPanelAction(studio, {
        field: 'doorsOpen',
        value: 'open',
      } as unknown as ConfigPanelChange),
    ).toThrow('boolean intent')
  })

  it('does not relax strict action/schema validation or permit unknown equipment/additions', () => {
    expect(() =>
      designPanelAction(studio, {
        field: 'finish',
        value: 'invented',
      } as unknown as ConfigPanelChange),
    ).toThrow()
    expect(() =>
      designPanelAction(studio, { field: 'addon', value: 'rack' } as unknown as ConfigPanelChange),
    ).toThrow()
    const incompatible = designPanelAction(container, { field: 'addon', value: 'gazebo' })
    expect(() => transitionDesign(container, incompatible)).toThrow('not modeled for container')
    expect(() =>
      designPanelAction(studio, { field: 'length', value: 30 } as unknown as ConfigPanelChange),
    ).toThrow()
  })

  it('leaves family-reset confirmation, full-schema adjustments and atomic command application to the domain', () => {
    const previous = parseDesign({
      ...studio,
      config: {
        ...studio.config,
        structure: {
          ...studio.config.structure,
          door: 'sliding',
          addons: ['roof', 'gazebo'],
          railing: 'cable',
        },
        appearance: { ...studio.config.appearance, accent: true, interior: 'birch', mirror: true },
      },
      presentation: { ...studio.presentation, doorPose: 'open', aspect: 'tall' },
      outputProfile: 'web-thumbnail',
    })
    const original = serializeDesign(previous)
    const action = designPanelAction(previous, { field: 'family', value: 'container' })
    expect(action).toEqual({ type: 'set-product', product: { family: 'container', lengthFt: 20 } })
    const transition = transitionDesign(previous, action)
    expect(transition.requiresConfirmation).toBe(true)
    expect(transition.adjustments.join(' ')).toContain('gazebo')
    expect(transition.adjustments.join(' ')).toContain('accent')
    expect(() => applyDesignCommand(previous, transition.command)).toThrow('explicit confirmation')
    const next = applyDesignCommand(previous, transition.command, true)
    expect(next.config.structure).toEqual({
      kind: 'container',
      opening: 'roll-up',
      infill: 'none',
      integratedFinish: false,
      addons: ['roof'],
      railing: 'cable',
    })
    expect(next.config.appearance).toEqual({ ...previous.config.appearance, accent: false })
    expect(next.config.arrangementRef).toBe('container-20-review@1')
    expect(next.presentation).toEqual(previous.presentation)
    expect(next.outputProfile).toBe('web-thumbnail')
    expect(serializeDesign(previous)).toBe(original)
    expect(() => applyDesignCommand(next, transition.command, true)).toThrow('design changed')
  })

  it('lets the domain explain infill and door-pose resets as one structural command', () => {
    const previous = parseDesign({
      ...container,
      config: {
        ...container.config,
        structure: { ...container.config.structure, opening: 'center', infill: 'awning' },
      },
      presentation: { ...container.presentation, doorPose: 'open' },
    })
    const opening = designPanelAction(previous, { field: 'containerOpening', value: 'roll-up' })
    expect(opening).toEqual({
      type: 'update-structure',
      patch: { kind: 'container', opening: 'roll-up' },
    })
    const rollup = transitionDesign(previous, opening)
    expect(rollup.requiresConfirmation).toBe(true)
    expect(rollup.adjustments.join(' ')).toContain('Remove the separate infill')
    const infill = designPanelAction(previous, { field: 'openingInfill', value: 'none' })
    expect(infill).toEqual({
      type: 'update-structure',
      patch: { kind: 'container', infill: 'none' },
    })
    const openSide = transitionDesign(previous, infill)
    expect(openSide.requiresConfirmation).toBe(true)
    expect(openSide.next.presentation.doorPose).toBe('closed')
    expect(openSide.adjustments.join(' ')).toContain('Reset door pose')
  })
})
