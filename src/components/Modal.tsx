import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

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
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby="dialog-title"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <div>
            <span className="eyebrow">YOUR SPACE, CONSIDERED</span>
            <h2 id="dialog-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
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
