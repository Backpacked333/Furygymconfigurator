import { useEffect, useState, type ReactNode } from 'react'
import type { Config } from '../lib/config'
import { buildAnimation } from '../lib/buildAnimation'

/** Decorative only: the animation's construction sequence is not render progress. */
export function BuildAnimation({ config, still = false }: { config?: Config; still?: boolean }) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const update = () => setPaused(document.hidden)
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return (
    <div className="build-animation" aria-hidden="true">
      {!paused && (
        <iframe
          src={`${import.meta.env.BASE_URL}builds/${buildAnimation(config)}.html?theme=light&site=0&interactive=0${still ? '&still=1' : ''}`}
          title="Illustrative Fury gym assembly"
          tabIndex={-1}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  )
}

export function WorkProgress({ label, fraction }: { label: string; fraction?: number }) {
  const percent =
    fraction === undefined || !Number.isFinite(fraction)
      ? undefined
      : Math.floor(Math.max(0, Math.min(1, fraction)) * 100)
  return (
    <div className="work-progress">
      <div className="work-progress-label">
        <span>{label}</span>
        {percent !== undefined && <span aria-hidden="true">{percent}%</span>}
      </div>
      <div
        className={`work-progress-track${percent === undefined ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={percent === undefined ? label : `${label}: ${percent}%`}
      >
        <span
          style={percent === undefined ? undefined : { transform: `scaleX(${percent / 100})` }}
        />
      </div>
    </div>
  )
}

export function LoadingExperience({
  config,
  title,
  description,
  label,
  fraction,
  compact = false,
  failed = false,
  children,
}: {
  config?: Config
  title: string
  description?: string
  label: string
  fraction?: number
  compact?: boolean
  failed?: boolean
  children?: ReactNode
}) {
  return (
    <section className={`loading-experience${compact ? ' is-compact' : ''}`} aria-label={title}>
      <BuildAnimation config={config} still={failed} />
      <div className="loading-experience-content">
        <p className="loading-eyebrow">FURY · MADE FOR YOU</p>
        <h2>{title}</h2>
        {description && <p className="loading-description">{description}</p>}
        <p className="sr-only" role={failed ? 'alert' : 'status'}>
          {title}. {label}
        </p>
        {failed ? (
          <p className="loading-note">{label}</p>
        ) : (
          <WorkProgress label={label} fraction={fraction} />
        )}
        {children}
      </div>
    </section>
  )
}
