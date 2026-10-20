import type { Material, Mesh, Scene } from 'three/webgpu'
import { stableStringify } from '../lib/stillKey'
import type { Config } from '../lib/config'
import type { SkyLook } from '../lib/visuals'
import { captureScene, type CapturedScene } from './cloud'
import { materialLoaded, quietly, whenMaterialLoaded } from './materials'
import { batchKeys } from './parts'
import { lookKey, partsSignature, sceneParts, type ScenePart } from './pathtrace'
import { SURFACE_FIELDS } from './prefetch'
import { UNIT_LISTS } from './unitParts'

/**
 * The stills' prefetch renders the current angle of a design the visitor has not chosen yet: the
 * design with one option of an open panel section changed (a sibling). The cloud renders from a
 * captured scene, so the sibling's scene has to be described without the visitor seeing it.
 *
 * Only siblings whose difference is a material swap are prefetched: the exterior finish and the
 * floor. Their capture is the live scene's, with the swapped surfaces put on the very meshes a
 * click would change (rebuilt here; in the live 360° view, kept, with only their material swapped:
 * geometryReuse.ts), for the moment of the capture alone: the swap, the fingerprints and the
 * capture's reading of the scene all happen in one task (captureScene reads the scene before its
 * first await), and the meshes get their own materials back before it returns, so no frame is
 * ever drawn with them and nothing is left behind. Rebuilding the part lists for the sibling
 * (unitParts.ts, the same builders the model renders) proves the swap is the whole edit: every
 * list merges into the same batches with the same geometry, and only their materials differ.
 * Anything else (a door, an interior style that adds slats, a setting that moves the camera or
 * relights the scene) would need a live re-render of the scene graph, which the visitor would
 * see or which would leave state behind: those siblings are not prefetched.
 */

/** One merged mesh of a part list, and the surface it takes for the sibling. */
export type Swap = { list: string; key: string; from: Material; to: Material }
/** How a sibling's scene follows from the design on screen: the surfaces it swaps. */
export type Derivation = { swaps: Swap[] }
export type PartKeys = Record<ScenePart, string>

/** The fields two designs differ in. */
function differing(a: Config, b: Config) {
  return (Object.keys(a) as (keyof Config)[]).filter(
    (field) => stableStringify(a[field]) !== stableStringify(b[field]),
  )
}

/**
 * How `sibling` follows from `current` by swapping surfaces, or null when it does not (it differs
 * in anything else, or the swap would merge the model's meshes differently). Builds both designs'
 * part lists quietly: the sibling's new surfaces and their scans are nothing the page shows.
 */
export function deriveSibling(current: Config, sibling: Config): Derivation | null {
  const fields = differing(current, sibling)
  // Options known to change surfaces alone (prefetch.ts); each sibling is checked all the same.
  if (fields.length !== 1 || !(SURFACE_FIELDS as readonly string[]).includes(fields[0])) return null
  return quietly(() => {
    const swaps: Swap[] = []
    for (const list of UNIT_LISTS) {
      const shown = list.shown(current)
      if (shown !== list.shown(sibling)) return null
      if (!shown) continue
      const before = batchKeys(list.build(current))
      const after = new Map(batchKeys(list.build(sibling)).map((b) => [b.key, b]))
      // The same batches, by geometry: a swap that merged two of them, or split one, would not be
      // the model a click builds.
      if (after.size !== before.length || new Set(before.map((b) => b.key)).size !== after.size)
        return null
      for (const batch of before) {
        const next = after.get(batch.key)
        if (!next || next.shadow !== batch.shadow) return null
        if (next.material !== batch.material)
          swaps.push({ list: list.name, key: batch.key, from: batch.material, to: next.material })
      }
    }
    return { swaps }
  })
}

type Surface = Parameters<typeof materialLoaded>[0]

/** Whether the sibling's surfaces have their scans in: captured before, they would read plain. */
export function siblingLoaded(derivation: Derivation) {
  return derivation.swaps.every((swap) => materialLoaded(swap.to as Surface))
}

/**
 * Downloads the sibling's scans quietly: true once its surfaces have them, false as soon as a set
 * fails a round (its surfaces would stay plain, so the sibling is not prefetched from this design;
 * a click on it asks again, for the page).
 */
export function whenSiblingLoaded(derivation: Derivation): Promise<boolean> {
  return Promise.all(derivation.swaps.map((swap) => whenMaterialLoaded(swap.to as Surface))).then(
    (loaded) => loaded.every(Boolean),
  )
}

/** The scene's fingerprints by part, as the stills sign it (RenderEffects). */
export function partKeys(scene: Scene, look: SkyLook): PartKeys {
  const key = lookKey(look)
  return {
    exterior: String(partsSignature(sceneParts(scene, 'exterior'), key)),
    interior: String(partsSignature(sceneParts(scene, 'interior'), key)),
  }
}

/**
 * Reads the live scene with the sibling's surfaces on the meshes a click rebuilds, for the call of
 * `read` alone: the meshes have their own surfaces back before it returns. Null when the live
 * scene is not the design the derivation was made from (`expected`, its fingerprints as the
 * stills last signed them): it is on its way to another one.
 */
function withSibling<T>(
  scene: Scene,
  look: SkyLook,
  derivation: Derivation,
  expected: PartKeys,
  read: () => T,
): T | null {
  scene.updateMatrixWorld()
  const now = partKeys(scene, look)
  if (now.exterior !== expected.exterior || now.interior !== expected.interior) return null
  const wanted = new Map(derivation.swaps.map((swap) => [`${swap.list}|${swap.key}`, swap]))
  const found: { mesh: Mesh; swap: Swap }[] = []
  let stray = false
  scene.traverse((object) => {
    const mesh = object as Mesh
    const list = (mesh.userData as { parts?: unknown }).parts
    if (!mesh.isMesh || typeof list !== 'string') return
    const swap = wanted.get(`${list}|${(mesh.geometry.userData as { key?: unknown }).key}`)
    if (!swap) return
    if (mesh.material === swap.from) found.push({ mesh, swap })
    else stray = true
  })
  // Each swapped batch exactly once, with the surface it has now: else the scene is not that design.
  if (stray || found.length !== derivation.swaps.length) return null
  if (new Set(found.map(({ swap }) => swap)).size !== found.length) return null
  try {
    for (const { mesh, swap } of found) mesh.material = swap.to
    return read()
  } finally {
    for (const { mesh, swap } of found) mesh.material = swap.from
  }
}

/**
 * The sibling's fingerprints, as the stills give it once a click builds it, without its scans:
 * they sign each surface by what it is, not by the maps it has yet. So a sibling whose still at an
 * angle is in already (a floor, from outside) is known to be without downloading anything. Null
 * when the live scene is not the design the derivation was made from.
 */
export function siblingKeys(
  scene: Scene,
  look: SkyLook,
  derivation: Derivation,
  expected: PartKeys,
): PartKeys | null {
  return withSibling(scene, look, derivation, expected, () => partKeys(scene, look))
}

/**
 * The sibling's scene, captured from the live one with the swapped surfaces on, and its
 * fingerprints: the very keys the stills give the sibling once a click builds it. Null when the
 * live scene is not the design the derivation was made from.
 */
export function captureSibling(
  scene: Scene,
  look: SkyLook,
  derivation: Derivation,
  expected: PartKeys,
): { keys: PartKeys; captured: Promise<CapturedScene> } | null {
  return withSibling(scene, look, derivation, expected, () => ({
    keys: partKeys(scene, look),
    // Read now, in this task, while the sibling's surfaces are on: hashing finishes later.
    captured: captureScene(scene, look),
  }))
}
