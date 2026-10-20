import { Component, type ReactNode } from 'react'

/**
 * Catches a failed download of the lazily loaded 3D bundle (a network drop, or a deploy that
 * replaced the hashed chunk this page referenced). Without it the rejection would unmount the whole
 * app. The design lives in the URL fragment, so reloading keeps it.
 */
export class SceneLoadBoundary extends Component<
  { children: ReactNode; onFallback: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="graphics-fallback" role="alert">
        <strong>Your design is still here.</strong>
        <p>
          The 3D view didn’t finish loading. Check your connection and reload. Configuration,
          pricing, and floor-plan tools still work.
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          Reload the 3D view
        </button>
        <button className="secondary" onClick={this.props.onFallback}>
          Open the floor plan
        </button>
      </div>
    )
  }
}
