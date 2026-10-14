import { useEffect, useMemo } from 'react'
import { MeshBasicNodeMaterial, MeshStandardMaterial } from 'three/webgpu'
import { color, reflector } from 'three/tsl'
import type { Quality } from '../render/renderer'

/**
 * Silvered glass. High and Ultra render a true planar reflection of the live scene; Lite falls
 * back to a polished metal surface lit by the captured interior probe.
 */
export function Mirror({
  width,
  height,
  quality,
}: {
  width: number
  height: number
  quality: Quality
}) {
  const { mesh, dispose } = useMemo(() => {
    if (quality === 'lite') {
      const m = new MeshStandardMaterial({ color: '#c9d1cc', metalness: 1, roughness: 0.04 })
      return { mesh: { material: m, target: null }, dispose: () => m.dispose() }
    }
    const reflection = reflector({ resolutionScale: quality === 'ultra' ? 0.75 : 0.5 })
    const m = new MeshBasicNodeMaterial()
    // Silvered float glass reflects ~90% with a faint green cast from the iron in the glass.
    m.colorNode = reflection.rgb.mul(color('#e3ebe5'))
    return {
      mesh: { material: m, target: reflection.target },
      dispose: () => {
        m.dispose()
        reflection.dispose()
      },
    }
  }, [quality])
  useEffect(() => dispose, [dispose])
  return (
    <mesh material={mesh.material}>
      <planeGeometry args={[width, height]} />
      {mesh.target && <primitive object={mesh.target} />}
    </mesh>
  )
}
