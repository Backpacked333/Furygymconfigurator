import { useSyncExternalStore } from 'react'
import { ANGLES, STILL_WIDTHS, type AngleId } from './cameras'
import type { Config } from './config'
import { STILLS_BASE, layerUrl, readyPath, type StillFormat } from './renderKey'
import { layersFor, type LayerKind } from './stills'

/**
 * Pre-rendered stills in the browser: whether they are published, which files make a still, and
 * a low-priority prefetch queue. Free of three.js, so the stills appear before any 3D code loads.
 */

/** 'checking' until the ready marker answers; 'live' when stills are drawn by the 3D view. */
export type StillsMode = 'checking' | 'published' | 'live'

let mode: StillsMode = STILLS_BASE ? 'checking' : 'live'
const listeners = new Set<() => void>()
let checked = false

/** Looks for the batch's ready marker once. Any failure means the 3D view draws stills. */
function checkPublished() {
  if (checked || mode !== 'checking') return
  checked = true
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 4000)
  fetch(`${STILLS_BASE}/${readyPath()}`, { signal: timeout.signal, cache: 'no-cache' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((marker) => {
      clearTimeout(timer)
      mode = marker ? 'published' : 'live'
      listeners.forEach((listener) => listener())
    })
}

export function useStillsMode(): StillsMode {
  checkPublished()
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => mode,
  )
}

/** Falls back to WebP where AVIF does not decode (older Safari and Edge). */
let format: StillFormat = 'webp'
export const avifSupport =
  typeof Image === 'undefined'
    ? Promise.resolve(false)
    : new Promise<boolean>((resolve) => {
        const probe = new Image()
        probe.onload = () => resolve(probe.width > 0)
        probe.onerror = () => resolve(false)
        probe.src =
          'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A='
      }).then((ok) => {
        if (ok) format = 'avif'
        return ok
      })

export type StillLayerSource = { key: string; kind: LayerKind; srcSet: string; src: string }

/** The image layers of a still, bottom first, as `srcset`s over the published widths. */
export function stillSources(config: Config, angle: AngleId): StillLayerSource[] {
  return layersFor(config, angle).map(({ key, kind }) => ({
    key,
    kind,
    srcSet: STILL_WIDTHS.map((w) => `${layerUrl(key, w, format)} ${w}w`).join(', '),
    src: layerUrl(key, 1024, format),
  }))
}

/** One URL per layer at a given width, for thumbnails and prefetching. */
export function stillUrls(config: Config, angle: AngleId, width: number) {
  return layersFor(config, angle).map(({ key }) => layerUrl(key, width, format))
}

/**
 * The width the browser will pick from a srcset for the stage: the stage's device-pixel width,
 * rounded up to a published width.
 */
export function stageWidth(cssWidth = window.innerWidth) {
  const needed = cssWidth * Math.min(2, window.devicePixelRatio || 1)
  return STILL_WIDTHS.find((w) => w >= needed) ?? STILL_WIDTHS[STILL_WIDTHS.length - 1]
}

const decoded = new Map<string, Promise<void>>()
/** Downloads and decodes an image once; resolves when it can be shown without a blank frame. */
export function decodeImage(url: string, priority: 'high' | 'low' = 'high'): Promise<void> {
  let pending = decoded.get(url)
  if (!pending) {
    const image = new Image()
    image.decoding = 'async'
    image.fetchPriority = priority
    image.src = url
    pending = image.decode()
    pending.catch(() => decoded.delete(url))
    decoded.set(url, pending)
  }
  return pending
}

/**
 * Background downloads, two at a time and lowest priority, restarted whenever the configuration
 * changes, so they never compete with the still on screen.
 */
let queue: string[] = []
let running = 0
function pump() {
  while (running < 2 && queue.length) {
    const url = queue.shift()!
    running++
    decodeImage(url, 'low')
      .catch(() => {})
      .finally(() => {
        running--
        pump()
      })
  }
}
export function prefetch(urls: string[], replace = false) {
  queue = replace ? [...urls] : [...queue, ...urls.filter((u) => !queue.includes(u))]
  pump()
}

/**
 * After the shown still decodes: its neighbors in the angle strip, the other lighting, every
 * thumbnail, then the remaining angles, so browsing the strip and Day/Night are instant.
 */
export function prefetchAround(config: Config, angle: AngleId) {
  const width = stageWidth()
  const index = ANGLES.indexOf(angle)
  const neighbors = [ANGLES[(index + 1) % ANGLES.length], ANGLES.at(index - 1)!]
  const other: Config = { ...config, lighting: config.lighting === 'day' ? 'night' : 'day' }
  prefetch(
    [
      ...neighbors.flatMap((a) => stillUrls(config, a, width)),
      ...(config.environment === 'studio' ? [] : stillUrls(other, angle, width)),
      ...ANGLES.flatMap((a) => stillUrls(config, a, 640)),
      ...ANGLES.flatMap((a) => stillUrls(config, a, width)),
    ],
    true,
  )
}

/** Hovering an option fetches what choosing it would show. */
export function prefetchChoice(config: Config, angle: AngleId) {
  if (mode !== 'published') return
  const urls = stillUrls(config, angle, stageWidth())
  queue = [...urls.filter((u) => !queue.includes(u)), ...queue]
  pump()
}

/** The still flattened into one PNG at full size, for downloads and the PDF brief. */
export async function stillImage(config: Config, angle: AngleId): Promise<string | null> {
  try {
    const urls = stillUrls(config, angle, 2048)
    const images = await Promise.all(
      urls.map(async (url) => {
        const image = new Image()
        image.crossOrigin = 'anonymous'
        image.src = url
        await image.decode()
        return image
      }),
    )
    const canvas = document.createElement('canvas')
    canvas.width = images[0].naturalWidth
    canvas.height = images[0].naturalHeight
    const context = canvas.getContext('2d')!
    for (const image of images) context.drawImage(image, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** Head start for the first still: preload it before React mounts. */
export function preloadHero(config: Config) {
  if (!STILLS_BASE || typeof document === 'undefined') return
  checkPublished()
  // The format probe decodes a tiny inline image: a few milliseconds, never a request.
  avifSupport.then(() => {
    for (const { srcSet } of stillSources(config, 'hero')) {
      const link = document.createElement('link')
      link.rel = 'preload'
      link.as = 'image'
      link.setAttribute('imagesrcset', srcSet)
      link.setAttribute('imagesizes', '100vw')
      link.setAttribute('fetchpriority', 'high')
      document.head.appendChild(link)
    }
  })
}
