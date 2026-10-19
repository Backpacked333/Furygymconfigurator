import { useEffect, useRef, useState } from 'react'
import { parseDesign, type DesignEnvelope } from '../domain/design'
import { identityPayload, computeSetIdentity } from '../render-library/identity'
import { uuidSchema, type SetSnapshot } from '../render-library/contracts'
import { LibraryRequestError, lookupSet, readJob, submitSet } from './renderLibraryClient'

type Pointer = { jobId?: string; joined?: true; uncertain?: string }
const POINTER_KEY = 'fury-render-library-pointers-v1'
function readPointer(key: string): Pointer {
  try {
    const value = JSON.parse(localStorage.getItem(POINTER_KEY) ?? '{}')[key] as Pointer | undefined
    return {
      jobId: uuidSchema.safeParse(value?.jobId).data,
      ...(value?.joined === true ? { joined: true } : {}),
      uncertain: uuidSchema.safeParse(value?.uncertain).data,
    }
  } catch {
    return {}
  }
}
function remember(key: string, pointer: Pointer) {
  try {
    const value = JSON.parse(localStorage.getItem(POINTER_KEY) ?? '{}') as Record<string, Pointer>
    delete value[key]
    const bounded = Object.fromEntries(Object.entries(value).slice(-19))
    localStorage.setItem(POINTER_KEY, JSON.stringify({ ...bounded, [key]: pointer }))
  } catch {
    /* Persistence is a convenience; the database lookup remains authoritative. */
  }
}

export function activeJob(snapshot: SetSnapshot | null) {
  return (
    !!snapshot?.job &&
    ['queued', 'preparing', 'rendering', 'saving', 'verifying', 'dispatch-uncertain'].includes(
      snapshot.job.stage,
    )
  )
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
      signal.removeEventListener('abort', abort)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const visible = () => {
      clearTimeout(timer)
      if (!document.hidden) timer = setTimeout(finish, ms)
    }
    const abort = () => {
      cleanup()
      reject(new DOMException('Superseded', 'AbortError'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    document.addEventListener('visibilitychange', visible)
    visible()
  })
}

export type LibrarySetState = {
  signature: string
  snapshot: SetSnapshot | null
  checking: boolean
  message: string | null
  paused: boolean
  uncertain: boolean
}
const empty = (signature: string): LibrarySetState => ({
  signature,
  snapshot: null,
  checking: true,
  message: null,
  paused: false,
  uncertain: false,
})

export function useLibrarySet(design: DesignEnvelope) {
  const signature = identityPayload(design, 'set')
  const [state, setState] = useState<LibrarySetState>(() => empty(signature))
  const [refreshCount, refresh] = useState(0)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const active = useRef(0)
  const inFlight = useRef(new Set<string>())
  useEffect(() => {
    let lastRefresh = -Infinity
    const reconnect = () => {
      if (document.hidden || Date.now() - lastRefresh < 1_000) return
      lastRefresh = Date.now()
      refresh((value) => value + 1)
    }
    window.addEventListener('online', reconnect)
    window.addEventListener('focus', reconnect)
    document.addEventListener('visibilitychange', reconnect)
    return () => {
      window.removeEventListener('online', reconnect)
      window.removeEventListener('focus', reconnect)
      document.removeEventListener('visibilitychange', reconnect)
    }
  }, [])
  useEffect(() => {
    const token = ++active.current
    const controller = new AbortController()
    // Camera is deliberately absent from the set key. Camera changes do not restart polling.
    const requestDesign = parseDesign({
      ...(JSON.parse(signature) as { design: object }).design,
      presentation: {
        ...(JSON.parse(signature) as { design: DesignEnvelope }).design.presentation,
        cameraRef: 'front-left-draft@1',
      },
    })
    const update = (patch: Partial<LibrarySetState>) => {
      if (active.current === token && !controller.signal.aborted)
        setState((previous) => ({
          ...(previous.signature === signature ? previous : empty(signature)),
          ...patch,
        }))
    }
    setState((previous) =>
      previous.signature === signature
        ? { ...previous, checking: true, paused: false }
        : empty(signature),
    )
    void (async () => {
      const identity = await computeSetIdentity(requestDesign)
      const pointer = readPointer(identity.setKey)
      let memberJobId = pointer.joined ? pointer.jobId : undefined
      update({ uncertain: !!pointer.uncertain })
      const read = async () => {
        if (memberJobId) {
          try {
            return await readJob(memberJobId, requestDesign, controller.signal)
          } catch {
            controller.signal.throwIfAborted()
            memberJobId = undefined
          }
        }
        return lookupSet(requestDesign, controller.signal)
      }
      let snapshot: SetSnapshot
      for (let failures = 0; ; failures++) {
        try {
          snapshot = await read()
          break
        } catch (error) {
          controller.signal.throwIfAborted()
          if (failures >= 2) throw error
          update({
            message: 'Reconnecting to the image library. No new render is being requested.',
          })
          await pause(1_000 * 2 ** failures, controller.signal)
        }
      }
      const apply = (next: SetSnapshot) => {
        const resolved =
          next.coverage === 'complete' ||
          (!!next.job && (next.job.id !== pointer.jobId || activeJob(next)))
        if (resolved) delete pointer.uncertain
        const uncertain = !!pointer.uncertain
        if (next.job)
          remember(identity.setKey, {
            jobId: next.job.id,
            ...(memberJobId === next.job.id ? { joined: true } : {}),
            ...(uncertain ? { uncertain: pointer.uncertain } : {}),
          })
        update({ snapshot: next, checking: false, message: null, uncertain })
      }
      apply(snapshot)
      let failures = 0
      for (let attempt = 0; activeJob(snapshot) && attempt < 1200; attempt++) {
        await pause(failures ? Math.min(30_000, 2_000 * 2 ** failures) : 2_000, controller.signal)
        try {
          if (memberJobId === snapshot.job!.id) {
            try {
              snapshot = await readJob(memberJobId, requestDesign, controller.signal)
            } catch {
              controller.signal.throwIfAborted()
              memberJobId = undefined
              snapshot = await lookupSet(requestDesign, controller.signal)
            }
          } else snapshot = await lookupSet(requestDesign, controller.signal)
          failures = 0
          apply(snapshot)
        } catch {
          controller.signal.throwIfAborted()
          failures++
          update({
            message:
              'Connection interrupted. Completed images remain available; checking status again.',
          })
          if (failures >= 5) break
        }
      }
      if (activeJob(snapshot))
        update({
          paused: true,
          message:
            'Automatic status checks paused. Check status to reconnect; this never starts another render.',
        })
    })().catch(() =>
      update({
        checking: false,
        paused: true,
        message:
          'Could not check the image library. Existing images remain available. This status check did not request a new render.',
      }),
    )
    return () => {
      active.current = token + 1
      controller.abort()
    }
  }, [signature, refreshCount])

  const current = state.signature === signature ? state : empty(signature)
  const request = async () => {
    const snapshot = current.snapshot
    if (
      !snapshot ||
      current.checking ||
      current.paused ||
      current.uncertain ||
      inFlight.current.has(signature) ||
      snapshot.rendering.status !== 'enabled' ||
      snapshot.coverage === 'complete' ||
      activeJob(snapshot)
    )
      return
    if (snapshot.job && !(snapshot.job.stage === 'failed' && snapshot.job.retrySafe)) return
    const token = active.current
    const key = snapshot.identity.setKey
    // Unknown delivery is never permission to mint a fresh billable request, even after reload.
    if (readPointer(key).uncertain) return
    const idempotencyKey = crypto.randomUUID()
    inFlight.current.add(signature)
    setSubmitting(signature)
    remember(key, { jobId: snapshot.job?.id, uncertain: idempotencyKey })
    try {
      const next = await submitSet(
        design,
        idempotencyKey,
        new AbortController().signal,
        snapshot.job?.id,
      )
      remember(key, { jobId: next.job?.id, ...(next.job ? { joined: true } : {}) })
      if (active.current === token) {
        setState({
          signature,
          snapshot: next,
          checking: false,
          message: null,
          paused: false,
          uncertain: false,
        })
        refresh((value) => value + 1)
      }
    } catch (error) {
      const known = error instanceof LibraryRequestError && error.code !== 'dispatch-uncertain'
      if (known) remember(key, { jobId: snapshot.job?.id })
      if (active.current === token)
        setState((previous) => ({
          ...previous,
          uncertain: !known,
          message: known
            ? error.message
            : 'Request delivery is unconfirmed. Check status before doing anything else; no automatic resubmission will occur.',
        }))
    } finally {
      inFlight.current.delete(signature)
      setSubmitting((previous) => (previous === signature ? null : previous))
    }
  }
  return {
    ...current,
    submitting: submitting === signature,
    request,
    refresh: () => refresh((value) => value + 1),
  }
}
