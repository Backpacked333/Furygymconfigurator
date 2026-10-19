import { useEffect, useState } from 'react'
import { Bookmark, CircleHelp, Plus, Share2 } from 'lucide-react'
import Modal from '../components/Modal'
import { projectDesignToConfig, serializeDesign, type DesignEnvelope } from '../domain/design'
import {
  BuildLibraryView,
  BuildShareView,
  EmptyBuildLibraryView,
  SavedBuildView,
} from '../components/BuildDialogView'
import { Elevation } from '../components/Elevation'
import { FINISHES, productName } from '../lib/config'
import {
  PROTOTYPE_RECOVERY_PREFIX,
  readPrototypeDesign,
  savePrototypeDesign,
  type PrototypeRead,
} from '../domain/prototypeStorage'
import { archiveLegacyOriginals } from '../lib/recovery'
import { downloadPrototypeFile, prototypeLink, prototypeStorage, readPrototypeShare } from './state'

const originalKeys = ['fury-draft-v1', 'fury-builds-v1', 'fury-fixed-review-v1'] as const
export function DesignLibrary({
  design,
  onLoad,
  notify: notifyParent,
  onHelp,
}: {
  design: DesignEnvelope
  onLoad: (design: DesignEnvelope) => void
  notify: (message: string) => void
  onHelp?: () => void
}) {
  const [open, setOpen] = useState<'library' | 'share' | 'help' | null>(null)
  const [storage] = useState(prototypeStorage)
  const [stored, setStored] = useState<PrototypeRead>(() =>
    storage ? readPrototypeDesign(storage) : { status: 'storage-error', raw: null },
  )
  const [share, setShare] = useState(() => readPrototypeShare(window.location.hash))
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [link, setLink] = useState('')
  const [originals, setOriginals] = useState<readonly { key: string; raw: string }[]>([])
  const [inspected, setInspected] = useState(false)
  const [copies, setCopies] = useState<readonly { key: string; raw: string }[]>([])
  const [visibleCopies, setVisibleCopies] = useState(5)
  function notify(message: string) {
    setFeedback(message)
    notifyParent(message)
  }
  function openLibrary() {
    setFeedback('')
    setOpen('library')
  }
  useEffect(() => {
    const update = () => {
      setShare(readPrototypeShare(window.location.hash))
      setLink('')
    }
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  function download(name: string, raw: string, type?: string) {
    try {
      downloadPrototypeFile(name, raw, type)
    } catch {
      notify('Download unavailable. No stored original was changed.')
    }
  }
  async function save(replace = false) {
    if (!storage || saving || stored.status === 'storage-error') return
    const snapshot = design
    const expected = stored.raw
    setSaving(true)
    setFeedback('Saving the selected snapshot…')
    try {
      const write = () => savePrototypeDesign(storage, snapshot, expected, replace)
      // Cooperating tabs serialize the entire compare/archive/write/readback sequence.
      const result = navigator.locks
        ? await navigator.locks.request('fury-prototype-v4-save', write)
        : write()
      if (result.status === 'saved') {
        setStored({ status: 'ready', raw: result.raw, design: result.design })
        notify(
          'Saved the selected v4 snapshot locally. Later edits are not auto-saved. Previous raw data was preserved before replacement.',
        )
      } else if (result.status === 'conflict')
        notify(
          'A newer or changed prototype is stored. Inspect saved prototype before deciding; nothing was intentionally replaced.',
        )
      else if (result.status === 'recovery-required')
        notify(
          'The saved original is malformed or from another version. Download it or explicitly preserve and replace it.',
        )
      else
        notify(
          'Storage preservation or verification failed. Save was not confirmed; keep your JSON and inspect the stored original.',
        )
    } catch {
      notify('Local save failed. No successful save is claimed.')
    } finally {
      setSaving(false)
    }
  }
  function inspectSaved(load: boolean) {
    if (!storage) return
    const next = readPrototypeDesign(storage)
    setStored(next)
    if (next.status === 'ready' && load) {
      onLoad(next.design)
      notify('Saved v4 design loaded as one Undo step. No original was migrated or overwritten.')
    } else
      notify(
        next.status === 'ready'
          ? 'Saved prototype inspected; your current design is unchanged.'
          : next.status === 'empty'
            ? 'No saved prototype found.'
            : next.status === 'storage-error'
              ? 'Browser storage is unavailable.'
              : 'Unsupported saved original retained. The current design is not that original.',
      )
  }
  async function copyLink() {
    const frozenLink = prototypeLink(design, window.location.href)
    setLink(frozenLink)
    // Explicit share creation adds history; unknown raw shares remain reachable with Back.
    // Invalid fragments are never replaced, so their raw recovery button remains available.
    try {
      if (share.status !== 'invalid' && window.location.href !== frozenLink) {
        window.history.pushState(null, '', frozenLink)
        setShare(readPrototypeShare(new URL(frozenLink).hash))
      }
    } catch {
      notify('Local history could not be updated. The snapshot link remains available below.')
    }
    try {
      await navigator.clipboard.writeText(frozenLink)
      notify(
        'Copied a local DEV prototype link for the selected snapshot. It is not a published customer link.',
      )
    } catch {
      notify('Clipboard unavailable. Copy the snapshot link below or export JSON instead.')
    }
  }
  function inspectOriginals() {
    try {
      if (!storage) throw new Error('Storage unavailable')
      setOriginals(
        originalKeys.flatMap((key) => {
          const raw = storage.getItem(key)
          return raw === null ? [] : [{ key, raw }]
        }),
      )
      const entries: { key: string; raw: string }[] = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (
          key &&
          (key.startsWith(PROTOTYPE_RECOVERY_PREFIX) ||
            /^fury-(draft|builds|fixed-review).*recovery-/.test(key))
        ) {
          const raw = storage.getItem(key)
          if (raw !== null) entries.push({ key, raw })
        }
      }
      setCopies(entries)
      setVisibleCopies(5)
      setInspected(true)
    } catch {
      notify('Originals could not be read. No conversion or replacement ran.')
    }
  }
  const projected = projectDesignToConfig(design)
  const feedbackView = (
    <p className="prototype-library-feedback" role="status" aria-atomic="true">
      {feedback}
    </p>
  )
  const exportDesign = () =>
    download(
      `Fury-v4-${design.config.product.family}-${design.config.product.lengthFt}-${design.config.appearance.finish}.json`,
      serializeDesign(design),
    )
  const shareView = (
    <BuildShareView
      visual={<Elevation config={projected} className="mini-studio" />}
      name={productName(projected)}
      summary={
        <>
          DRAFT · {projected.items.length} fixed interior items ·{' '}
          {FINISHES.find((finish) => finish.id === projected.finish)!.name}
        </>
      }
      link={link || prototypeLink(design, window.location.href)}
      linkLabel="Snapshot link (not live-synced)"
      linkAriaLabel="Local prototype snapshot link"
      multiline
      copyLabel="Copy local prototype link"
      downloadLabel="Export design JSON"
      onCopy={() => void copyLink()}
      onDownload={exportDesign}
      notice="Local DEV prototype only, not a published customer link. Contains the full design, look, camera, door pose, aspect and output profile. Display units are personal UI state, not visual identity. PDF and approved image exports are unavailable."
    >
      {share.status === 'ready' && (
        <button
          className="secondary full"
          onClick={() => {
            onLoad(share.design)
            notify('Shared v4 snapshot opened as one Undo step. No storage was written.')
          }}
        >
          Open shared design
        </button>
      )}
      {share.status === 'invalid' && (
        <p className="prototype-warning">
          Invalid or unsupported share. No import or migration occurred.
        </p>
      )}
      {share.status !== 'empty' && (
        <button
          className="secondary full"
          onClick={() => download('fury-original-share-fragment.txt', share.raw, 'text/plain')}
        >
          Download original link fragment
        </button>
      )}
    </BuildShareView>
  )
  return (
    <>
      <nav className="header-actions" aria-label="Build actions">
        <button onClick={openLibrary}>
          <Bookmark size={16} />
          <span>My builds</span>
        </button>
        <button
          onClick={() => {
            setFeedback('')
            setOpen('share')
          }}
        >
          <Share2 size={16} />
          <span>Share</span>
        </button>
        <button
          className="help-button"
          aria-label="Help and information"
          onClick={onHelp ?? (() => setOpen('help'))}
        >
          <CircleHelp size={18} />
        </button>
      </nav>
      {share.status !== 'empty' && (
        <div
          className="prototype-share-notice"
          role={share.status === 'invalid' ? 'alert' : 'status'}
        >
          {share.status === 'invalid'
            ? 'Unsupported link preserved. The displayed design is not that original.'
            : 'A v4 link is available. Open it explicitly; edits are never auto-saved.'}
          <button onClick={openLibrary}>Review link</button>
        </div>
      )}
      {open === 'share' && (
        <Modal
          title="Good things are shared."
          subtitle="A full v4 snapshot. Local DEV prototype only."
          onClose={() => setOpen(null)}
        >
          {feedbackView}
          {shareView}
        </Modal>
      )}
      {open === 'help' && (
        <Modal
          title="Your space. Your way."
          subtitle="Local DEV image-first configurator"
          onClose={() => setOpen(null)}
        >
          <div className="help-grid">
            <div>
              <h3>Make it yours.</h3>
              <p>
                Use Space, Exterior, Interior and Setting. Fixed arrangements are DRAFT, not
                approved specifications. The plan is read-only; equipment cannot be added, moved,
                rotated or removed.
              </p>
            </div>
            <div>
              <h3>Keep your decisions.</h3>
              <p>
                My builds saves one complete v4 snapshot on this browser. Save, Share, JSON and
                Undo/Redo do not depend on an image. Nothing is automatically migrated or submitted.
              </p>
            </div>
            <div>
              <h3>Know what you are seeing.</h3>
              <p>
                Historical references and mock previews are not approved current images. Quote
                required. Engineering, rights, art, cameras, renderer, performance and G1 gates
                remain open. PDF, live and approved-image exports are unavailable.
              </p>
            </div>
          </div>
        </Modal>
      )}
      {open === 'library' && (
        <BuildLibraryView
          subtitle="Local v4 prototype only. No customer conversion or external submission."
          onClose={() => setOpen(null)}
          feedback={feedbackView}
          saveRow={
            <>
              <button
                className="primary"
                disabled={
                  saving ||
                  stored.status === 'storage-error' ||
                  stored.status === 'recovery-required'
                }
                onClick={() => void save()}
              >
                <Plus size={16} />
                Save design locally
              </button>
              <button
                className="secondary"
                disabled={saving || !storage}
                onClick={() => inspectSaved(false)}
              >
                Inspect saved prototype
              </button>
              <button
                className="secondary"
                disabled={saving || !storage}
                onClick={() => inspectSaved(true)}
              >
                Load saved prototype
              </button>
            </>
          }
          summary="One local v4 snapshot, not the legacy build library. Edits stay in memory until you save. Legacy and review keys are never overwritten. Replaced v4 originals receive verified raw recovery copies."
        >
          <section className="prototype-library">
            <h3>Save & load</h3>
            {saving && (
              <p role="status">
                Saving the selected snapshot; save and load controls are temporarily unavailable.
              </p>
            )}
            {stored.status === 'empty' && <EmptyBuildLibraryView />}
            {stored.status === 'ready' && (
              <div className="saved-grid">
                <SavedBuildView
                  name="Saved v4 snapshot"
                  visual={
                    <Elevation
                      config={projectDesignToConfig(stored.design)}
                      className="mini-studio"
                    />
                  }
                  summary={
                    <>
                      {productName(projectDesignToConfig(stored.design))} · DRAFT · Quote required
                    </>
                  }
                />
              </div>
            )}
            {stored.status === 'storage-error' && (
              <p role="alert">
                Browser storage is unavailable. Keep editing in memory and export JSON.
              </p>
            )}
            {stored.status === 'recovery-required' && (
              <div className="prototype-warning" role="alert">
                <p>
                  Malformed, unknown or future saved original retained. This workspace is not that
                  original.
                </p>
                <button onClick={() => download('fury-v4-original.txt', stored.raw, 'text/plain')}>
                  Download saved original
                </button>
                <button disabled={saving} onClick={() => void save(true)}>
                  Preserve original and replace with this design
                </button>
              </div>
            )}
            <h3>Share the selected snapshot</h3>
            {shareView}
            <details>
              <summary>Original designs & recovery</summary>
              <p>
                Optional raw recovery only. Production conversion is blocked pending catalog
                approval. No automatic migration or faithful historical rendering is offered.
              </p>
              <button onClick={inspectOriginals}>Inspect saved originals</button>
              {inspected && (
                <>
                  <p>
                    {originals.length} original source records found. Downloads preserve exact
                    inspected text.
                  </p>
                  {originals.map(({ key, raw }) => (
                    <div key={key}>
                      <code>{key}</code>
                      <button onClick={() => download(`${key}-original.txt`, raw, 'text/plain')}>
                        Download {key}
                      </button>
                    </div>
                  ))}
                  <button
                    disabled={!storage}
                    onClick={() => {
                      try {
                        if (storage) {
                          archiveLegacyOriginals(storage)
                          inspectOriginals()
                          notify(
                            'Legacy originals copied and verified; source keys unchanged. No conversion ran.',
                          )
                        }
                      } catch {
                        notify('Preservation did not complete. Existing originals are unchanged.')
                      }
                    }}
                  >
                    Preserve legacy originals
                  </button>
                  {copies.length > 0 && (
                    <section aria-label="Prototype and legacy recovery copies">
                      <h4>Raw recovery copies</h4>
                      {copies.slice(0, visibleCopies).map(({ key, raw }, index) => (
                        <div key={key}>
                          <code>{key}</code>
                          <button onClick={() => download(`${key}.txt`, raw, 'text/plain')}>
                            Download recovery copy {index + 1}
                          </button>
                        </div>
                      ))}
                      {copies.length > visibleCopies && (
                        <button onClick={() => setVisibleCopies((value) => value + 5)}>
                          Show more recovery copies
                        </button>
                      )}
                    </section>
                  )}
                </>
              )}
            </details>
          </section>
        </BuildLibraryView>
      )}
    </>
  )
}
