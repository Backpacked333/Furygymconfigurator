import { useLayoutEffect, useState } from 'react'
import { serializeDesign, type DesignEnvelope } from '../domain/design'
import type { ImageReadyReply } from '../image-service/protocol'
import { startImageRequest, type ImageProgress } from './imageClient'

type ImageSnapshot = {
  key: string
  progress: ImageProgress
  shown: { key: string; reply: ImageReadyReply } | null
}
export function usePrototypeImage(design: DesignEnvelope) {
  const [attempt, setAttempt] = useState(0)
  const key = serializeDesign(design)
  const [snapshot, setSnapshot] = useState<ImageSnapshot>({
    key,
    progress: { state: 'pending' },
    shown: null,
  })
  // Cleanup before paint closes the previous revision. Async identity/decode may finish later,
  // but startImageRequest's active guard prevents it from committing after cleanup/unmount.
  useLayoutEffect(
    () =>
      startImageRequest(design, (progress) => {
        setSnapshot((previous) => ({
          key,
          progress,
          shown: progress.state === 'ready' ? { key, reply: progress.reply } : previous.shown,
        }))
      }),
    [design, key, attempt],
  )
  const progress: ImageProgress = snapshot.key === key ? snapshot.progress : { state: 'pending' }
  const current = snapshot.shown?.key === key && progress.state === 'ready'
  return { progress, shown: snapshot.shown, current, retry: () => setAttempt((value) => value + 1) }
}
