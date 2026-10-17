import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
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
import { ENVIRONMENTS, type Config } from '../lib/config'
import { boostOption, focusSection, leaveSection } from '../render/prefetch'
import { TimeOfDay } from './TimeOfDay'

/**
 * The stage's one toolbar, a glass pill over the bottom of the picture, like a car configurator's:
 * Adjust scene (the setting and the time of day), 360° View, Download, and Full screen. In the
 * 360° view it adds the live view's own tools: Dimensions, Reset view, and Auto-rotate. Everything
 * else stays off the picture.
 */
export function StageToolbar({
  live,
  interior,
  config,
  onChange,
  onMoreSettings,
  onToggleLive,
  dimensions,
  onDimensions,
  autoRotate,
  onAutoRotate,
  onReset,
  onDownload,
  downloading,
  fullscreen,
  onFullscreen,
}: {
  /** The 360° view is on. */
  live: boolean
  /** The view is inside the room, where nothing rotates on its own. */
  interior: boolean
  config: Config
  onChange: (config: Config) => void
  /** Opens every setting option (the configuration panel's Setting step). */
  onMoreSettings: () => void
  onToggleLive: () => void
  dimensions: boolean
  onDimensions: () => void
  autoRotate: boolean
  onAutoRotate: () => void
  onReset: () => void
  onDownload: () => void
  /** A download is being prepared (the full-resolution still renders). */
  downloading: boolean
  /** Null where the browser cannot show the stage full screen. */
  fullscreen: boolean | null
  onFullscreen: () => void
}) {
  const [open, setOpen] = useState(false)
  const popover = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // The popover floats over the page (a short stage would clip it), above the toolbar and inside
  // the window; in full screen, inside the full-screen stage.
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
  // Open, its settings are the section whose siblings the stills prefetch (prefetch.ts).
  useEffect(() => {
    if (!open) return
    focusSection('environment')
    return () => leaveSection('environment')
  }, [open])
  // Opened, the focus moves to the setting chosen now.
  const shown = open && place !== null
  useEffect(() => {
    if (shown) panel.current?.querySelector<HTMLElement>('[aria-pressed="true"], button')?.focus()
  }, [shown])
  // The popover closes on Escape (focus back on its button), and on a click or the focus going
  // anywhere else.
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    const away = (e: Event) => {
      const target = e.target as Node
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
            <div className="section-label">Setting</div>
            <div className="scene-settings">
              {ENVIRONMENTS.map((env) => (
                <button
                  key={env.id}
                  onPointerEnter={() => boostOption('environment', env.id)}
                  onFocus={() => boostOption('environment', env.id)}
                  aria-pressed={config.environment === env.id}
                  className={config.environment === env.id ? 'selected' : ''}
                  onClick={() => onChange({ ...config, environment: env.id })}
                >
                  {env.name}
                  {config.environment === env.id && <Check size={13} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <TimeOfDay
              label="Time of day"
              time={config.time}
              onChange={(time) => onChange({ ...config, time })}
            />
            <button
              className="popover-more"
              onClick={() => {
                setOpen(false)
                onMoreSettings()
              }}
            >
              All setting options <ArrowRight size={14} />
            </button>
          </div>,
          document.fullscreenElement ?? document.body,
        )}
      <div className="stage-toolbar" role="group" aria-label="Stage tools">
        <button
          ref={trigger}
          className={`tool-labelled${open ? ' is-open' : ''}`}
          aria-expanded={open}
          aria-controls={open ? popover : undefined}
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span>Adjust scene</span>
        </button>
        <i className="toolbar-divider" aria-hidden="true" />
        <button
          className={`tool-labelled${live ? ' is-on' : ''}`}
          aria-pressed={live}
          aria-label={live ? 'Close the 360° View' : '360° View'}
          onClick={onToggleLive}
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
          aria-label={downloading ? 'Preparing your image' : 'Download image'}
          title="Download image"
          aria-busy={downloading}
          onClick={onDownload}
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
    </div>
  )
}
