import { createHash } from 'node:crypto'
import { serializeDesign, type DesignEnvelope } from '../../domain/design.js'
import { nativeLibrarySchema, type NativeLibrary } from '../seedManifest.js'
import {
  CONTRACT_VERSION,
  SEED_MANIFEST_REVISION,
  SEED_MANIFEST_SHA256,
  cameraRefSchema,
  imageDescriptorSchema,
  type ImageDescriptor,
} from '../contracts.js'
import { computeSetIdentity } from '../identity.js'
import { viewDesign } from '../views.js'

/** Import these EXACT historical receipts, not an editable manifest with a matching design. */
export function verifySeedManifest(bytes: Uint8Array): NativeLibrary {
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== SEED_MANIFEST_SHA256)
    throw new Error('Seed manifest is not the pinned historical artifact.')
  const manifest = nativeLibrarySchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  if (manifest.revision !== SEED_MANIFEST_REVISION || manifest.entries.length !== 400)
    throw new Error('Unexpected seed revision.')
  for (const entry of manifest.entries) {
    if (
      entry.requestKey !== createHash('sha256').update(serializeDesign(entry.design)).digest('hex')
    )
      throw new Error('Seed design receipt mismatch.')
  }
  return manifest
}

/** Compatibility is exact-entry reuse, not an assertion that old and new renderer builds match. */
export async function seedImagesForSet(
  manifestBytes: Uint8Array,
  requested: DesignEnvelope,
): Promise<readonly ImageDescriptor[]> {
  const manifest = verifySeedManifest(manifestBytes)
  const identity = await computeSetIdentity(requested)
  const images: ImageDescriptor[] = []
  for (const entry of manifest.entries) {
    const camera = cameraRefSchema.safeParse(entry.design.presentation.cameraRef)
    if (!camera.success || camera.data === 'entry-draft@1') continue
    const selectedView = viewDesign(requested, camera.data)
    if (serializeDesign(selectedView) !== serializeDesign(entry.design)) continue
    images.push(
      imageDescriptorSchema.parse({
        contractVersion: CONTRACT_VERSION,
        setKey: identity.setKey,
        imageKey: identity.imageKeys[camera.data],
        design: entry.design,
        recipeRelease: identity.recipeRelease,
        url: `/native-library/${entry.imageSha256}.webp`,
        sha256: entry.imageSha256,
        bytes: entry.imageBytes,
        width: entry.width,
        height: entry.height,
        mime: 'image/webp',
        samples: 1024,
        adaptiveSampling: false,
        quality: 95,
        provenance: {
          kind: 'seed-cache',
          compatibilityRule: 'native-library-400-exact@1',
          manifestSha256: SEED_MANIFEST_SHA256,
          manifestRevision: SEED_MANIFEST_REVISION,
          entryId: entry.id,
          requestKey: entry.requestKey,
          historicalRecipeDigest: entry.recipeDigest,
          historicalManifestSha256: entry.manifestSha256,
          historicalWorkerSha256: entry.workerSha256,
        },
        productionAllowed: false,
        visuallyQualified: false,
        strictReference: false,
        engineeringApproved: false,
      }),
    )
  }
  return images
}
