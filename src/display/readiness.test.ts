import { describe, expect, it } from 'vitest'
import { DISPLAY_READY_PARTS } from './session'
import { DisplayReadiness } from './readiness'

describe('revision-scoped display readiness (no GPU)', () => {
  it('requires every current resource, quiet time and 40+2 actual completed frames', () => {
    const gate = new DisplayReadiness()
    gate.begin(1, 0)
    for (const part of DISPLAY_READY_PARTS.slice(0, -1)) gate.complete(part, 1, 0)
    expect(gate.frame(1, 1000)).toBe(false)
    gate.complete('pipeline-warm', 1, 1000)
    expect(gate.frame(1, 1499)).toBe(false)
    for (let i = 0; i < 41; i++) expect(gate.frame(1, 1500 + i)).toBe(false)
    expect(gate.frame(1, 1541)).toBe(true)
    expect(gate.receipt()).toEqual({
      revision: 1,
      resources: 'all-current-revision',
      temporalFrames: 40,
      postReadyFrames: 2,
    })
  })
  it('cannot carry A readiness to B or let late A events complete B (including A→B→A)', () => {
    const gate = new DisplayReadiness()
    gate.begin(1, 0)
    for (const part of DISPLAY_READY_PARTS) gate.complete(part, 1, 0)
    gate.begin(2, 100)
    for (const part of DISPLAY_READY_PARTS) expect(gate.complete(part, 1, 101)).toBe(false)
    expect(gate.frame(1, 102)).toBe(false)
    expect(gate.frame(2, 1000)).toBe(false)
    expect(() => gate.receipt()).toThrow()
    gate.begin(3, 1001)
    expect(gate.complete('react-commit', 1, 1002)).toBe(false)
    expect(() => gate.begin(1, 1003)).toThrow()
  })
  it('late material/probe invalidation resets temporal accumulation', () => {
    const gate = new DisplayReadiness()
    gate.begin(1, 0)
    for (const part of DISPLAY_READY_PARTS) gate.complete(part, 1, 0)
    for (let i = 0; i < 42; i++) gate.frame(1, 500 + i)
    gate.invalidate('materials', 1, 600)
    expect(() => gate.receipt()).toThrow()
    gate.complete('materials', 1, 601)
    expect(gate.frame(1, 1100)).toBe(false)
    for (let i = 0; i < 41; i++) expect(gate.frame(1, 1101 + i)).toBe(false)
    expect(gate.frame(1, 1142)).toBe(true)
  })
  it('frame exhaustion poisons reuse; a backwards clock also rejects', () => {
    const gate = new DisplayReadiness()
    gate.begin(1, 0)
    for (let i = 0; i < 240; i++) gate.frame(1, i)
    expect(() => gate.frame(1, 240)).toThrow('cap')
    expect(() => gate.begin(2, 241)).toThrow()
    const other = new DisplayReadiness()
    other.begin(1, 100)
    expect(() => other.complete('materials', 1, 99)).toThrow('clock')
  })
})
