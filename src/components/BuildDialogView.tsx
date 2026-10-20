import type { ReactNode } from 'react'
import { ArrowDownToLine, Bookmark, Check, Copy, Trash2 } from 'lucide-react'
import Modal from './Modal'

/** Presentation only: adapters own storage, snapshot identity, consent and feedback. */
export function BuildLibraryView({
  subtitle = 'Save a few directions. Find the one that feels right.',
  onClose,
  saveRow,
  summary,
  feedback,
  children,
}: {
  subtitle?: string
  onClose: () => void
  saveRow: ReactNode
  summary: ReactNode
  feedback?: ReactNode
  children: ReactNode
}) {
  return (
    <Modal title="Keep the possibilities open." subtitle={subtitle} onClose={onClose} wide>
      {feedback}
      <div className="save-row">{saveRow}</div>
      <p className="muted small">{summary}</p>
      {children}
    </Modal>
  )
}

export function EmptyBuildLibraryView() {
  return (
    <div className="empty-library">
      <Bookmark size={32} strokeWidth={1} />
      <h3>Your ideas belong here.</h3>
      <p>Save your first design above. Come back to it whenever inspiration strikes.</p>
    </div>
  )
}

export function SavedBuildView({
  name,
  visual,
  summary,
  onDelete,
  actions,
}: {
  name: string
  visual: ReactNode
  summary: ReactNode
  onDelete?: () => void
  actions?: ReactNode
}) {
  return (
    <div className="saved-card">
      <div className="saved-visual">
        {visual}
        {onDelete && (
          <button className="icon-button" aria-label={`Delete ${name}`} onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <h3>{name}</h3>
      <p>{summary}</p>
      {actions && <div className="saved-actions">{actions}</div>}
    </div>
  )
}

/** The original Share body, with no Config, persistence, clipboard or export dependency. */
export function BuildShareView({
  visual,
  name,
  summary,
  link,
  linkLabel = 'Configuration link',
  linkAriaLabel = 'Configuration share link',
  copied = false,
  multiline = false,
  copyLabel = 'Copy your build link',
  downloadLabel = 'Download configuration JSON',
  onCopy,
  onDownload,
  notice,
  children,
}: {
  visual: ReactNode
  name: string
  summary: ReactNode
  link: string
  linkLabel?: string
  linkAriaLabel?: string
  copied?: boolean
  multiline?: boolean
  copyLabel?: string
  downloadLabel?: string
  onCopy: () => void
  onDownload: () => void
  notice: ReactNode
  children?: ReactNode
}) {
  return (
    <>
      <div className="share-visual">
        {visual}
        <span>
          {name}
          <small>{summary}</small>
        </span>
      </div>
      <label className="field-label">
        {linkLabel}
        {multiline ? (
          <textarea
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={linkAriaLabel}
          />
        ) : (
          <input
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={linkAriaLabel}
          />
        )}
      </label>
      <button className="primary full" onClick={onCopy}>
        {copied ? <Check size={17} /> : <Copy size={17} />}
        {copied ? 'Link copied' : copyLabel}
      </button>
      <button className="secondary full" onClick={onDownload}>
        <ArrowDownToLine size={16} />
        {downloadLabel}
      </button>
      <p className="muted small">{notice}</p>
      {children}
    </>
  )
}
