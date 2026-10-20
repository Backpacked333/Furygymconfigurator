import {
  bindCloudRecipe,
  CLOUD_DISPLAY_BUILD_GATE,
  cloudRecipeSchema,
  type CloudRecipe,
} from '../../../display/cloudContract'
import type { RemoteDisplayBackend } from '../../../display/cloudSession'
import { stableDisplayJson } from '../../../display/contract'
import { parseDesign } from '../../../domain/design'
import { displayCameraDigest } from '../../../render/display/input'
import { preparePortablePackage, type PortablePackage } from './package'

export class CloudDispatchDenied extends Error {
  readonly code = 'execution-denied'
  readonly blocker = 'approval-required'
  constructor() {
    super('External display execution is not authorized in this build.')
  }
}
/** No approval parsing, file I/O, factory callbacks or transport construction before the build hold. */
export function requireCloudDispatch(): never {
  if (!CLOUD_DISPLAY_BUILD_GATE.dispatchAllowed) throw new CloudDispatchDenied()
  // A future build requires reviewed activation, not an environment switch or truthy permit.
  throw new CloudDispatchDenied()
}
export function createRemoteDisplayBackend(): RemoteDisplayBackend {
  let prepared: Promise<PortablePackage> | undefined
  let closed = false
  const recipes = new Map<string, CloudRecipe>()
  const get = () => {
    if (closed) throw new Error('Cloud backend closed.')
    return (prepared ??= preparePortablePackage().catch((error: unknown) => {
      prepared = undefined
      throw error
    }))
  }
  return {
    async prepare(input) {
      const design = parseDesign(input)
      const pkg = await get()
      await pkg.revalidate()
      const recipe = await bindCloudRecipe(
        design,
        pkg.build,
        pkg.packageDigest,
        await displayCameraDigest(design),
      )
      if (closed) throw new Error('Cloud backend closed.')
      // Bounded memo is only for same-process closure validation, not durable job/cache state.
      if (recipes.size >= 64 && !recipes.has(recipe.recipeDigest))
        recipes.delete(recipes.keys().next().value!)
      recipes.set(recipe.recipeDigest, recipe)
      return recipe
    },
    async revalidate(input) {
      const recipe = cloudRecipeSchema.parse(input)
      const expected = recipes.get(recipe.recipeDigest)
      if (!expected || stableDisplayJson(recipe) !== stableDisplayJson(expected))
        throw new Error('Cloud recipe was not prepared by this backend.')
      const pkg = await get()
      if (
        recipe.workerPackageDigest !== pkg.packageDigest ||
        stableDisplayJson(recipe.binding.build) !== stableDisplayJson(pkg.build)
      )
        throw new Error('Cloud package identity mismatch.')
      await pkg.revalidate()
    },
    async open() {
      return requireCloudDispatch()
    },
    async close() {
      closed = true
      recipes.clear()
      prepared = undefined
    },
  }
}
