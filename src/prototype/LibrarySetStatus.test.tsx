// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LibrarySetStatus } from './LibrarySetStatus'
import { defaultDesign } from '../domain/design'
import { RENDER_CTA, safeError } from '../render-library/contracts'
import { snapshotFixture, queued } from './renderLibraryClient.fixtures'
import type { useLibrarySet } from './useLibrarySet'

let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
async function show(overrides: Partial<ReturnType<typeof useLibrarySet>> = {}, hasImage = false) {
  const library = {
    signature: 'test',
    snapshot: await snapshotFixture(),
    checking: false,
    message: null,
    paused: false,
    uncertain: false,
    submitting: false,
    request: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  }
  await act(async () =>
    root.render(
      <LibrarySetStatus
        design={defaultDesign()}
        library={library}
        catalog={null}
        hasImage={hasImage}
      />,
    ),
  )
  return library
}
it('shows the exact explicit CTA only for an authoritative miss, with five named views', async () => {
  const library = await show()
  expect(host.querySelectorAll('li')).toHaveLength(5)
  expect(host.textContent).toContain('not yet rendered')
  const button = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === RENDER_CTA,
  )!
  expect(button.disabled).toBe(false)
  expect(library.request).not.toHaveBeenCalled()
  act(() => button.click())
  expect(library.request).toHaveBeenCalledOnce()
})
it('never presents lookup failure as a miss or authorizes a render', async () => {
  await show({ snapshot: null, paused: true, message: 'Could not check the library' })
  expect(host.textContent).toContain('not a confirmed cache miss')
  expect(host.textContent).not.toContain(RENDER_CTA)
})
it('shows partial per-view readiness and honest count-based progress alongside a ready image', async () => {
  await show({ snapshot: queued(await snapshotFixture(defaultDesign(), 2)) }, true)
  expect(host.querySelectorAll('li[data-state=ready]')).toHaveLength(2)
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('40')
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-label')).toContain(
    '2/5 images ready',
  )
  expect(host.textContent).toContain('not GPU telemetry')
  expect(host.textContent).not.toContain(RENDER_CTA)
})
it('leaves initial lookup progress indeterminate and disables unavailable or uncertain admission', async () => {
  await show({ snapshot: null, checking: true })
  expect(host.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false)
  const snapshot = await snapshotFixture()
  snapshot.rendering = { status: 'unavailable', reason: safeError('rendering-disabled') }
  await show({ snapshot })
  expect(host.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true)
  expect(host.textContent).toContain('Rendering is not enabled')
  await show({ uncertain: true })
  expect(host.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true)
  expect(host.textContent).toContain('do not submit a new request')
})
