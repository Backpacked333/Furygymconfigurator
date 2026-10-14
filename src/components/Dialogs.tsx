import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Bookmark,
  Check,
  Copy,
  FileText,
  Info,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  ADDONS,
  FINISHES,
  FLOORS,
  area,
  distance,
  estimate,
  money,
  monthlyPayment,
  readSaved,
  shareUrl,
  writeSaved,
  type Config,
  type SavedBuild,
  type Unit,
} from '../lib/config'
import { downloadFile, exportBrief } from '../lib/export'
import Modal from './Modal'
import { MiniStudio } from './ConfigPanel'

export function EstimateDialog({ config, onClose }: { config: Config; onClose: () => void }) {
  const { lines, total } = estimate(config)
  const [deposit, setDeposit] = useState(20),
    [apr, setApr] = useState(8.5),
    [term, setTerm] = useState(120)
  const payment = monthlyPayment(total, deposit, apr, term)
  return (
    <Modal
      title="The bigger picture."
      subtitle="Understand your build, line by line."
      onClose={onClose}
    >
      <div className="notice">
        <Info size={18} />
        <p>
          <strong>Illustrative pricing only.</strong> Not an approved price list, quotation, or
          financing offer. Taxes, delivery, foundation, site works, permits, utilities, and
          installation are not included.
        </p>
      </div>
      <div className="price-lines">
        {lines.map((line, i) => (
          <div key={i}>
            <span>{line.name}</span>
            <b>{money(line.amount)}</b>
          </div>
        ))}
        <div className="price-total">
          <strong>Illustrative total</strong>
          <strong>{money(total)}</strong>
        </div>
      </div>
      <div className="finance">
        <span className="eyebrow">EXPLORE THE NUMBERS</span>
        <h3>A monthly perspective.</h3>
        <div className="finance-fields">
          <label>
            Deposit
            <select value={deposit} onChange={(e) => setDeposit(Number(e.target.value))}>
              {[0, 10, 20, 30, 50].map((n) => (
                <option key={n} value={n}>
                  {n}%
                </option>
              ))}
            </select>
          </label>
          <label>
            APR assumption
            <input
              type="number"
              min="0"
              max="30"
              step="0.25"
              value={apr}
              onChange={(e) => setApr(Math.max(0, Math.min(30, Number(e.target.value))))}
            />
          </label>
          <label>
            Term
            <select value={term} onChange={(e) => setTerm(Number(e.target.value))}>
              {[36, 60, 84, 120, 180].map((n) => (
                <option key={n} value={n}>
                  {n / 12} years
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="finance-result">
          <strong>
            {money(payment)}
            <small>/ month</small>
          </strong>
          <span>{money((total * deposit) / 100)} initial deposit</span>
        </div>
        <p className="muted small">
          Principal: {money(total * (1 - deposit / 100))}. Total of payments:{' '}
          {money(payment * term)}. Interest: {money(payment * term - total * (1 - deposit / 100))}.
          Excludes lender fees; no lending partner or approval is implied.
        </p>
      </div>
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
      <div className="share-visual">
        <MiniStudio
          finish={FINISHES.find((f) => f.id === config.finish)!.color}
          deck={config.addons.deck}
        />
        <span>
          S-{config.length}
          <small>
            {config.items.length} interior items ·{' '}
            {FINISHES.find((f) => f.id === config.finish)!.name}
          </small>
        </span>
      </div>
      <label className="field-label">
        Configuration link
        <input
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          aria-label="Configuration share link"
        />
      </label>
      <button
        className="primary full"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url)
            setCopied(true)
          } catch {
            notify('Clipboard unavailable. Select the link and copy it manually.')
          }
        }}
      >
        {copied ? <Check size={17} /> : <Copy size={17} />}
        {copied ? 'Link copied' : 'Copy your build link'}
      </button>
      <button
        className="secondary full"
        onClick={() =>
          downloadFile(
            `fury-s${config.length}-configuration.json`,
            JSON.stringify(
              {
                configuration: config,
                priceModel: estimate(config).version,
                notice: 'Concept configuration; illustrative prices only.',
              },
              null,
              2,
            ),
          )
        }
      >
        <ArrowDownToLine size={16} />
        Download configuration JSON
      </button>
      <p className="muted small">
        The full configuration is in the link; no account needed. Anyone with the link can view it.
        Preview links may require session access. Saved builds remain on this browser, not in the
        cloud.
      </p>
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
  capture: () => string | null
  onClose: () => void
  notify: (s: string) => void
}) {
  const [name, setName] = useState(`My S-${config.length} studio`),
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
          <span>Configuration · Scene image · Itemized estimate · Floor plan</span>
        </div>
      </div>
      <label className="field-label">
        Project name
        <input
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="My backyard studio"
        />
      </label>
      <label className="field-label">
        What else should be considered?
        <textarea
          value={notes}
          maxLength={2000}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Your training goals, site access, target timeline, or questions for the studio team…"
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
            await exportBrief(config, capture(), { name, notes })
            notify('Build brief downloaded. Your next step: share it with your project team.')
          } catch {
            notify('Could not create the PDF. Try again, or download the configuration from Share.')
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
      `S-${config.length} / ${FINISHES.find((f) => f.id === config.finish)!.name}`,
    ),
    [compare, setCompare] = useState<string[]>([])
  const persist = (next: SavedBuild[]) => {
    try {
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
    <Modal
      title="Keep the possibilities open."
      subtitle="Save a few directions. Find the one that feels right."
      onClose={onClose}
      wide
    >
      <div className="save-row">
        <label className="field-label">
          Name this build
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          className="primary"
          disabled={!name.trim() || saved.length >= 12}
          onClick={() => {
            const next = [
              {
                id: crypto.randomUUID(),
                name: name.trim(),
                date: new Date().toISOString(),
                config: structuredClone(config),
              },
              ...saved,
            ]
            if (persist(next)) notify('Build saved on this browser.')
          }}
        >
          <Plus size={16} /> Save current
        </button>
      </div>
      <p className="muted small">
        {saved.length}/12 saved locally on this browser. No account or cloud backup. Select two
        builds to compare.
      </p>
      {saved.length === 0 ? (
        <div className="empty-library">
          <Bookmark size={32} strokeWidth={1} />
          <h3>Your ideas belong here.</h3>
          <p>Save your first studio above. Come back to it whenever inspiration strikes.</p>
        </div>
      ) : (
        <div className="saved-grid">
          {saved.map((build) => (
            <div className="saved-card" key={build.id}>
              <div className="saved-visual">
                <MiniStudio
                  finish={FINISHES.find((f) => f.id === build.config.finish)!.color}
                  deck={build.config.addons.deck}
                  long={build.config.length === 40}
                />
                <button
                  className="icon-button"
                  aria-label={`Delete ${build.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete “${build.name}” from this browser?`)) {
                      if (persist(saved.filter((s) => s.id !== build.id)))
                        setCompare(compare.filter((id) => id !== build.id))
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <h3>{build.name}</h3>
              <p>
                S-{build.config.length} · {money(estimate(build.config).total)} illustrative
              </p>
              <div className="saved-actions">
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
              </div>
            </div>
          ))}
        </div>
      )}
      {comparisons.length === 2 && (
        <div className="comparison">
          <h3>Side by side.</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Your decisions</th>
                  {comparisons.map((s) => (
                    <th scope="col" key={s.id}>
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    'Footprint',
                    (c: Config) =>
                      `${distance(c.length, unit)} × ${distance(8, unit)} / ${area(c.length * 8, unit)}`,
                  ],
                  [
                    'Exterior',
                    (c: Config) =>
                      `${FINISHES.find((f) => f.id === c.finish)!.name}${c.accent ? ' + cedar' : ''}`,
                  ],
                  [
                    'Outdoor',
                    (c: Config) =>
                      ADDONS.filter((a) => c.addons[a.id])
                        .map((a) => a.name)
                        .join(', ') || 'None',
                  ],
                  ['Floor', (c: Config) => FLOORS.find((f) => f.id === c.flooring)!.name],
                  ['Equipment', (c: Config) => `${c.items.length} pieces / ${c.package}`],
                  ['Illustrative total', (c: Config) => money(estimate(c).total)],
                ].map(([label, getter]) => {
                  const get = getter as (c: Config) => string
                  const values = comparisons.map((s) => get(s.config))
                  return (
                    <tr key={String(label)} className={values[0] !== values[1] ? 'different' : ''}>
                      <th scope="row">{String(label)}</th>
                      {values.map((v, i) => (
                        <td key={i}>{v}</td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Highlighted rows differ. Neither estimate includes site costs or tax.
          </p>
        </div>
      )}
    </Modal>
  )
}
