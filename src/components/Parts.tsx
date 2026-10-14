import { useEffect, useMemo } from 'react'
import { batch, type Part } from '../render/parts'

/** Renders a part list as a few merged, per-material meshes. Callers memoize `parts`. */
export function Parts({ parts, receiveShadow = true }: { parts: Part[]; receiveShadow?: boolean }) {
  const batches = useMemo(() => batch(parts), [parts])
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
        />
      ))}
    </>
  )
}
