import { TEXTURE_SETS, type TextureSet } from './textureSets'

/**
 * The scanned materials' files (public/textures), and their encoded bytes downloaded early: when
 * the visitor shows intent to open the 360° view (src/prototype/liveWarmup.ts), before three.js
 * and the material library have loaded. The library (materials.ts) then decodes those bytes
 * instead of downloading the file again. Free of three.js, so an early download can start at once.
 */

const base = `${import.meta.env.BASE_URL}textures/`

/** A set's maps and where each is: detail-only sets have no albedo. */
export function scanFiles(set: TextureSet) {
  const info = TEXTURE_SETS[set] as { detailOnly?: boolean }
  const names = info.detailOnly
    ? (['normal', 'arm'] as const)
    : (['albedo', 'normal', 'arm'] as const)
  return names.map((name) => ({ name, url: `${base}${set}/${name}.webp` }))
}

/**
 * Scans decode off the main thread where createImageBitmap takes its options (Safari 17+, Firefox
 * 98+, the gate three's GLTFLoader uses). An <img> would instead be decoded synchronously by the
 * first GPU upload, stalling a frame for every arriving map.
 */
export const decodeOffThread = (() => {
  if (typeof createImageBitmap === 'undefined' || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const safari = /^((?!chrome|android).)*safari/i.test(ua)
  const safariVersion = Number(ua.match(/Version\/(\d+)/)?.[1] ?? -1)
  const firefoxVersion = Number(ua.match(/Firefox\/(\d+)\./)?.[1] ?? -1)
  return !(safari && safariVersion < 17) && !(ua.includes('Firefox') && firefoxVersion < 98)
})()

/** Early downloads the library has not taken yet. */
const early = new Map<string, Promise<Blob>>()
/** Files the library has asked for itself: downloading them early again would be for nothing. */
const taken = new Set<string>()

/**
 * Starts downloading scans the page is about to want, at low priority, without decoding them or
 * counting them in the load progress (whose arrivals would also restart a running trace). At most
 * once per file, and not at all where the visitor asked to save data, or where the library loads
 * each scan through an <img> by URL (no bytes to hand it). What is never taken stays for the
 * session, bounded by the library's 41 MB of scans.
 */
export function prefetchEncoded(urls: Iterable<string>) {
  if (!decodeOffThread) return
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection
  if (connection?.saveData) return
  for (const url of urls) {
    if (taken.has(url) || early.has(url)) continue
    // Only this download passes options. The library's own is a bare `fetch(url)`, as the private
    // display and capture realms require; they never download early.
    const download = fetch(url, { priority: 'low' }).then((response) => {
      if (!response.ok) throw new Error(`${response.status} for ${url}`)
      return response.blob()
    })
    // Nothing may ever ask for it; one that fails is downloaded again when the library asks.
    download.catch(() => {})
    early.set(url, download)
  }
}

/**
 * The bytes an early download has (or has on the way) for a file the library now asks for, once:
 * from then on the library downloads that file itself.
 */
export function takePrefetched(url: string): Promise<Blob> | undefined {
  taken.add(url)
  const download = early.get(url)
  early.delete(url)
  return download
}
