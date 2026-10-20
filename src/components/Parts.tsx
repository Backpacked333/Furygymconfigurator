import { useContext, useEffect, useMemo } from 'react'
import { GeometryReuse } from '../render/geometryReuse'
import {
  acquireBatches,
  batch,
  cachedBatches,
  releaseBatches,
  type CachedBatch,
  type Part,
} from '../render/parts'

/** Meshes named by their geometry, so a list rebuilt to the same shapes keeps them. */
function meshKeys(batches: CachedBatch[]) {
  const seen = new Set<string>()
  return batches.map((b) => {
    let key = `${b.key}:${b.shadow}`
    // One shape in two materials: never two meshes under one key.
    if (seen.has(key)) key += `:${b.material.uuid}`
    seen.add(key)
    return key
  })
}

/**
 * Renders a part list as a few merged, per-material meshes. Callers memoize `parts`. A `name`
 * (unitParts.ts) is kept on each mesh, so the stills' prefetch can find the list's meshes
 * (siblings.ts).
 *
 * Where geometry is reused (the live 360° view, geometryReuse.ts), the merged geometry comes from
 * a cache shared by content and each mesh is keyed by its geometry: a finish or floor edit
 * rebuilds the list to the same batches, so its meshes stay mounted, keep their geometry, and only
 * swap material. Elsewhere each list merges its own geometry, disposed with it, and meshes are
 * keyed by material, so an edit remounts the meshes whose material changed.
 */
export function Parts({
  parts,
  name,
  receiveShadow = true,
}: {
  parts: Part[]
  name?: string
  receiveShadow?: boolean
}) {
  const reuse = useContext(GeometryReuse)
  const { batches, keys, shared } = useMemo(() => {
    if (!reuse) {
      const own = batch(parts)
      return { batches: own, keys: own.map((b) => b.material.uuid + b.shadow), shared: null }
    }
    const cached = cachedBatches(parts)
    return { batches: cached, keys: meshKeys(cached), shared: cached }
  }, [parts, reuse])
  // One object for the list's life: a new one each render would replace the meshes' userData.
  const tag = useMemo(() => (name ? { userData: { parts: name } } : {}), [name])
  // Shared geometry is counted by what committed, never by a render that may be thrown away.
  useEffect(() => {
    if (!shared) return () => batches.forEach((b) => b.geometry.dispose())
    acquireBatches(shared)
    return () => releaseBatches(shared)
  }, [batches, shared])
  return (
    <>
      {batches.map((b, i) => (
        <mesh
          key={keys[i]}
          geometry={b.geometry}
          material={b.material}
          castShadow={b.shadow}
          receiveShadow={receiveShadow}
          {...tag}
        />
      ))}
    </>
  )
}
