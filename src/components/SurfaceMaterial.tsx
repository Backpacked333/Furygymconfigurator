import { material, type MaterialSpec, type TextureSet } from '../render/materials'

export type Surface = 'cedar' | 'oak' | 'rubber' | 'stone' | 'plaster' | 'metal'

const SURFACE_SETS: Record<Surface, TextureSet> = {
  cedar: 'oak_veneer_01',
  oak: 'laminate_floor_02',
  rubber: 'rubber_tiles',
  stone: 'granite_tile_04',
  plaster: 'beige_wall_001',
  metal: 'powder_coat',
}

/** Attaches a shared library material; the library owns disposal. */
export function Mat(spec: MaterialSpec) {
  return <primitive object={material(spec)} attach="material" dispose={null} />
}

export function SurfaceMaterial({
  kind,
  color = '#ffffff',
  roughness,
  metalness = 0,
  interior = false,
}: {
  kind: Surface
  color?: string
  roughness?: number
  metalness?: number
  interior?: boolean
}) {
  return (
    <Mat
      set={SURFACE_SETS[kind]}
      color={color}
      roughness={roughness ?? (kind === 'metal' ? 0.9 : 1)}
      metalness={metalness}
      normalScale={kind === 'metal' ? 0.25 : 1}
      interior={interior}
    />
  )
}
