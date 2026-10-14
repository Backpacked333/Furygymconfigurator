import { MeshBasicNodeMaterial, MeshStandardMaterial, type Object3D } from 'three/webgpu'
import { color, reflector } from 'three/tsl'
import type { Quality } from '../render/quality'
import { useResource } from '../render/useResource'

type MirrorSurface = {
  material: MeshStandardMaterial | MeshBasicNodeMaterial
  target: Object3D | null
  dispose: () => void
}

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
  const surface = useResource<MirrorSurface>(() => {
    if (quality === 'lite') {
      const m = new MeshStandardMaterial({ color: '#c9d1cc', metalness: 1, roughness: 0.04 })
      return { material: m, target: null, dispose: () => m.dispose() }
    }
    const reflection = reflector({ resolutionScale: quality === 'ultra' ? 0.75 : 0.5 })
    const m = new MeshBasicNodeMaterial()
    // Silvered float glass reflects ~90% with a faint green cast from the iron in the glass.
    m.colorNode = reflection.rgb.mul(color('#e3ebe5'))
    return {
      material: m,
      target: reflection.target,
      dispose: () => {
        m.dispose()
        reflection.dispose()
      },
    }
  }, [quality])
  if (!surface) return null
  return (
    <mesh material={surface.material} userData={{ noProbe: true }}>
      <planeGeometry args={[width, height]} />
      {surface.target && <primitive object={surface.target} />}
    </mesh>
  )
}
