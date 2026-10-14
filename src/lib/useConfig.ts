import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { DEFAULT_CONFIG, initialConfig, inspectDocument, type Config } from './config'
import {
  configReducer,
  sameConfig,
  type EditAction,
  type EditResult,
  type EditToken,
} from './editTransactions'
import { DraftPersistence, initializeRepository, type PersistenceState } from './draftSession'
import {
  browserStorage,
  preserveRaw,
  recoveryRecord,
  type Initialization,
  type Preservation,
} from './recovery'
import { openDocumentRepository } from './repository'

export { configReducer } from './editTransactions'

export function useConfig() {
  const [initial] = useState(() => initialConfig())
  const [initialization, setInitialization] = useState<Initialization<Config>>(initial)
  const [state, dispatch] = useReducer(configReducer, {
    past: [],
    present: initial.config,
    future: [],
    notice: initial.notice,
    revision: 0,
  })
  const stateRef = useRef(state)
  const persistenceRef = useRef<DraftPersistence | null>(null)
  const [persistence, setPersistence] = useState<PersistenceState>({
    status: 'initializing',
    writeSafe: false,
    draftRevision: null,
    savedRevision: null,
    recovery: initial.recovery,
  })
  const [ready, setReady] = useState(false)
  const [rejectedInputs, setRejectedInputs] = useState<Preservation[]>([])
  const rejectedRef = useRef<Preservation[]>([])
  const [hash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash))
  const apply = useCallback((action: EditAction): EditResult => {
    const before = stateRef.current
    const next = configReducer(before, action)
    stateRef.current = next
    dispatch(action)
    if (next.present !== before.present || next.revision !== before.revision)
      void persistenceRef.current?.enqueue(next.present, next.revision ?? 0)
    if (action.type !== 'preview' && next.result?.recoveryRaw && next.result !== before.result) {
      const preserved = preserveRaw(recoveryRecord(next.result.recoveryRaw, 'transaction', 'json'))
      rejectedRef.current = [
        ...rejectedRef.current.filter((record) => record.record.raw !== preserved.record.raw),
        preserved,
      ]
      setRejectedInputs(rejectedRef.current)
      persistenceRef.current?.remember(preserved)
    }
    return next === before
      ? { status: 'noop', issues: [] }
      : (next.result ?? { status: 'noop', issues: [] })
  }, [])
  const setConfig = useCallback((config: Config) => apply({ type: 'set', config }), [apply])
  const undo = useCallback(() => apply({ type: 'undo' }), [apply])
  const redo = useCallback(() => apply({ type: 'redo' }), [apply])
  const beginEdit = useCallback((): EditToken => {
    const token = { id: crypto.randomUUID(), baseRevision: stateRef.current.revision ?? 0 }
    apply({ type: 'begin', token })
    return token
  }, [apply])
  const previewEdit = useCallback(
    (token: EditToken, config: Config) => apply({ type: 'preview', token, config }),
    [apply],
  )
  const commitEdit = useCallback(
    (token: EditToken, config?: Config) => apply({ type: 'commit', token, config }),
    [apply],
  )
  const cancelEdit = useCallback((token?: EditToken) => apply({ type: 'cancel', token }), [apply])

  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    const load = async () => {
      const opened = await openDocumentRepository()
      if (!opened.ok) {
        if (!disposed) {
          setPersistence((previous) => ({
            ...previous,
            status: 'volatile',
            reason: opened.reason,
            writeSafe: false,
          }))
          setReady(true)
        }
        return
      }
      const repository = opened.value
      const loaded = await initializeRepository(repository, browserStorage(), hash)
      if (disposed) {
        repository.close()
        return
      }
      const controller = new DraftPersistence(repository, loaded.initial, loaded.draftRevision)
      for (const input of rejectedRef.current) controller.remember(input)
      persistenceRef.current = controller
      const unsubscribe = controller.subscribe(setPersistence)
      const unwatch = repository.subscribe(() => {
        void controller.detectStale(stateRef.current.present)
      })
      cleanup = () => {
        unsubscribe()
        unwatch()
        if (persistenceRef.current === controller) persistenceRef.current = null
        // Committed writes finish after unmount; asynchronous unload writes are not promised.
        void controller.flush().finally(() => repository.close())
      }
      if ((stateRef.current.revision ?? 0) === 0)
        apply({
          type: 'restore',
          config: loaded.initial.config,
          notice: loaded.initial.notice,
          expectedRevision: 0,
        })
      else {
        controller.suspend('conflict')
        await controller.preserveCandidate(stateRef.current.present)
      }
      if (disposed) {
        cleanup()
        return
      }
      setInitialization(loaded.initial)
      setPersistence(controller.snapshot)
      setReady(true)
    }
    void load()
    return () => {
      disposed = true
      cleanup()
    }
  }, [apply, hash])

  useEffect(() => {
    if (ready) void persistenceRef.current?.enqueue(state.present, state.revision ?? 0)
  }, [state.present, state.revision, ready])

  useEffect(() => {
    const flush = () => {
      void persistenceRef.current?.flush()
    }
    const check = () => {
      void persistenceRef.current?.detectStale(stateRef.current.present)
    }
    const storageChanged = (event: StorageEvent) => {
      if (event.key === 'fury-draft-v1') {
        persistenceRef.current?.suspend('conflict')
        void persistenceRef.current?.preserveCandidate(stateRef.current.present)
      }
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('focus', check)
    window.addEventListener('storage', storageChanged)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('focus', check)
      window.removeEventListener('storage', storageChanged)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [])

  const acceptRecovery = useCallback(
    async (candidate?: Config) => {
      const config = candidate ?? stateRef.current.present
      const inspected = inspectDocument(config)
      if (inspected.status !== 'accepted')
        return { ok: false as const, reason: 'corrupt-store' as const }
      const controller = persistenceRef.current
      if (!controller) return { ok: false as const, reason: 'unavailable' as const }
      const baseRevision = stateRef.current.revision ?? 0
      if (!sameConfig(config, stateRef.current.present))
        await controller.preserveCandidate(stateRef.current.present, 'displaced-draft')
      const result = await controller.accept(
        config,
        baseRevision,
        () => stateRef.current.revision === baseRevision,
      )
      if (result.ok && result.value.status === 'saved') {
        if (stateRef.current.revision !== baseRevision) {
          controller.suspend('conflict')
          return { ok: false as const, reason: 'conflict' as const }
        }
        apply({ type: 'set', config })
        setInitialization((previous) => ({
          ...previous,
          config,
          acceptance: 'accepted',
          issues: [],
          writeSafe: true,
          originalPreserved: 'durable',
          storageFailure: undefined,
        }))
      }
      return result
    },
    [apply],
  )
  const resetConfig = useCallback(
    () => acceptRecovery(structuredClone(DEFAULT_CONFIG)),
    [acceptRecovery],
  )
  const flushPersistence = useCallback(
    () => persistenceRef.current?.flush() ?? Promise.resolve(),
    [],
  )
  const inspection = inspectDocument(state.present)
  return {
    config: state.preview?.config ?? state.present,
    committedConfig: state.present,
    revision: state.revision ?? 0,
    isPreviewing: !!state.preview,
    setConfig,
    undo,
    redo,
    beginEdit,
    previewEdit,
    commitEdit,
    cancelEdit,
    canUndo: !!state.past.length,
    canRedo: !!state.future.length,
    initialNotice: state.notice,
    initialization,
    persistence,
    recovery: [
      ...new Map(
        [...initialization.recovery, ...rejectedInputs, ...persistence.recovery].map((entry) => [
          JSON.stringify([entry.record.source, entry.record.format, entry.record.raw]),
          entry,
        ]),
      ).values(),
    ],
    repair: {
      required:
        inspection.status !== 'accepted' ||
        (initialization.acceptance === 'rejected' && !persistence.writeSafe),
      issues: inspection.status !== 'accepted' ? inspection.issues : initialization.issues,
    },
    lastEditResult: state.result,
    acceptRecovery,
    resetConfig,
    flushPersistence,
  }
}
