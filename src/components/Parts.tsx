import { useEffect, useMemo, useRef } from 'react'
import { batch, disposeBatches, type Batch, type Part } from '../render/parts'

/** Renders a part list as a few merged, per-material meshes. Callers memoize `parts`. */
export function Parts({ parts, receiveShadow = true }: { parts: Part[]; receiveShadow?: boolean }) {
  const batches = useMemo(() => batch(parts), [parts])
  const committed = useRef<Batch[] | null>(null)
  useEffect(() => {
    committed.current = batches
    return () => {
      if (committed.current === batches) committed.current = null
      // StrictMode replays this effect with the same buffers before the next microtask.
      queueMicrotask(() => {
        if (committed.current !== batches) disposeBatches(batches)
      })
    }
  }, [batches])
  return (
    <>
      {batches.map((b) => (
        <mesh
          key={b.material.uuid + b.shadow}
          geometry={b.geometry}
          material={b.material}
          castShadow={b.shadow}
          receiveShadow={receiveShadow}
          dispose={null}
        />
      ))}
    </>
  )
}
