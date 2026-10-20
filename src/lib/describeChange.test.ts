import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, SIGNATURES, addEquipment, packageItems, setFamily } from './config'
import { clockTime, describeChange } from './describeChange'

const base = DEFAULT_CONFIG

describe('describing an edit', () => {
  it('names the option picked, and the field and value for its swatch', () => {
    expect(describeChange(base, { ...base, finish: 'graphite' })).toEqual({
      label: 'Graphite',
      field: 'finish',
      value: 'graphite',
    })
    expect(describeChange(base, { ...base, flooring: 'oak' })).toMatchObject({
      label: 'Oak look',
      field: 'flooring',
      value: 'oak',
    })
    expect(describeChange(base, { ...base, interiorStyle: 'timber' }).label).toBe('Warm cedar')
    expect(describeChange(base, { ...base, environment: 'desert' })).toMatchObject({
      label: 'Desert retreat',
      field: 'environment',
    })
  })

  it('reads toggles and the time of day as phrases', () => {
    expect(describeChange(base, { ...base, mirror: true }).label).toBe('the mirror wall')
    expect(describeChange(base, { ...base, time: 19.5 }).label).toBe('the 7:30 pm light')
    const deck = { ...base, addons: { ...base.addons, deck: true } }
    expect(describeChange(base, deck)).toEqual({
      label: 'the front deck',
      field: 'addons',
      value: null,
    })
  })

  it('names a package rather than the equipment it lays out, and equipment added as such', () => {
    const recovery = { ...base, package: 'recovery' as const, items: packageItems('recovery', 20) }
    expect(describeChange(base, recovery)).toMatchObject({
      label: 'Recovery',
      field: 'package',
      value: 'recovery',
    })
    const added = addEquipment(base, 'medball')!
    expect(describeChange(base, added).label).toBe('your equipment')
  })

  it('names a family change by the family, whatever else it resets', () => {
    expect(describeChange(base, setFamily(base, 'container'))).toMatchObject({
      label: 'the Container',
      field: 'family',
    })
  })

  it('calls a wider change, like a signature build, your design', () => {
    expect(describeChange(base, SIGNATURES[1].config)).toEqual({
      label: 'your design',
      field: null,
      value: null,
    })
  })

  it("is your gym for the page's first design, or no change", () => {
    expect(describeChange(null, base).label).toBe('your gym')
    expect(describeChange(base, { ...base }).label).toBe('your gym')
  })

  it('tells the time as a clock does', () => {
    expect(clockTime(16.5)).toBe('4:30 pm')
    expect(clockTime(6)).toBe('6:00 am')
    expect(clockTime(12.25)).toBe('12:15 pm')
    expect(clockTime(21)).toBe('9:00 pm')
  })
})
