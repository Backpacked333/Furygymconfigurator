import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  CircleHelp,
  Expand,
  ExternalLink,
  Eye,
  Leaf,
  Maximize,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Ruler,
  Share2,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react'
import ConfigPanel from './components/ConfigPanel'
import FloorPlan from './components/FloorPlan'
import Modal from './components/Modal'
import { SceneLoadBoundary } from './components/SceneLoadBoundary'
import { SceneLoading } from './components/SceneLoading'
import { BriefDialog, EstimateDialog, LibraryDialog, ShareDialog } from './components/Dialogs'
import {
  DEFAULT_CONFIG,
  FINISHES,
  area,
  decodeConfig,
  distance,
  estimate,
  money,
  productName,
  productHeight,
  setFamily,
  packageItems,
  type Config,
  type Unit,
  type View,
} from './lib/config'
import { useConfig } from './lib/useConfig'
import { useShareFragment } from './lib/useShareFragment'
import { useStagedScene } from './lib/useStagedScene'
import { productFamily } from './lib/products'
import { defaultQuality, type Backend, type Quality } from './render/quality'
import { sceneProgress, textureProgress } from './render/progress'

const Scene = lazy(() => import('./components/Scene'))
type Dialog = 'share' | 'brief' | 'estimate' | 'library' | 'help' | null

export default function App() {
  const { config, encoded, setConfig, undo, redo, canUndo, canRedo, initialNotice } = useConfig()
  const [step, setStep] = useState(0),
    [view, setView] = useState<View>('exterior'),
    [unit, setUnit] = useState<Unit>('ft')
  const [dimensions, setDimensions] = useState(false),
    [quality, setQuality] = useState<Quality>(() => defaultQuality()),
    [backend, setBackend] = useState<Backend | null>(null)
  // An explicit choice (panel or ?quality=) is never overridden by the performance governor.
  const qualityChosen = useRef(new URLSearchParams(window.location.search).has('quality'))
  const [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState(initialNotice),
    [reset, setReset] = useState(0)
  const [autoRotate, setAutoRotate] = useState(false),
    [photoMode, setPhotoMode] = useState(false),
    [mobilePanel, setMobilePanel] = useState(true)
  const captureRef = useRef<(() => string) | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback((s: string) => {
    setToast(s)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 6500)
  }, [])
  const chooseQuality = useCallback((next: Quality) => {
    qualityChosen.current = true
    setQuality(next)
  }, [])
  const onSlow = useCallback(() => {
    if (qualityChosen.current || quality === 'lite') return
    const next = quality === 'ultra' ? 'high' : 'lite'
    setQuality(next)
    notify(
      `Switched to ${next === 'high' ? 'High' : 'Lite'} quality for smoother interaction on this device. You can change it under Surroundings.`,
    )
  }, [quality, notify])
  const onCaptureReady = useCallback((capture: (() => string) | null) => {
    captureRef.current = capture
  }, [])
  const openPlan = useCallback(() => setView('plan'), [])
  const staged = useStagedScene(config, quality)
  // The 3D scene stays mounted, hidden and paused, under the floor plan, so returning keeps the
  // renderer, its compiled shaders, and the camera rather than starting cold. It keeps the last
  // 3D view meanwhile.
  const [sceneView, setSceneView] = useState<View>('exterior')
  if (view !== 'plan' && view !== sceneView) setSceneView(view)
  const capture = useCallback(() => {
    if (view === 'plan') return null
    try {
      return captureRef.current?.() ?? null
    } catch {
      return null
    }
  }, [view])
  const close = () => setDialog(null)
  const openShared = useCallback(
    (value: string) => {
      const shared = decodeConfig(value)
      if (!shared) {
        notify('This share link is invalid or unsupported. Your design is unchanged.')
        return false
      }
      setConfig(shared)
      notify('Shared design loaded. Undo returns to your previous design.')
      return true
    },
    [setConfig, notify],
  )
  useShareFragment(encoded, openShared)
  useEffect(() => {
    if (initialNotice) timer.current = setTimeout(() => setToast(''), 6500)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [initialNotice])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (dialog || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName))
        return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
      if (e.key === 'Escape') setPhotoMode(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [dialog, undo, redo])
  const template = (id: 'athlete' | 'retreat' | 'flow') => {
    if (
      !window.confirm(
        'Apply this concept layout in your selected product family? This replaces your current design with a 20-foot example. You can undo the change.',
      )
    )
      return
    const templates: Record<typeof id, Config> = {
      athlete: { ...DEFAULT_CONFIG },
      retreat: {
        ...DEFAULT_CONFIG,
        finish: 'chalk',
        flooring: 'oak',
        mirror: false,
        package: 'recovery',
        items: packageItems('recovery', 20),
        addons: { deck: true, gazebo: true, roof: false, stairs: false },
        time: 18,
      },
      flow: {
        ...DEFAULT_CONFIG,
        finish: 'olive',
        flooring: 'oak',
        package: 'movement',
        items: packageItems('movement', 20),
        time: 9,
      },
    }
    setConfig(setFamily(templates[id], config.family))
    setView('exterior')
    setReset((r) => r + 1)
    notify('Concept layout applied. This is not an official Fury package.')
  }
  const photo = () => {
    const image = capture()
    if (!image) {
      notify('Your scene is still getting ready. Try again in a moment.')
      return
    }
    const a = document.createElement('a')
    a.href = image
    a.download = `Fury-${config.family}-${config.length}-${config.finish}.png`
    a.click()
    notify('Your gym image is downloaded. Concept rendering, not manufacturer photography.')
  }
  const startingPrice = estimate(config).startingPrice,
    finish = FINISHES.find((f) => f.id === config.finish)!
  return (
    <div
      className={`app ${photoMode ? 'photo-mode' : ''} ${mobilePanel ? 'panel-open' : 'panel-closed'}`}
    >
      <a className="skip-link" href="#configuration">
        Skip to configuration
      </a>
      <header className="header">
        <a
          className="brand"
          href={window.location.pathname}
          onClick={(e) => {
            e.preventDefault()
            setDialog('help')
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
        <nav className="header-actions" aria-label="Build actions">
          <button onClick={() => setDialog('library')}>
            <Bookmark size={16} />
            <span>My builds</span>
          </button>
          <button onClick={() => setDialog('share')}>
            <Share2 size={16} />
            <span>Share</span>
          </button>
          <button
            className="help-button"
            aria-label="Help and information"
            onClick={() => setDialog('help')}
          >
            <CircleHelp size={18} />
          </button>
        </nav>
      </header>
      <main className="workspace">
        <section
          className={`stage ${view === 'plan' ? 'is-plan' : ''}`}
          aria-label="Gym visualization"
        >
          <div className={`scene-layer ${view === 'plan' ? 'is-hidden' : ''}`}>
            <SceneLoadBoundary onFallback={openPlan}>
              <Suspense fallback={<SceneLoading phase="engine" />}>
                <Scene
                  active={view !== 'plan'}
                  config={staged.config}
                  view={sceneView}
                  dimensions={dimensions}
                  unit={unit}
                  reset={reset}
                  autoRotate={autoRotate}
                  quality={staged.quality}
                  onCaptureReady={onCaptureReady}
                  onFallback={openPlan}
                  onBackend={setBackend}
                  onSlow={onSlow}
                />
              </Suspense>
            </SceneLoadBoundary>
          </div>
          {view === 'plan' && (
            <FloorPlan config={config} unit={unit} onChange={setConfig} notify={notify} />
          )}
          <div className="stage-heading">
            <span className="eyebrow">
              <span className="small-line" />{' '}
              {config.family === 'studio' ? 'THE S-SERIES COLLECTION' : 'CONTAINER GYMS'}
            </span>
            <h1>
              {config.family === 'studio' ? 'S' : 'C'}-{config.length}
              <span>
                Space to
                <br />
                become more.
              </span>
            </h1>
            <div className="studio-meta">
              {area(config.length * 8, unit)}
              <i />
              {finish.name}
              <i />
              {distance(productHeight(config), unit)} high
            </div>
            {config.studioLayout !== 'single' && (
              <p className="custom-preview-note">
                Custom project requested · Single reference unit shown
              </p>
            )}
          </div>
          <div className="view-switch" role="group" aria-label="Camera views">
            {(['exterior', 'interior', 'plan'] as const).map((v, i) => {
              const icons = [Expand, Eye, Maximize],
                Icon = icons[i]
              return (
                <button
                  key={v}
                  aria-pressed={view === v}
                  className={view === v ? 'active' : ''}
                  onClick={() => {
                    setView(v)
                    setAutoRotate(false)
                    if (v === 'plan') setStep(2)
                  }}
                >
                  <Icon size={14} />
                  <span>{v === 'plan' ? 'Floor plan' : v[0].toUpperCase() + v.slice(1)}</span>
                </button>
              )
            })}
          </div>
          <div className="stage-tools" aria-label="Scene controls">
            <button
              className={dimensions ? 'active' : ''}
              aria-label="Show dimensions"
              aria-pressed={dimensions}
              onClick={() => setDimensions(!dimensions)}
              disabled={view === 'plan'}
            >
              <Ruler size={18} />
              <span>Dimensions</span>
            </button>
            <button
              aria-label="Reset camera"
              onClick={() => setReset((r) => r + 1)}
              disabled={view === 'plan'}
            >
              <RotateCcw size={17} />
              <span>Reset view</span>
            </button>
            <button
              className={autoRotate ? 'active' : ''}
              aria-label={autoRotate ? 'Pause rotation' : 'Rotate automatically'}
              aria-pressed={autoRotate}
              disabled={view !== 'exterior'}
              onClick={() => setAutoRotate(!autoRotate)}
            >
              {autoRotate ? <Pause size={17} /> : <Play size={17} />}
              <span>Auto rotate</span>
            </button>
            <span className="tool-divider" />
            <button
              aria-label="Enter photo mode"
              onClick={() => {
                setView('exterior')
                setPhotoMode(true)
                setMobilePanel(false)
              }}
            >
              <Camera size={18} />
              <span>Photo mode</span>
            </button>
          </div>
          {photoMode && (
            <div className="photo-controls">
              <span>
                PHOTO MODE <small>Concept rendering</small>
              </span>
              <button onClick={photo}>
                <ArrowDownToLine size={16} /> Save image
              </button>
              <button
                aria-label="Exit photo mode"
                onClick={() => {
                  setPhotoMode(false)
                  setMobilePanel(true)
                }}
              >
                <X size={18} />
              </button>
            </div>
          )}
          {view !== 'plan' && <SceneActivity updating={staged.updating} />}
          {view !== 'plan' && (
            <div className="stage-bottom">
              <div className="scene-status">
                <span className="status-dot" />
                <strong>LIVE 3D</strong>
                {backend && (
                  <span className="render-backend">
                    {backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · {quality}
                  </span>
                )}
                <span>Concept visualization · Not manufacturer CAD</span>
              </div>
              <div className="scene-hint">
                {view === 'interior' ? 'Drag to look around' : 'Drag to orbit · Scroll to explore'}
              </div>
              <button className="environment-quick" onClick={() => setStep(3)}>
                <Leaf size={14} />
                {config.environment === 'courtyard'
                  ? 'The courtyard'
                  : config.environment === 'desert'
                    ? 'Desert retreat'
                    : 'Studio backdrop'}
                <ChevronDown size={13} />
              </button>
            </div>
          )}
          <div className="history-controls">
            <button aria-label="Undo last change" disabled={!canUndo} onClick={undo}>
              <Undo2 size={16} />
            </button>
            <button aria-label="Redo last change" disabled={!canRedo} onClick={redo}>
              <Redo2 size={16} />
            </button>
          </div>
          <button
            className="mobile-toggle"
            onClick={() => setMobilePanel(!mobilePanel)}
            aria-expanded={mobilePanel}
            aria-controls="configuration"
          >
            <SlidersHorizontal size={16} />
            {mobilePanel ? 'Hide options' : 'Customize gym'}
            {mobilePanel ? <Minus size={14} /> : <Plus size={14} />}
          </button>
        </section>
        <div id="configuration" className="panel-wrapper">
          <ConfigPanel
            config={config}
            onChange={setConfig}
            step={step}
            setStep={setStep}
            unit={unit}
            setUnit={setUnit}
            quality={quality}
            setQuality={chooseQuality}
            notify={notify}
            onPlan={() => {
              setView('plan')
              setPhotoMode(false)
            }}
            onTemplate={template}
          />
        </div>
      </main>
      <footer className="summary-bar">
        <div className="summary-product">
          <span className="summary-monogram">
            {config.family === 'studio' ? 'S' : 'C'}
            {config.length}
          </span>
          <div>
            <strong>Your {productName(config)}</strong>
            <span>
              {distance(config.length, unit)} × {distance(8, unit)} · {finish.name} ·{' '}
              {config.items.length} equipment items
            </span>
          </div>
        </div>
        <div className="summary-estimate">
          <button onClick={() => setDialog('estimate')}>
            <span>
              {productFamily(config.family).shortName.toUpperCase()} FAMILY STARTING AT <InfoIcon />
            </span>
            <strong>
              {money(startingPrice)}
              <small>USD</small>
              <ChevronDown size={15} />
            </strong>
          </button>
          <small>Selected build: quote required</small>
        </div>
        <button className="primary brief-cta" onClick={() => setDialog('brief')}>
          <span>
            Create build brief<small>Your vision, in one beautiful PDF.</small>
          </span>
          <ArrowRight size={19} />
        </button>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {dialog === 'estimate' && <EstimateDialog config={config} onClose={close} />}
      {dialog === 'share' && <ShareDialog config={config} onClose={close} notify={notify} />}
      {dialog === 'brief' && (
        <BriefDialog config={config} capture={capture} onClose={close} notify={notify} />
      )}
      {dialog === 'library' && (
        <LibraryDialog
          config={config}
          unit={unit}
          onLoad={setConfig}
          onClose={close}
          notify={notify}
        />
      )}
      {dialog === 'help' && (
        <Modal
          title="A clearer starting point."
          subtitle="Explore. Personalize. Bring your vision into focus."
          onClose={close}
        >
          <div className="help-grid">
            <div>
              <span>01</span>
              <strong>Shape your space</strong>
              <p>
                Choose your footprint, finishes, and outdoor additions. Size changes never silently
                reset your selections.
              </p>
            </div>
            <div>
              <span>02</span>
              <strong>Find your ritual</strong>
              <p>
                Start from an interior package. Drag items in the floor plan, use arrow keys to move
                them, R to rotate, or Delete to remove.
              </p>
            </div>
            <div>
              <span>03</span>
              <strong>Keep the possibilities</strong>
              <p>
                Save and compare builds locally. Share a complete configuration or download a PDF
                brief to discuss with your project team.
              </p>
            </div>
          </div>
          <div className="notice">
            <CircleHelp size={18} />
            <p>
              This is a concept design tool, not a purchasing or engineering system. Family starting
              prices are published; configured totals require a quote. Equipment, materials, and
              geometry are illustrative. No sales requests, deposits, or personal data are
              transmitted.
            </p>
          </div>
          <p className="muted small">
            Camera: drag / pinch / scroll, or focus the scene and use arrow keys and +/−. Undo:
            Ctrl/Cmd+Z. Redo: Ctrl/Cmd+Shift+Z. Floor plan: arrow keys move 3 inches; Shift moves 1
            foot.
          </p>
          <button
            className="secondary full"
            onClick={() => {
              if (
                window.confirm(
                  'Reset to the original Studio concept? Saved builds will not be deleted.',
                )
              ) {
                setConfig(structuredClone(DEFAULT_CONFIG))
                setView('exterior')
                setReset((r) => r + 1)
                close()
                notify('Your design is reset. Undo is available.')
              }
            }}
          >
            <RotateCcw size={16} /> Start fresh
          </button>
        </Modal>
      )}
    </div>
  )
}
/**
 * What the 3D view is busy with once it has a picture: applying a change that rebuilds the scene,
 * or streaming the photo-scanned materials. Hidden while the start-up screen is showing.
 */
function SceneActivity({ updating }: { updating: boolean }) {
  const phase = useSyncExternalStore(sceneProgress.subscribe, sceneProgress.get)
  const { requested, loaded } = useSyncExternalStore(textureProgress.subscribe, textureProgress.get)
  if (phase !== 'ready') return null
  if (updating)
    return (
      <div className="scene-activity is-updating" role="status">
        <i className="activity-spinner" aria-hidden="true" />
        Updating the 3D view…
      </div>
    )
  if (!requested || loaded >= requested) return null
  const percent = Math.round((loaded / requested) * 100)
  return (
    <div className="scene-activity" role="status">
      <i className="activity-spinner" aria-hidden="true" />
      Loading photo-scanned materials · {percent}%
      <span
        className="activity-bar"
        role="progressbar"
        aria-label="Materials loaded"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{ transform: `scaleX(${loaded / requested})` }}
      />
    </div>
  )
}
function InfoIcon() {
  return <ExternalLink size={10} />
}
