import { useLayoutEffect, useRef } from 'react'
import type { InstancedMesh, Matrix4 } from 'three/webgpu'
import { drawInstances, fillInstances } from '../render/instances'

/**
 * An instanced mesh's instances: every one of `matrices` put on it, the first `drawn` drawn
 * (instances.ts). Filled again when R3F builds a new InstancedMesh for new constructor args (its
 * geometry, material, or capacity), whose instances would otherwise all sit at the origin; a tier
 * change only draws more or fewer.
 */
export function useInstances(
  matrices: Matrix4[],
  drawn: number = matrices.length,
  geometry?: unknown,
  surface?: unknown,
) {
  const mesh = useRef<InstancedMesh>(null)
  const drawnNow = useRef(drawn)
  drawnNow.current = drawn
  useLayoutEffect(() => {
    if (mesh.current) fillInstances(mesh.current, matrices, drawnNow.current)
  }, [matrices, geometry, surface])
  useLayoutEffect(() => {
    if (mesh.current) drawInstances(mesh.current, drawn)
  }, [drawn])
  return mesh
}
