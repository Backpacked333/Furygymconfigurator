// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { captureCapability, type CaptureProvider } from '../lib/capture'
import { DEFAULT_CONFIG } from '../lib/config'
import { createPresentationStore } from '../lib/presentation'
import ImageExportControls from './ImageExportControls'

describe('budget-derived image alternatives', () => {
  it.each(['current', 'presentation'] as const)(
    'keeps the selected %s alternative usable and accurately labeled',
    async (mode) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const state = createPresentationStore({
        token: {
          revision: 1,
          generation: 1,
          view: 'exterior',
          camera: 'fixed',
          material: 'ready',
          presentation: 'day',
          quality: 'lite',
          preview: false,
        },
        stage: 'settled',
        reasons: [],
        animating: false,
        rendered: { width: 1600, height: 900 },
      })
      const provider: CaptureProvider = {
        generation: 1,
        getState: state.get,
        subscribe: state.subscribe,
        preflight: (size) =>
          captureCapability(size, {
            backend: 'webgl2',
            hardware: 'software',
            maxTextureSize: 4096,
            memoryBudgetMB: 16,
          }),
        capture: async () => ({
          status: 'unavailable',
          reason: 'This test does not capture pixels.',
        }),
      }
      try {
        await act(async () =>
          root.render(
            <ImageExportControls
              context={{
                config: DEFAULT_CONFIG,
                revision: 1,
                getProvider: () => provider,
                blocked: false,
              }}
              presentation={state.get()}
              onClose={vi.fn()}
            />,
          ),
        )
        if (mode === 'presentation') {
          await act(async () => {
            const select = host.querySelector('select')!
            select.value = 'presentation'
            select.dispatchEvent(new Event('change', { bubbles: true }))
          })
        }
        const alternative = [...host.querySelectorAll('button')].find((button) =>
          button.textContent?.startsWith('Use '),
        )!
        expect(alternative).toBeDefined()
        const label = alternative.textContent!.replace('Use ', '')
        await act(async () => alternative.click())
        const save = [...host.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Save image'),
        )!
        expect(save.disabled).toBe(false)
        expect(host.querySelector('[role="status"]')?.textContent).toContain(
          `${label} rendered pixels`,
        )
        if (mode === 'presentation') {
          const selected = host.querySelectorAll('select')[1]
          expect(selected.selectedOptions[0]?.textContent).toBe(label)
        }
      } finally {
        await act(async () => root.unmount())
        host.remove()
        vi.unstubAllGlobals()
      }
    },
  )
})
