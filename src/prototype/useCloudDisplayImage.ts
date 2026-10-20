import { useLayoutEffect, useRef, useState } from 'react'
import { serializeDesign, type DesignEnvelope } from '../domain/design'
import type { CloudDisplayReadyReply } from '../display/cloudContract'
import { createCloudDisplaySelectionQueue, type CloudDisplayProgress } from './cloudDisplayClient'

type Snapshot = {
  generation: number
  progress: CloudDisplayProgress
  shown: { key: string; generation: number; reply: CloudDisplayReadyReply; src: string } | null
}

export function useCloudDisplayImage(design: DesignEnvelope) {
  const key = serializeDesign(design)
  const [selection, setSelection] = useState({ key, generation: 0 })
  // Render-time fencing includes A→B→A; a matching design alone is not the active generation.
  if (selection.key !== key) setSelection({ key, generation: selection.generation + 1 })
  const generation = selection.generation
  const activeGeneration = useRef(0)
  const queue = useRef<ReturnType<typeof createCloudDisplaySelectionQueue> | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot>({
    generation: -1,
    progress: { state: 'pending' },
    shown: null,
  })
  useLayoutEffect(() => {
    const currentQueue = createCloudDisplaySelectionQueue()
    queue.current = currentQueue
    return () => {
      activeGeneration.current++
      currentQueue.dispose()
      queue.current = null
    }
  }, [])
  useLayoutEffect(() => {
    const token = ++activeGeneration.current
    queue.current!.select(design, (progress) => {
      if (activeGeneration.current !== token) return
      setSnapshot((previous) => ({
        generation,
        progress,
        shown:
          progress.state === 'ready'
            ? { key, generation, reply: progress.reply, src: progress.src }
            : previous.shown,
      }))
    })
    return () => {
      activeGeneration.current = token + 1
    }
  }, [design, key, generation])
  const progress: CloudDisplayProgress =
    snapshot.generation === generation && selection.key === key
      ? snapshot.progress
      : { state: 'pending' }
  const current =
    snapshot.shown?.key === key &&
    snapshot.shown.generation === generation &&
    progress.state === 'ready'
  // Retain previous receipt for explanation only. Its revoked URL must never be drawn.
  return { progress, shown: snapshot.shown, current, retry: () => undefined }
}
