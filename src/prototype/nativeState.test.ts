// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, serializeDesign } from '../domain/design'
import { designHistory, initialNativeHistory, rememberNativeSelection } from './state'
import { normalizeCustomerDesign } from '../render-library/views'
import { transitionDesign } from '../domain/designTransitions'
import { identityPayload } from '../render-library/identity'

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/?experience=library')
})
afterEach(() => vi.unstubAllGlobals())
it('starts new native selections at Studio Day and restores the exact previous selected scene', () => {
  expect(initialNativeHistory().present.presentation.lookRef).toBe('studio-day-draft@1')
  const night = parseDesign({
    ...defaultDesign(),
    presentation: {
      ...defaultDesign().presentation,
      lookRef: 'desert-night-draft@1',
      cameraRef: 'entry-draft@1',
      aspect: 'tall',
    },
  })
  rememberNativeSelection(night)
  expect(initialNativeHistory().present).toEqual(night)
  expect(localStorage.getItem('fury-draft-v1')).toBeNull()
})
it('honors shared scenes over local selection, normalizing only historical camera/neutral-studio aliases', () => {
  rememberNativeSelection(defaultDesign())
  const shared = parseDesign({
    ...defaultDesign(),
    presentation: {
      ...defaultDesign().presentation,
      lookRef: 'campus-night-draft@1',
      cameraRef: 'centre-draft@1',
      aspect: 'tall',
    },
  })
  window.location.hash = '#fury-v4=' + encodeURIComponent(serializeDesign(shared))
  expect(initialNativeHistory().present).toEqual({
    ...shared,
    presentation: { ...shared.presentation, cameraRef: 'entry-draft@1' },
  })
})
it('keeps malformed/future local selections non-authoritative and handles unavailable storage', () => {
  localStorage.setItem('fury-native-selected-v1', '{"schemaVersion":999}')
  expect(initialNativeHistory().present).toEqual(defaultDesign())
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('Denied')
    },
    setItem() {
      throw new Error('Denied')
    },
  })
  expect(() => rememberNativeSelection(defaultDesign())).not.toThrow()
  expect(initialNativeHistory().present).toEqual(defaultDesign())
})
it('returns to the edited design rather than the old shared URL after leaving and reloading', () => {
  const original = defaultDesign()
  window.location.hash = '#fury-v4=' + encodeURIComponent(serializeDesign(original))
  expect(initialNativeHistory().present).toEqual(original)
  const edited = parseDesign({
    ...original,
    config: {
      ...original.config,
      appearance: { ...original.config.appearance, finish: 'bronze' },
    },
    presentation: { ...original.presentation, cameraRef: 'entry-draft@1' },
  })
  rememberNativeSelection(edited)
  expect(initialNativeHistory().present).toEqual(edited)
  localStorage.clear()
  expect(initialNativeHistory().present).toEqual(edited)
})
it('does not overwrite unsupported shared data when remembering the current selection', () => {
  window.location.hash = '#fury-v4=%broken'
  rememberNativeSelection(defaultDesign())
  expect(window.location.hash).toBe('#fury-v4=%broken')
})
it('preserves an incoming shared design during edits until it has been imported', () => {
  const original = defaultDesign()
  let managedHash = rememberNativeSelection(original)
  const incoming = defaultDesign({ family: 'container', lengthFt: 40 })
  const incomingHash = '#fury-v4=' + encodeURIComponent(serializeDesign(incoming))
  window.location.hash = incomingHash
  const edited = parseDesign({
    ...original,
    presentation: { ...original.presentation, cameraRef: 'entry-draft@1' },
  })
  managedHash = rememberNativeSelection(edited, managedHash)
  expect(window.location.hash).toBe(incomingHash)
  expect(initialNativeHistory().present).toEqual(normalizeCustomerDesign(incoming))
  managedHash = rememberNativeSelection(incoming, managedHash)
  expect(readURIComponentHash(managedHash)).toEqual(normalizeCustomerDesign(incoming))
  const importedEdit = parseDesign({
    ...incoming,
    presentation: { ...incoming.presentation, cameraRef: 'entry-draft@1' },
  })
  rememberNativeSelection(importedEdit, managedHash)
  expect(initialNativeHistory().present).toEqual(normalizeCustomerDesign(importedEdit))
})

function readURIComponentHash(hash: string) {
  return JSON.parse(decodeURIComponent(hash.slice('#fury-v4='.length)))
}

it.each([20, 40] as const)(
  'opens saved and shared %s ft Container doors without rewriting source data',
  (lengthFt) => {
    const closed = defaultDesign({ family: 'container', lengthFt })
    const source = serializeDesign(closed)
    localStorage.setItem('fury-native-selected-v1', source)
    expect(initialNativeHistory().present.presentation.doorPose).toBe('open')
    expect(localStorage.getItem('fury-native-selected-v1')).toBe(source)
    window.location.hash = '#fury-v4=' + encodeURIComponent(source)
    expect(initialNativeHistory().present.presentation.doorPose).toBe('open')
    expect(serializeDesign(closed)).toBe(source)
  },
)

it('keeps Container doors open across family changes, opening changes, undo and redo', () => {
  let history = initialNativeHistory()
  const commit = (design: ReturnType<typeof defaultDesign>) => {
    history = designHistory(history, { type: 'commit', design })
  }
  commit(
    transitionDesign(history.present, {
      type: 'set-product',
      product: { family: 'container', lengthFt: 40 },
    }).next,
  )
  expect(history.present.presentation.doorPose).toBe('open')
  commit(
    transitionDesign(history.present, {
      type: 'update-structure',
      patch: { kind: 'container', opening: 'full', infill: 'none' },
    }).next,
  )
  expect(history.present.presentation.doorPose).toBe('closed') // Neutral pose: no physical door.
  commit(
    transitionDesign(history.present, {
      type: 'update-structure',
      patch: { kind: 'container', infill: 'awning' },
    }).next,
  )
  expect(history.present.presentation.doorPose).toBe('open')
  history = designHistory(history, { type: 'undo' })
  expect(history.present.config.structure).toMatchObject({ infill: 'none' })
  history = designHistory(history, { type: 'redo' })
  expect(history.present.presentation.doorPose).toBe('open')
  commit(
    transitionDesign(history.present, {
      type: 'update-presentation',
      patch: { doorPose: 'closed' },
    }).next,
  )
  expect(history.present.presentation.doorPose).toBe('open')
})

it.each([20, 40] as const)(
  'restores the exact cached Studio %s identity after visiting Container',
  (lengthFt) => {
    const original = defaultDesign({ family: 'studio', lengthFt })
    let history = { past: [], present: original, future: [] } as ReturnType<
      typeof initialNativeHistory
    >
    for (const family of ['container', 'studio'] as const) {
      const transition = transitionDesign(history.present, {
        type: 'set-product',
        product: { family, lengthFt },
      })
      history = designHistory(history, { type: 'commit', design: transition.next })
      expect(history.present.presentation.doorPose).toBe(family === 'container' ? 'open' : 'closed')
    }
    expect(history.present).toEqual(original)
    expect(identityPayload(history.present, 'set')).toBe(identityPayload(original, 'set'))
    history = designHistory(history, { type: 'undo' })
    expect(history.present.config.product.family).toBe('container')
    expect(history.present.presentation.doorPose).toBe('open')
    history = designHistory(history, { type: 'redo' })
    expect(history.present).toEqual(original)
  },
)

it('preserves intentionally open Studio doors across edits, size changes and saved selections', () => {
  const open = parseDesign({
    ...defaultDesign(),
    presentation: { ...defaultDesign().presentation, doorPose: 'open' },
  })
  const resized = transitionDesign(open, {
    type: 'set-product',
    product: { family: 'studio', lengthFt: 40 },
  }).next
  expect(resized.presentation.doorPose).toBe('open')
  rememberNativeSelection(resized)
  expect(initialNativeHistory().present).toEqual(resized)
})
