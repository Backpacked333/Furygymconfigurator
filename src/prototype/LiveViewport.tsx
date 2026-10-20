import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { DesignEnvelope } from '../domain/design'
import type { Unit } from '../lib/config'
import {
  LIVE_STEPS,
  liveLoading,
  sceneProgress,
  textureProgress,
  type LiveStep,
} from '../render/progress'
import type { ViewerStatus } from '../viewer/ProgressiveRenderer'

const LiveDesignScene = lazy(() => import('./LiveDesignScene'))

class ViewerBoundary extends Component<
  { children: ReactNode; onUnavailable: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onUnavailable()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

const labels: Record<ViewerStatus, string> = {
  loading: 'Preparing your live 360° view…',
  interactive: 'Drag to explore · Scroll to zoom',
  refining: 'Refining light and reflections',
  settled: 'View refined · Drag to explore',
  'raster-only': 'Live 3D · Path tracing unavailable on this device',
}

/** The crossfade between the gallery image and the live view, either way (prototype.css). */
export const LIVE_FADE_MS = 300

/** What the loading screen says each step is doing (render/progress.ts liveLoading). */
const stepLabels: Record<Exclude<LiveStep, 'ready'>, string> = {
  engine: 'Loading the 3D engine',
  scene: 'Building the scene',
  materials: 'Preparing materials and light',
  tracer: 'Starting the path tracer',
}
const STEPS = LIVE_STEPS.filter((step): step is Exclude<LiveStep, 'ready'> => step !== 'ready')

/**
 * Where the view is on its way to being explorable: the renderer's own phases move it to "scene"
 * (the engine is up and the scene is mounting) before the scene's controller takes over.
 */
function useLiveStep(): LiveStep {
  const step = useSyncExternalStore(liveLoading.subscribe, liveLoading.get)
  const phase = useSyncExternalStore(sceneProgress.subscribe, sceneProgress.get)
  const mounting = phase === 'shaders' || phase === 'ready'
  return step === 'engine' && mounting ? 'scene' : step
}

/**
 * The loading screen over the stage while the 360° view prepares (over the gallery image, which
 * stays visible behind it). Every animation in it is a transform or an opacity, which the
 * compositor runs off the main thread: it keeps moving through the scene's longest tasks.
 */
function LiveLoading({
  step,
  fraction,
  done,
}: {
  step: LiveStep
  fraction: number | null
  done: boolean
}) {
  const current = step === 'ready' ? STEPS.length : STEPS.indexOf(step)
  return (
    <div className={`live-viewport-loading live-loading${done ? ' is-done' : ''}`} role="status">
      <div className="live-loading-card">
        <svg className="live-loading-ring" viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r="16" />
          <circle cx="20" cy="20" r="16" />
        </svg>
        <strong>{labels.loading}</strong>
        <ol className="live-loading-steps" aria-hidden="true">
          {STEPS.map((item, index) => (
            <li
              key={item}
              className={index < current ? 'is-done' : index === current ? 'is-active' : undefined}
            >
              <i />
              {stepLabels[item]}
            </li>
          ))}
        </ol>
        <div
          className={`live-loading-bar${fraction === null ? ' is-waiting' : ''}`}
          aria-hidden="true"
        >
          <i style={fraction === null ? undefined : { transform: `scaleX(${fraction})` }} />
        </div>
        <span className="sr-only">{step === 'ready' ? 'Ready' : stepLabels[step]}</span>
      </div>
    </div>
  )
}

/**
 * Whether the gallery image is on the stage under the live view: 'still' while the canvas draws
 * unseen over this design's own rendered image, 'lifting' while it fades in over it, null once the
 * live view stands alone.
 */
export type LiveCurtain = 'still' | 'lifting' | null

/** This boundary is renderer-free until the user explicitly opens the live view. */
export function LiveViewport(props: {
  design: DesignEnvelope
  active: boolean
  unit: Unit
  dimensions: boolean
  autoRotate: boolean
  reset: number
  /** The design's own Cycles image, on the stage at the camera the view opens at; none otherwise. */
  entryImage?: string
  curtain: LiveCurtain
  /** Closing: the inactive view stays up, holding its last frame, to fade off the gallery image. */
  leaving: boolean
  onReadyChange: (ready: boolean) => void
  onLeaveEntry: () => void
}) {
  const [status, setStatus] = useState<ViewerStatus>('loading')
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  // A new view starts its loading from the beginning (before any of its scene mounts).
  useState(() => liveLoading.restart())
  const step = useLiveStep()
  // Scans are counted for the whole page: the share of those requested since this view opened.
  const [textureBase] = useState(() => textureProgress.get())
  const textures = useSyncExternalStore(textureProgress.subscribe, textureProgress.get)
  const requested = textures.requested - textureBase.requested
  const fraction =
    step === 'materials' && requested > 0
      ? Math.min(1, (textures.loaded - textureBase.loaded) / requested)
      : null
  // The screen fades out (LIVE_FADE_MS) once the view is ready to explore.
  const loading = step !== 'ready'
  const [fading, setFading] = useState(false)
  const [wasLoading, setWasLoading] = useState(loading)
  if (wasLoading !== loading) {
    setWasLoading(loading)
    if (!loading) setFading(true)
  }
  useEffect(() => {
    if (!fading) return
    const timer = setTimeout(() => setFading(false), LIVE_FADE_MS)
    return () => clearTimeout(timer)
  }, [fading])
  // The curtain is the gallery's, not the scene's: the memoised scene never re-renders for it.
  const { curtain, leaving, onReadyChange, onLeaveEntry, ...scene } = props
  // The gallery image is on the stage under the canvas, or the canvas is fading in over it. A
  // failed view shows its failure over the image instead.
  const covered = curtain !== null && !failed
  const photo = covered && curtain === 'still'
  const onReady = useCallback(() => {
    setReady(true)
    onReadyChange(true)
  }, [onReadyChange])
  const onUnavailable = useCallback(() => {
    setFailed(true)
    onReadyChange(false)
  }, [onReadyChange])
  return (
    <div
      className={`live-viewport${ready && !failed ? ' is-ready' : ''}${photo ? ' is-covered' : covered ? ' is-lifting' : ''}${leaving ? ' is-leaving' : ''}`}
      hidden={!props.active && !leaving}
      aria-label="Interactive 360° design view"
    >
      <ViewerBoundary onUnavailable={onUnavailable}>
        <Suspense fallback={null}>
          {!failed && (
            <LiveDesignScene
              {...scene}
              onReady={onReady}
              onStatus={setStatus}
              onUnavailable={onUnavailable}
              onLeaveEntry={onLeaveEntry}
            />
          )}
        </Suspense>
      </ViewerBoundary>
      {failed ? (
        <div className="live-viewport-loading" role="status">
          <strong>Live 3D is unavailable on this device.</strong>
          <span>Close the 360° view to return to your gallery. Your design is unchanged.</span>
        </div>
      ) : loading || fading || (!ready && !covered) ? (
        <LiveLoading step={step} fraction={fraction} done={!loading && (ready || covered)} />
      ) : null}
      {/* Over the rendered image a compact note, not a veil: the image is what is on the stage. */}
      {!failed && !loading && (ready || covered) && (
        <span className="live-viewport-status" role="status">
          {!ready
            ? labels.loading
            : photo
              ? 'Showing the rendered image · Drag to explore'
              : labels[status]}
        </span>
      )}
      {!photo && (
        <span className="live-viewport-disclaimer">Live concept preview · Not a saved render</span>
      )}
    </div>
  )
}
