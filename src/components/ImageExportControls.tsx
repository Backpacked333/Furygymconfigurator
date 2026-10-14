import { useState } from 'react'
import { ArrowDownToLine, X } from 'lucide-react'
import { downloadFile } from '../lib/export'
import { presentationFrame } from '../lib/capture'
import type { PresentationState } from '../lib/presentation'
import { useExportJob, type ExportContext } from './useExportJob'

export default function ImageExportControls({
  context,
  presentation,
  onClose,
}: {
  context: ExportContext
  presentation: PresentationState | null
  onClose: () => void
}) {
  const [mode, setMode] = useState<'current' | 'presentation'>('current')
  const [width, setWidth] = useState(3840)
  const [currentWidth, setCurrentWidth] = useState<number | null>(null)
  const job = useExportJob(context)
  const provider = context.getProvider()
  const currentSize = presentation?.rendered ?? { width: 0, height: 0 }
  const requested =
    mode === 'presentation'
      ? { width, height: (width * 9) / 16 }
      : currentWidth && currentSize.width > 0
        ? {
            width: currentWidth,
            height: Math.round((currentWidth * currentSize.height) / currentSize.width),
          }
        : currentSize
  const capability = provider?.preflight(requested)
  const frame = presentationFrame(currentSize.width, currentSize.height)
  const motion = presentation?.animating
  const start = () =>
    void job.run(true, async (exportJob) => {
      const result = await exportJob.capture(mode, requested)
      if (!('blob' in result)) throw new Error(result.reason)
      exportJob.assertCurrent()
      downloadFile(
        `Fury-${exportJob.config.family}-${exportJob.config.length}-${result.encoded.width}x${result.encoded.height}.png`,
        result.blob,
      )
      exportJob.message(
        `Downloaded · rendered ${result.rendered.width} × ${result.rendered.height}, encoded ${result.encoded.width} × ${result.encoded.height}${result.status === 'degraded' ? ' · degraded materials or lighting; not final quality' : ''}.`,
      )
    })
  return (
    <>
      {mode === 'presentation' && (
        <div
          className="presentation-frame"
          aria-label="16:9 centered presentation crop"
          style={{
            left: `${frame.x * 100}%`,
            top: `${frame.y * 100}%`,
            width: `${frame.width * 100}%`,
            height: `${frame.height * 100}%`,
          }}
        >
          <span>16:9 CENTERED CROP · OUTSIDE FRAME EXCLUDED</span>
        </div>
      )}
      <div className="photo-controls export-controls">
        <label>
          Image framing
          <select
            value={mode}
            disabled={job.busy}
            onChange={(event) => setMode(event.target.value as typeof mode)}
          >
            <option value="current">Current view · exact aspect</option>
            <option value="presentation">Presentation · 16:9 crop</option>
          </select>
        </label>
        {mode === 'presentation' && (
          <label>
            Native output
            <select
              value={width}
              disabled={job.busy}
              onChange={(event) => setWidth(Number(event.target.value))}
            >
              <option value={3840}>3840 × 2160 · 4K</option>
              <option value={1920}>1920 × 1080</option>
              <option value={1280}>1280 × 720</option>
              <option value={960}>960 × 540</option>
            </select>
          </label>
        )}
        <button
          disabled={job.busy || context.blocked || !capability?.allowed || motion}
          onClick={start}
        >
          <ArrowDownToLine size={16} />
          Save image
        </button>
        {job.busy && <button onClick={job.cancel}>Cancel export</button>}
        <button
          aria-label="Exit photo mode"
          onClick={() => {
            job.cancel()
            onClose()
          }}
        >
          <X size={18} />
        </button>
        <p className="export-detail" role="status">
          {job.message ||
            (motion
              ? 'Pause motion and let the view settle before exporting.'
              : capability?.allowed
                ? `${requested.width} × ${requested.height} rendered pixels · ${Math.ceil(capability.estimatedMB)} MB conservative transient budget. Concept rendering, not manufacturer photography.`
                : (capability?.reason ?? 'Waiting for the graphics view…'))}
        </p>
        {!capability?.allowed && !!capability?.alternatives.length && (
          <p className="export-detail">
            Choose a lower native resolution:{' '}
            {capability.alternatives.map((size) => (
              <button
                key={size.width}
                disabled={job.busy}
                onClick={() => {
                  if (mode === 'presentation') setWidth(size.width)
                  else setCurrentWidth(size.width)
                }}
              >
                Use {size.width} × {size.height}
              </button>
            ))}
            {mode === 'current' &&
              ' · Lower-resolution alternatives preserve your current view’s aspect.'}
          </p>
        )}
      </div>
    </>
  )
}
