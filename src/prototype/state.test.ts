import { describe, expect, it } from 'vitest'
import { defaultDesign, serializeDesign } from '../domain/design'
import { applyDesignCommand, transitionDesign } from '../domain/designTransitions'
import { createPresentationFixtures } from '../domain/designFixtures'
import { designHistory, initialHistory, prototypeLink, readPrototypeShare } from './state'

describe('full v4 prototype history and share authority', () => {
  it('round trips every proposed family/size/look/camera/aspect composition', () => {
    for (const design of createPresentationFixtures(true)) {
      const link = new URL(prototypeLink(design, 'http://localhost/?cloud=unsafe&bake=1#old'))
      expect(link.search).toBe('?prototype=images')
      expect(readPrototypeShare(link.hash)).toEqual({ status: 'ready', raw: link.hash, design })
    }
  })
  it.each(['#legacy=raw', '#fury-v4=%ZZ', '#fury-v4=%7B', '#fury-v4=' + 'x'.repeat(65536)])(
    'preserves an invalid exact raw fragment (%#)',
    (raw) => {
      expect(readPrototypeShare(raw)).toEqual({ status: 'invalid', raw })
    },
  )
  it('rejects future versions, unknown keys and an editable equipment payload', () => {
    const base = defaultDesign()
    for (const input of [
      { ...base, config: { ...base.config, schemaVersion: 999 } },
      { ...base, config: { ...base.config, items: [] } },
      { ...base, presentation: { ...base.presentation, cameraRef: 'custom' } },
    ]) {
      const raw = '#fury-v4=' + encodeURIComponent(JSON.stringify(input))
      expect(readPrototypeShare(raw)).toEqual({ status: 'invalid', raw })
    }
  })
  it('retains all appearance, structure and presentation fields through one-step undo/redo', () => {
    let history = initialHistory()
    const previous = history.present
    const proposal = transitionDesign(previous, {
      type: 'set-product',
      product: { family: 'container', lengthFt: 40 },
    })
    history = designHistory(history, {
      type: 'commit',
      design: applyDesignCommand(previous, proposal.command, true),
    })
    const after = serializeDesign(history.present)
    expect(history.past).toHaveLength(1)
    history = designHistory(history, { type: 'undo' })
    expect(history.present).toEqual(previous)
    history = designHistory(history, { type: 'redo' })
    expect(serializeDesign(history.present)).toBe(after)
    const unchanged = designHistory(history, { type: 'commit', design: history.present })
    expect(unchanged).toBe(history)
    history = designHistory(designHistory(history, { type: 'undo' }), {
      type: 'commit',
      design: defaultDesign({ family: 'studio', lengthFt: 40 }),
    })
    expect(history.future).toHaveLength(0)
  })
})
