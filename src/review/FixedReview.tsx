import { useEffect, useReducer, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpRight, LockKeyhole, Redo2, Undo2 } from 'lucide-react'
import { arrangementEquipment } from '../domain/arrangements'
import {
  fixedLayoutProductionGate,
  resolveFixedLayoutForReview,
  serializeFixedLayout,
} from '../domain/fixedLayout'
import { catalogItem, distance, type Unit } from '../lib/config'
import { downloadFile } from '../lib/export'
import { FixedPlan } from './FixedPlan'
import { RecoveryPanel } from './RecoveryPanel'
import {
  defaultReview,
  readReviewDraft,
  readReviewShare,
  reviewHistory,
  reviewLink,
  reviewReducer,
  saveReviewDraft,
} from './state'

function browserStorage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function FixedReview() {
  const workspace = useRef<HTMLElement>(null)
  const [storage] = useState(browserStorage)
  const [snapshot, setSnapshot] = useState(() => readReviewDraft(storage))
  const [share, setShare] = useState(() => readReviewShare(window.location.hash))
  const [history, dispatch] = useReducer(
    reviewReducer,
    share.layout ?? snapshot.layout ?? defaultReview(),
    reviewHistory,
  )
  const [unit, setUnit] = useState<Unit>('ft')
  const [halos, setHalos] = useState(false)
  const [notice, setNotice] = useState({ text: '', error: false })
  const layout = history.present
  const resolved = resolveFixedLayoutForReview(layout)
  const gate = fixedLayoutProductionGate(layout)
  const family = layout.product.family === 'studio' ? 'Studio' : 'Container'
  const label = `${family} ${layout.product.lengthFt}`
  const saved =
    snapshot.layout !== null &&
    serializeFixedLayout(snapshot.layout) === serializeFixedLayout(layout)
  const notify = (text: string, error = false) => setNotice({ text, error })

  useEffect(() => {
    function restoreShare() {
      const next = readReviewShare(window.location.hash)
      setShare(next)
      if (next.layout) {
        dispatch({ type: 'load', layout: next.layout })
        setNotice({ text: 'Shared review loaded. No stored design was overwritten.', error: false })
      } else if (next.status === 'unreadable') {
        setNotice({
          text: 'The new link could not be read. Your current review is unchanged.',
          error: true,
        })
      }
    }
    window.addEventListener('hashchange', restoreShare)
    return () => window.removeEventListener('hashchange', restoreShare)
  }, [])

  function save(preserveUnreadable = false) {
    try {
      if (!storage) throw new Error('Storage is unavailable. Export the review to keep a copy.')
      setSnapshot(saveReviewDraft(storage, snapshot.raw, layout, preserveUnreadable))
      notify(
        preserveUnreadable
          ? 'Original preserved and verified. The new review is saved separately from legacy designs.'
          : `${label} review saved on this browser only.`,
      )
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The review could not be saved.', true)
    }
  }

  function download(name: string, content: string, type = 'application/json') {
    try {
      downloadFile(name, content, type)
    } catch {
      notify('Download failed. No stored data was changed.', true)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(reviewLink(layout, window.location.href))
      notify(
        `Copied the ${label} local review link. It needs this development workspace to be running.`,
      )
    } catch {
      notify('Clipboard access is unavailable. Export the review JSON instead.', true)
    }
  }

  return (
    <div className="fixed-review">
      <a
        className="review-skip"
        href="#review-workspace"
        onClick={(event) => {
          event.preventDefault()
          workspace.current?.focus()
        }}
      >
        Skip to arrangement review
      </a>
      <header className="review-header">
        <div className="review-wordmark">
          FURY<span>CO GYMS</span>
        </div>
        <div className="review-header-label">
          DESIGN LAB <span>/</span> FIXED ARRANGEMENTS
        </div>
        <span className="review-badge">LOCAL REVIEW ONLY</span>
      </header>
      <main ref={workspace} id="review-workspace" tabIndex={-1}>
        <section className="review-intro">
          <div>
            <p className="review-eyebrow">A considered place to train</p>
            <h1>Space, considered.</h1>
            <p>
              One arrangement for each family and size. Explore the proposal, not an equipment
              editor.
            </p>
          </div>
          <div className="review-intro-note">
            <LockKeyhole size={18} aria-hidden="true" />
            <span>
              Fixed by design.
              <br />
              <strong>Still subject to approval.</strong>
            </span>
          </div>
        </section>

        {share.status === 'unreadable' && (
          <section className="review-warning" role="alert">
            <strong>This link is invalid or from an unsupported version.</strong>
            <p>
              The plan below is your current review, not a rendering of that link. The original
              fragment is retained; nothing was migrated or saved.
            </p>
            <button
              className="review-text-button"
              onClick={() => download('unreadable-review-link.txt', share.raw, 'text/plain')}
            >
              Download original link fragment
            </button>
          </section>
        )}
        {snapshot.status === 'unreadable' && (
          <section className="review-warning" role="alert">
            <strong>Your stored review could not be read. It remains untouched.</strong>
            <p>
              The plan below is a separate review, not the unreadable original. Download the
              original or explicitly preserve it before replacing this review slot.
            </p>
            <div className="review-actions">
              <button
                className="review-secondary"
                onClick={() => download('original-review.txt', snapshot.raw!, 'text/plain')}
              >
                Download original review
              </button>
              <button className="review-secondary" onClick={() => save(true)}>
                Preserve original and save review
              </button>
            </div>
          </section>
        )}
        {snapshot.status === 'unavailable' && (
          <p className="review-warning" role="alert">
            Browser storage is unavailable. Changes stay in memory; export your review before
            leaving.
          </p>
        )}

        <div className="review-workspace">
          <aside className="review-controls" aria-label="Arrangement selection">
            <p className="review-eyebrow">01 / Your space</p>
            <h2>Choose the envelope.</h2>
            <fieldset>
              <legend>Product family</legend>
              <div className="review-choice-grid">
                {(['studio', 'container'] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={layout.product.family === value}
                    onClick={() => {
                      dispatch({ type: 'select', patch: { family: value } })
                      notify('Family and fixed arrangement updated together.')
                    }}
                  >
                    <span>{value === 'studio' ? 'Studio' : 'Container'}</span>
                    <small>
                      {value === 'studio' ? 'Purpose-built space' : 'Container concept'}
                    </small>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Nominal length</legend>
              <div className="review-choice-grid">
                {([20, 40] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={layout.product.lengthFt === value}
                    onClick={() => {
                      dispatch({ type: 'select', patch: { lengthFt: value } })
                      notify('Size and fixed arrangement updated together.')
                    }}
                  >
                    <span>
                      {value} <small>ft</small>
                    </span>
                    <small>{value === 20 ? 'Focused footprint' : 'Room for more'}</small>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="review-control-summary">
              <span>Included in this proposal</span>
              <strong>{resolved.items.length} equipment pieces</strong>
              <p>Positions are fixed. There are no add, move, rotate or remove controls.</p>
            </div>
            <div className="review-history" aria-label="Review history">
              <button
                aria-label="Undo review change"
                disabled={!history.past.length}
                onClick={() => dispatch({ type: 'undo' })}
              >
                <Undo2 size={17} aria-hidden="true" />
                Undo
              </button>
              <button
                aria-label="Redo review change"
                disabled={!history.future.length}
                onClick={() => dispatch({ type: 'redo' })}
              >
                <Redo2 size={17} aria-hidden="true" />
                Redo
              </button>
            </div>
            <p className="review-fine">
              The envelope is schematic. Retained doors, finishes and structural options are not
              part of this review contract.
            </p>
          </aside>

          <section className="review-stage" aria-label="Fixed arrangement plan">
            <div className="review-stage-header">
              <div>
                <p className="review-eyebrow">02 / Fixed arrangement</p>
                <h2>
                  {label}
                  <span> · proposed plan</span>
                </h2>
              </div>
              <label className="review-unit">
                Display units
                <select
                  aria-label="Display units"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as Unit)}
                >
                  <option value="ft">Feet</option>
                  <option value="m">Metres</option>
                </select>
              </label>
            </div>
            <div className="review-stage-meta">
              <span>
                <LockKeyhole size={13} aria-hidden="true" /> READ-ONLY
              </span>
              <span>NOT FOR CONSTRUCTION</span>
            </div>
            <FixedPlan layout={layout} unit={unit} halos={halos} />
            <div className="review-stage-footer">
              <label>
                <input
                  type="checkbox"
                  checked={halos}
                  onChange={(e) => setHalos(e.target.checked)}
                />
                Show illustrative clearance halos
              </label>
              <span>Use zones are not certified.</span>
            </div>
          </section>
        </div>

        <div className="review-detail-grid">
          <section className="review-inventory" aria-labelledby="inventory-heading">
            <p className="review-eyebrow">03 / What is included</p>
            <h2 id="inventory-heading">The equipment proposal.</h2>
            <ol>
              {resolved.items.map((item, index) => {
                const dimensions = arrangementEquipment(item.sku)
                return (
                  <li key={item.id}>
                    <span className="review-number">{index + 1}</span>
                    <div>
                      <strong>{catalogItem(item.sku).name}</strong>
                      <small>
                        Catalog occupied footprint: {distance(dimensions.occupiedWidthFt, unit)} ×{' '}
                        {distance(dimensions.depthFt, unit)}
                      </small>
                    </div>
                    <span className="review-quantity">× 1</span>
                  </li>
                )
              })}
            </ol>
            <p className="review-fine">
              Generic catalog dimensions before rotation, not manufacturer specifications. The
              numbers match the plan.
            </p>
          </section>
          <section className="review-holds" aria-labelledby="holds-heading">
            <p className="review-eyebrow">04 / Before this becomes a product</p>
            <h2 id="holds-heading">Review, not approval.</h2>
            <p className="review-hold-label">
              {gate.allowed ? 'Approval required' : 'Production use blocked'}
            </p>
            <ul>
              {gate.reviewHolds.map((hold) => (
                <li key={hold}>{hold}</li>
              ))}
            </ul>
            <p>
              There is no renderer request, price, strict-image export or purchase action in this
              workspace.
            </p>
          </section>
        </div>

        <section className="review-save" aria-label="Save and share review">
          <div>
            <h2>Keep the conversation moving.</h2>
            <p>
              {saved
                ? 'This exact review is saved in this browser.'
                : 'Unsaved review. Nothing is written until you choose Save.'}{' '}
              Legacy designs stay separate.
            </p>
            <small>
              {layout.arrangementRef} · {layout.catalogVersion}
            </small>
          </div>
          <div className="review-actions">
            <button
              className="review-primary"
              disabled={snapshot.status === 'unreadable' || snapshot.status === 'unavailable'}
              onClick={() => save()}
            >
              Save review
              <ArrowUpRight size={17} aria-hidden="true" />
            </button>
            <button className="review-secondary" onClick={copyLink}>
              Copy local review link
            </button>
            <button
              className="review-secondary"
              onClick={() =>
                download(
                  `fury-${layout.product.family}-${layout.product.lengthFt}-review.json`,
                  serializeFixedLayout(layout),
                )
              }
            >
              <ArrowDownToLine size={16} aria-hidden="true" />
              Export review JSON
            </button>
          </div>
        </section>
        <p
          className={`review-status${notice.error ? ' review-status-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text || 'Local-only proposals. No GPU work or external design submission.'}
        </p>
        <RecoveryPanel storage={storage} notify={notify} />
      </main>
      <footer className="review-footer">
        <span>FURY CO GYMS / ARRANGEMENT STUDIES</span>
        <span>Unpublished development workspace · equipment approval outstanding</span>
      </footer>
    </div>
  )
}
