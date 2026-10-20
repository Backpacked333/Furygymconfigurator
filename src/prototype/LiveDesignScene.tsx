import { memo, useMemo, useState } from 'react'
import { projectDesignToConfig, type DesignEnvelope } from '../domain/design'
import { resolveCamera } from '../domain/presentation'
import type { Unit } from '../lib/config'
import { skyLook } from '../lib/visuals'
import { useStagedScene } from '../lib/useStagedScene'
import { loadTracerModule } from '../render/pathtrace'
import { defaultQuality } from '../render/quality'
import { resolveNativeCamera } from '../render/nativeCamera'
import { SceneSurface } from '../components/SceneSurface'
import { ProgressiveRenderer, type ViewerStatus } from '../viewer/ProgressiveRenderer'
import { EntryWatch } from '../viewer/EntryWatch'

// This module loads only once the visitor shows intent to open the 360° view (LiveViewport): start
// fetching the tracer and denoiser then too, on browsers that can run them, so a resting view can
// refine as soon as it is open. ProgressiveRenderer awaits the same cached load.
if (typeof navigator !== 'undefined' && 'gpu' in navigator) void loadTracerModule().catch(() => {})

export default memo(function LiveDesignScene({
  design,
  active,
  unit,
  dimensions,
  autoRotate,
  reset,
  onReady,
  onStatus,
  onUnavailable,
  onLeaveEntry,
}: {
  design: DesignEnvelope
  active: boolean
  unit: Unit
  dimensions: boolean
  autoRotate: boolean
  reset: number
  onReady: () => void
  onStatus: (status: ViewerStatus) => void
  onUnavailable: () => void
  /** Once per opening: the camera has left `pose`, the gallery image's own camera. */
  onLeaveEntry?: () => void
}) {
  const config = useMemo(() => projectDesignToConfig(design), [design])
  const [quality] = useState(defaultQuality)
  const staged = useStagedScene(config, quality)
  const camera = resolveCamera(design.presentation.cameraRef)
  const pose = useMemo(() => resolveNativeCamera(design), [design])
  const look = useMemo(
    () => skyLook(staged.config.environment, staged.config.time),
    [staged.config.environment, staged.config.time],
  )
  return (
    <>
      <SceneSurface
        active={active}
        config={staged.config}
        quality={staged.quality}
        view={camera.group}
        angle={camera.previewAngle}
        pose={pose}
        mode="live"
        unit={unit}
        dimensions={dimensions}
        autoRotate={active && autoRotate}
        reset={reset}
        onFallback={onUnavailable}
        effects={
          <>
            <ProgressiveRenderer
              active={active}
              revision={JSON.stringify([staged.config, dimensions, unit])}
              look={look}
              quality={staged.quality}
              place={camera.group}
              onReady={onReady}
              onStatus={onStatus}
            />
            <EntryWatch active={active} pose={pose} onLeave={onLeaveEntry} />
          </>
        }
      />
      {staged.updating && (
        <div className="scene-activity" role="status">
          Updating the 3D view…
        </div>
      )}
    </>
  )
})
