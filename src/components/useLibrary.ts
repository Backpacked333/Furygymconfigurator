import { useCallback, useEffect, useRef, useState } from 'react'
import {
  openDocumentRepository,
  type DocumentRepository,
  type LibrarySnapshot,
  type RecordWrite,
} from '../lib/repository'
import type { SavedBuild } from '../lib/config'
import type { Outcome, StorageFailure } from '../lib/recovery'

export function useLibrary() {
  const repository = useRef<DocumentRepository | null>(null)
  const epoch = useRef(0)
  const changing = useRef(false)
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [error, setError] = useState<StorageFailure | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const owner = repository.current
    if (!owner) return
    const request = ++epoch.current
    const result = await owner.list()
    if (repository.current !== owner || request !== epoch.current) return
    if (result.ok) {
      setSnapshot(result.value)
      setError(null)
    } else setError(result.reason)
  }, [])
  useEffect(() => {
    let disposed = false
    let release = () => {}
    void openDocumentRepository().then((opened) => {
      if (disposed) {
        if (opened.ok) opened.value.close()
        return
      }
      if (!opened.ok) {
        setError(opened.reason)
        return
      }
      const owner = opened.value
      repository.current = owner
      const unsubscribe = owner.subscribe(() => void refresh())
      release = () => {
        unsubscribe()
        repository.current = null
        owner.close()
      }
      void refresh()
    })
    return () => {
      disposed = true
      release()
    }
  }, [refresh])
  const mutate = useCallback(
    async (
      operation: (owner: DocumentRepository) => Promise<Outcome<RecordWrite>>,
    ): Promise<Outcome<RecordWrite>> => {
      const owner = repository.current
      if (!owner) return { ok: false, reason: 'unavailable' }
      if (changing.current) return { ok: false, reason: 'conflict' }
      changing.current = true
      setBusy(true)
      try {
        const result = await operation(owner)
        if (repository.current === owner) {
          await refresh()
          if (!result.ok) setError(result.reason)
          else if (result.value.status === 'conflict') setError('conflict')
        }
        return result
      } finally {
        changing.current = false
        if (repository.current === owner) setBusy(false)
      }
    },
    [refresh],
  )
  return {
    snapshot,
    error,
    busy,
    refresh,
    save: (build: SavedBuild) => mutate((owner) => owner.put(build, null)),
    remove: (id: string, revision: number) => mutate((owner) => owner.delete(id, revision)),
  }
}

export function storageMessage(reason: StorageFailure) {
  if (reason === 'conflict')
    return 'Another tab changed this record. Nothing was overwritten. Review the refreshed library before trying again.'
  if (reason === 'quota' || reason === 'capacity' || reason === 'too-large')
    return 'Browser storage is full or this record exceeds its limit. Download your design and recovery originals before clearing anything.'
  if (reason === 'corrupt-store')
    return 'Some stored data cannot be read safely. Original records are retained; download them for recovery.'
  return 'Browser storage is unavailable. Your in-memory design is still here; download it before closing this tab.'
}
