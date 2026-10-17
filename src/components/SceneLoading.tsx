import { useSyncExternalStore } from 'react'
import { sceneProgress, type ScenePhase } from '../render/progress'

const STEPS: { phase: Exclude<ScenePhase, 'ready'>; label: string }[] = [
  { phase: 'engine', label: 'Downloading the 3D engine' },
  { phase: 'renderer', label: 'Starting the graphics renderer' },
  { phase: 'shaders', label: 'Preparing materials and lighting' },
]
/** Overall progress shown at the start of each step. */
const AT: Record<ScenePhase, number> = { engine: 8, renderer: 45, shaders: 70, ready: 100 }

/**
 * Staged progress while the 3D view starts, so a first visit never looks stuck. Its motion is
 * transform-only, which the browser's compositor keeps animating even while shader compilation
 * holds the main thread.
 */
export function SceneLoading({ phase }: { phase: ScenePhase }) {
  const current = STEPS.findIndex((step) => step.phase === phase)
  return (
    <div className="scene-loading" role="status" aria-live="polite">
      <span className="loading-mark" aria-hidden="true">
        F
      </span>
      <p className="scene-loading-title">Loading the 3D studio</p>
      <div
        className="loading-bar"
        role="progressbar"
        aria-label="3D view loading"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={AT[phase]}
      >
        <span style={{ transform: `scaleX(${AT[phase] / 100})` }} />
        <i aria-hidden="true" />
      </div>
      <ol className="loading-steps">
        {STEPS.map((step, i) => (
          <li
            key={step.phase}
            className={i < current ? 'is-done' : i === current ? 'is-active' : undefined}
          >
            {step.label}
          </li>
        ))}
      </ol>
      <p className="scene-loading-note">You can start configuring while it loads.</p>
    </div>
  )
}

/** The loading screen, kept over the canvas until the scene has drawn its first frame. */
export function SceneLoadingStatus() {
  const phase = useSyncExternalStore(sceneProgress.subscribe, sceneProgress.get)
  return phase === 'ready' ? null : <SceneLoading phase={phase} />
}
