import { useState } from 'react'
import { ArrowDownToLine, ArrowRight, FileText, Info, Plus } from 'lucide-react'
import {
  ADDONS,
  FINISHES,
  FLOORS,
  INTERIORS,
  area,
  distance,
  estimate,
  money,
  productName,
  productHeight,
  readSaved,
  shareUrl,
  writeSaved,
  type Config,
  type SavedBuild,
  type Unit,
} from '../lib/config'
import {
  CONTAINER_OPENINGS,
  OPENING_INFILLS,
  STUDIO_DOORS,
  STUDIO_LAYOUTS,
  PROJECT_URL,
  PRODUCT_SOURCE_DATE,
  productFamily,
} from '../lib/products'
import { PdfToolUnavailable, downloadFile, exportBrief } from '../lib/export'
import Modal from './Modal'
import { Elevation } from './Elevation'
import {
  BuildLibraryView,
  BuildShareView,
  EmptyBuildLibraryView,
  SavedBuildView,
} from './BuildDialogView'
import { SpecificationView } from './SpecificationView'

export function EstimateDialog({ config, onClose }: { config: Config; onClose: () => void }) {
  const { lines, startingPrice, source } = estimate(config)
  return (
    <Modal
      title="A starting point. Not a quote."
      subtitle="Published facts, separated from your planning selections."
      onClose={onClose}
    >
      <div className="notice">
        <Info size={18} />
        <p>
          <strong>
            {productFamily(config.family).name}: base models starting at {money(startingPrice)}.
          </strong>{' '}
          Fury publishes one starting price for this family, not a separate price for each size. It
          is not the cost of your selected build. Option prices and project costs are not published.
        </p>
      </div>
      <div className="price-lines">
        {lines.map((line, i) => (
          <div key={i}>
            <span>{line.name}</span>
            <b>Quote required</b>
          </div>
        ))}
        <div className="price-total">
          <strong>Your configured project</strong>
          <strong>Quote required</strong>
        </div>
      </div>
      <p className="muted small">
        Not a quotation or financing offer. Confirm tax, delivery, site work, foundation, permits,
        utilities, installation, availability, and engineering directly with Fury. Concept finishes
        and planning equipment are not an approved product catalog.
      </p>
      <p className="muted small">
        Fury’s inquiry page separately says entry-level projects typically begin at $25,000. That is
        project guidance, not an additional fee or a calculated total.
      </p>
      <a className="source-link" href={source} target="_blank" rel="noreferrer">
        Published product source · checked {PRODUCT_SOURCE_DATE} ↗
      </a>
      <a className="primary full inquiry-link" href={PROJECT_URL} target="_blank" rel="noreferrer">
        Start a project with Fury <ArrowRight size={16} />
      </a>
      <p className="muted small">
        Opens Fury’s website. Your configuration and personal information are not automatically
        sent; you can supply your downloaded brief yourself.
      </p>
    </Modal>
  )
}
export function ShareDialog({
  config,
  onClose,
  notify,
}: {
  config: Config
  onClose: () => void
  notify: (s: string) => void
}) {
  const [copied, setCopied] = useState(false),
    url = shareUrl(config)
  return (
    <Modal
      title="Good things are shared."
      subtitle="Every finish, every detail, every decision. In one link."
      onClose={onClose}
    >
      <BuildShareView
        visual={<Elevation config={config} className="mini-studio" />}
        name={productName(config)}
        summary={
          <>
            {config.items.length} interior items ·{' '}
            {FINISHES.find((f) => f.id === config.finish)!.name}
          </>
        }
        link={url}
        copied={copied}
        onCopy={async () => {
          try {
            await navigator.clipboard.writeText(url)
            setCopied(true)
          } catch {
            notify('Clipboard unavailable. Select the link and copy it manually.')
          }
        }}
        onDownload={() =>
          downloadFile(
            `fury-${config.family}-${config.length}-configuration.json`,
            JSON.stringify(
              {
                configuration: config,
                pricing: estimate(config),
                notice:
                  'Concept configuration. Published family starting price only; all selections require a quote. Not manufacturer CAD.',
              },
              null,
              2,
            ),
          )
        }
        notice="The full configuration is in the link; no account needed. Anyone with the link can view it. Preview links may require session access. Saved builds remain on this browser, not in the cloud."
      />
    </Modal>
  )
}
export function BriefDialog({
  config,
  capture,
  onClose,
  notify,
}: {
  config: Config
  capture: () => Promise<string | null>
  onClose: () => void
  notify: (s: string) => void
}) {
  const [name, setName] = useState(`My ${productName(config)}`),
    [notes, setNotes] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <Modal
      title="From a vision to a plan."
      subtitle="A considered brief to start a real conversation."
      onClose={onClose}
    >
      <div className="brief-includes">
        <FileText size={30} strokeWidth={1} />
        <div>
          <strong>Your personal build brief</strong>
          <span>Configuration · Scene image · Quote checklist · Floor plan</span>
        </div>
      </div>
      <label className="field-label">
        Project name
        <input
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="My backyard gym"
        />
      </label>
      <label className="field-label">
        What else should be considered?
        <textarea
          value={notes}
          maxLength={2000}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Your training goals, site access, target timeline, or questions for Fury…"
        />
      </label>
      <div className="notice">
        <Info size={18} />
        <p>
          This creates a PDF on your device. It is <strong>not sent to sales</strong> and does not
          reserve a production slot. No personal information is uploaded.
        </p>
      </div>
      <p className="muted small">
        Scene image included when 3D is available. Project names and notes currently support
        Latin-script text in the PDF.
      </p>
      <button
        className="primary full"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true)
          try {
            await exportBrief(config, await capture(), { name, notes })
            notify('Build brief downloaded. Your next step: share it with your project team.')
          } catch (error) {
            notify(
              error instanceof PdfToolUnavailable
                ? 'The PDF tool didn’t load. Check your connection, or reload the page (your design is kept) and try again.'
                : 'Could not create the PDF. Try again, or download the configuration from Share.',
            )
          } finally {
            setBusy(false)
          }
        }}
      >
        <ArrowDownToLine size={17} />
        {busy ? 'Preparing your brief…' : 'Download build brief'}
      </button>
    </Modal>
  )
}
export function LibraryDialog({
  config,
  unit,
  onLoad,
  onClose,
  notify,
}: {
  config: Config
  unit: Unit
  onLoad: (c: Config) => void
  onClose: () => void
  notify: (s: string) => void
}) {
  const [saved, setSaved] = useState<SavedBuild[]>(readSaved),
    [name, setName] = useState(
      `${productName(config)} / ${FINISHES.find((f) => f.id === config.finish)!.name}`,
    ),
    [compare, setCompare] = useState<string[]>([])
  // Changes apply to what is stored now, so a build saved from another tab is not overwritten.
  const persist = (change: (stored: SavedBuild[]) => SavedBuild[]) => {
    try {
      const next = change(readSaved())
      writeSaved(next)
      setSaved(next)
      return true
    } catch {
      notify(
        'Browser storage is unavailable or full. Export your configuration from Share instead.',
      )
      return false
    }
  }
  const comparisons = compare.map((id) => saved.find((s) => s.id === id)!).filter(Boolean)
  return (
    <BuildLibraryView
      onClose={onClose}
      saveRow={
        <>
          <label className="field-label">
            Name this build
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={!name.trim() || saved.length >= 12}
            onClick={() => {
              const build = {
                id: crypto.randomUUID(),
                name: name.trim(),
                date: new Date().toISOString(),
                config: structuredClone(config),
              }
              if (persist((stored) => [build, ...stored])) notify('Build saved on this browser.')
            }}
          >
            <Plus size={16} /> Save current
          </button>
        </>
      }
      summary={
        <>
          {saved.length}/12 saved locally on this browser. No account or cloud backup. Select two
          builds to compare.
        </>
      }
    >
      {saved.length === 0 ? (
        <EmptyBuildLibraryView />
      ) : (
        <div className="saved-grid">
          {saved.map((build) => (
            <SavedBuildView
              key={build.id}
              name={build.name}
              visual={<Elevation config={build.config} className="mini-studio" />}
              summary={<>{productName(build.config)} · Quote required</>}
              onDelete={() => {
                if (window.confirm(`Delete “${build.name}” from this browser?`)) {
                  if (persist((stored) => stored.filter((s) => s.id !== build.id)))
                    setCompare(compare.filter((id) => id !== build.id))
                }
              }}
              actions={
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={compare.includes(build.id)}
                      disabled={!compare.includes(build.id) && compare.length >= 2}
                      onChange={(e) =>
                        setCompare(
                          e.target.checked
                            ? [...compare, build.id]
                            : compare.filter((id) => id !== build.id),
                        )
                      }
                    />{' '}
                    Compare
                  </label>
                  <button
                    onClick={() => {
                      onLoad(build.config)
                      onClose()
                      notify(`Loaded “${build.name}”.`)
                    }}
                  >
                    Load <ArrowRight size={14} />
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}
      {comparisons.length === 2 && (
        <SpecificationView
          title="Side by side."
          columns={comparisons.map(({ id, name }) => ({ id, name }))}
          rows={[
            ['Product', (c: Config) => productName(c)],
            ['Height', (c: Config) => distance(productHeight(c), unit)],
            [
              'Footprint',
              (c: Config) =>
                `${distance(c.length, unit)} × ${distance(8, unit)} / ${area(c.length * 8, unit)}`,
            ],
            [
              'Concept exterior',
              (c: Config) =>
                `${FINISHES.find((f) => f.id === c.finish)!.name}${c.accent ? ' + timber' : ''}${c.integratedFinish ? ' / Integrated exterior finish' : ''}`,
            ],
            ['Interior', (c: Config) => INTERIORS.find((f) => f.id === c.interiorStyle)!.name],
            [
              'Outdoor',
              (c: Config) =>
                ADDONS.filter((a) => c.addons[a.id])
                  .map((a) => a.name)
                  .join(', ') || 'None',
            ],
            ['Floor', (c: Config) => FLOORS.find((f) => f.id === c.flooring)!.name],
            ['Equipment', (c: Config) => `${c.items.length} pieces / ${c.package}`],
            [
              'Opening',
              (c: Config) =>
                c.family === 'container'
                  ? `${CONTAINER_OPENINGS.find((o) => o.id === c.containerOpening)!.name}${c.openingInfill !== 'none' ? ` / ${OPENING_INFILLS.find((o) => o.id === c.openingInfill)!.name}` : ''}`
                  : STUDIO_DOORS.find((d) => d.id === c.studioDoor)!.name,
            ],
            [
              'Configuration request',
              (c: Config) =>
                c.family === 'studio'
                  ? STUDIO_LAYOUTS.find((o) => o.id === c.studioLayout)!.name
                  : 'Single unit',
            ],
            ['Published family starting price', (c: Config) => money(estimate(c).startingPrice)],
            ['Configured price', () => 'Quote required'],
          ].map(([label, getter]) => {
            const get = getter as (c: Config) => string
            const values = comparisons.map((s) => get(s.config))
            return { label: String(label), values, different: values[0] !== values[1] }
          })}
          notice="Highlighted rows differ. Family starting prices are not configured project totals. All selections and site costs require a quote."
        />
      )}
    </BuildLibraryView>
  )
}
