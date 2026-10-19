import { useEffect, useState, type KeyboardEvent } from 'react'
import { ANGLES, CAMERA_PRESETS, type AngleId } from '../../lib/cameras'
import type { Config } from '../../lib/config'
import { avifSupport, stillUrls } from '../../lib/stillImages'

/**
 * The seven angles. With published stills each button is a thumbnail of that angle for the
 * current configuration; otherwise a label. Arrow keys move between angles.
 */
export function AngleStrip({
  config,
  angle,
  thumbnails,
  onChange,
}: {
  config: Config
  angle: AngleId
  thumbnails: boolean
  onChange: (angle: AngleId) => void
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    avifSupport.then(() => setReady(true))
  }, [])
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const index = ANGLES.indexOf(angle) + (e.key === 'ArrowRight' ? 1 : -1)
    const next = ANGLES[(index + ANGLES.length) % ANGLES.length]
    onChange(next)
    document.getElementById(`angle-${next}`)?.focus()
  }
  return (
    <div
      className={`angle-strip ${thumbnails ? 'with-thumbnails' : ''}`}
      role="tablist"
      aria-label="Views"
    >
      {ANGLES.map((id) => {
        const preset = CAMERA_PRESETS[id]
        const selected = id === angle
        return (
          <button
            key={id}
            id={`angle-${id}`}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`${selected ? 'selected' : ''} ${preset.view === 'interior' && id === 'interiorHero' ? 'first-interior' : ''}`}
            onClick={() => onChange(id)}
            onKeyDown={key}
          >
            {thumbnails && ready && (
              <span className="angle-thumb" aria-hidden="true">
                {stillUrls(config, id, 640).map((url) => (
                  <img
                    key={url}
                    src={url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                  />
                ))}
              </span>
            )}
            <span className="angle-label">{preset.label}</span>
          </button>
        )
      })}
    </div>
  )
}
