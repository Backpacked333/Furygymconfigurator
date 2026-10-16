import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import {
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  CircleHelp,
  Expand,
  ExternalLink,
  Eye,
  Maximize,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
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
import { RenderStatus } from './components/RenderStatus'
import { StageToolbar } from './components/StageToolbar'
import { Filmstrip, StillLayers } from './components/StillStage'
import { stillLabel, useReducedMotion, useStillStage } from './components/useStillStage'
import {
  DEFAULT_CAMERA,
  DEFAULT_CONFIG,
  FINISHES,
  SIGNATURES,
  area,
  decodeConfig,
  distance,
  estimate,
  money,
  productName,
  productHeight,
  type Config,
  type SignatureId,
  type Unit,
  type View,
} from './lib/config'
import { describeChange, type Change } from './lib/describeChange'
import { configKey } from './lib/stillKey'
import { useConfig } from './lib/useConfig'
import { useShareFragment } from './lib/useShareFragment'
import { useStagedScene } from './lib/useStagedScene'
import { productFamily } from './lib/products'
import { defaultQuality, type Backend, type Quality } from './render/quality'
import { cloudUrl, requestedTrace } from './render/traceStatus'
import {
  ASPECT_RATIO,
  DEFAULT_ANGLE,
  INTERIOR_ANGLE,
  TALL_MEDIA,
  galleryAngle,
  nearestAngle,
  type AngleId,
  type AspectClass,
} from './render/gallery'
import { freezeLiveView, settledRuns, useSettledRuns } from './render/liveView'
import { setPendingChoice, useStills } from './render/stillStatus'
import { warmCloud } from './render/renderSession'
import { sceneProgress, textureProgress } from './render/progress'
import { benchEnabled, useBench } from './render/bench'

const Scene = lazy(() => import('./components/Scene'))
type Dialog = 'share' | 'brief' | 'estimate' | 'library' | 'help' | null
/** `?bench=1`: read once, as the panel is for a page opened to measure it. */
const BENCH = benchEnabled()
/** The crossfade between a still and the 360° view, either way. */
const LIVE_FADE_MS = 300
/** The longest the 360° view waits for its first settled frame before it shows anyway. */
const LIVE_WAIT_MS = 2500

export default function App() {
  const { config, encoded, setConfig, undo, redo, canUndo, canRedo, initialNotice } = useConfig()
  const [step, setStep] = useState(0),
    [view, setView] = useState<View>('exterior'),
    [unit, setUnit] = useState<Unit>('ft')
  const [dimensions, setDimensions] = useState(false),
    [quality, setQuality] = useState<Quality>(() => defaultQuality()),
    [backend, setBackend] = useState<Backend | null>(null),
    // A cloud renderer path traces on any device, so light devices get it too.
    [trace, setTrace] = useState(
      () => requestedTrace() ?? (cloudUrl() !== null || defaultQuality() !== 'lite'),
    )
  // An explicit choice (panel or ?quality=) is never overridden by the performance governor.
  const qualityChosen = useRef(new URLSearchParams(window.location.search).has('quality'))
  const [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState(initialNotice),
    [reset, setReset] = useState(0)
  const [autoRotate, setAutoRotate] = useState(false),
    [mobilePanel, setMobilePanel] = useState(true),
    [downloading, setDownloading] = useState(false)
  const [camera, setCamera] = useState<[number, number, number]>(DEFAULT_CAMERA)
  // The gallery of path-traced stills (the default), or the live 360° view.
  const [mode, setMode] = useState<'gallery' | 'live'>('gallery')
  /**
   * Entering the 360° view, the still stays over the canvas until the live view has drawn a
   * settled frame, then fades ('lifting'). Leaving it, the live view's last frame is held as an
   * image ('hold') until the still of the nearest angle is on the stage under it, then fades.
   */
  const [curtain, setCurtain] = useState<'still' | 'lifting' | null>(null)
  const [freeze, setFreeze] = useState<'hold' | 'fading' | null>(null)
  const freezeCanvas = useRef<HTMLCanvasElement>(null)
  /** The live view's settle runs at the last switch of mode: the next one is of the new view. */
  const settledAt = useRef(0)
  const settled = useSettledRuns(curtain === 'still' || freeze === 'hold')
  const reduced = useReducedMotion()
  const [angle, setAngle] = useState<AngleId>(DEFAULT_ANGLE)
  /** Where each view switch lands in the gallery: the angle last picked in it. */
  const lastAngles = useRef<Record<'exterior' | 'interior', AngleId>>({
    exterior: DEFAULT_ANGLE,
    interior: INTERIOR_ANGLE,
  })
  const aspect = useAspectClass()
  const design = useMemo(() => configKey(config), [config])
  const change = useChange(config)
  const stills = useStills()
  // Under a held frame of the 360° view the still swaps in at once: the frame's fade is the one.
  const stage = useStillStage({
    design,
    angle,
    aspect,
    snapshot: stills,
    instant: freeze === 'hold',
  })
  const gallery = mode === 'gallery'
  // The stage waits for a still of the visitor's design at their angle, which something renders.
  const stagePending = gallery && stills.source !== null && !stage.current
  const covered = gallery && stage.covered
  // Nothing path traced on the stage yet (or nothing to trace with): the live view shows there.
  const livePreview = gallery && !stage.state.shown
  // An angle turned to whose still is not in yet is named by the angle; anything else by the edit.
  const what =
    stage.state.shown?.design === `${design}|${aspect}` ? galleryAngle(angle).phrase : change.label
  const progress = stills.design === design ? stills.progress : null
  useEffect(() => {
    setPendingChoice(
      stagePending && change.field && change.value
        ? { field: change.field, value: change.value }
        : null,
    )
  }, [stagePending, change])
  // The still in the 360° view's way lifts once the live view shows a settled frame (or after a
  // while, on a device too slow to settle promptly).
  useEffect(() => {
    if (mode !== 'live' || curtain !== 'still') return
    if (settled > settledAt.current) {
      setCurtain('lifting')
      return
    }
    const timer = setTimeout(() => setCurtain('lifting'), LIVE_WAIT_MS)
    return () => clearTimeout(timer)
  }, [mode, curtain, settled])
  useEffect(() => {
    if (curtain !== 'lifting') return
    const timer = setTimeout(() => setCurtain(null), reduced ? 0 : LIVE_FADE_MS)
    return () => clearTimeout(timer)
  }, [curtain, reduced])
  // The held frame fades once the still of the angle is whole on the stage under it (or, with no
  // stills to wait for, once the live view under it has settled at the angle).
  const angleShown =
    stage.state.shown?.design === `${design}|${aspect}` &&
    stage.state.shown.angle === angle &&
    !stage.state.fading
  useEffect(() => {
    if (freeze !== 'hold') return
    if (angleShown || (stills.source === null && settled > settledAt.current)) setFreeze('fading')
  }, [freeze, angleShown, stills.source, settled])
  useEffect(() => {
    if (freeze !== 'fading') return
    const timer = setTimeout(() => setFreeze(null), reduced ? 0 : LIVE_FADE_MS)
    return () => clearTimeout(timer)
  }, [freeze, reduced])
  /** Opens the 360° view at the still's own pose; the still stays until the view has settled. */
  const enterLive = () => {
    if (view === 'plan' || mode === 'live') return
    settledAt.current = settledRuns()
    setCurtain(stage.state.shown && !freeze ? 'still' : null)
    setFreeze(null)
    setMode('live')
  }
  const leaving = useRef(false)
  /**
   * Back to the gallery, at `to` or the angle nearest where the 360° view's camera ended up. The
   * view's last frame is held over the stage until that angle's still is there, so nothing of
   * another angle, or a lesser image, shows meanwhile.
   */
  const leaveLive = async (to?: AngleId) => {
    if (mode !== 'live' || leaving.current) return
    leaving.current = true
    const pose = freezeCanvas.current ? await freezeLiveView(freezeCanvas.current) : null
    leaving.current = false
    const group = to ? galleryAngle(to).group : view === 'interior' ? 'interior' : 'exterior'
    const next =
      to ??
      (pose ? nearestAngle(staged.config, group, pose, aspect, camera) : lastAngles.current[group])
    settledAt.current = settledRuns()
    setFreeze(pose ? 'hold' : null)
    setCurtain(null)
    lastAngles.current[group] = next
    setAngle(next)
    setView(group)
    setAutoRotate(false)
    setMode('gallery')
  }
  /** Puts an angle on the stage, in the gallery. */
  const pickAngle = (next: AngleId) => {
    if (mode === 'live') {
      void leaveLive(next)
      return
    }
    const group = galleryAngle(next).group
    lastAngles.current[group] = next
    setAngle(next)
    setView(group)
    setAutoRotate(false)
  }
  const frame = useRef<HTMLDivElement>(null)
  const box = useFitBox(frame, ASPECT_RATIO[aspect])
  const fullscreen = useFullscreen(frame)
  const captureRef = useRef<(() => Promise<string>) | null>(null),
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
  const onCaptureReady = useCallback((capture: (() => Promise<string>) | null) => {
    captureRef.current = capture
  }, [])
  const openPlan = useCallback(() => setView('plan'), [])
  const staged = useStagedScene(config, quality)
  // The 3D scene stays mounted, hidden and paused, under the floor plan, so returning keeps the
  // renderer, its compiled shaders, and the camera rather than starting cold. It keeps the last
  // 3D view meanwhile.
  const [sceneView, setSceneView] = useState<View>('exterior')
  if (view !== 'plan' && view !== sceneView) setSceneView(view)
  const capture = useCallback(async () => {
    if (view === 'plan' || !captureRef.current) return null
    try {
      return (await captureRef.current()) || null
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
  // The visitor's cloud GPU boots while the scene chunk and the scanned materials load.
  useEffect(() => {
    const url = cloudUrl()
    if (url !== null && trace) warmCloud(url)
  }, [trace])
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
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [dialog, undo, redo])
  const signature = (id: SignatureId) => {
    const build = SIGNATURES.find((s) => s.id === id)!
    if (
      !window.confirm(
        `Apply the ${build.name} build? This replaces your current design, including product family, size, and equipment. You can undo the change.`,
      )
    )
      return
    setConfig(structuredClone(build.config))
    setCamera(build.camera)
    setView('exterior')
    setAngle(DEFAULT_ANGLE)
    lastAngles.current.exterior = DEFAULT_ANGLE
    setReset((r) => r + 1)
    notify(`${build.name} applied. Every option stays editable; the build still requires a quote.`)
  }
  const download = async () => {
    if (downloading) return
    setDownloading(true)
    if (gallery && stills.source !== null)
      notify('Rendering a full-resolution image of this view. It takes up to a minute.')
    const image = await capture()
    setDownloading(false)
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
    <div className={`app ${mobilePanel ? 'panel-open' : 'panel-closed'}`}>
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
          className={`stage is-${mode} ${view === 'plan' ? 'is-plan' : ''}`}
          aria-label="Gym visualization"
        >
          <div className="stage-header">
            <div className="stage-heading">
              <span className="eyebrow">
                <span className="small-line" />{' '}
                {config.family === 'studio' ? 'THE S-SERIES COLLECTION' : 'CONTAINER GYMS'}
              </span>
              <div className="stage-title">
                <h1>
                  {config.family === 'studio' ? 'S' : 'C'}-{config.length}
                  <span>Space to become more.</span>
                </h1>
                <div className="studio-meta">
                  {area(config.length * 8, unit)}
                  <i />
                  {finish.name}
                  <i />
                  {distance(productHeight(config), unit)} high
                </div>
              </div>
              {config.studioLayout !== 'single' && (
                <p className="custom-preview-note">
                  Custom project requested · Single reference unit shown
                </p>
              )}
            </div>
            <div className="stage-header-tools">
              <div className="stage-header-row">
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
                          // The angle last picked inside or outside: in the gallery its still, in
                          // the 360° view where the camera glides to.
                          else setAngle(lastAngles.current[v])
                        }}
                      >
                        <Icon size={14} />
                        <span>{v === 'plan' ? 'Floor plan' : v[0].toUpperCase() + v.slice(1)}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="history-controls" role="group" aria-label="History">
                  <button aria-label="Undo last change" disabled={!canUndo} onClick={undo}>
                    <Undo2 size={16} />
                  </button>
                  <button aria-label="Redo last change" disabled={!canRedo} onClick={redo}>
                    <Redo2 size={16} />
                  </button>
                </div>
              </div>
              {view !== 'plan' && (
                <div className="scene-status">
                  <span className="status-dot" />
                  <strong>
                    {mode === 'live' ? 'LIVE 3D' : livePreview ? 'LIVE PREVIEW' : 'PATH TRACED'}
                  </strong>
                  {backend && (mode === 'live' || livePreview) && (
                    <span className="render-backend">
                      {backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · {quality}
                    </span>
                  )}
                  {gallery && !livePreview && (
                    <span className="render-backend">
                      {stills.source === 'local' ? 'This device' : 'Cycles'} · 256 samples
                    </span>
                  )}
                  <span className="scene-note">
                    {mode === 'live'
                      ? view === 'interior'
                        ? 'Drag to look around'
                        : 'Drag to orbit · Scroll to zoom'
                      : 'Concept visualization · Not manufacturer CAD'}
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="stage-body">
            <div className="stage-frame" ref={frame}>
              <div
                className={`still-stage is-${aspect}${covered ? ' is-covered' : ''}`}
                style={box ?? undefined}
              >
                <div className={`scene-layer ${view === 'plan' ? 'is-hidden' : ''}`}>
                  <SceneLoadBoundary onFallback={openPlan}>
                    <Suspense fallback={<SceneLoading phase="engine" />}>
                      <Scene
                        active={view !== 'plan'}
                        config={staged.config}
                        view={sceneView}
                        dimensions={dimensions && mode === 'live'}
                        unit={unit}
                        reset={reset}
                        camera={camera}
                        autoRotate={autoRotate}
                        quality={staged.quality}
                        trace={trace}
                        mode={mode}
                        angle={angle}
                        covered={covered}
                        onCaptureReady={onCaptureReady}
                        onFallback={openPlan}
                        onBackend={setBackend}
                        onSlow={onSlow}
                      />
                    </Suspense>
                  </SceneLoadBoundary>
                </div>
                {(gallery || curtain) && (
                  <StillLayers
                    stage={stage}
                    label={stillLabel(angle)}
                    lifting={curtain === 'lifting'}
                  />
                )}
                <canvas
                  ref={freezeCanvas}
                  className={`live-freeze${freeze ? ` is-${freeze}` : ''}`}
                  aria-hidden="true"
                />
                {gallery && view !== 'plan' && (
                  <RenderStatus
                    pending={stagePending}
                    swaps={stage.state.swaps}
                    what={what}
                    progress={progress}
                  />
                )}
                {livePreview && !freeze && view !== 'plan' && (
                  <span className="live-preview-label">Live preview</span>
                )}
                {view !== 'plan' && (mode === 'live' || (livePreview && !stagePending)) && (
                  <SceneActivity updating={staged.updating} />
                )}
                <div className="sr-only" role="status" aria-live="polite">
                  {mode === 'live'
                    ? view === 'interior'
                      ? '360° View. Drag, or focus the view and use the arrow keys, to look around.'
                      : '360° View. Drag, or focus the view and use the arrow keys, to orbit.'
                    : ''}
                </div>
                {view !== 'plan' && (
                  <StageToolbar
                    live={mode === 'live'}
                    interior={view === 'interior'}
                    config={config}
                    onChange={setConfig}
                    onMoreSettings={() => {
                      setStep(3)
                      setMobilePanel(true)
                    }}
                    onToggleLive={() => (mode === 'live' ? void leaveLive() : enterLive())}
                    dimensions={dimensions}
                    onDimensions={() => setDimensions(!dimensions)}
                    autoRotate={autoRotate}
                    onAutoRotate={() => setAutoRotate(!autoRotate)}
                    onReset={() => setReset((r) => r + 1)}
                    onDownload={download}
                    downloading={downloading}
                    fullscreen={fullscreen}
                    onFullscreen={() => toggleFullscreen(frame.current)}
                  />
                )}
              </div>
            </div>
            {view !== 'plan' && (
              <Filmstrip
                design={design}
                angle={angle}
                aspect={aspect}
                snapshot={stills}
                stagePending={stagePending}
                onPick={pickAngle}
              />
            )}
            <div className="stage-mobile-row">
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
            </div>
            {view === 'plan' && (
              <FloorPlan config={config} unit={unit} onChange={setConfig} notify={notify} />
            )}
          </div>
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
            trace={trace}
            setTrace={setTrace}
            traceSupported={backend === 'webgpu'}
            cloud={cloudUrl() !== null}
            notify={notify}
            onPlan={() => setView('plan')}
            onSignature={signature}
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
      {BENCH && <BenchPanel />}
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
                setCamera(DEFAULT_CAMERA)
                setView('exterior')
                setAngle(DEFAULT_ANGLE)
                lastAngles.current.exterior = DEFAULT_ANGLE
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
/** The stage's shape: 4:5 on phones, 16:10 elsewhere (styles.css switches at the same width). */
function useAspectClass(): AspectClass {
  const query = useMemo(() => window.matchMedia(TALL_MEDIA), [])
  const tall = useSyncExternalStore(
    (listener) => {
      query.addEventListener('change', listener)
      return () => query.removeEventListener('change', listener)
    },
    () => query.matches,
  )
  return tall ? 'tall' : 'wide'
}

/** What the latest edit changed (describeChange.ts), kept until the next one. */
function useChange(config: Config): Change {
  const [seen, setSeen] = useState<{ config: Config; change: Change }>(() => ({
    config,
    change: describeChange(null, config),
  }))
  if (seen.config !== config) {
    const change = describeChange(seen.config, config)
    setSeen({ config, change })
    return change
  }
  return seen.change
}

/**
 * The largest box of `ratio` that fits the frame: the stage keeps its shape at any window size,
 * like a photograph. Null until the frame has been measured (CSS sizes the box meanwhile).
 */
function useFitBox(frame: RefObject<HTMLDivElement | null>, ratio: number) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const fit = () => {
      const style = getComputedStyle(element)
      const width =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const height =
        element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      if (!(width > 0 && height > 0)) return
      const w = Math.floor(Math.min(width, height * ratio))
      const next = { width: w, height: Math.round(w / ratio) }
      setSize((current) =>
        current?.width === next.width && current.height === next.height ? current : next,
      )
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame, ratio])
  return size
}

/**
 * Whether `target` is shown full screen; null where the browser cannot (an iPhone, an embed that
 * does not allow it), so the stage offers no button that would do nothing.
 */
function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const change = () => setOn(!!target.current && document.fullscreenElement === target.current)
    document.addEventListener('fullscreenchange', change)
    return () => document.removeEventListener('fullscreenchange', change)
  }, [target])
  return document.fullscreenEnabled ? on : null
}

function toggleFullscreen(target: HTMLElement | null) {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void target?.requestFullscreen().catch(() => {})
}

/**
 * The rendering benchmarks `?bench=1` shows (src/render/bench.ts, docs/benchmarks.md): a small
 * table of seconds from page load to each first, how the cloud answered and what its frames cost,
 * and the local tracer's times. Text only, so it is read off a screenshot as easily as the page.
 */
function BenchPanel() {
  const stats = useBench()
  const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`)
  const millis = (ms: number | null) => (ms === null ? '—' : `${Math.round(ms)} ms`)
  const { own, shared } = stats.renderer
  const renderer = own || shared ? ` · own ${own} / shared ${shared}` : ''
  const frames = stats.frames ? ` (${stats.frames} frames, ${stats.cached} cached)` : ''
  const rows: [string, string][] = [
    ['first raster frame', seconds(stats.marks.firstRaster)],
    ['textures settled', seconds(stats.marks.texturesSettled)],
    ['scene captured', seconds(stats.marks.sceneCaptured)],
    ['first request', seconds(stats.marks.firstRequest)],
    ['first thumbnail', seconds(stats.marks.firstThumb)],
    ['first still on stage', seconds(stats.marks.firstStill)],
    ['first local trace', seconds(stats.marks.firstLocalTrace)],
    ['cloud', `${stats.cloud}${renderer}`],
    [
      'server frame',
      `render ${millis(stats.renderMs)} · finish ${millis(stats.finishMs)} · round trip ${millis(stats.totalMs)}${frames}`,
    ],
    [
      'local tracer',
      `first image ${seconds(stats.local.firstMs)} · settled ${seconds(stats.local.settledMs)}`,
    ],
  ]
  return (
    <table className="bench-panel" aria-label="Rendering benchmarks">
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
