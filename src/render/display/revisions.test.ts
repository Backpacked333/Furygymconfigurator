import { describe, expect, it } from 'vitest'
import { DISPLAY_READY_PARTS } from '../../display/session'
import { RevisionResources } from './revisions'

describe('revision-scoped actual resource acknowledgements', () => {
  it('requires all resources then 500ms quiet and 40+2 frames', () => {
    let now = 0
    const state = new RevisionResources(() => now),
      observer = state.begin(1)
    for (const part of DISPLAY_READY_PARTS.filter((p) => p !== 'site-field'))
      observer.complete(part)
    now = 1000
    expect(state.frame()).toBe(false)
    observer.complete('site-field')
    now = 1499
    expect(state.frame()).toBe(false)
    now = 1500
    for (let i = 0; i < 41; i++) expect(state.frame()).toBe(false)
    expect(state.frame()).toBe(true)
    expect(state.gate.receipt()).toEqual({
      revision: 1,
      resources: 'all-current-revision',
      temporalFrames: 40,
      postReadyFrames: 2,
    })
  })
  it('fences old revision AND same-revision obsolete async epoch before callbacks can mutate', () => {
    let now = 0
    const state = new RevisionResources(() => now),
      a = state.begin(1)
    for (const p of DISPLAY_READY_PARTS) a.complete(p)
    const b = state.restart()
    expect(a.active()).toBe(false)
    expect(a.signal.aborted).toBe(true)
    for (const p of DISPLAY_READY_PARTS) a.complete(p)
    now = 1000
    expect(state.frame()).toBe(false)
    expect(state.resourcesReady()).toBe(false)
    for (const p of DISPLAY_READY_PARTS) b.complete(p)
    state.begin(2)
    expect(b.active()).toBe(false)
    for (const p of DISPLAY_READY_PARTS) b.complete(p)
    expect(state.resourcesReady()).toBe(false)
  })
  it('orders actual material application before environment, and environment/field before probes', () => {
    const state = new RevisionResources(() => 0),
      observer = state.begin(1)
    expect(observer.permitted('environment')).toBe(false)
    observer.complete('react-commit')
    observer.complete('materials')
    expect(observer.permitted('environment')).toBe(false)
    observer.complete('site-field')
    expect(observer.permitted('environment')).toBe(true)
    expect(observer.permitted('interior-probe')).toBe(false)
    observer.complete('environment')
    expect(observer.permitted('interior-probe')).toBe(true)
    expect(observer.permitted('site-probe')).toBe(true)
    observer.complete('pipeline-warm')
    observer.invalidate('environment')
    expect(state.has('pipeline-warm')).toBe(false)
  })
  it('bounds resources/frames and permanently poisons failures', () => {
    const state = new RevisionResources(() => 0)
    state.begin(1)
    for (let i = 0; i < 240; i++) state.frame()
    expect(() => state.frame()).toThrow('cap')
    const failed = new RevisionResources(() => 0),
      observer = failed.begin(1)
    observer.fail(new Error('texture failed'))
    expect(observer.active()).toBe(false)
    expect(() => failed.check()).toThrow('poisoned')
    expect(() => failed.begin(2)).toThrow()
  })
})
