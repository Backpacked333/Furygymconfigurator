import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { Config } from '../lib/config'
import type { StillProgress } from '../render/stillStatus'
import { describeWork } from '../render/workProgress'
import { LoadingExperience } from './LoadingExperience'

/** Instant cached swaps never mount an animation or announce a wait. */
export const PILL_DELAY_MS = 350
export const DONE_MS = 1600
export const LONG_WAIT_MS = 30_000

type Phase = 'hidden' | 'rendering' | 'done'

export function RenderStatus({
  pending,
  swaps,
  what,
  progress,
  config,
  requestKey = what,
  newCombination = false,
  decoding = false,
  unavailable = false,
  onRetry,
  onPlan,
}: {
  pending: boolean
  swaps: number
  what: string
  progress: StillProgress | null
  config?: Config
  requestKey?: string
  newCombination?: boolean
  decoding?: boolean
  unavailable?: boolean
  onRetry?: () => void
  onPlan?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [longWait, setLongWait] = useState(false)
  const swapsRef = useRef(swaps)
  swapsRef.current = swaps
  const swapsAt = useRef(swaps)

  useEffect(() => {
    setLongWait(false)
    if (pending) {
      setPhase('hidden')
      swapsAt.current = swapsRef.current
      const timer = setTimeout(() => setPhase('rendering'), PILL_DELAY_MS)
      const longer = setTimeout(() => setLongWait(true), LONG_WAIT_MS)
      return () => {
        clearTimeout(timer)
        clearTimeout(longer)
      }
    }
    const swapped = swapsRef.current !== swapsAt.current
    setPhase((current) =>
      current === 'rendering' && swapped ? 'done' : current === 'done' ? 'done' : 'hidden',
    )
  }, [pending, requestKey])

  useEffect(() => {
    if (phase !== 'done') return
    const timer = setTimeout(() => setPhase('hidden'), DONE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  const work = decoding
    ? { label: 'Preparing your image for display' }
    : progress?.kind === 'measured'
      ? progress.fraction >= 1
        ? { label: 'Finishing your rendered image' }
        : { label: 'Rendering on this device · samples completed', fraction: progress.fraction }
      : progress?.kind === 'stage'
        ? describeWork(progress)
        : { label: 'Preparing your view' }
  const showing = pending && phase === 'rendering'
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {!pending && phase === 'done' ? 'Your view is ready' : ''}
      </div>
      {showing && (
        <div
          className={`render-wait${newCombination && !unavailable ? ' is-new-combination' : ''}`}
          data-phase="rendering"
        >
          <LoadingExperience
            config={config}
            compact
            failed={unavailable}
            title={
              unavailable
                ? 'Your design is still here.'
                : newCombination
                  ? 'You’ve got taste.'
                  : `Preparing ${what}`
            }
            description={
              unavailable
                ? 'We couldn’t finish this view. Your choices are safe; you can retry or keep working on the floor plan.'
                : newCombination
                  ? 'This view isn’t ready yet. Give us a few moments to bring your vision to life.'
                  : 'Keep exploring. Your finished view will appear here when it’s ready.'
            }
            {...(unavailable ? { label: 'Finished image unavailable' } : work)}
          >
            {longWait && !unavailable && (
              <p className="loading-note">
                This is taking longer than usual. Your design is safe, and you can keep configuring.
              </p>
            )}
            {(unavailable || longWait) && (onRetry || onPlan) && (
              <div className="loading-actions">
                {onRetry && (
                  <button type="button" onClick={onRetry}>
                    Retry view
                  </button>
                )}
                {onPlan && (
                  <button type="button" onClick={onPlan}>
                    Open floor plan
                  </button>
                )}
              </div>
            )}
          </LoadingExperience>
        </div>
      )}
      <div
        className={`render-pill is-${!pending && phase === 'done' ? 'done' : 'hidden'}`}
        aria-hidden="true"
        data-phase={!pending ? phase : showing ? 'rendering' : 'hidden'}
      >
        <Check size={13} /> Your view is ready
      </div>
    </>
  )
}
