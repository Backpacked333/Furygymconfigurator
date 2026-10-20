import { SCENE_LANDSCAPES, sceneLook, sceneSelection, type LookRef } from '../domain/presentation'

type Props = { lookRef: LookRef; onChange: (lookRef: LookRef) => void }

export function DayNightControl({ lookRef, onChange }: Props) {
  const selection = sceneSelection(lookRef)
  return (
    <div className="setting-row">
      <span>Lighting</span>
      <div className="segmented" role="group" aria-label="Scene lighting">
        {(['day', 'night'] as const).map((lighting) => (
          <button
            key={lighting}
            className={selection.lighting === lighting ? 'active' : ''}
            aria-pressed={selection.lighting === lighting}
            onClick={() => onChange(sceneLook(selection.landscape, lighting))}
          >
            {lighting === 'day' ? 'Day' : 'Night'}
          </button>
        ))}
      </div>
    </div>
  )
}

export function SceneLookControls({ lookRef, onChange }: Props) {
  const selection = sceneSelection(lookRef)
  return (
    <>
      <div className="section-label">Landscape</div>
      <div className="scene-settings" role="group" aria-label="Scene landscape">
        {SCENE_LANDSCAPES.map((landscape) => (
          <button
            key={landscape.id}
            aria-pressed={selection.landscape === landscape.id}
            className={selection.landscape === landscape.id ? 'selected' : ''}
            onClick={() => onChange(sceneLook(landscape.id, selection.lighting))}
          >
            {landscape.name}
          </button>
        ))}
      </div>
      <DayNightControl lookRef={lookRef} onChange={onChange} />
    </>
  )
}
