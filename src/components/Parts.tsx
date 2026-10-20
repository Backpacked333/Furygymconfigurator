import { useEffect, useMemo } from 'react'
import { batch, type Part } from '../render/parts'

/**
 * Renders a part list as a few merged, per-material meshes. Callers memoize `parts`. A `name`
 * (unitParts.ts) is kept on each mesh, so the stills' prefetch can find the list's meshes
 * (siblings.ts).
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
  const batches = useMemo(() => batch(parts), [parts])
  // One object for the list's life: a new one each render would replace the meshes' userData.
  const tag = useMemo(() => (name ? { userData: { parts: name } } : {}), [name])
  useEffect(() => () => batches.forEach((b) => b.geometry.dispose()), [batches])
  return (
    <>
      {batches.map((b) => (
        <mesh
          key={b.material.uuid + b.shadow}
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
