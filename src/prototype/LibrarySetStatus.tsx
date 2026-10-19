import { RefreshCw } from 'lucide-react'
import { projectDesignToConfig, type DesignEnvelope } from '../domain/design'
import { CUSTOMER_CAMERAS } from '../render-library/views'
import { RENDER_CTA } from '../render-library/contracts'
import { BuildAnimation, WorkProgress } from '../components/LoadingExperience'
import { findNativeImage, type NativeLibrary } from './nativeLibrary'
import { activeJob, type useLibrarySet } from './useLibrarySet'

const stageNames = {
  queued: 'Waiting for a render slot',
  preparing: 'Preparing your exact design',
  rendering: 'Rendering an image',
  saving: 'Saving the image',
  verifying: 'Verifying the image',
  complete: 'Your five views are ready',
  failed: 'Rendering stopped',
  blocked: 'Rendering is unavailable',
  'dispatch-uncertain': 'Checking whether rendering started',
} as const

export function LibrarySetStatus({
  design,
  library,
  catalog,
  hasImage,
  imageLoading = false,
  imageError,
  onRetryImage,
  onDetails,
}: {
  design: DesignEnvelope
  library: ReturnType<typeof useLibrarySet>
  catalog: NativeLibrary | null
  hasImage: boolean
  imageLoading?: boolean
  imageError?: string
  onRetryImage?: () => void
  onDetails?: () => void
}) {
  const { snapshot, checking, message, submitting, uncertain } = library
  const job = snapshot?.job
  const working = activeJob(snapshot)
  const views = CUSTOMER_CAMERAS.map((camera) => {
    const remote = snapshot?.views.find((view) => view.cameraRef === camera.ref)
    const seed =
      catalog &&
      findNativeImage(catalog, {
        ...design,
        presentation: { ...design.presentation, cameraRef: camera.ref },
      })
    return {
      camera,
      status: remote?.status ?? (seed ? 'ready' : checking ? 'checking' : 'unknown'),
    }
  })
  const count = views.filter((view) => view.status === 'ready').length
  const terminal = !!job && !working && job.stage !== 'complete'
  const mayRetry = job?.stage === 'failed' && job.retrySafe
  const canRequest =
    snapshot &&
    !checking &&
    !library.paused &&
    !submitting &&
    !uncertain &&
    snapshot.rendering.status === 'enabled' &&
    snapshot.coverage !== 'complete' &&
    !working &&
    (!job || mayRetry)
  const title = imageError
    ? 'Your image could not be loaded'
    : imageLoading && !working && !submitting
      ? 'Bringing your design into focus'
      : submitting
        ? 'Requesting your five-view set'
        : uncertain
          ? 'Confirming your request'
          : working || terminal
            ? stageNames[job!.stage]
            : count === 5
              ? 'Your five views are ready'
              : checking
                ? 'Checking your five-view set'
                : snapshot?.coverage === 'missing'
                  ? 'Your vision starts here'
                  : snapshot?.coverage === 'partial'
                    ? 'Complete the picture'
                    : 'Image library unavailable'
  const description =
    imageError ??
    (imageLoading && !working && !submitting
      ? 'Loading your exact image. No new render is being started.'
      : uncertain
        ? 'We have not confirmed delivery. Check status; do not submit a new request. Your design stays editable.'
        : working
          ? 'Verified views appear as they finish. You can keep exploring.'
          : snapshot?.coverage === 'missing'
            ? 'This exact design and scene are not yet rendered. One request creates four exterior views and one interior entry view, starting with your selected camera.'
            : snapshot?.coverage === 'partial'
              ? `${count} of 5 images already exist. This view is not yet rendered. One request completes the set; cached views are reused.`
              : count === 5
                ? 'Your exact views are ready.'
                : 'We could not confirm which views exist. This is not a confirmed cache miss; no work is queued.')
  const label = `${count}/5 images ready${working ? ` · ${stageNames[job!.stage]}` : ''}`
  return (
    <section
      className={`library-set-status ${hasImage ? 'is-summary' : 'is-stage'}`}
      aria-label="Five-view image set"
    >
      {!hasImage && (
        <BuildAnimation config={projectDesignToConfig(design)} still={terminal || !!imageError} />
      )}
      <div className="library-set-content">
        {!hasImage ? (
          <>
            <h2>{title}</h2>
            <p className="library-set-description">{description}</p>
            <small className="library-animation-note">
              Illustrative assembly · not a render or GPU telemetry
            </small>
          </>
        ) : !working ? (
          <span className="library-set-summary" role="status" title={message ?? undefined}>
            Draft preview · {count}/5 views ready
            {message ? ' · Library status unavailable' : ''}
          </span>
        ) : null}
        {(working || (!hasImage && !imageError && (checking || submitting || imageLoading))) && (
          <WorkProgress
            label={imageLoading && !working ? 'Loading exact image' : label}
            fraction={working ? count / 5 : undefined}
          />
        )}
        <div className="library-set-actions">
          {snapshot && snapshot.coverage !== 'complete' && !working && !terminal && (
            <button
              className="primary"
              onClick={() => void library.request()}
              disabled={!canRequest}
            >
              {RENDER_CTA}
            </button>
          )}
          {mayRetry && (
            <button
              className="primary"
              onClick={() => void library.request()}
              disabled={!canRequest}
            >
              Retry missing views
            </button>
          )}
          {submitting && <span role="status">Requesting…</span>}
          {!checking && (library.paused || uncertain || terminal || (!snapshot && !hasImage)) && (
            <button className="text-link" onClick={library.refresh} disabled={submitting}>
              <RefreshCw size={13} aria-hidden="true" /> Check status
            </button>
          )}
          {imageError && onRetryImage && (
            <button className="text-link" onClick={onRetryImage}>
              Retry image
            </button>
          )}
          {onDetails && (
            <button className="text-link" onClick={onDetails}>
              Image details
            </button>
          )}
          <p role={message || terminal ? 'status' : undefined}>
            {(hasImage && !terminal && !uncertain ? null : message) ??
              job?.error?.message ??
              (!hasImage && snapshot?.rendering.status === 'unavailable' && count < 5
                ? snapshot.rendering.reason.message
                : null)}
          </p>
        </div>
      </div>
    </section>
  )
}
