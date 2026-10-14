import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
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
import { EstimateDialog, LibraryDialog, ShareDialog } from './components/Dialogs'
import BriefDialog from './components/BriefDialog'
import ImageExportControls from './components/ImageExportControls'
import {
  DEFAULT_CONFIG,
  FINISHES,
  area,
  distance,
  encodeConfig,
  estimate,
  money,
  productName,
  productHeight,
  changeFamily,
  packageItems,
  packageDefinition,
  type Config,
  type Unit,
  type View,
} from './lib/config'
import { useConfig } from './lib/useConfig'
import { productFamily } from './lib/products'
import {
  defaultQuality,
  initialAutoQuality,
  requestedQuality,
  type Backend,
  type Quality,
  type QualityMode,
  type DeviceProfile,
} from './render/quality'
import { textureProgress } from './render/progress'
import { createCaptureRegistry } from './lib/capture'
import type { PresentationState } from './lib/presentation'
import type { CameraMemory } from './lib/camera'
import { SceneBoundary, SceneLoading } from './components/SceneBoundary'
import RecoveryDialog from './components/RecoveryDialog'
import { storageMessage } from './components/useLibrary'
import './components/document-status.css'
import './components/export-controls.css'

const sceneAssets = () => textureProgress.snapshot('scene')

type Dialog = 'share' | 'brief' | 'estimate' | 'library' | 'help' | 'recovery' | null

export default function App() {
  const [Scene, setScene] = useState(() => lazy(() => import('./components/Scene')))
  const [sceneAttempt, setSceneAttempt] = useState(0)
  const design = useConfig()
  const {
    config,
    committedConfig,
    revision,
    isPreviewing,
    persistence,
    repair,
    recovery,
    setConfig,
    undo,
    redo,
    canUndo,
    canRedo,
    initialNotice,
  } = design
  const exportBlocked = isPreviewing || repair.required || persistence.status === 'initializing'
  const [step, setStep] = useState(0),
    [view, setView] = useState<View>('exterior'),
    [unit, setUnit] = useState<Unit>('ft')
  const [dimensions, setDimensions] = useState(false),
    [quality, setQuality] = useState<Quality>(() => defaultQuality()),
    [backend, setBackend] = useState<Backend | null>(null)
  const [qualityMode, setQualityMode] = useState<QualityMode>(() => requestedQuality() ?? 'auto')
  const [profile, setProfile] = useState<DeviceProfile>()
  const autoAdmitted = useRef(false)
  const [captureRegistry] = useState(createCaptureRegistry)
  const cameraMemory = useRef<CameraMemory>({})
  const [presentation, setPresentation] = useState<PresentationState | null>(null)
  const assets = useSyncExternalStore(textureProgress.subscribe, sceneAssets)
  const assetReadiness = useMemo(
    () => ({
      pending: assets.pending,
      degraded: assets.degraded > 0 || assets.failed > 0,
      revision: `${assets.generation}:${assets.revision}`,
    }),
    [assets],
  )
  const exportContext = {
    config: committedConfig,
    revision,
    getProvider: captureRegistry.get,
    blocked: exportBlocked,
  }
  const [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState(initialNotice),
    [reset, setReset] = useState(0)
  const [autoRotate, setAutoRotate] = useState(false),
    [photoMode, setPhotoMode] = useState(false),
    [mobilePanel, setMobilePanel] = useState(true)
  const photoOpener = useRef<HTMLButtonElement>(null)
  const photoReturn = useRef<{ mobilePanel: boolean; view: View } | null>(null)
  const exitPhoto = useCallback(() => {
    setPhotoMode(false)
    if (photoReturn.current) {
      setMobilePanel(photoReturn.current.mobilePanel)
      setView(photoReturn.current.view)
    }
  }, [])
  useLayoutEffect(() => {
    if (photoMode) {
      document.querySelector<HTMLButtonElement>('[aria-label="Exit photo mode"]')?.focus()
    } else if (photoReturn.current) {
      photoReturn.current = null
      photoOpener.current?.focus()
    }
  }, [photoMode])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback((s: string) => {
    setToast(s)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 6500)
  }, [])
  const chooseQuality = useCallback((next: Quality) => {
    setQualityMode(next)
    setQuality(next)
  }, [])
  const chooseQualityMode = useCallback(
    (next: QualityMode) => {
      setQualityMode(next)
      setQuality(next === 'auto' ? initialAutoQuality(profile) : next)
      autoAdmitted.current = next === 'auto' && !!profile
    },
    [profile],
  )
  const editInteractions = {
    revision,
    interactionKey: `${view}:${photoMode}:${dialog ?? ''}:${step}:${unit}:${mobilePanel}`,
    interactionDisabled: !!dialog || photoMode || persistence.status === 'initializing',
    onBeginEdit: () => {
      setAutoRotate(false)
      return design.beginEdit()
    },
    onPreviewEdit: design.previewEdit,
    onCommitEdit: design.commitEdit,
    onCancelEdit: design.cancelEdit,
  }
  const applyConfiguration = (next: Config) => {
    setAutoRotate(false)
    return setConfig(next)
  }
  const onDeviceProfile = useCallback(
    (next: DeviceProfile) => {
      setProfile(next)
      if (qualityMode === 'auto' && !autoAdmitted.current) {
        autoAdmitted.current = true
        setQuality(initialAutoQuality(next))
      }
    },
    [qualityMode],
  )
  const onSlow = useCallback(() => {
    if (qualityMode !== 'auto' || quality === 'lite') return
    const next = quality === 'ultra' ? 'high' : 'lite'
    setQuality(next)
    notify(
      `Switched to ${next === 'high' ? 'High' : 'Lite'} quality for smoother interaction on this device. You can change it under Setting.`,
    )
  }, [quality, qualityMode, notify])
  const close = () => setDialog(null)
  useEffect(() => {
    if (!persistence.writeSafe || isPreviewing || repair.required) return
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#c=${encodeConfig(committedConfig)}`,
    )
  }, [committedConfig, persistence.writeSafe, isPreviewing, repair.required])
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
      if (e.key === 'Escape') exitPhoto()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [dialog, undo, redo, exitPhoto])
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
        items: packageItems('recovery', 20, config),
        addons: { deck: true, gazebo: config.family === 'studio', roof: false, stairs: false },
        time: 18,
      },
      flow: {
        ...DEFAULT_CONFIG,
        finish: 'olive',
        flooring: 'oak',
        package: 'movement',
        items: packageItems('movement', 20, config),
        time: 9,
      },
    }
    const selected = templates[id]
    const kind = id === 'athlete' ? 'strength' : id === 'retreat' ? 'recovery' : 'movement'
    const preset = packageDefinition(kind, { ...selected, family: config.family })
    if (!preset.available) {
      notify(preset.notice ?? preset.issues.join(' '))
      return
    }
    selected.items = preset.items
    const family = changeFamily(templates[id], config.family)
    if (!family.accepted) {
      notify(family.notice ?? family.issues.join(' '))
      return
    }
    const applied = setConfig(family.config)
    if (applied.status === 'rejected' || applied.status === 'conflict') {
      notify(applied.issues.join(' '))
      return
    }
    setView('exterior')
    setReset((r) => r + 1)
    notify('Concept layout applied. This is not an official Fury package.')
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
          <button disabled={exportBlocked} onClick={() => setDialog('library')}>
            <Bookmark size={16} />
            <span>My builds</span>
          </button>
          <button disabled={exportBlocked} onClick={() => setDialog('share')}>
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
      {(persistence.status !== 'saved' && persistence.status !== 'ready') ||
      repair.required ||
      recovery.length > 0 ||
      isPreviewing ? (
        <div className="document-status" role="status">
          <span>
            {isPreviewing
              ? 'Previewing an edit — finish or cancel before sharing.'
              : repair.required
                ? 'Review required. Original design preserved; exports are paused.'
                : persistence.status === 'initializing'
                  ? 'Opening your saved design…'
                  : persistence.status === 'saving'
                    ? 'Saving on this browser…'
                    : persistence.reason
                      ? storageMessage(persistence.reason)
                      : 'Recovery originals available.'}
          </span>
          {persistence.status !== 'initializing' && (
            <button onClick={() => setDialog('recovery')}>Review & download originals</button>
          )}
        </div>
      ) : null}
      <main className="workspace" tabIndex={-1} data-modal-focus-fallback>
        <section
          className={`stage ${view === 'plan' ? 'is-plan' : ''}`}
          aria-label="Gym visualization"
        >
          {view === 'plan' ? (
            <FloorPlan
              {...editInteractions}
              config={config}
              unit={unit}
              onChange={applyConfiguration}
              notify={notify}
              repairWorkspace={repair.workspace}
            />
          ) : (
            <SceneBoundary
              key={sceneAttempt}
              attempts={sceneAttempt}
              onFailure={() => {
                setPresentation(null)
              }}
              onPlan={() => setView('plan')}
              onRetry={() => {
                setPresentation(null)
                setScene(() => lazy(() => import('./components/Scene')))
                setSceneAttempt((n) => n + 1)
              }}
            >
              <Suspense fallback={<SceneLoading onPlan={() => setView('plan')} />}>
                <Scene
                  config={config}
                  revision={revision}
                  isPreviewing={isPreviewing}
                  view={view}
                  dimensions={dimensions}
                  unit={unit}
                  reset={reset}
                  autoRotate={autoRotate && !dialog && !photoMode && !isPreviewing}
                  quality={quality}
                  onCaptureProvider={captureRegistry.register}
                  onPresentation={setPresentation}
                  cameraMemory={cameraMemory}
                  assets={assetReadiness}
                  qualityMode={qualityMode}
                  onDeviceProfile={onDeviceProfile}
                  onFallback={() => setView('plan')}
                  onBackend={setBackend}
                  onSlow={onSlow}
                />
              </Suspense>
            </SceneBoundary>
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
              ref={photoOpener}
              aria-label="Enter photo mode"
              onClick={() => {
                photoReturn.current = { mobilePanel, view }
                if (view === 'plan') setView('exterior')
                setAutoRotate(false)
                setPhotoMode(true)
                setMobilePanel(false)
              }}
            >
              <Camera size={18} />
              <span>Photo mode</span>
            </button>
          </div>
          {photoMode && (
            <ImageExportControls
              context={exportContext}
              presentation={presentation}
              onClose={exitPhoto}
            />
          )}
          {view !== 'plan' && <MaterialProgress assets={assets} />}
          {view !== 'plan' && (
            <div className="stage-bottom">
              <div className="scene-status">
                <span className="status-dot" />
                <strong>{presentation?.stage.toUpperCase() ?? 'INITIALIZING'}</strong>
                {backend && (
                  <span className="render-backend">
                    {backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} ·{' '}
                    {qualityMode === 'auto' ? 'Auto / ' : ''}
                    {presentation?.token.quality ?? quality}
                    {profile?.hardware === 'software' ? ' · software rendering' : ''}
                  </span>
                )}
                <span>Concept visualization · Not manufacturer CAD</span>
                {qualityMode !== 'auto' && (
                  <button className="quality-auto" onClick={() => chooseQualityMode('auto')}>
                    Use Auto quality
                  </button>
                )}
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
            {...editInteractions}
            config={config}
            onChange={applyConfiguration}
            step={step}
            setStep={setStep}
            unit={unit}
            setUnit={setUnit}
            quality={quality}
            setQuality={chooseQuality}
            qualityMode={qualityMode}
            setQualityMode={chooseQualityMode}
            notify={notify}
            onPlan={() => {
              exitPhoto()
              setView('plan')
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
        <button
          className="primary brief-cta"
          disabled={exportBlocked}
          onClick={() => setDialog('brief')}
        >
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
      {dialog === 'share' && !exportBlocked && (
        <ShareDialog config={committedConfig} onClose={close} notify={notify} />
      )}
      {dialog === 'brief' && (
        <BriefDialog context={exportContext} onClose={close} notify={notify} />
      )}
      {dialog === 'library' && (
        <LibraryDialog
          config={committedConfig}
          unit={unit}
          saveBlocked={isPreviewing || repair.required}
          onRepair={async (candidate, original) => {
            const result = await design.openRepair(candidate, original)
            if (!result.ok) {
              notify(storageMessage(result.reason))
              return false
            }
            setView('plan')
            notify(
              'Repair workspace opened. Both designs are preserved; accept a valid repair to resume saving.',
            )
            return true
          }}
          onLoad={(next) => {
            const result = setConfig(next)
            if (result.status === 'rejected' || result.status === 'conflict') {
              notify(
                result.issues.join(' ') ||
                  'This saved build needs repair. Its original is preserved.',
              )
              return false
            }
            return true
          }}
          onClose={close}
          notify={notify}
        />
      )}
      {dialog === 'recovery' && (
        <RecoveryDialog
          document={design}
          onClose={close}
          notify={notify}
          onPlan={() => {
            setView('plan')
            close()
          }}
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
            onClick={async () => {
              if (
                window.confirm(
                  'Reset to the original Studio concept? Saved builds will not be deleted.',
                )
              ) {
                const result = await design.resetConfig()
                if (!result.ok || result.value.status !== 'saved') {
                  notify(storageMessage(result.ok ? 'conflict' : result.reason))
                  return
                }
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
/** Shows progress while the photo-scanned material library streams in. */
function MaterialProgress({ assets }: { assets: ReturnType<typeof sceneAssets> }) {
  const { requested, ready, pending, failed, degraded, canRetry } = assets
  if (!requested || (!pending && !failed && !degraded)) return null
  return (
    <div className="material-progress" role="status">
      <span aria-hidden="true" style={{ width: `${Math.round((ready / requested) * 100)}%` }} />
      {pending
        ? `Loading scanned maps · ${ready}/${requested} ready`
        : `Degraded materials · ${failed || degraded} maps use illustrative fallbacks`}
      {canRetry && (
        <button onClick={() => textureProgress.retry('scene')}>Retry failed maps</button>
      )}
    </div>
  )
}
function InfoIcon() {
  return <ExternalLink size={10} />
}
