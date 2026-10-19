import { useEffect, useState, type RefObject } from 'react'

/** The largest box of `ratio` that fits the existing frame; CSS sizes it until measured. */
export function useFitBox(frame: RefObject<HTMLDivElement | null>, ratio: number) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const fit = () => {
      const style = getComputedStyle(element)
      const width =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const height =
        element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      if (!(width > 0 && height > 0)) return
      const w = Math.floor(Math.min(width, height * ratio))
      const next = { width: w, height: Math.round(w / ratio) }
      setSize((current) =>
        current?.width === next.width && current.height === next.height ? current : next,
      )
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame, ratio])
  return size
}

/** Null where full screen is unsupported: never expose a button that cannot work. */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const change = () => setOn(!!target.current && document.fullscreenElement === target.current)
    document.addEventListener('fullscreenchange', change)
    return () => document.removeEventListener('fullscreenchange', change)
  }, [target])
  return document.fullscreenEnabled ? on : null
}

export function toggleFullscreen(target: HTMLElement | null) {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void target?.requestFullscreen().catch(() => {})
}
