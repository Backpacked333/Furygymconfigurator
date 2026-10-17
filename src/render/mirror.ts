import { Color, MeshBasicNodeMaterial, MeshStandardMaterial, type Object3D } from 'three/webgpu'
import { color, reflector } from 'three/tsl'
import type { Quality } from './quality'
import { useResource } from './useResource'

export type MirrorSurface = {
  material: MeshStandardMaterial | MeshBasicNodeMaterial
  target: Object3D | null
  dispose: () => void
}

/**
 * Silvered glass as a material. High and Ultra render a true planar reflection of the live scene;
 * Lite falls back to a polished metal surface lit by the captured interior probe. Null until it
 * exists (a GPU resource, made in an effect), so whatever frames the glass can wait and mount
 * with it (StudioModel's MirrorWall).
 */
export function useMirror(quality: Quality): MirrorSurface | null {
  return useResource<MirrorSurface>(() => {
    if (quality === 'lite') {
      const m = new MeshStandardMaterial({ color: '#c9d1cc', metalness: 1, roughness: 0.04 })
      return { material: m, target: null, dispose: () => m.dispose() }
    }
    const reflection = reflector({ resolutionScale: quality === 'ultra' ? 0.75 : 0.5 })
    const m = new MeshBasicNodeMaterial()
    // Silvered float glass reflects ~90% with a faint green cast from the iron in the glass.
    m.colorNode = reflection.rgb.mul(color('#e3ebe5'))
    // Path traced, the same silvered glass is simply a near-perfect metallic reflector.
    m.userData.pathTrace = { color: new Color('#e3ebe5'), metalness: 1, roughness: 0.015 }
    return {
      material: m,
      target: reflection.target,
      dispose: () => {
        m.dispose()
        reflection.dispose()
      },
    }
  }, [quality])
}
