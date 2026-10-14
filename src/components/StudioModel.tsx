import { useEffect, useMemo, useRef } from 'react'
import { CanvasTexture, SRGBColorSpace } from 'three'
import type { Config } from '../lib/config'
import {
  containerInterior,
  containerShell,
  interiorBounds,
  studioGlazing,
  studioInterior,
  studioShell,
} from '../render/architecture'
import { deck, pergola, roofDeck, stairs, timberAccent } from '../render/addons'
import { box } from '../render/geometry'
import { palette } from '../render/palette'
import { part, type Part } from '../render/parts'
import type { Quality } from '../render/quality'
import { Equipment } from './Equipment'
import { InteriorLights } from './InteriorLights'
import { Mirror } from './Mirror'
import { Parts } from './Parts'

/** Rebuilds a part list only when the inputs named in `key` change. */
function useParts(build: (c: Config) => Part[], config: Config, key: string) {
  const cache = useRef<{ key: string; parts: Part[] } | null>(null)
  if (cache.current?.key !== key) cache.current = { key, parts: build(config) }
  return cache.current.parts
}

function Signature({ length }: { length: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 128
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#e4e1d6'
    ctx.font = '600 66px sans-serif'
    ctx.fillText('F U R Y', 10, 86)
    ctx.font = '24px sans-serif'
    ctx.fillText(`S / ${length}     —     PERSONAL STUDIO`, 390, 76)
    const map = new CanvasTexture(canvas)
    map.colorSpace = SRGBColorSpace
    map.anisotropy = 8
    return map
  }, [length])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh position={[-length / 2 + 3.8, 10.13, 4.04]}>
      <planeGeometry args={[5.6, 0.32]} />
      <meshStandardMaterial
        map={texture}
        transparent
        depthWrite={false}
        roughness={0.35}
        metalness={0.6}
      />
    </mesh>
  )
}

function MirrorWall({ config: c, quality }: { config: Config; quality: Quality }) {
  const L = c.length
  const b = interiorBounds(c)
  const width = L * 0.48,
    height = 5.8
  const frame = useMemo(() => {
    const m = palette.powder('#161716')
    return [
      part(box(width + 0.1, 0.05, 0.06), m, [0, height / 2 + 0.025, -0.02]),
      part(box(width + 0.1, 0.05, 0.06), m, [0, -height / 2 - 0.025, -0.02]),
      part(box(0.05, height + 0.1, 0.06), m, [-width / 2 - 0.025, 0, -0.02]),
      part(box(0.05, height + 0.1, 0.06), m, [width / 2 + 0.025, 0, -0.02]),
    ]
  }, [width])
  return (
    <group position={[-L * 0.16, 4.9, b.back + 0.04]}>
      <Parts parts={frame} />
      <Mirror width={width} height={height} quality={quality} />
    </group>
  )
}

export function StudioModel({
  config: c,
  quality = 'high',
}: {
  config: Config
  quality?: Quality
}) {
  const studio = c.family === 'studio'
  const shellKey = `${c.family}|${c.length}|${c.finish}|${c.containerOpening}|${c.integratedFinish}`
  const interiorKey = `${shellKey}|${c.flooring}`
  const shell = useParts(
    (x) => (x.family === 'studio' ? studioShell(x) : containerShell(x)),
    c,
    shellKey,
  )
  const interior = useParts(
    (x) => (x.family === 'studio' ? studioInterior(x) : containerInterior(x)),
    c,
    interiorKey,
  )
  const glazing = useParts((x) => (x.family === 'studio' ? studioGlazing(x) : []), c, shellKey)
  const a = c.addons
  const deckParts = useParts(deck, c, `${shellKey}|${c.lights}`)
  const pergolaParts = useParts(pergola, c, shellKey)
  const roofParts = useParts(roofDeck, c, `${shellKey}|${a.stairs}`)
  const stairParts = useParts(stairs, c, shellKey)
  const accentParts = useParts(timberAccent, c, shellKey)
  return (
    <group>
      <Parts parts={shell} />
      <Parts parts={interior} />
      {glazing.length > 0 && <Parts parts={glazing} />}
      <InteriorLights config={c} quality={quality} />
      {c.mirror && <MirrorWall config={c} quality={quality} />}
      {studio && <Signature length={c.length} />}
      {studio && c.accent && <Parts parts={accentParts} />}
      {studio && a.deck && <Parts parts={deckParts} />}
      {studio && a.gazebo && <Parts parts={pergolaParts} />}
      {studio && a.roof && <Parts parts={roofParts} />}
      {studio && a.stairs && <Parts parts={stairParts} />}
      {c.items.map((item) => (
        <Equipment key={item.id} item={item} />
      ))}
    </group>
  )
}
