import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { projectDesignToConfig, type DesignEnvelope } from '../domain/design'
import { resolveCamera } from '../domain/presentation'
import type { Unit } from '../lib/config'
import { skyLook } from '../lib/visuals'
import { useStagedScene } from '../lib/useStagedScene'
import { loadTracerModule } from '../render/pathtrace'
import { liveLoading, sceneProgress, textureProgress, traceProgress } from '../render/progress'
import { defaultQuality } from '../render/quality'
import { resolveNativeCamera } from '../render/nativeCamera'
import { SceneSurface } from '../components/SceneSurface'
import { arcWindow, requestedArc } from '../viewer/arc'
import { ProgressiveRenderer, type ViewerStatus } from '../viewer/ProgressiveRenderer'
import { EntryWatch } from '../viewer/EntryWatch'
import type { LiveProgress } from './LiveViewport'

// This module loads only once the visitor shows intent to open the 360° view (LiveViewport): start
// fetching the tracer and denoiser then too, on browsers that can run them, so a resting view can
// refine as soon as it is open. ProgressiveRenderer awaits the same cached load.
if (typeof navigator !== 'undefined' && 'gpu' in navigator) void loadTracerModule().catch(() => {})

/**
 * Reports the live view's load and refinement to the gallery (LiveViewport), which imports none of
 * the renderer's stores itself. A new view starts its load from the beginning; its scans count from
 * those asked for since it opened (the store counts the page's).
 */
function useLiveProgress(onProgress?: (progress: LiveProgress) => void) {
  useState(() => liveLoading.restart())
  const [base] = useState(() => textureProgress.get())
  const loading = useSyncExternalStore(liveLoading.subscribe, liveLoading.get)
  const phase = useSyncExternalStore(sceneProgress.subscribe, sceneProgress.get)
  const textures = useSyncExternalStore(textureProgress.subscribe, textureProgress.get)
  const refine = useSyncExternalStore(traceProgress.subscribe, traceProgress.get)
  // The engine is up and the scene is mounting once the renderer compiles its shaders.
  const step =
    loading === 'engine' && (phase === 'shaders' || phase === 'ready') ? 'scene' : loading
  const requested = textures.requested - base.requested
  const fraction =
    step === 'materials' && requested > 0
      ? Math.min(1, (textures.loaded - base.loaded) / requested)
      : null
  useEffect(() => onProgress?.({ step, fraction, refine }), [onProgress, step, fraction, refine])
}

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
  entryImage,
  onProgress,
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
  /** The design's own Cycles image, seen from `pose`: the first trace there starts from it. */
  entryImage?: string
  /** The view's load and refinement, for the loading screen and the refinement pill. */
  onProgress?: (progress: LiveProgress) => void
}) {
  useLiveProgress(onProgress)
  const config = useMemo(() => projectDesignToConfig(design), [design])
  const [quality] = useState(defaultQuality)
  const staged = useStagedScene(config, quality)
  const camera = resolveCamera(design.presentation.cameraRef)
  const pose = useMemo(() => resolveNativeCamera(design), [design])
  const entry = useMemo(
    () => (entryImage ? { pose, image: entryImage } : undefined),
    [pose, entryImage],
  )
  // Experimental `?arc=N` (ADR-003): the exterior orbit kept to a window around this design's
  // cameras. Read once; the window follows the design, but a finish edit (a new design object for
  // the same cameras) hands CameraRig the same window.
  const [degrees] = useState(() => requestedArc())
  const limits = useMemo(
    () => (degrees === null ? null : arcWindow(design, degrees)),
    [design, degrees],
  )
  const arcMin = limits?.min,
    arcMax = limits?.max
  const arc = useMemo(
    () => (arcMin === undefined || arcMax === undefined ? undefined : { min: arcMin, max: arcMax }),
    [arcMin, arcMax],
  )
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
        arc={arc}
        mode="live"
        unit={unit}
        dimensions={dimensions}
        autoRotate={active && autoRotate}
        reset={reset}
        onFallback={onUnavailable}
        // A finish or floor edit then swaps materials in place: no remount, no BVH rebuild.
        reuseGeometry
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
              entry={entry}
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
