import { projectDesignToConfig } from '../domain/design'
import { textureSetsFor } from '../lib/designTextures'
import { prefetchEncoded, scanFiles } from '../render/scanFiles'

/**
 * Starts downloading the scans the 360° view of `design` is made from, read off the design
 * (designTextures.ts) without building its scene or loading three.js, so they come in alongside
 * the view's own code. Only their encoded bytes, at low priority: they are decoded, and counted in
 * the view's load progress, once its material library asks for them (materials.ts), which then
 * downloads none of them again.
 */
export function warmLiveDesign(design: unknown) {
  const sets = textureSetsFor(projectDesignToConfig(design))
  prefetchEncoded(sets.flatMap((set) => scanFiles(set).map((file) => file.url)))
}
