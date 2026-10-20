import { parseDesign, serializeDesign } from '../domain/design.js'
import { CUSTOMER_CAMERA_REFS } from '../domain/presentation.js'
import {
  CONTRACT_VERSION,
  recipeForDesign,
  customerDesignSchema,
  imageDescriptorSchema,
  identitySchema,
  type ImageDescriptor,
  type SetIdentity,
} from './contracts.js'
import { INTERIOR_KEYING, fiveViewDesigns, viewDesign } from './views.js'

/** Sorted UTF-8 JSON. Contract values are finite JSON primitives; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  throw new Error('Only finite JSON contract values may be canonicalized.')
}

export function identityPayload(input: unknown, kind: 'set' | 'image'): string {
  const design = JSON.parse(serializeDesign(customerDesignSchema.parse(input)))
  if (kind === 'set') delete design.presentation.cameraRef
  return canonicalJson({
    contractVersion: CONTRACT_VERSION,
    kind,
    design,
    recipeRelease: recipeForDesign(design),
    // Sets whose interior key is shared get new keys; immutable historical sets stay untouched.
    ...(kind === 'set' ? { viewKeying: INTERIOR_KEYING } : {}),
  })
}
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}
export async function computeSetIdentity(input: unknown): Promise<SetIdentity> {
  const design = customerDesignSchema.parse(input)
  const hash = (value: string) => sha256Hex(new TextEncoder().encode(value))
  const [setDigest, ...imageDigests] = await Promise.all([
    hash(identityPayload(design, 'set')),
    ...fiveViewDesigns(design).map((view) => hash(identityPayload(view, 'image'))),
  ])
  return identitySchema.parse({
    setKey: `set_${setDigest}`,
    recipeRelease: recipeForDesign(design),
    imageKeys: Object.fromEntries(
      CUSTOMER_CAMERA_REFS.map((ref, index) => [ref, `img_${imageDigests[index]}`]),
    ),
  })
}

/** Call before fetching bytes; then verify checksum, byte cap, decode and dimensions separately. */
export async function verifyImageDescriptor(
  input: unknown,
  wantedDesign: unknown,
  allowedStorageOrigins: readonly string[],
): Promise<ImageDescriptor> {
  const image = imageDescriptorSchema.parse(input)
  const design = parseDesign(wantedDesign)
  const cameraRef = image.design.presentation.cameraRef as keyof SetIdentity['imageKeys']
  if (serializeDesign(image.design) !== serializeDesign(viewDesign(design, cameraRef)))
    throw new Error('Wrong image design.')
  const identity = await computeSetIdentity(design)
  // The image key binds design, camera and recipe; the set key only records which set published it.
  if (
    canonicalJson(image.recipeRelease) !== canonicalJson(identity.recipeRelease) ||
    image.imageKey !== identity.imageKeys[cameraRef]
  )
    throw new Error('Wrong image identity.')
  if (image.provenance.kind === 'seed-cache') {
    if (design.presentation.cameraRef === 'entry-draft@1')
      throw new Error('Historical interior pixels do not match the room-overview camera.')
    if (image.url !== `/native-library/${image.sha256}.webp`) throw new Error('Wrong seed URL.')
  } else {
    const url = new URL(image.url)
    if (!allowedStorageOrigins.includes(url.origin)) throw new Error('Untrusted storage origin.')
    const suffix = `/render-library/${image.setKey}/${image.imageKey}/${image.sha256}.webp`
    if (!url.pathname.endsWith(suffix)) throw new Error('Wrong storage object binding.')
  }
  return image
}
