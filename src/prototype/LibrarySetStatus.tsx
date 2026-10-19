import { Check, RefreshCw } from 'lucide-react'
import { projectDesignToConfig, type DesignEnvelope } from '../domain/design'
import { CUSTOMER_CAMERAS } from '../render-library/views'
import { RENDER_CTA } from '../render-library/contracts'
import { LoadingExperience, WorkProgress } from '../components/LoadingExperience'
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
}: {
  design: DesignEnvelope
  library: ReturnType<typeof useLibrarySet>
  catalog: NativeLibrary | null
  hasImage: boolean
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
  const title = submitting
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
  const description = uncertain
    ? 'We have not confirmed delivery. Check status; do not submit a new request. Your design stays editable.'
    : working
      ? 'This animation is illustrative, not GPU telemetry. Verified images appear as they finish. You can keep exploring; this shared job will continue.'
      : snapshot?.coverage === 'missing'
        ? 'This exact design and scene are not yet rendered. One request creates four exterior views and one interior entry view, starting with your selected camera.'
        : snapshot?.coverage === 'partial'
          ? `${count} of 5 images already exist. Keep using ready views while the missing views are created for this exact scene. Cached images will not be rendered again.`
          : count === 5
            ? 'Four exterior views. One interior entry. Reused for this exact design and scene.'
            : 'We could not confirm which views exist. This is not a confirmed cache miss; no work is queued.'
  const label = `${count}/5 images ready${working ? ` · ${stageNames[job!.stage]}` : ''}`
  return (
    <section className="library-set-status" aria-label="Five-view image set">
      {!hasImage && (working || submitting || checking) ? (
        <LoadingExperience
          config={projectDesignToConfig(design)}
          title={title}
          description={description}
          label={label}
          fraction={working ? count / 5 : undefined}
          compact
        />
      ) : (
        <div className="library-set-heading">
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <span className="library-set-count" aria-label={`${count} of 5 images ready`}>
            {count}
            <span>/5</span>
          </span>
        </div>
      )}
      {working && hasImage && <WorkProgress label={label} fraction={count / 5} />}
      <ul className="library-view-statuses" aria-label="Image availability">
        {views.map(({ camera, status }) => (
          <li key={camera.ref} data-state={status}>
            {status === 'ready' && <Check size={12} aria-hidden="true" />}
            <span>{camera.name.replace('DRAFT — ', '')}</span>
            <small>
              {status === 'ready'
                ? 'Ready'
                : status === 'missing'
                  ? 'Not yet rendered'
                  : status === 'pending'
                    ? 'In progress'
                    : status === 'failed'
                      ? 'Stopped'
                      : status === 'checking'
                        ? 'Checking'
                        : 'Unconfirmed'}
            </small>
          </li>
        ))}
      </ul>
      <div className="library-set-actions">
        {snapshot && snapshot.coverage !== 'complete' && !working && !terminal && (
          <button className="primary" onClick={() => void library.request()} disabled={!canRequest}>
            {RENDER_CTA}
          </button>
        )}
        {mayRetry && (
          <button className="primary" onClick={() => void library.request()} disabled={!canRequest}>
            Retry missing views
          </button>
        )}
        {submitting && <span role="status">Requesting…</span>}
        {!checking && (
          <button className="text-link" onClick={library.refresh} disabled={submitting}>
            <RefreshCw size={13} aria-hidden="true" /> Check status
          </button>
        )}
        <p role={message || terminal ? 'status' : undefined}>
          {message ??
            job?.error?.message ??
            (snapshot?.rendering.status === 'unavailable' && count < 5
              ? snapshot.rendering.reason.message
              : null)}
        </p>
      </div>
    </section>
  )
}
