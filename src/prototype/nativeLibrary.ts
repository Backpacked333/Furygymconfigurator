import { serializeDesign, type DesignEnvelope } from '../domain/design'
import {
  nativeLibrarySchema,
  type NativeEntry,
  type NativeLibrary,
} from '../render-library/seedManifest'
export { nativeEntrySchema, nativeLibrarySchema } from '../render-library/seedManifest'
export type { NativeEntry, NativeLibrary } from '../render-library/seedManifest'
export const nativeImageUrl = (entry: NativeEntry) => `/native-library/${entry.imageSha256}.webp`
export const nativeThumbUrl = (entry: NativeEntry) =>
  `/native-library/${entry.imageSha256}-thumb.webp`
const nativeDesignIndexes = new WeakMap<NativeLibrary, Map<string, NativeEntry>>()
export function findNativeImage(library: NativeLibrary, design: DesignEnvelope) {
  let index = nativeDesignIndexes.get(library)
  if (!index) {
    index = new Map()
    for (const entry of library.entries) index.set(serializeDesign(entry.design), entry)
    nativeDesignIndexes.set(library, index)
  }
  return index.get(serializeDesign(design))
}
export async function bytesSha256(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

let libraryPromise: Promise<NativeLibrary> | undefined
export function getNativeLibrary(): Promise<NativeLibrary> {
  libraryPromise ??= (async () => {
    const response = await fetch('/native-library/manifest.json', { cache: 'no-cache' })
    if (!response.ok) throw new Error('The rendered library could not be loaded.')
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) throw new Error('Library manifest is too large.')
    const library = nativeLibrarySchema.parse(JSON.parse(text))
    const identities = await Promise.all(
      library.entries.map(
        async (entry) =>
          entry.requestKey ===
          (await bytesSha256(new TextEncoder().encode(serializeDesign(entry.design)))),
      ),
    )
    if (identities.some((valid) => !valid)) throw new Error('Library design identity mismatch.')
    return library
  })().catch((error: unknown) => {
    libraryPromise = undefined
    throw error
  })
  return libraryPromise
}

type CachedImage = { src: string; entry: NativeEntry }
const imageCache = new Map<string, CachedImage>()
export async function decodeNativeImage(
  entry: NativeEntry,
  signal: AbortSignal,
): Promise<CachedImage> {
  const cached = imageCache.get(entry.imageSha256)
  if (cached) {
    imageCache.delete(entry.imageSha256)
    imageCache.set(entry.imageSha256, cached)
    return { src: cached.src, entry }
  }
  const response = await fetch(nativeImageUrl(entry), { signal, cache: 'force-cache' })
  if (!response.ok) throw new Error('The selected render could not be loaded.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== entry.imageBytes || (await bytesSha256(bytes)) !== entry.imageSha256)
    throw new Error('Image verification failed. No substitute image was displayed.')
  const src = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }))
  try {
    const image = new Image()
    image.src = src
    await image.decode()
    if (signal.aborted) throw new DOMException('Superseded', 'AbortError')
    if (image.naturalWidth !== entry.width || image.naturalHeight !== entry.height)
      throw new Error('Image dimensions do not match the library.')
    const result = { src, entry }
    imageCache.set(entry.imageSha256, result)
    while (imageCache.size > 8) {
      const oldest = imageCache.keys().next().value!
      URL.revokeObjectURL(imageCache.get(oldest)!.src)
      imageCache.delete(oldest)
    }
    return result
  } catch (error) {
    URL.revokeObjectURL(src)
    throw error
  }
}
