import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { continuedProgress, estimatedProgress, secondsLeft } from '../render/progress'
import type { StillProgress } from '../render/stillStatus'
import { useReducedMotion } from './useStillStage'

/** A still that comes this quickly (a cached design) swaps in with no status at all. */
export const PILL_DELAY_MS = 350
/** How long "Updated" stays before it fades. */
export const DONE_MS = 1600
/** The wait assumed before the 3D view has said how long the still will take. */
const DEFAULT_EXPECTED_MS = 8000

type Phase = 'hidden' | 'rendering' | 'done'

/**
 * The stage's status while a still is on its way: a glass pill ("Rendering Graphite · about 4 s")
 * with a hairline ring running round it, and a 2 px line along the stage's bottom edge that fills
 * as the still renders. When the still swaps in, the pill says "Updated" and fades. Screen readers
 * hear the start and the end, not every second; with reduced motion the ring stands still.
 */
export function RenderStatus({
  pending,
  swaps,
  what,
  progress,
}: {
  /** The stage waits for a still of what the visitor chose. */
  pending: boolean
  /** Stills swapped onto the stage so far: "Updated" only when the wait ended with one. */
  swaps: number
  /** What changed, as the status line names it ("Graphite", "the rear view"). */
  what: string
  progress: StillProgress | null
}) {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [seconds, setSeconds] = useState<number | null>(null)
  const since = useRef(0)
  const line = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  const progressRef = useRef(progress)
  progressRef.current = progress
  const swapsRef = useRef(swaps)
  swapsRef.current = swaps
  /** The swap count when the pill appeared. */
  const swapsAt = useRef(swaps)

  useEffect(() => {
    if (pending) {
      const timer = setTimeout(() => {
        since.current = performance.now()
        swapsAt.current = swapsRef.current
        setPhase('rendering')
      }, PILL_DELAY_MS)
      return () => clearTimeout(timer)
    }
    // A wait that ended without a still (the renderer gave up) says nothing it did not do.
    const swapped = swapsRef.current !== swapsAt.current
    setPhase((current) =>
      current === 'rendering' && swapped ? 'done' : current === 'done' ? 'done' : 'hidden',
    )
  }, [pending])

  useEffect(() => {
    if (phase !== 'done') return
    const timer = setTimeout(() => setPhase('hidden'), DONE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  // The line and the seconds follow the estimate frame by frame; the text changes once a second.
  useEffect(() => {
    if (phase !== 'rendering') {
      if (line.current) line.current.style.transform = `scaleX(${phase === 'done' ? 1 : 0})`
      return
    }
    let frame = 0
    // The estimate in use, and where the line stood when it was taken up: a revised estimate
    // (the request went out behind another still) carries the line on from there, never back.
    let basis = {
      startedAt: since.current,
      expectedMs: DEFAULT_EXPECTED_MS,
      at: since.current,
      from: 0,
    }
    let shown = 0
    const tick = () => {
      const now = performance.now()
      const p = progressRef.current
      let fraction: number
      let left: number | null
      if (p?.kind === 'measured') {
        fraction = p.fraction
        left = p.remainingMs === null ? null : Math.max(1, Math.ceil(p.remainingMs / 1000))
      } else {
        const startedAt = p ? p.startedAt : since.current
        const expectedMs = p ? p.expectedMs : DEFAULT_EXPECTED_MS
        if (startedAt !== basis.startedAt || expectedMs !== basis.expectedMs)
          basis = { startedAt, expectedMs, at: now, from: shown }
        fraction =
          basis.from > 0
            ? continuedProgress(basis.from, now - basis.at, expectedMs - (basis.at - startedAt))
            : estimatedProgress(now - startedAt, expectedMs)
        left = secondsLeft(now - startedAt, expectedMs)
      }
      shown = Math.max(shown, fraction)
      fraction = shown
      if (line.current) line.current.style.transform = `scaleX(${fraction.toFixed(4)})`
      setSeconds(left)
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [phase])

  const announce = phase === 'rendering' ? `Rendering ${what}` : phase === 'done' ? 'Updated' : ''
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      <div
        className={`render-pill is-${phase}${reduced ? ' is-still' : ''}`}
        aria-hidden="true"
        data-phase={phase}
      >
        <span className="pill-mark">{phase === 'done' ? <Check size={13} /> : <i />}</span>
        <span className="pill-text">
          {phase === 'done' ? (
            'Updated'
          ) : (
            <>
              Rendering {what}
              <span className="pill-time">
                {' · '}
                {seconds === null ? 'almost there' : `about ${seconds} s`}
              </span>
            </>
          )}
        </span>
      </div>
      <div className={`render-line is-${phase}`} aria-hidden="true">
        <span ref={line} />
      </div>
    </>
  )
}
