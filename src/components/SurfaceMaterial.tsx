import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three'
import { surfacePixels, type Surface } from '../lib/visuals'

const Surfaces = createContext<
  Partial<Record<Surface, { color: DataTexture; relief: DataTexture }>>
>({})

export function SurfaceProvider({ children }: { children: ReactNode }) {
  const textures = useMemo(() => {
    const entries = (['cedar', 'oak', 'rubber', 'stone', 'plaster', 'metal'] as const).map(
      (kind) => {
        const color = new DataTexture(surfacePixels(kind), 256, 256)
        color.colorSpace = SRGBColorSpace
        const relief = new DataTexture(surfacePixels(kind), 256, 256)
        for (const texture of [color, relief]) {
          texture.wrapS = texture.wrapT = RepeatWrapping
          texture.generateMipmaps = true
          texture.minFilter = LinearMipmapLinearFilter
          texture.magFilter = LinearFilter
          texture.anisotropy = 4
          texture.needsUpdate = true
          if (kind === 'rubber') texture.repeat.set(12, 6)
          if (kind === 'stone' || kind === 'plaster') texture.repeat.set(3, 3)
          if (kind === 'oak') texture.rotation = Math.PI / 2
        }
        return [kind, { color, relief }] as const
      },
    )
    return Object.fromEntries(entries) as Record<
      Surface,
      { color: DataTexture; relief: DataTexture }
    >
  }, [])
  useEffect(
    () => () => {
      Object.values(textures).forEach(({ color, relief }) => {
        color.dispose()
        relief.dispose()
      })
    },
    [textures],
  )
  return <Surfaces.Provider value={textures}>{children}</Surfaces.Provider>
}

export function SurfaceMaterial({
  kind,
  color = '#ffffff',
  roughness,
  metalness = 0,
}: {
  kind: Surface
  color?: string
  roughness?: number
  metalness?: number
}) {
  const texture = useContext(Surfaces)[kind]
  return (
    <meshStandardMaterial
      color={color}
      map={texture?.color}
      bumpMap={texture?.relief}
      bumpScale={kind === 'metal' ? 0.004 : kind === 'rubber' ? 0.012 : 0.018}
      roughness={roughness ?? (kind === 'metal' ? 0.38 : 0.82)}
      metalness={metalness}
      envMapIntensity={kind === 'metal' ? 1.1 : 0.65}
    />
  )
}
