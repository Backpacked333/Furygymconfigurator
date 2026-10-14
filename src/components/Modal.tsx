import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

const openDialogs: HTMLDialogElement[] = []
const focusable = (dialog: HTMLDialogElement) =>
  Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [contenteditable="true"], [tabindex]',
    ),
  ).filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled, [type="hidden"]')) return false
    for (
      let current: HTMLElement | null = element;
      current && current !== dialog;
      current = current.parentElement
    ) {
      if (current.matches('[hidden], [inert], [aria-hidden="true"]')) return false
      const style = getComputedStyle(current)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      )
        return false
      if (current.parentElement?.matches('details:not([open])') && current.tagName !== 'SUMMARY')
        return false
    }
    return true
  })
const restoreFocus = (element: Element | null) => {
  if (element?.isConnected && 'focus' in element && typeof element.focus === 'function') {
    element.focus({ preventScroll: true })
    return document.activeElement === element
  }
  return false
}

export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const subtitleId = useId()
  const backdropDown = useRef(false)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement
    window.dispatchEvent(new Event('fury:modal-open'))
    dialog.showModal()
    openDialogs.push(dialog)
    const focusInside = () => {
      if (openDialogs.at(-1) !== dialog || dialog.contains(document.activeElement)) return
      ;(focusable(dialog)[0] ?? dialog).focus({ preventScroll: true })
    }
    focusInside()
    document.addEventListener('focusin', focusInside)
    return () => {
      document.removeEventListener('focusin', focusInside)
      const index = openDialogs.indexOf(dialog)
      if (index !== -1) openDialogs.splice(index, 1)
      dialog.close()
      if (!restoreFocus(opener)) {
        const activeDialog = openDialogs.at(-1)
        restoreFocus(
          activeDialog
            ? (focusable(activeDialog)[0] ?? activeDialog)
            : document.querySelector('[data-modal-focus-fallback], header button, main button'),
        )
      }
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key !== 'Tab' || !ref.current) return
        const elements = focusable(ref.current)
        const first = elements[0],
          last = elements.at(-1)
        if (!first) {
          event.preventDefault()
          ref.current.focus()
          return
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === ref.current)
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === ref.current)
        ) {
          event.preventDefault()
          first.focus()
        }
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        backdropDown.current =
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom)
      }}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          backdropDown.current &&
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom)
        )
          onClose()
        backdropDown.current = false
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <div>
            <span className="eyebrow">YOUR SPACE, CONSIDERED</span>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p id={subtitleId}>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
