import { serializeDesign, type DesignEnvelope } from '../domain/design'
import { SEED_MANIFEST_SHA256 } from '../render-library/contracts'
import { deliverImage, readBounded } from './imageDelivery'
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
    const response = await fetch('/native-library/manifest.json', {
      cache: 'no-cache',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error('The rendered library could not be loaded.')
    const bytes = await readBounded(response, 2 * 1024 * 1024)
    if ((await bytesSha256(bytes)) !== SEED_MANIFEST_SHA256)
      throw new Error('Library release mismatch.')
    const text = new TextDecoder().decode(bytes)
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

type CachedImage = { src: string; entry: NativeEntry; release: () => void }
export async function decodeNativeImage(
  entry: NativeEntry,
  signal: AbortSignal,
): Promise<CachedImage> {
  return {
    ...(await deliverImage(
      {
        url: nativeImageUrl(entry),
        sha256: entry.imageSha256,
        bytes: entry.imageBytes,
        width: entry.width,
        height: entry.height,
      },
      signal,
    )),
    entry,
  }
}
