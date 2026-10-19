// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, serializeDesign } from '../domain/design'
import { initialNativeHistory, rememberNativeSelection } from './state'

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
