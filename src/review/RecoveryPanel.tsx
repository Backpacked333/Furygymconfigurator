import { useState } from 'react'
import { downloadFile } from '../lib/export'
import { archiveLegacyOriginals } from '../lib/recovery'

const sources = [
  { key: 'fury-draft-v1', label: 'Legacy draft' },
  { key: 'fury-builds-v1', label: 'Legacy saved library' },
] as const

const recoveryPrefixes = [
  'fury-draft-recovery-',
  'fury-draft-v1-recovery-',
  'fury-builds-v1-recovery-',
  'fury-fixed-review-v1-recovery-',
]
function recoveryCopies(storage: Storage) {
  const copies: { key: string; raw: string }[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key && recoveryPrefixes.some((prefix) => key.startsWith(prefix))) {
      const raw = storage.getItem(key)
      if (raw !== null) copies.push({ key, raw })
    }
  }
  return copies
}

export function RecoveryPanel({
  storage,
  notify,
}: {
  storage: Storage | null
  notify: (message: string, error?: boolean) => void
}) {
  const [originals, setOriginals] = useState<
    null | { key: string; label: string; raw: string | null }[]
  >(null)
  const [copies, setCopies] = useState<{ key: string; raw: string }[]>([])
  const [visible, setVisible] = useState(5)
  function inspect() {
    try {
      if (!storage)
        throw new Error('Browser storage is unavailable. No original has been replaced.')
      const nextOriginals = sources.map((source) => ({
        ...source,
        raw: storage.getItem(source.key),
      }))
      const nextCopies = recoveryCopies(storage)
      setOriginals(nextOriginals)
      setCopies(nextCopies)
      setVisible(5)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Originals could not be read.', true)
    }
  }
  function archive() {
    try {
      if (!storage) throw new Error('Browser storage is unavailable.')
      const copies = archiveLegacyOriginals(storage)
      setCopies(recoveryCopies(storage))
      notify(
        `Preserved ${copies.length} original${copies.length === 1 ? '' : 's'}. Legacy source keys were not changed.`,
      )
    } catch {
      notify(
        'Preservation could not finish. Originals are unchanged; any completed recovery copies remain. No conversion ran.',
        true,
      )
    }
  }
  return (
    <details className="review-recovery">
      <summary>Original designs & recovery</summary>
      <p>
        Existing editable designs stay in their original storage. This workspace does not convert
        them, substitute a fixed-layout picture or send them anywhere.
      </p>
      <button className="review-secondary" onClick={inspect}>
        Inspect saved originals
      </button>
      {originals && (
        <>
          <ul>
            {originals.map(({ key, label, raw }) => (
              <li key={key}>
                <span>
                  <strong>{label}</strong>
                  <small>
                    {raw === null
                      ? 'Not found'
                      : `${raw.length.toLocaleString()} characters · exact raw snapshot`}
                  </small>
                </span>
                {raw !== null && (
                  <button
                    className="review-text-button"
                    onClick={() => {
                      try {
                        downloadFile(`${key}-original.txt`, raw, 'text/plain')
                      } catch {
                        notify('Download failed. The stored original is unchanged.', true)
                      }
                    }}
                  >
                    Download {label.toLowerCase()}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {originals.some(({ raw }) => raw !== null) && (
            <button className="review-secondary" onClick={archive}>
              Preserve legacy originals
            </button>
          )}
          <p className="review-fine">
            Downloads use the last inspected snapshot. Preservation re-reads current values and
            creates verified recovery copies. It does not delete, edit or approve anything. Copies
            use browser storage space.
          </p>
          {copies.length > 0 && (
            <section aria-label="Recovery copies">
              <h3>
                Recovery copies <small>({copies.length})</small>
              </h3>
              <p>
                These are preserved originals, not converted designs. Download any copy as its exact
                stored text. No recovery copy is automatically deleted.
              </p>
              <ul>
                {copies.slice(0, visible).map(({ key, raw }, index) => (
                  <li key={key}>
                    <span>
                      <strong>Copy {index + 1}</strong>
                      <small className="review-recovery-key">{key}</small>
                    </span>
                    <button
                      className="review-text-button"
                      onClick={() => {
                        try {
                          downloadFile(`${key}.txt`, raw, 'text/plain')
                        } catch {
                          notify('Download failed. The recovery copy is unchanged.', true)
                        }
                      }}
                    >
                      Download recovery copy {index + 1}
                    </button>
                  </li>
                ))}
              </ul>
              {copies.length > visible && (
                <button
                  className="review-secondary"
                  onClick={() => setVisible((count) => count + 5)}
                >
                  Show more recovery copies
                </button>
              )}
            </section>
          )}
        </>
      )}
    </details>
  )
}
