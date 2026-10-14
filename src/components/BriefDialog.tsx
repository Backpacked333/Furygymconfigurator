import { useState } from 'react'
import { ArrowDownToLine, FileText, Info } from 'lucide-react'
import { productName } from '../lib/config'
import { createBrief, downloadFile, type BriefImageEvidence } from '../lib/export'
import { validateProject } from '../lib/pdfText'
import { useExportJob, type ExportContext } from './useExportJob'
import Modal from './Modal'

export default function BriefDialog({
  context,
  onClose,
  notify,
}: {
  context: ExportContext
  onClose: () => void
  notify: (message: string) => void
}) {
  const [name, setName] = useState(`My ${productName(context.config)}`)
  const [notes, setNotes] = useState('')
  const [includeImage, setIncludeImage] = useState(() => !!context.getProvider())
  const [imageWidth, setImageWidth] = useState<number | null>(null)
  const job = useExportJob(context)
  const provider = context.getProvider()
  const rendered = provider?.getState().rendered ?? { width: 0, height: 0 }
  const size =
    imageWidth && rendered.width
      ? { width: imageWidth, height: Math.round((imageWidth * rendered.height) / rendered.width) }
      : rendered
  const capability = provider?.preflight(size)
  const download = () =>
    void job.run(includeImage, async (exportJob) => {
      const project = validateProject({ name, notes })
      let image: Uint8Array | null = null
      let evidence: BriefImageEvidence | undefined
      if (includeImage) {
        const result = await exportJob.capture('current', size)
        if (!('blob' in result))
          throw new Error(
            `${result.reason} Choose the image-free brief if graphics are unavailable.`,
          )
        image = new Uint8Array(await result.blob.arrayBuffer())
        evidence = {
          status: result.status,
          rendered: result.rendered,
          encoded: result.encoded,
          reasons: [...result.reasons],
          provenance: result.provenance,
        }
      }
      exportJob.assertCurrent()
      exportJob.message('Creating PDF with the frozen design and project notes…')
      const pdf = await createBrief(exportJob.config, image, project, evidence)
      exportJob.assertCurrent()
      downloadFile(
        `Fury-${exportJob.config.family}-${exportJob.config.length}-build-brief.pdf`,
        pdf.output('blob'),
      )
      exportJob.message(
        `Build brief downloaded${evidence?.status === 'degraded' ? ' with an explicitly degraded scene image' : ''}.`,
      )
      notify('Build brief downloaded. Nothing was sent to Fury.')
    })
  return (
    <Modal
      title="From a vision to a plan."
      subtitle="A considered brief to start a real conversation."
      onClose={() => {
        job.cancel()
        onClose()
      }}
    >
      <div className="brief-includes">
        <FileText size={30} strokeWidth={1} />
        <div>
          <strong>Your personal build brief</strong>
          <span>
            Frozen configuration · Current view or image-free · Quote checklist · Floor plan
          </span>
        </div>
      </div>
      <label className="field-label">
        Project name
        <input
          value={name}
          maxLength={60}
          disabled={job.busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field-label">
        What else should be considered?
        <textarea
          value={notes}
          maxLength={2000}
          disabled={job.busy}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          placeholder="Training goals, site access, timing, or questions for Fury…"
        />
      </label>
      <label className="export-image-choice">
        <input
          type="checkbox"
          checked={includeImage}
          disabled={job.busy}
          onChange={(event) => setIncludeImage(event.target.checked)}
        />
        Include the current 3D view
      </label>
      {includeImage && (
        <p className="muted small">
          The image preserves the current camera and aspect. {size.width} × {size.height} native
          pixels. It will not substitute an old image after a design or view change.
        </p>
      )}
      {includeImage && !capability?.allowed && (
        <div className="notice">
          <p>
            {capability?.reason ??
              'The 3D view is unavailable. Uncheck the image option for an image-free brief.'}
          </p>
          {capability?.alternatives.map((alternative) => (
            <button
              className="secondary"
              key={alternative.width}
              disabled={job.busy}
              onClick={() => setImageWidth(alternative.width)}
            >
              Use {alternative.width} × {alternative.height}
            </button>
          ))}
        </div>
      )}
      {!includeImage && (
        <p className="muted small">
          Image-free PDF: your full configuration, notes, plan, pricing disclaimers and interactive
          link remain included.
        </p>
      )}
      <div className="notice">
        <Info size={18} />
        <p>
          This creates a PDF on your device. It is <strong>not sent to sales</strong> and does not
          reserve a production slot. No personal information is uploaded.
        </p>
      </div>
      <p className="muted small">
        Project names and notes support Latin-script text and common punctuation. Unsupported
        characters are reported, never silently removed; JSON preserves the original configuration.
      </p>
      {job.message && (
        <p className="export-message" role="status">
          {job.message}
        </p>
      )}
      <button
        className="secondary full"
        disabled={job.busy}
        onClick={() =>
          downloadFile(
            'fury-project-text.json',
            JSON.stringify({ project: { name, notes }, configuration: context.config }, null, 2),
          )
        }
      >
        Download project text as JSON
      </button>
      <button
        className="primary full"
        disabled={
          job.busy || context.blocked || !name.trim() || (includeImage && !capability?.allowed)
        }
        onClick={download}
      >
        <ArrowDownToLine size={17} />
        {job.busy ? 'Preparing your brief…' : 'Download build brief'}
      </button>
      {job.busy && (
        <button className="secondary full" onClick={job.cancel}>
          Cancel export
        </button>
      )}
    </Modal>
  )
}
