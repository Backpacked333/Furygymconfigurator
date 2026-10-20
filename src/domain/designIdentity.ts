import { parseDesign, resolveDesignManifest } from './design'

/** Stable JSON with sorted object keys; caller inputs must first pass the strict domain schema. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalDesign(input: unknown): string {
  const resolved = resolveDesignManifest(input)
  return canonical({
    purpose: 'fury.logical-design@1',
    config: resolved.design.config,
    arrangementCatalog: resolved.catalogVersions.arrangement,
    arrangement: resolved.arrangement,
  })
}
export function canonicalPresentation(input: unknown): string {
  const resolved = resolveDesignManifest(input)
  return canonical({
    purpose: 'fury.logical-presentation@1',
    presentation: resolved.design.presentation,
    presentationCatalog: resolved.catalogVersions.presentation,
    look: resolved.look,
    camera: resolved.camera,
  })
}
export function canonicalRequest(input: unknown): string {
  const design = parseDesign(input)
  return canonical({
    purpose: 'fury.logical-image-request@1',
    design: JSON.parse(canonicalDesign(design)),
    presentation: JSON.parse(canonicalPresentation(design)),
    outputProfile: { id: design.outputProfile, version: 1, approval: 'draft' },
  })
}
export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
export type DesignIdentity = Readonly<{
  designDigest: string
  presentationDigest: string
  requestDigest: string
}>

/**
 * Logical request identity, NOT rendered artifact identity or proof of release approval.
 * Server must recompute these values, then bind trusted asset/geometry/material hashes,
 * actual camera/lens, renderer build, profile and encoded bytes before publishing real images.
 */
export async function designIdentity(input: unknown): Promise<DesignIdentity> {
  const design = parseDesign(input)
  const [designDigest, presentationDigest, requestDigest] = await Promise.all([
    sha256Text(canonicalDesign(design)),
    sha256Text(canonicalPresentation(design)),
    sha256Text(canonicalRequest(design)),
  ])
  return Object.freeze({ designDigest, presentationDigest, requestDigest })
}
