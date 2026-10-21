import { useEffect, useState } from 'react'
import type { JobSummary, SetSnapshot } from '../render-library/contracts'
import type { SampleProgress } from '../render-library/sampleProgress'
import { readSamples } from './renderLibraryClient'

export function currentSample(
  job: JobSummary | null | undefined,
  views: SetSnapshot['views'],
  sample: SampleProgress | null,
  now = Date.now(),
) {
  if (
    !sample ||
    job?.stage !== 'rendering' ||
    job.id !== sample.jobId ||
    job.currentCamera !== sample.cameraRef ||
    now - Date.parse(sample.observedAt) > 15_000 ||
    Date.parse(sample.observedAt) > now + 3_000 ||
    !views.some(
      (view) =>
        view.cameraRef === sample.cameraRef &&
        view.imageKey === sample.imageKey &&
        view.status === 'pending' &&
        view.stage === 'rendering',
    )
  )
    return null
  return sample
}

export function useSampleProgress(snapshot: SetSnapshot | null) {
  const jobId = snapshot?.job?.stage === 'rendering' ? snapshot.job.id : undefined
  const [value, setValue] = useState<SampleProgress | null>(null)
  useEffect(() => {
    if (!jobId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const sample = document.hidden ? null : await readSamples(jobId, controller.signal)
        if (!controller.signal.aborted) setValue(sample)
      } catch {
        if (!controller.signal.aborted) setValue(null)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2_000)
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [jobId])
  return currentSample(snapshot?.job, snapshot?.views ?? [], value)
}
