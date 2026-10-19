import type { ReactNode } from 'react'
import { Expand, Eye, Maximize, Redo2, Undo2 } from 'lucide-react'

export type StageView = 'exterior' | 'interior' | 'plan'

/** Shared title, view switch and history placement; no design or renderer authority. */
export function StageHeader({
  collection,
  title,
  meta,
  note,
  view,
  onView,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  status,
}: {
  collection: ReactNode
  title: ReactNode
  meta: ReactNode
  note?: ReactNode
  view: StageView
  onView: (view: StageView) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  status?: ReactNode
}) {
  return (
    <div className="stage-header">
      <div className="stage-heading">
        <span className="eyebrow">
          <span className="small-line" /> {collection}
        </span>
        <div className="stage-title">
          <h1>
            {title}
            <span>Space to become more.</span>
          </h1>
          <div className="studio-meta">{meta}</div>
        </div>
        {note && <p className="custom-preview-note">{note}</p>}
      </div>
      <div className="stage-header-tools">
        <div className="stage-header-row">
          <div className="view-switch" role="group" aria-label="Camera views">
            {(['exterior', 'interior', 'plan'] as const).map((value, index) => {
              const Icon = [Expand, Eye, Maximize][index]
              return (
                <button
                  key={value}
                  aria-pressed={view === value}
                  className={view === value ? 'active' : ''}
                  onClick={() => onView(value)}
                >
                  <Icon size={14} />
                  <span>
                    {value === 'plan' ? 'Floor plan' : value[0].toUpperCase() + value.slice(1)}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="history-controls" role="group" aria-label="History">
            <button aria-label="Undo last change" disabled={!canUndo} onClick={onUndo}>
              <Undo2 size={16} />
            </button>
            <button aria-label="Redo last change" disabled={!canRedo} onClick={onRedo}>
              <Redo2 size={16} />
            </button>
          </div>
        </div>
        {status}
      </div>
    </div>
  )
}
