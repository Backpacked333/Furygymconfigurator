import { useSyncExternalStore } from 'react'
import { sceneProgress, type ScenePhase } from '../render/progress'
import { LoadingExperience } from './LoadingExperience'

const STEPS: { phase: Exclude<ScenePhase, 'ready'>; label: string }[] = [
  { phase: 'engine', label: 'Downloading the 3D engine' },
  { phase: 'renderer', label: 'Starting the graphics renderer' },
  { phase: 'shaders', label: 'Preparing materials and lighting' },
]

export function SceneLoading({ phase }: { phase: ScenePhase }) {
  const current = STEPS.findIndex((step) => step.phase === phase)
  if (phase === 'ready') return null
  return (
    <div className="scene-loading">
      <LoadingExperience
        title="Good things are taking shape."
        description="Your gym, your way. Start configuring while we prepare the studio."
        label={STEPS[current].label}
      >
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
      </LoadingExperience>
    </div>
  )
}

export function SceneLoadingStatus() {
  const phase = useSyncExternalStore(sceneProgress.subscribe, sceneProgress.get)
  return <SceneLoading phase={phase} />
}
