import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  ArrowRight,
  Maximize,
  Minimize,
  Pause,
  Play,
  Rotate3d,
  RotateCcw,
  Ruler,
  SlidersHorizontal,
  X,
} from 'lucide-react'

export type StageToolbarViewProps = {
  live: boolean
  interior: boolean
  settings: ReactNode
  /** Legacy prefetch activation stays in its adapter; cleanup runs on close/unmount. */
  onSettingsOpen?: () => void | (() => void)
  onMoreSettings: () => void
  onToggleLive?: () => void
  /** The visitor is about to open the 360° view (pointer, focus, or touch on its button). */
  onLiveIntent?: () => void
  dimensions?: boolean
  onDimensions?: () => void
  autoRotate?: boolean
  onAutoRotate?: () => void
  onReset?: () => void
  onDownload: () => void
  downloading?: boolean
  fullscreen: boolean | null
  onFullscreen: () => void
  liveDisabledReason?: string
  liveLabel?: string
  downloadDisabledReason?: string
  downloadLabel?: string
}

/** The existing floating glass toolbar, with renderer-free settings and policy slots. */
export function StageToolbarView({
  live,
  interior,
  settings,
  onSettingsOpen,
  onMoreSettings,
  onToggleLive,
  onLiveIntent,
  dimensions = false,
  onDimensions,
  autoRotate = false,
  onAutoRotate,
  onReset,
  onDownload,
  downloading = false,
  fullscreen,
  onFullscreen,
  liveDisabledReason,
  liveLabel,
  downloadDisabledReason,
  downloadLabel = 'Download image',
}: StageToolbarViewProps) {
  const [open, setOpen] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const popover = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const bar = wrap.current?.getBoundingClientRect()
      if (!bar) return
      const width = Math.min(320, window.innerWidth - 24)
      const centre = bar.left + bar.width / 2
      setPlace({
        width,
        left: Math.min(window.innerWidth - width - 12, Math.max(12, centre - width / 2)),
        bottom: window.innerHeight - bar.top + 10,
        maxHeight: Math.max(160, bar.top - 22),
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])
  useEffect(() => {
    if (open) return onSettingsOpen?.()
  }, [open, onSettingsOpen])
  const shown = open && place !== null
  useEffect(() => {
    if (shown) panel.current?.querySelector<HTMLElement>('[aria-pressed="true"], button')?.focus()
  }, [shown])
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    const away = (event: Event) => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('focusin', away, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('focusin', away, true)
    }
  }, [open])
  return (
    <div className="stage-toolbar-wrap" ref={wrap}>
      {open &&
        place &&
        createPortal(
          <div
            className="scene-popover"
            id={popover}
            role="dialog"
            aria-label="Adjust scene"
            ref={panel}
            style={place}
          >
            {settings}
            <button
              className="popover-more"
              aria-describedby={settingsError ? `${popover}-settings-error` : undefined}
              onClick={async () => {
                setSettingsError('')
                try {
                  // The sidebar is outside the fullscreen frame. Do not move focus there until
                  // the browser has made it visible; keep a rejection in this visible popover.
                  if (document.fullscreenElement) await document.exitFullscreen()
                } catch {
                  setSettingsError(
                    'Exit full screen to open all setting options. You can try again.',
                  )
                  return
                }
                setOpen(false)
                trigger.current?.focus()
                onMoreSettings()
              }}
            >
              All setting options <ArrowRight size={14} />
            </button>
            {settingsError && (
              <p id={`${popover}-settings-error`} className="muted small" role="status">
                {settingsError}
              </p>
            )}
          </div>,
          document.fullscreenElement ?? document.body,
        )}
      <div className="stage-toolbar" role="group" aria-label="Stage tools">
        <button
          ref={trigger}
          className={`tool-labelled${open ? ' is-open' : ''}`}
          aria-label="Adjust scene"
          title="Adjust scene"
          aria-expanded={open}
          aria-controls={open ? popover : undefined}
          onClick={() => {
            setSettingsError('')
            setOpen(!open)
          }}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span>Adjust scene</span>
        </button>
        <i className="toolbar-divider" aria-hidden="true" />
        <button
          className={`tool-labelled${live ? ' is-on' : ''}`}
          aria-pressed={live}
          aria-label={liveLabel ?? (live ? 'Close the 360° View' : '360° View')}
          onClick={onToggleLive}
          onPointerEnter={live ? undefined : onLiveIntent}
          onFocus={live ? undefined : onLiveIntent}
          onTouchStart={live ? undefined : onLiveIntent}
          disabled={!!liveDisabledReason}
          aria-describedby={liveDisabledReason ? `${popover}-live-reason` : undefined}
          title={liveDisabledReason}
        >
          {live ? <X size={16} aria-hidden="true" /> : <Rotate3d size={16} aria-hidden="true" />}
          <span>360° View</span>
        </button>
        {live && (
          <>
            <i className="toolbar-divider" aria-hidden="true" />
            <button
              className={dimensions ? 'is-on' : ''}
              aria-label="Show dimensions"
              title="Dimensions"
              aria-pressed={dimensions}
              onClick={onDimensions}
            >
              <Ruler size={16} aria-hidden="true" />
            </button>
            <button aria-label="Reset view" title="Reset view" onClick={onReset}>
              <RotateCcw size={16} aria-hidden="true" />
            </button>
            <button
              className={autoRotate ? 'is-on' : ''}
              aria-label={autoRotate ? 'Pause rotation' : 'Rotate automatically'}
              title={autoRotate ? 'Pause rotation' : 'Auto-rotate'}
              aria-pressed={autoRotate}
              disabled={interior}
              onClick={onAutoRotate}
            >
              {autoRotate ? (
                <Pause size={16} aria-hidden="true" />
              ) : (
                <Play size={16} aria-hidden="true" />
              )}
            </button>
          </>
        )}
        <i className="toolbar-divider" aria-hidden="true" />
        <button
          className={downloading ? 'is-busy' : ''}
          aria-label={downloading ? 'Preparing your image' : downloadLabel}
          title={downloadDisabledReason ?? downloadLabel}
          aria-busy={downloading}
          onClick={onDownload}
          disabled={!!downloadDisabledReason}
          aria-describedby={downloadDisabledReason ? `${popover}-download-reason` : undefined}
        >
          <ArrowDownToLine size={16} aria-hidden="true" />
        </button>
        {fullscreen !== null && (
          <button
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            title={fullscreen ? 'Exit full screen' : 'Full screen'}
            aria-pressed={fullscreen}
            onClick={onFullscreen}
          >
            {fullscreen ? (
              <Minimize size={16} aria-hidden="true" />
            ) : (
              <Maximize size={16} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      {liveDisabledReason && (
        <span className="sr-only" id={`${popover}-live-reason`}>
          {liveDisabledReason}
        </span>
      )}
      {downloadDisabledReason && (
        <span className="sr-only" id={`${popover}-download-reason`}>
          {downloadDisabledReason}
        </span>
      )}
    </div>
  )
}
