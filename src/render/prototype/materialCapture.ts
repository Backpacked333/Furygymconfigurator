/** Preparation-only material receipts, NOT implementations of the browser shaders. */
import { MeshPhysicalMaterial } from 'three'
import type { MaterialSpec } from '../materials'

export const MATERIAL_CAPTURE_VERSION = 'authored-spec-no-pixels@1' as const
const cache = new Map<string, MeshPhysicalMaterial>()

export function material(spec: MaterialSpec): MeshPhysicalMaterial {
  const key = JSON.stringify(spec)
  const previous = cache.get(key)
  if (previous) return previous
  // The authored spec is authoritative for preparation. This CPU holder is not renderable parity.
  const holder = new MeshPhysicalMaterial()
  holder.userData.prototypeMaterial = {
    boundary: MATERIAL_CAPTURE_VERSION,
    authoredSpec: structuredClone(spec),
  }
  cache.set(key, holder)
  return holder
}

/** Only equipment.ts receives this lexical document. No canvas APIs are simulated. */
export const preparationDocument = Object.freeze({
  createElement(tag: string) {
    if (tag !== 'canvas')
      throw new Error('Unsupported browser dependency in equipment preparation.')
    return { width: 0, height: 0, getContext: () => null, prototypeMissingPixels: true }
  },
})
