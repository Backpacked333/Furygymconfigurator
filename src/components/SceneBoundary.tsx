import { Component, useEffect, useState, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  onRetry: () => void
  onPlan: () => void
  onFailure: () => void
  attempts: number
}

export class SceneBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onFailure()
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="graphics-fallback" role="alert">
        <strong>The 3D view could not open.</strong>
        <p>
          Your design has not been reset. Continue in the floor plan, or retry the graphics view.
          Saving and image-free briefs remain available.
        </p>
        {this.props.attempts < 2 ? (
          <button className="secondary" onClick={this.props.onRetry}>
            Retry 3D
          </button>
        ) : (
          <p>
            Retry limit reached. Keep working in the plan and export your design before reloading.
          </p>
        )}
        <button className="primary" onClick={this.props.onPlan}>
          Continue in the floor plan
        </button>
      </div>
    )
  }
}

export function SceneLoading({ onPlan }: { onPlan: () => void }) {
  const [delayed, setDelayed] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setDelayed(true), 12_000)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div className="scene-loading" role="status">
      <span className="loading-mark" aria-hidden="true">
        F
      </span>
      <p>{delayed ? '3D is taking longer than expected.' : 'Preparing your 3D workspace.'}</p>
      <button className="secondary" onClick={onPlan}>
        Work in the floor plan
      </button>
    </div>
  )
}
