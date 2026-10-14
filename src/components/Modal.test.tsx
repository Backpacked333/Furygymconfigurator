// @vitest-environment jsdom
import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Modal from './Modal'

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button id="trigger" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Modal title="Test dialog" onClose={() => setOpen(false)}>
          Content
        </Modal>
      )}
    </>
  )
}

describe('dialog focus lifecycle', () => {
  let container: HTMLDivElement
  let root: Root
  let trigger: HTMLButtonElement
  const nativeMethods = ['showModal', 'close'] as const
  const descriptors = nativeMethods.map((name) =>
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  )

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // jsdom does not implement native modal focus management.
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value: function (this: HTMLDialogElement) {
          this.open = true
          this.querySelector<HTMLButtonElement>('button')?.focus()
        },
      },
      close: {
        configurable: true,
        value: function (this: HTMLDialogElement) {
          this.open = false
        },
      },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      ),
    )
    trigger = container.querySelector<HTMLButtonElement>('#trigger')!
    trigger.focus()
    act(() => trigger.click())
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Close dialog"]'))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    nativeMethods.forEach((name, index) => {
      const descriptor = descriptors[index]
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
    })
    vi.unstubAllGlobals()
  })

  it('returns focus to the opener when the close button is activated', () => {
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click())
    expect(container.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('handles Escape declaratively and restores focus', () => {
    const event = new Event('cancel', { cancelable: true })
    act(() => container.querySelector('dialog')!.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(container.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus after a backdrop click', () => {
    act(() => container.querySelector('dialog')!.click())
    expect(container.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('does not close when the dialog content is clicked', () => {
    act(() => container.querySelector<HTMLElement>('.modal-content')!.click())
    expect(container.querySelector('dialog')?.open).toBe(true)
  })

  it('restores focus across repeated openings under Strict Mode', () => {
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click())
    act(() => trigger.click())
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click())
    expect(document.activeElement).toBe(trigger)
  })
})
