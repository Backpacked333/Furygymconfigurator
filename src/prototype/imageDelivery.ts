import { MAX_IMAGE_BYTES } from '../render-library/contracts'
import { sha256Hex } from '../render-library/identity'

export async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Response exceeds the byte limit.')
  }
  if (!response.body) throw new Error('Response has no body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('Response exceeds the byte limit.')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

type StoredImage = { src: string; users: number; bytes: number }
const cache = new Map<string, StoredImage>()
const MAX_CACHED_IMAGES = 8
export type DeliveredImage = { src: string; release: () => void }

function acquire(key: string, image: StoredImage): DeliveredImage {
  image.users++
  cache.delete(key)
  cache.set(key, image)
  let released = false
  return {
    src: image.src,
    release: () => {
      if (!released) image.users--
      released = true
      if (image.users === 0 && cache.get(key) === image) {
        cache.delete(key)
        URL.revokeObjectURL(image.src)
      }
    },
  }
}

function decode(src: string, signal: AbortSignal) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    const abort = () => {
      image.src = ''
      reject(new DOMException('Image delivery interrupted', 'AbortError'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    image.src = src
    void image
      .decode()
      .then(() => resolve({ width: image.naturalWidth, height: image.naturalHeight }), reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Only validated bytes get a display URL. Cache entries in use cannot be evicted. */
export async function deliverImage(
  image: { url: string; sha256: string; bytes: number; width: number; height: number },
  signal: AbortSignal,
): Promise<DeliveredImage> {
  signal.throwIfAborted()
  const key = `${image.sha256}:${image.bytes}:${image.width}:${image.height}`
  const hit = cache.get(key)
  if (hit) return acquire(key, hit)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 20_000)
  let src: string | undefined
  try {
    if (image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES) throw new Error('Invalid image size.')
    const response = await fetch(image.url, {
      signal: controller.signal,
      cache: 'force-cache',
      credentials: 'same-origin',
      redirect: 'error',
    })
    if (!response.ok) throw new Error('The selected image could not be loaded.')
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/webp')
      throw new Error('The image response has the wrong media type.')
    const bytes = await readBounded(response, image.bytes)
    if (
      new TextDecoder().decode(bytes.slice(0, 4)) !== 'RIFF' ||
      new TextDecoder().decode(bytes.slice(8, 12)) !== 'WEBP'
    )
      throw new Error('The image response is not WebP.')
    if (bytes.length !== image.bytes || (await sha256Hex(bytes)) !== image.sha256)
      throw new Error('Image verification failed. No substitute image was displayed.')
    controller.signal.throwIfAborted()
    src = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }))
    const dimensions = await decode(src, controller.signal)
    controller.signal.throwIfAborted()
    if (dimensions.width !== image.width || dimensions.height !== image.height)
      throw new Error('Image dimensions do not match the library.')
    const raced = cache.get(key)
    if (raced) {
      URL.revokeObjectURL(src)
      src = undefined
      return acquire(key, raced)
    }
    while (cache.size >= MAX_CACHED_IMAGES) {
      const oldest = [...cache].find(([, value]) => value.users === 0)
      if (!oldest) throw new Error('Image memory is full. Close another image and retry delivery.')
      URL.revokeObjectURL(oldest[1].src)
      cache.delete(oldest[0])
    }
    const stored = { src, users: 0, bytes: bytes.length }
    src = undefined
    return acquire(key, stored)
  } finally {
    controller.abort()
    if (src) URL.revokeObjectURL(src)
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
