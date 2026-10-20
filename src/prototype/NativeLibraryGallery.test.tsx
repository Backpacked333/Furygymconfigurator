// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { serializeDesign } from '../domain/design'
import { CUSTOMER_CAMERA_REFS } from '../domain/presentation'
import { normalizeCustomerDesign } from '../render-library/views'
import { NativeLibraryGallery } from './NativeLibraryGallery'
import { decodeNativeImage, nativeLibrarySchema } from './nativeLibrary'

vi.mock('./nativeLibrary', async (original) => ({
  ...(await original<typeof import('./nativeLibrary')>()),
  decodeNativeImage: vi.fn(),
}))
vi.mock('../components/Modal', () => ({
  default: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
    <div role="dialog">
      <button onClick={onClose}>Close dialog</button>
      {children}
    </div>
  ),
}))
const catalog = nativeLibrarySchema.parse(
  JSON.parse(readFileSync('public/native-library/manifest.json', 'utf8')),
)
const container = catalog.entries.find(
  (entry) =>
    entry.design.config.product.family === 'container' &&
    entry.design.presentation.cameraRef === 'front-left-draft@1' &&
    entry.design.presentation.lookRef === 'studio-day-draft@1',
)!
const studio = catalog.entries.find(
  (entry) =>
    entry.design.config.product.family === 'studio' &&
    entry.design.presentation.cameraRef === 'front-left-draft@1' &&
    entry.design.presentation.lookRef === 'studio-day-draft@1',
)!
const library = {
  ...catalog,
  entries: catalog.entries.filter((entry) =>
    [container.configId, studio.configId].includes(entry.configId),
  ),
}
let host: HTMLDivElement, root: Root
const load = vi.fn(),
  release = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  vi.mocked(decodeNativeImage).mockImplementation(async (entry) => ({
    entry,
    src: `blob:${entry.imageSha256}`,
    release,
  }))
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  )!
  expect(button).toBeDefined()
  await act(async () => button.click())
}
async function open() {
  await act(async () => root.render(<NativeLibraryGallery library={library} onLoad={load} />))
  await click('Rendered builds')
}
it('shows all five original Container images without changing the design or requesting a render', async () => {
  const original = serializeDesign(container.design)
  await open()
  await click('View saved closed-door images')
  expect(load).not.toHaveBeenCalled()
  expect(host.textContent).toContain('original saved images with doors closed')
  const views = host.querySelectorAll('[aria-label="Original saved views"] button')
  expect(views).toHaveLength(5)
  for (const button of views) await act(async () => (button as HTMLButtonElement).click())
  const rendered = vi.mocked(decodeNativeImage).mock.calls.map(([entry]) => entry)
  expect(new Set(rendered.map((entry) => entry.design.presentation.cameraRef))).toEqual(
    new Set(CUSTOMER_CAMERA_REFS),
  )
  expect(rendered.every((entry) => entry.design.presentation.doorPose === 'closed')).toBe(true)
  expect(load).not.toHaveBeenCalled()
  expect(host.textContent).not.toContain('Bring your vision to life')
  await click('Configure open-door version')
  expect(load).toHaveBeenCalledExactlyOnceWith(normalizeCustomerDesign(rendered.at(-1)!.design))
  expect(load.mock.calls[0][0].presentation.doorPose).toBe('open')
  expect(serializeDesign(container.design)).toBe(original)
  expect(release).toHaveBeenCalled()
})
it('loads unchanged Studio cards directly and can leave an archived preview without changing selection', async () => {
  await open()
  await click('View saved closed-door images')
  await click('Back to rendered builds')
  expect(load).not.toHaveBeenCalled()
  const card = [...host.querySelectorAll<HTMLButtonElement>('.native-library-card')].find(
    (button) => button.textContent?.includes('S-'),
  )!
  await act(async () => card.click())
  expect(load).toHaveBeenCalledExactlyOnceWith(studio.design)
  expect(host.querySelector('[role="dialog"]')).toBeNull()
})
it('reports a saved-image download error without offering a paid rerender', async () => {
  vi.mocked(decodeNativeImage).mockRejectedValue(new Error('verification failed'))
  await open()
  await click('View saved closed-door images')
  expect(host.textContent).toContain('Could not load the saved image')
  expect(host.textContent).toContain('No render was requested')
  expect(host.querySelector('.native-saved-image img')).toBeNull()
  expect(load).not.toHaveBeenCalled()
})
it('fences late image completions after switching views and releases their resources', async () => {
  let finish!: (image: Awaited<ReturnType<typeof decodeNativeImage>>) => void
  vi.mocked(decodeNativeImage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await open()
  await click('View saved closed-door images')
  const next = host.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Original saved views"] button',
  )[1]
  await act(async () => next.click())
  const currentSrc = host.querySelector('.native-saved-image img')?.getAttribute('src')
  expect(currentSrc).toBeTruthy()
  const staleRelease = vi.fn()
  await act(async () => finish({ entry: container, src: 'blob:stale', release: staleRelease }))
  expect(staleRelease).toHaveBeenCalledOnce()
  expect(host.querySelector('.native-saved-image img')?.getAttribute('src')).toBe(currentSrc)
})
