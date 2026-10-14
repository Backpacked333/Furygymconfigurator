import { useState } from 'react'
import { inspectConfig, inspectDocument } from '../lib/config'
import { downloadFile } from '../lib/export'
import type { useConfig } from '../lib/useConfig'
import type { RecoveryRecord } from '../lib/recovery'
import Modal from './Modal'
import { storageMessage } from './useLibrary'

function inspectOriginal(record: RecoveryRecord) {
  if (record.format === 'hash')
    return inspectConfig(new URLSearchParams(record.raw.replace(/^#/, '')).get('c') ?? '')
  if (record.format === 'encoded-config') return inspectConfig(record.raw)
  try {
    const value = JSON.parse(record.raw)
    return inspectDocument(value?.configuration ?? value?.config ?? value)
  } catch {
    return null
  }
}

export default function RecoveryDialog({
  document,
  onClose,
  onPlan,
  notify,
}: {
  document: ReturnType<typeof useConfig>
  onClose: () => void
  onPlan: () => void
  notify: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = inspectDocument(document.committedConfig)
  const accept = async (candidate = document.committedConfig) => {
    setBusy(true)
    setError('')
    try {
      const result = await document.acceptRecovery(candidate)
      if (result.ok && result.value.status === 'saved') {
        notify('Design saved. Displaced originals remain available for recovery.')
        onClose()
      } else setError(storageMessage(result.ok ? 'conflict' : result.reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Your design comes first."
      subtitle="Review preserved originals before resuming automatic saving."
      onClose={onClose}
      wide
    >
      <div className="notice" role="status">
        <p>
          {document.persistence.reason
            ? storageMessage(document.persistence.reason)
            : document.repair.required
              ? 'This design needs review. Repair the layout or download the original; it will not be silently rearranged.'
              : 'Recovery copies stay on this browser. Download them for an independent backup.'}
        </p>
      </div>
      {!!document.repair.issues.length && (
        <ul>
          {document.repair.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="secondary full"
        onClick={() =>
          downloadFile(
            'fury-current-document.json',
            JSON.stringify(document.committedConfig, null, 2),
          )
        }
      >
        Download current document JSON
      </button>
      <button className="secondary full" onClick={onPlan}>
        Review in the floor plan
      </button>
      <button
        className="primary full"
        disabled={busy || document.isPreviewing || current.status !== 'accepted'}
        onClick={() => void accept()}
      >
        {busy ? 'Preserving and saving…' : 'Use current design and resume saving'}
      </button>
      <h3>Preserved originals · {document.recovery.length}</h3>
      {document.recovery.length > 0 && (
        <button
          className="secondary full"
          onClick={() =>
            downloadFile('fury-recovery-originals.json', JSON.stringify(document.recovery, null, 2))
          }
        >
          Download all recovery originals
        </button>
      )}
      {document.recovery.map(({ record, status }) => {
        const inspected = inspectOriginal(record)
        return (
          <details key={record.id}>
            <summary>
              {record.source} · {record.createdAt.slice(0, 16).replace('T', ' ')} ·{' '}
              {status === 'volatile'
                ? 'In memory only — download now'
                : 'Preserved on this browser'}
            </summary>
            <p className="muted small">
              {inspected?.status === 'accepted'
                ? 'This original can be restored.'
                : inspected?.status === 'repair'
                  ? 'Open this original in a suspended repair workspace. Its exact bytes and your current design are preserved before anything changes.'
                  : 'Unsupported or damaged original. Download without alteration for recovery.'}
            </p>
            <button
              className="secondary"
              onClick={() => downloadFile(`fury-original-${record.id}.txt`, record.raw)}
            >
              Download exact original
            </button>
            {inspected?.status === 'accepted' && (
              <button
                className="secondary"
                disabled={busy || document.isPreviewing}
                onClick={() => {
                  if (
                    window.confirm(
                      'Restore this original? Your current design will be preserved first.',
                    )
                  )
                    void accept(inspected.config)
                }}
              >
                Restore this design
              </button>
            )}
            {inspected?.status === 'repair' && (
              <button
                className="secondary"
                disabled={busy || document.isPreviewing}
                onClick={async () => {
                  if (
                    !window.confirm(
                      'Open this original for repair? Both designs will be preserved first. You must explicitly accept a valid repair before automatic saving resumes.',
                    )
                  )
                    return
                  setBusy(true)
                  setError('')
                  try {
                    const result = await document.openRepair(inspected.config, record)
                    if (result.ok) {
                      notify(
                        'Repair workspace opened. Originals are preserved; automatic saving is suspended.',
                      )
                      onPlan()
                    } else setError(storageMessage(result.reason))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Open original for repair
              </button>
            )}
          </details>
        )
      })}
      <p className="muted small">
        Recovery copies are not cloud backups. Failed writes remain explicitly in memory and may be
        lost when this tab closes.
      </p>
    </Modal>
  )
}
