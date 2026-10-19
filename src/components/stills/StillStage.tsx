import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AngleId } from '../../lib/cameras'
import type { Config } from '../../lib/config'
import {
  avifSupport,
  decodeImage,
  prefetchAround,
  stageWidth,
  stillUrls,
} from '../../lib/stillImages'
import { layersFor } from '../../lib/stills'

type Shown = { id: string; urls: string[] }

/**
 * The hero still: pre-rendered layers stacked as plain images. A new still replaces the old one
 * only after every layer has decoded, then fades in over it, so the stage never shows a blank or
 * half-loaded frame however quickly options change.
 */
export function StillStage({
  config,
  angle,
  label,
  onMissing,
  onShown,
}: {
  config: Config
  angle: AngleId
  label: string
  /** A layer could not be loaded twice: the live view takes over this still. */
  onMissing: () => void
  /** A still is on screen: a good moment for background work. */
  onShown?: () => void
}) {
  const stage = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>(() => stageWidth())
  const [stills, setStills] = useState<Shown[]>([])
  const [slow, setSlow] = useState(false)
  // Layer keys change only when something visible changes; anything else keeps the still.
  const id = `${layersFor(config, angle)
    .map((l) => l.key)
    .join('+')}@${width}`
  const latest = useRef(config)
  latest.current = config

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth((current) => Math.max(current, stageWidth(entry.contentRect.width))),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => setSlow(true), 150)
    const load = async () => {
      await avifSupport
      const urls = stillUrls(latest.current, angle, width)
      const attempt = () => Promise.all(urls.map((url) => decodeImage(url)))
      try {
        await attempt().catch(attempt)
      } catch {
        if (!cancelled) onMissing()
        return
      }
      if (cancelled) return
      setStills((current) =>
        current.at(-1)?.id === id ? current : [...current.slice(-1), { id, urls }],
      )
      prefetchAround(latest.current, angle)
      onShown?.()
    }
    load().finally(() => {
      clearTimeout(timer)
      if (!cancelled) setSlow(false)
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [id, angle, width, onMissing, onShown])

  return (
    <div className="still-stage" ref={stage} role="img" aria-label={label}>
      {stills.map((still, i) => (
        <div
          key={still.id}
          className={`still ${i === stills.length - 1 && stills.length > 1 ? 'is-entering' : ''}`}
          onAnimationEnd={() => setStills((current) => current.slice(-1))}
        >
          {still.urls.map((url) => (
            <img key={url} src={url} alt="" draggable={false} />
          ))}
        </div>
      ))}
      {slow && <span className="still-loading" aria-hidden="true" />}
    </div>
  )
}
