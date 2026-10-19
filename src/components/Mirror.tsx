import { MeshBasicNodeMaterial, MeshStandardMaterial, type Object3D } from 'three/webgpu'
import { color, reflector } from 'three/tsl'
import { viewerMotion, type Quality } from '@fury/viewer360'
import { useResource } from '../render/useResource'

type MirrorSurface = {
  material: MeshStandardMaterial | MeshBasicNodeMaterial
  target: Object3D | null
  dispose: () => void
}

/**
 * Silvered glass. Ultra renders a true planar reflection of the live scene (held still while the
 * camera moves): a second full scene render, with its own shaders. High and Lite use a polished
 * metal surface lit by the interior probe, which costs nothing extra.
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
    if (quality !== 'ultra') {
      const m = new MeshStandardMaterial({ color: '#c9d1cc', metalness: 1, roughness: 0.04 })
      return { material: m, target: null, dispose: () => m.dispose() }
    }
    const reflection = reflector({ resolutionScale: 0.75 })
    // A reflection redraws the whole scene. While the camera moves it keeps its last picture,
    // which halves the cost of a drag past the mirror; it catches up on the first frame at rest.
    const base = reflection.reflector as unknown as { updateBefore: (frame: unknown) => unknown }
    const update = base.updateBefore.bind(base)
    base.updateBefore = (frame) => (viewerMotion.active ? undefined : update(frame))
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
