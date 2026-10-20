import type { MouseEventHandler, ReactNode } from 'react'
import { Check, Minus, Plus, SlidersHorizontal, X } from 'lucide-react'

/** The existing Fury page chrome. Action slots own their nav, including dialog-local feedback. */
export function ConfiguratorShell({
  mobilePanel,
  className = '',
  configurationId = 'configuration',
  onSkip,
  onBrand,
  headerActions,
  workspace,
  children,
}: {
  mobilePanel: boolean
  className?: string
  configurationId?: string
  onSkip?: MouseEventHandler<HTMLAnchorElement>
  onBrand: () => void
  headerActions: ReactNode
  workspace: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      className={`app ${mobilePanel ? 'panel-open' : 'panel-closed'}${className ? ` ${className}` : ''}`}
    >
      <a className="skip-link" href={`#${configurationId}`} onClick={onSkip}>
        Skip to configuration
      </a>
      <header className="header">
        <a
          className="brand"
          href={window.location.pathname}
          onClick={(event) => {
            event.preventDefault()
            onBrand()
          }}
          aria-label="Fury gym information"
        >
          <svg viewBox="0 0 30 30" aria-hidden="true">
            <path d="M3 5h24l-4 6H10v4h11l-4 6h-7v6H3z" />
          </svg>
          <span>FURY</span>
          <span className="brand-divider" />
          <small>
            GYM
            <br />
            CONFIGURATOR
          </small>
        </a>
        <div className="header-center">
          <span className="live-dot" /> YOUR SPACE. YOUR WAY.
        </div>
        {headerActions}
      </header>
      <main className="workspace">{workspace}</main>
      {children}
    </div>
  )
}

export function ConfiguratorPanelToggle({
  open,
  onToggle,
  configurationId = 'configuration',
}: {
  open: boolean
  onToggle: () => void
  configurationId?: string
}) {
  return (
    <div className="stage-mobile-row">
      <button
        className="mobile-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={configurationId}
      >
        <SlidersHorizontal size={16} />
        {open ? 'Hide options' : 'Customize gym'}
        {open ? <Minus size={14} /> : <Plus size={14} />}
      </button>
    </div>
  )
}

export function ConfiguratorNotification({
  message,
  onDismiss,
}: {
  message: string
  onDismiss: () => void
}) {
  if (!message) return null
  return (
    <div className="toast" role="status">
      <Check size={16} />
      <span>{message}</span>
      <button aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  )
}

/** Footer geometry stays shared; pricing and export/inquiry policy belong to the route. */
export function ConfiguratorSummary({
  monogram,
  title,
  detail,
  estimate,
  action,
}: {
  monogram: ReactNode
  title: ReactNode
  detail: ReactNode
  estimate: ReactNode
  action: ReactNode
}) {
  return (
    <footer className="summary-bar">
      <div className="summary-product">
        <span className="summary-monogram">{monogram}</span>
        <div>
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
      </div>
      <div className="summary-estimate">{estimate}</div>
      {action}
    </footer>
  )
}
