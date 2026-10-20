import { useLayoutEffect, useRef, useState } from 'react'
import { serializeDesign, type DesignEnvelope } from '../domain/design'
import type { LocalRenderReadyReply } from '../image-service/localRenderProtocol'
import { startLocalRenderRequest, type LocalRenderProgress } from './localRenderClient'

type Snapshot = {
  generation: number
  progress: LocalRenderProgress
  shown: { key: string; reply: LocalRenderReadyReply; src: string } | null
}

export function useLocalRenderImage(design: DesignEnvelope) {
  const key = serializeDesign(design)
  const [selection, setSelection] = useState({ key, generation: 0 })
  // Invalidate during render, not after an async effect. Key equality alone fails A→B→A.
  if (selection.key !== key) setSelection({ key, generation: selection.generation + 1 })
  const generation = selection.generation
  const activeGeneration = useRef(0)
  const [snapshot, setSnapshot] = useState<Snapshot>({
    generation: -1,
    progress: { state: 'pending' },
    shown: null,
  })
  useLayoutEffect(() => {
    const token = ++activeGeneration.current
    const stop = startLocalRenderRequest(design, (progress) => {
      if (activeGeneration.current !== token) return
      setSnapshot((previous) => ({
        generation,
        progress,
        shown:
          progress.state === 'ready'
            ? { key, reply: progress.reply, src: progress.src }
            : previous.shown,
      }))
    })
    return () => {
      activeGeneration.current = token + 1
      stop()
    }
  }, [design, key, generation])
  const progress: LocalRenderProgress =
    snapshot.generation === generation && selection.key === key
      ? snapshot.progress
      : { state: 'pending' }
  const current = snapshot.shown?.key === key && progress.state === 'ready'
  // Previous provenance is retained for explanation only. Its revoked URL is NEVER presented.
  // All protocol errors are retryable:false: an uncertain capture requires operator review.
  return { progress, shown: snapshot.shown, current, retry: () => undefined }
}
