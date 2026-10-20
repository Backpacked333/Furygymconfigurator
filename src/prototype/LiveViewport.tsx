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

/** This boundary is renderer-free until the user explicitly opens the live view. */
export function LiveViewport(props: {
  design: DesignEnvelope
  active: boolean
  unit: Unit
  dimensions: boolean
  autoRotate: boolean
  reset: number
  onReadyChange: (ready: boolean) => void
}) {
  const [status, setStatus] = useState<ViewerStatus>('loading')
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const { onReadyChange } = props
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
      className={`live-viewport${ready && !failed ? ' is-ready' : ''}`}
      hidden={!props.active}
      aria-label="Interactive 360° design view"
    >
      <ViewerBoundary onUnavailable={onUnavailable}>
        <Suspense fallback={null}>
          {!failed && (
            <LiveDesignScene
              {...props}
              onReady={onReady}
              onStatus={setStatus}
              onUnavailable={onUnavailable}
            />
          )}
        </Suspense>
      </ViewerBoundary>
      {(!ready || failed) && (
        <div className="live-viewport-loading" role="status">
          <strong>{failed ? 'Live 3D is unavailable on this device.' : labels.loading}</strong>
          <span>
            {failed
              ? 'Close the 360° view to return to your gallery. Your design is unchanged.'
              : 'Your selected design is loading. No cloud render is started.'}
          </span>
        </div>
      )}
      {ready && !failed && (
        <span className="live-viewport-status" role="status">
          {labels[status]}
        </span>
      )}
      <span className="live-viewport-disclaimer">Live concept preview · Not a saved render</span>
    </div>
  )
}
