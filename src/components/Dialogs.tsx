import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Bookmark,
  Check,
  Copy,
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
  productName,
  productHeight,
  shareUrl,
  type Config,
  type Unit,
} from '../lib/config'
import {
  CONTAINER_OPENINGS,
  STUDIO_LAYOUTS,
  PROJECT_URL,
  PRODUCT_SOURCE_DATE,
  productFamily,
} from '../lib/products'
import { downloadFile } from '../lib/export'
import Modal from './Modal'
import { MiniStudio } from './ConfigPanel'
import { useLibrary, storageMessage } from './useLibrary'
import type { RecoveryRecord } from '../lib/recovery'

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
      <div className="share-visual">
        <MiniStudio
          family={config.family}
          finish={FINISHES.find((f) => f.id === config.finish)!.color}
          deck={config.addons.deck}
        />
        <span>
          {productName(config)}
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
export function LibraryDialog({
  config,
  unit,
  onLoad,
  onRepair,
  saveBlocked = false,
  onClose,
  notify,
}: {
  config: Config
  unit: Unit
  onLoad: (c: Config) => boolean
  onRepair: (c: Config, original?: Pick<RecoveryRecord, 'raw' | 'format'>) => Promise<boolean>
  saveBlocked?: boolean
  onClose: () => void
  notify: (s: string) => void
}) {
  const library = useLibrary()
  const [loading, setLoading] = useState<string | null>(null)
  const saved = library.snapshot?.entries.map((entry) => entry.build) ?? []
  const [name, setName] = useState(
      `${productName(config)} / ${FINISHES.find((f) => f.id === config.finish)!.name}`,
    ),
    [compare, setCompare] = useState<string[]>([])
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
          disabled={
            saveBlocked ||
            !name.trim() ||
            !library.snapshot ||
            library.busy ||
            !!loading ||
            saved.length >= 12
          }
          onClick={async () => {
            const result = await library.save({
              id: crypto.randomUUID(),
              name: name.trim(),
              date: new Date().toISOString(),
              config: structuredClone(config),
            })
            if (result.ok && result.value.status === 'saved') notify('Build saved on this browser.')
            else notify(storageMessage(result.ok ? 'conflict' : result.reason))
          }}
        >
          <Plus size={16} /> Save current
        </button>
      </div>
      {saveBlocked && (
        <p className="muted small">
          Finish the current edit or explicitly accept the repaired design before saving it to the
          library. Recovery originals remain downloadable.
        </p>
      )}
      {loading && <p role="status">Preserving both designs before opening the repair workspace…</p>}
      {library.error && (
        <div className="notice" role="alert">
          <p>{storageMessage(library.error)}</p>
          <button className="secondary" onClick={() => void library.refresh()}>
            Refresh library
          </button>
        </div>
      )}
      {!library.snapshot && !library.error && <p role="status">Opening your saved builds…</p>}
      {!!library.snapshot?.rejected.length && (
        <div className="notice" role="alert">
          <p>
            {library.snapshot.rejected.length} unsupported or damaged records are preserved, not
            deleted.
          </p>
          <button
            className="secondary"
            onClick={() =>
              downloadFile(
                'fury-library-recovery.json',
                JSON.stringify(library.snapshot?.rejected, null, 2),
              )
            }
          >
            Download original records
          </button>
        </div>
      )}
      <p className="muted small">
        {saved.length}/12 saved locally on this browser. No account or cloud backup. Select two
        builds to compare.
      </p>
      {library.snapshot && saved.length === 0 ? (
        <div className="empty-library">
          <Bookmark size={32} strokeWidth={1} />
          <h3>Your ideas belong here.</h3>
          <p>Save your first design above. Come back to it whenever inspiration strikes.</p>
        </div>
      ) : (
        <div className="saved-grid">
          {saved.map((build) => (
            <div className="saved-card" key={build.id}>
              <div className="saved-visual">
                <MiniStudio
                  family={build.config.family}
                  finish={FINISHES.find((f) => f.id === build.config.finish)!.color}
                  deck={build.config.addons.deck}
                  long={build.config.length === 40}
                />
                <button
                  className="icon-button"
                  aria-label={`Delete ${build.name}`}
                  disabled={library.busy || !!loading}
                  onClick={async () => {
                    if (window.confirm(`Delete “${build.name}” from this browser?`)) {
                      const entry = library.snapshot!.entries.find(
                        (entry) => entry.build.id === build.id,
                      )!
                      const result = await library.remove(build.id, entry.revision)
                      if (result.ok && result.value.status === 'saved')
                        setCompare(compare.filter((id) => id !== build.id))
                      else notify(storageMessage(result.ok ? 'conflict' : result.reason))
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <h3>{build.name}</h3>
              <p>{productName(build.config)} · Quote required</p>
              {library.snapshot?.entries.find((entry) => entry.build.id === build.id)?.status ===
                'repair' && (
                <p className="muted small">Needs layout repair. Original build is preserved.</p>
              )}
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
                  disabled={library.busy || !!loading}
                  onClick={async () => {
                    const entry = library.snapshot!.entries.find(
                      (entry) => entry.build.id === build.id,
                    )!
                    if (entry.status === 'repair') {
                      if (
                        !window.confirm(
                          'Open this build for repair? Your current design and this original will be preserved before anything changes. Automatic saving stays suspended until you accept a valid repair.',
                        )
                      )
                        return
                      setLoading(build.id)
                      try {
                        if (
                          await onRepair(
                            structuredClone(build.config),
                            entry.originalRaw
                              ? { raw: entry.originalRaw, format: 'json' }
                              : undefined,
                          )
                        )
                          onClose()
                      } finally {
                        setLoading(null)
                      }
                      return
                    }
                    if (onLoad(structuredClone(build.config))) {
                      onClose()
                      notify(`Loaded “${build.name}”.`)
                    }
                  }}
                >
                  {library.snapshot?.entries.find((entry) => entry.build.id === build.id)
                    ?.status === 'repair'
                    ? 'Open for repair'
                    : 'Load'}{' '}
                  <ArrowRight size={14} />
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
                        ? CONTAINER_OPENINGS.find((o) => o.id === c.containerOpening)!.name
                        : 'Studio concept glazing',
                  ],
                  [
                    'Configuration request',
                    (c: Config) =>
                      c.family === 'studio'
                        ? STUDIO_LAYOUTS.find((o) => o.id === c.studioLayout)!.name
                        : 'Single unit',
                  ],
                  [
                    'Published family starting price',
                    (c: Config) => money(estimate(c).startingPrice),
                  ],
                  ['Configured price', () => 'Quote required'],
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
            Highlighted rows differ. Family starting prices are not configured project totals. All
            selections and site costs require a quote.
          </p>
        </div>
      )}
    </Modal>
  )
}
