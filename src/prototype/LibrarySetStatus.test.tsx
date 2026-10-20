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
async function show(
  overrides: Partial<ReturnType<typeof useLibrarySet>> = {},
  hasImage = false,
  imageProps: { imageLoading?: boolean; imageError?: string; onRetryImage?: () => void } = {},
) {
  const library = {
    signature: 'test',
    snapshot: await snapshotFixture(),
    checking: false,
    message: null,
    paused: false,
    uncertain: false,
    variants: [],
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
        {...imageProps}
      />,
    ),
  )
  return library
}
it('puts the assembly animation and explicit CTA on the empty stage without fake progress', async () => {
  const library = await show()
  expect(host.querySelector('.is-stage iframe')?.getAttribute('src')).toContain('/builds/')
  expect(host.querySelector('[role=progressbar]')).toBeNull()
  expect(host.querySelector('ul')).toBeNull()
  expect(host.textContent).toContain('Illustrative assembly')
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
it('shows only count-based progress alongside a ready image, without a second animation or view list', async () => {
  await show({ snapshot: queued(await snapshotFixture(defaultDesign(), 2)) }, true)
  expect(host.querySelector('.is-summary')).not.toBeNull()
  expect(host.querySelector('iframe')).toBeNull()
  expect(host.querySelector('h2')).toBeNull()
  expect(host.querySelector('ul')).toBeNull()
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('40')
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-label')).toContain(
    '2/5 images ready',
  )
  expect(host.textContent).not.toContain(RENDER_CTA)
})
it('keeps completed images to one quiet summary without progress or refresh controls', async () => {
  await show({ snapshot: await snapshotFixture(defaultDesign(), 5) }, true)
  expect(host.textContent).toContain('Draft preview · 5/5 views ready')
  expect(host.querySelector('[role=progressbar]')).toBeNull()
  expect(host.querySelector('iframe')).toBeNull()
  expect(host.querySelector('button')).toBeNull()
})
it('offers a read-only reconnect for a partially cached set after polling pauses', async () => {
  const library = await show(
    { snapshot: queued(await snapshotFixture(defaultDesign(), 2)), paused: true },
    true,
  )
  const refresh = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Check status'),
  )!
  expect(refresh).toBeDefined()
  act(() => refresh.click())
  expect(library.refresh).toHaveBeenCalledOnce()
  expect(library.request).not.toHaveBeenCalled()
})
it('animates image delivery, even after all five views are cached, without claiming GPU work', async () => {
  await show({ snapshot: await snapshotFixture(defaultDesign(), 5) }, false, { imageLoading: true })
  expect(host.querySelector('iframe')).not.toBeNull()
  expect(host.textContent).toContain('No new render is being started')
  expect(host.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false)
})
it('keeps failed image delivery retry separate from requesting a render', async () => {
  const retry = vi.fn()
  const library = await show({ snapshot: await snapshotFixture(defaultDesign(), 5) }, false, {
    imageError: 'Image could not be verified',
    onRetryImage: retry,
  })
  expect(host.querySelector('iframe')?.getAttribute('src')).toContain('still=1')
  expect(host.querySelector('[role=progressbar]')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(retry).toHaveBeenCalledOnce()
  expect(library.request).not.toHaveBeenCalled()
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
it('offers saved sets of the same build in another format or scene without requesting a render', async () => {
  const onUseVariant = vi.fn()
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
    variants: [
      {
        presentation: {
          aspect: 'tall',
          doorPose: 'closed',
          lookRef: 'studio-night-draft@1',
        },
        readyViews: 5,
      },
    ] as const,
  }
  await act(async () =>
    root.render(
      <LibrarySetStatus
        design={defaultDesign()}
        library={library}
        catalog={null}
        hasImage={false}
        onUseVariant={onUseVariant}
      />,
    ),
  )
  const button = [...host.querySelectorAll('.library-saved-variants button')]
  expect(button.map((entry) => entry.textContent)).toEqual([
    'Portrait · Studio · night · 5/5 views',
  ])
  act(() => (button[0] as HTMLButtonElement).click())
  expect(onUseVariant).toHaveBeenCalledWith(library.variants[0].presentation)
  expect(library.request).not.toHaveBeenCalled()
})
