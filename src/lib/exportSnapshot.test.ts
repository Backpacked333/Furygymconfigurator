import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from './config'
import { exportSnapshot, assertExportCurrent } from './exportSnapshot'
import type { CaptureProvider } from './capture'
import type { PresentationState } from './presentation'

function fixture() {
  const state: PresentationState = {
    stage: 'settled',
    animating: false,
    reasons: [],
    rendered: { width: 1280, height: 720 },
    token: {
      revision: 7,
      generation: 2,
      camera: 'fixed',
      material: '2:19',
      presentation: 'day',
      view: 'exterior',
      quality: 'lite',
      preview: false,
    },
  }
  const provider: CaptureProvider = {
    generation: 2,
    getState: () => state,
    subscribe: () => () => {},
    capture: vi.fn(),
    preflight: vi.fn(),
  }
  return { state, provider }
}

describe('application export snapshot binding', () => {
  it('freezes configuration and token before any asynchronous capture or PDF import', () => {
    const { state, provider } = fixture()
    const config = structuredClone(DEFAULT_CONFIG)
    const snapshot = exportSnapshot(config, 7, provider)
    config.time = 18
    state.token.camera = 'moved'
    expect(snapshot.config.time).toBe(DEFAULT_CONFIG.time)
    expect(snapshot.token?.camera).toBe('fixed')
    expect(() =>
      assertExportCurrent(snapshot, 7, provider, false, new AbortController().signal),
    ).toThrow('view changed')
  })
  it('rejects stale captures even if undo returns to identical document bytes', () => {
    const { provider } = fixture()
    const snapshot = exportSnapshot(DEFAULT_CONFIG, 7, provider)
    expect(() =>
      assertExportCurrent(snapshot, 9, provider, false, new AbortController().signal),
    ).toThrow('design changed')
  })
  it('rejects replaced and lost renderers and pre-preview exports', () => {
    const { state, provider } = fixture()
    const snapshot = exportSnapshot(DEFAULT_CONFIG, 7, provider)
    const signal = new AbortController().signal
    expect(() => assertExportCurrent(snapshot, 7, null, false, signal)).toThrow('view changed')
    expect(() => assertExportCurrent(snapshot, 7, provider, true, signal)).toThrow('design changed')
    state.stage = 'lost'
    expect(() => assertExportCurrent(snapshot, 7, provider, false, signal)).toThrow('view changed')
  })
  it('permits explicitly image-free PDF generation without a renderer', () => {
    const snapshot = exportSnapshot(DEFAULT_CONFIG, 7, null)
    expect(() =>
      assertExportCurrent(snapshot, 7, null, false, new AbortController().signal),
    ).not.toThrow()
  })
  it('checks cancellation again after PDF/image generation before download', () => {
    const snapshot = exportSnapshot(DEFAULT_CONFIG, 7, null)
    const controller = new AbortController()
    controller.abort()
    expect(() => assertExportCurrent(snapshot, 7, null, false, controller.signal)).toThrow(
      'No file was downloaded',
    )
  })
})
