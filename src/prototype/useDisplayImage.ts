import { useLayoutEffect, useRef, useState } from 'react'
import { serializeDesign, type DesignEnvelope } from '../domain/design'
import type { DisplayReadyReply } from '../display/contract'
import { createDisplaySelectionQueue, type DisplayProgress } from './displayClient'

type Snapshot = {
  generation: number
  progress: DisplayProgress
  shown: { key: string; generation: number; reply: DisplayReadyReply; src: string } | null
}

export function useDisplayImage(design: DesignEnvelope) {
  const key = serializeDesign(design)
  const [selection, setSelection] = useState({ key, generation: 0 })
  // Invalidate synchronously during render, including A→B→A, before the new effect can run.
  if (selection.key !== key) setSelection({ key, generation: selection.generation + 1 })
  const generation = selection.generation
  const activeGeneration = useRef(0)
  const queue = useRef<ReturnType<typeof createDisplaySelectionQueue> | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot>({
    generation: -1,
    progress: { state: 'pending' },
    shown: null,
  })
  useLayoutEffect(() => {
    const currentQueue = createDisplaySelectionQueue()
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
  const progress: DisplayProgress =
    snapshot.generation === generation && selection.key === key
      ? snapshot.progress
      : { state: 'pending' }
  const current =
    snapshot.shown?.key === key &&
    snapshot.shown.generation === generation &&
    progress.state === 'ready'
  // Previous provenance survives for explanation ONLY: its revoked object URL must not be drawn.
  // Failure is never permission to retry uncertain work, spawn a renderer or substitute images.
  return { progress, shown: snapshot.shown, current, retry: () => undefined }
}
