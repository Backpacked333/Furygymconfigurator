import { Component, Suspense, lazy, useCallback, useState, type ReactNode } from 'react'
import type { DesignEnvelope } from '../domain/design'
import type { Unit } from '../lib/config'
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
  curtain: LiveCurtain
  /** Closing: the inactive view stays up, holding its last frame, to fade off the gallery image. */
  leaving: boolean
  onReadyChange: (ready: boolean) => void
  onLeaveEntry: () => void
}) {
  const [status, setStatus] = useState<ViewerStatus>('loading')
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
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
      {(failed || (!ready && !covered)) && (
        <div className="live-viewport-loading" role="status">
          <strong>{failed ? 'Live 3D is unavailable on this device.' : labels.loading}</strong>
          <span>
            {failed
              ? 'Close the 360° view to return to your gallery. Your design is unchanged.'
              : 'Your selected design is loading. No cloud render is started.'}
          </span>
        </div>
      )}
      {/* Over the rendered image a compact note, not a veil: the image is what is on the stage. */}
      {!failed && (ready || covered) && (
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
