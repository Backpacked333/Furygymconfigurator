import { Component, type ReactNode } from 'react'

/**
 * Last line of defense: an unexpected render or effect error shows a way back instead of a blank
 * page. The design lives in the URL fragment and the browser draft, so reloading restores it.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="graphics-fallback" role="alert">
        <strong>Something went wrong.</strong>
        <p>Your design is saved in this page’s link. Reload to pick up where you left off.</p>
        <button className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
