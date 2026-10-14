import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  changeFamily,
  decodeConfig,
  encodeConfig,
  estimate,
  type Config,
} from './config'
import { configReducer, type EditState, type EditToken } from './editTransactions'
import { FEATURE_EVIDENCE, featureEvidence, OPENING_CONCEPTS } from './products'

const initial = (): EditState => ({
  past: [],
  present: structuredClone(DEFAULT_CONFIG),
  future: [],
  notice: '',
  revision: 0,
})
const token: EditToken = { id: 'gesture', baseRevision: 0 }
const chalk: Config = { ...DEFAULT_CONFIG, finish: 'chalk' }

describe('EDIT-01..07 transactions', () => {
  it('keeps a long preview outside committed state/history, then commits once', () => {
    let state = configReducer(initial(), { type: 'begin', token })
    for (let i = 0; i < 100; i++)
      state = configReducer(state, {
        type: 'preview',
        token,
        config: { ...DEFAULT_CONFIG, time: 6 + i / 10 },
      })
    expect(state.present).toEqual(DEFAULT_CONFIG)
    expect(state.revision).toBe(0)
    expect(state.past).toEqual([])
    const preview = state.preview!.config
    state = configReducer(state, { type: 'commit', token })
    expect(state.present).toEqual(preview)
    expect(state.revision).toBe(1)
    expect(state.past).toEqual([DEFAULT_CONFIG])
    expect(state.preview).toBeUndefined()
  })
  it('preserves redo on preview cancel and semantic no-ops, including synthetic custom tags', () => {
    let state = configReducer(initial(), { type: 'set', config: chalk })
    state = configReducer(state, { type: 'undo' })
    const revision = state.revision
    const noop = configReducer(state, {
      type: 'set',
      config: { ...DEFAULT_CONFIG, package: 'custom' },
    })
    expect(noop).toBe(state)
    expect(noop.future).toEqual([chalk])
    const nextToken = { ...token, baseRevision: revision! }
    state = configReducer(state, { type: 'begin', token: nextToken })
    state = configReducer(state, { type: 'preview', token: nextToken, config: chalk })
    state = configReducer(state, { type: 'cancel', token: nextToken })
    expect(state.future).toEqual([chalk])
    expect(state.revision).toBe(revision)
    state = configReducer(state, { type: 'begin', token: nextToken })
    state = configReducer(state, {
      type: 'commit',
      token: nextToken,
      config: { ...DEFAULT_CONFIG, package: 'custom' },
    })
    expect(state.result?.status).toBe('noop')
    expect(state.future).toEqual([chalk])
    expect(state.revision).toBe(revision)
  })
  it('increments revision on undo, redo, and restore while bounding history', () => {
    let state = initial()
    for (let i = 0; i < 75; i++)
      state = configReducer(state, { type: 'set', config: { ...DEFAULT_CONFIG, time: 6 + i / 10 } })
    expect(state.past).toHaveLength(50)
    expect(state.revision).toBe(75)
    state = configReducer(state, { type: 'undo' })
    expect(state.revision).toBe(76)
    state = configReducer(state, { type: 'redo' })
    expect(state.revision).toBe(77)
    state = configReducer(state, { type: 'restore', config: chalk, expectedRevision: 77 })
    expect(state.revision).toBe(78)
    expect(state.past).toEqual([])
  })
  it('rejects stale gestures and exposes rejected raw data without replacing the live document', () => {
    let state = configReducer(initial(), { type: 'begin', token })
    state = configReducer(state, { type: 'set', config: chalk })
    const stale = { ...DEFAULT_CONFIG, time: 10 }
    state = configReducer(state, { type: 'commit', token, config: stale })
    expect(state.present).toEqual(chalk)
    expect(state.revision).toBe(1)
    expect(state.result).toMatchObject({ status: 'conflict', recoveryRaw: JSON.stringify(stale) })
    expect(
      configReducer(state, { type: 'restore', config: DEFAULT_CONFIG, expectedRevision: 0 })
        .present,
    ).toEqual(chalk)
  })
  it('permits geometric previews but rejects invalid commits without a history entry', () => {
    let state = configReducer(initial(), { type: 'begin', token })
    const invalid = { ...DEFAULT_CONFIG, items: [{ ...DEFAULT_CONFIG.items[0], x: 19 }] }
    state = configReducer(state, { type: 'preview', token, config: invalid })
    expect(state.preview?.config.items).toEqual(invalid.items)
    state = configReducer(state, { type: 'commit', token })
    expect(state.result).toMatchObject({ status: 'rejected', recoveryRaw: JSON.stringify(invalid) })
    expect(state.present).toEqual(DEFAULT_CONFIG)
    expect(state.past).toEqual([])
    expect(state.revision).toBe(0)
  })
  it('ignores cancel from another owner and cancels current previews on undo', () => {
    const state = configReducer(initial(), { type: 'begin', token })
    expect(configReducer(state, { type: 'cancel', token: { ...token, id: 'other' } })).toBe(state)
    expect(configReducer(state, { type: 'undo' }).preview).toBeUndefined()
  })
})

describe('REF-05..07 schema and honest metadata', () => {
  it('round-trips every opening, pose, context, and Container concept addition at both lengths', () => {
    for (const length of [20, 40] as const)
      for (const opening of OPENING_CONCEPTS)
        for (const openingPose of ['open', 'closed'] as const)
          for (const context of ['product', 'custom-wellness', 'sunken-lounge'] as const) {
            const config: Config = {
              ...DEFAULT_CONFIG,
              family: 'container',
              length,
              openingConcept: opening.id,
              presentation: { openingPose, context },
              addons: { deck: true, roof: true, stairs: true, gazebo: false },
            }
            expect(decodeConfig(encodeConfig(config))).toEqual(config)
            expect(estimate(config).total).toBeNull()
          }
  })
  it('does not conflate published facts with visual concepts or certify scope', () => {
    expect(new Set(FEATURE_EVIDENCE.map((entry) => entry.id)).size).toBe(FEATURE_EVIDENCE.length)
    expect(new Set(FEATURE_EVIDENCE.map((entry) => entry.category))).toEqual(
      new Set(['published', 'reference', 'illustrative']),
    )
    for (const entry of FEATURE_EVIDENCE) {
      expect(featureEvidence(entry.id)).toEqual(entry)
      if (entry.category === 'published') expect(entry.source).toMatch(/^https:\/\//)
      if (entry.category === 'reference') expect(entry.references.length).toBeGreaterThan(0)
      expect(entry.wording.length).toBeGreaterThan(10)
    }
  })
  it('returns actionable family conflicts without erasing incompatible features', () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      accent: true,
      addons: { ...DEFAULT_CONFIG.addons, gazebo: true },
    }
    expect(changeFamily(config, 'container')).toMatchObject({
      accepted: false,
      config,
      notice: expect.stringContaining('Studio'),
    })
    const container: Config = {
      ...DEFAULT_CONFIG,
      family: 'container',
      openingConcept: 'raised-glazed',
    }
    expect(changeFamily(container, 'studio')).toMatchObject({ accepted: false, config: container })
  })
})
