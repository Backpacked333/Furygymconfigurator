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
