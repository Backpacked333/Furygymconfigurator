/**
 * Content keys for pre-rendered still layers. A key hashes exactly the inputs a layer can show,
 * plus the renderer and scene version, so equal keys always mean equal pictures and any visual
 * change to the scene produces new keys instead of stale images.
 */

/** Which renderer drew the stills. A different renderer gets its own keys and its own folder. */
export const RENDERER_ID = 'webgpu-three-r186'
/**
 * Bump on any change to how the scene looks (geometry, materials, lighting, post-processing,
 * textures). CI's scene-version guard fails when render code changes without a bump.
 */
export const SCENE_VERSION = 1

/** JSON with object keys sorted at every level, so key order never changes a hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/**
 * A 128-bit non-cryptographic hash (four interleaved 32-bit lanes, MurmurHash3-style mixing),
 * as 32 hex characters. Synchronous and identical in browsers and Node, so the page can name a
 * still's URL in the same frame a choice changes.
 */
export function hash128(input: string): string {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('')
}

export function renderKey(fields: Record<string, unknown>, renderer = RENDERER_ID): string {
  return hash128(canonicalJson({ ...fields, renderer, scene: SCENE_VERSION }))
}

export type StillFormat = 'avif' | 'webp'

/** Where stills are published, e.g. https://stills.example.com. Unset: no published stills. */
export const STILLS_BASE: string = (import.meta.env?.VITE_STILLS_BASE ?? '').replace(/\/$/, '')

/** The published path of one layer at one width, relative to the stills base. */
export function layerPath(key: string, width: number, format: StillFormat, renderer = RENDERER_ID) {
  return `${renderer}/${key.slice(0, 2)}/${key}/${width}.${format}`
}

export function layerUrl(key: string, width: number, format: StillFormat) {
  return `${STILLS_BASE}/${layerPath(key, width, format)}`
}
