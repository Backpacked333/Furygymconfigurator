// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { configSchema, DEFAULT_CONFIG, encodeConfig, type Config } from './lib/config'
import * as repository from './lib/repository'
import { TestBackend } from './lib/persistenceTestFixtures'
import type { QualityMode } from './render/quality'

const { scenes } = vi.hoisted(() => ({
  scenes: [] as {
    config: Config
    revision: number
    isPreviewing: boolean
    autoRotate: boolean
    qualityMode: QualityMode
  }[],
}))
vi.mock('./components/Scene', () => ({
  default: (props: (typeof scenes)[number]) => {
    scenes.push(props)
    return <div>Scene test double</div>
  },
}))

describe('assembled application edit ownership', () => {
  let root: Root, host: HTMLDivElement, backend: TestBackend
  const initial = () =>
    configSchema.parse({
      ...DEFAULT_CONFIG,
      items: [{ id: 'mat', sku: 'mat', x: -4, z: 0, rotation: 0 }],
    })
  const button = (name: string, selector = 'button'): HTMLButtonElement => {
    const element = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
      (button) => button.getAttribute('aria-label') === name || button.textContent?.includes(name),
    )
    if (!element) throw new Error(`Missing button: ${name}`)
    return element
  }
  const click = async (element: Element) => {
    await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }
  const item = () => host.querySelector('[data-item-id="mat"]')!
  const key = async (element: Element, key: string, type = 'keydown') => {
    await act(async () =>
      element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })),
    )
  }
  const pointer = async (element: Element, type: string) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      isPrimary: { value: true },
    })
    await act(async () => element.dispatchEvent(event))
  }
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    backend = new TestBackend()
    vi.spyOn(repository, 'openDocumentRepository').mockImplementation(async () => ({
      ok: true,
      value: new repository.DocumentRepository(backend, false),
    }))
    Object.defineProperties(HTMLInputElement.prototype, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => false },
    })
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.open = true
        },
      },
      close: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.open = false
        },
      },
    })
    localStorage.clear()
    history.replaceState(null, '', `/#c=${encodeConfig(initial())}`)
    scenes.length = 0
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps selection and held-key previews out of the URL and durable draft until one commit', async () => {
    await click(button('Floor plan'))
    const hash = location.hash,
      raw = backend.rows.get('draft')?.raw,
      writes = backend.writes
    await click(item())
    expect(button('Undo last change').disabled).toBe(true)
    expect(location.hash).toBe(hash)
    for (let index = 0; index < 3; index++) await key(item(), 'ArrowRight')
    expect(host.textContent).toContain('Previewing an edit')
    expect(location.hash).toBe(hash)
    expect(backend.rows.get('draft')?.raw).toBe(raw)
    expect(backend.writes).toBe(writes)
    expect(button('Create build brief').disabled).toBe(true)
    await key(item(), 'ArrowRight', 'keyup')
    expect(location.hash).not.toBe(hash)
    expect(backend.writes).toBe(writes + 1)
    expect(button('Undo last change').disabled).toBe(false)
    await click(button('Undo last change'))
    expect(location.hash).toBe(hash)
    expect(backend.rows.get('draft')?.raw).toBe(raw)
    expect(button('Undo last change').disabled).toBe(true)
  })

  it('cancels a live plan preview when a real application dialog opens', async () => {
    await click(button('Floor plan'))
    const hash = location.hash,
      writes = backend.writes
    await key(item(), 'ArrowRight')
    expect(host.textContent).toContain('Previewing an edit')
    await click(button('Help and information'))
    expect(host.querySelector('dialog[open]')).not.toBeNull()
    expect(host.textContent).not.toContain('Previewing an edit')
    expect(location.hash).toBe(hash)
    expect(backend.writes).toBe(writes)
    await click(button('Close dialog'))
    expect(button('Undo last change').disabled).toBe(true)
  })

  it('wires daylight preview to the scene while pausing rotation and preserving committed exports', async () => {
    await click(button('Rotate automatically'))
    expect(scenes.at(-1)?.autoRotate).toBe(true)
    await click(button('Setting'))
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!
    const hash = location.hash,
      revision = scenes.at(-1)?.revision
    await pointer(slider, 'pointerdown')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '9')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(scenes.at(-1)?.config.time).toBe(9)
    expect(scenes.at(-1)?.revision).toBe(revision)
    expect(scenes.at(-1)?.isPreviewing).toBe(true)
    expect(scenes.at(-1)?.autoRotate).toBe(false)
    expect(location.hash).toBe(hash)
    expect(button('Create build brief').disabled).toBe(true)
    await pointer(slider, 'pointerup')
    expect(scenes.at(-1)?.isPreviewing).toBe(false)
    expect(location.hash).not.toBe(hash)
    await click(button('Undo last change'))
    expect(location.hash).toBe(hash)
  })

  it('wires explicit tier selection and restoring Auto to the renderer boundary', async () => {
    await click(button('Setting'))
    await click(button('High'))
    expect(scenes.at(-1)?.qualityMode).toBe('high')
    await click(button('Auto', '.setting-row button'))
    expect(scenes.at(-1)?.qualityMode).toBe('auto')
    expect(button('Undo last change').disabled).toBe(true)
  })

  it.each(['button', 'Escape'])('moves photo focus in and restores it on %s exit', async (exit) => {
    const opener = button('Enter photo mode')
    opener.focus()
    const panelClass = host.querySelector('.app')?.className
    await click(opener)
    const closer = button('Exit photo mode')
    expect(document.activeElement).toBe(closer)
    if (exit === 'button') await click(closer)
    else await key(closer, 'Escape')
    expect(document.activeElement).toBe(opener)
    expect(host.querySelector('.app')?.className).toBe(panelClass)
    expect(host.querySelector('[aria-label="Exit photo mode"]')).toBeNull()
  })
})
