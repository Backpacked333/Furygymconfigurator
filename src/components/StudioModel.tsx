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
import { canopy, deck, pergola, roofDeck, stairs, timberAccent } from '../render/addons'
import { box } from '../render/geometry'
import { palette } from '../render/palette'
import { part, type Part } from '../render/parts'
import { useMirror } from '../render/mirror'
import type { Quality } from '../render/quality'
import { Equipment, SaunaLights } from './Equipment'
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
    <mesh position={[-length / 2 + 4.2, 10.15, 4.006]}>
      <planeGeometry args={[5.6 * 0.8, 0.32 * 0.8]} />
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

/** The mirror wall: a framed pane of silvered glass on the back wall. */
export function MirrorWall({ config: c, quality }: { config: Config; quality: Quality }) {
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
  const surface = useMirror(quality)
  // Nothing until the glass exists (a frame after mount), so the frame mounts with it: the spin
  // then renders its panorama once for the mirror, not once for the frame and again for the glass
  // a frame later (spin.ts takes a changed design up once it has held a frame: one edit, one
  // design).
  if (!surface) return null
  return (
    // Inside the room: the spin's panorama changes with it, its exterior ring does not.
    <group position={[-L * 0.16, 4.9, b.back + 0.04]} userData={{ interior: true }}>
      <Parts parts={frame} />
      <Mirror width={width} height={height} surface={surface} />
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
  const openingKey = `${shellKey}|${c.openingInfill}|${c.doorsOpen}|${c.studioDoor}`
  const interiorKey = `${shellKey}|${c.flooring}|${c.interiorStyle}|${c.openingInfill}`
  const shell = useParts(
    (x) => (x.family === 'studio' ? studioShell(x) : containerShell(x)),
    c,
    openingKey,
  )
  const interior = useParts(
    (x) => (x.family === 'studio' ? studioInterior(x) : containerInterior(x)),
    c,
    interiorKey,
  )
  const glazing = useParts((x) => (x.family === 'studio' ? studioGlazing(x) : []), c, openingKey)
  const a = c.addons
  const deckParts = useParts(deck, c, `${shellKey}|${c.lights}`)
  const pergolaParts = useParts(pergola, c, shellKey)
  const roofParts = useParts(roofDeck, c, `${shellKey}|${a.stairs}|${c.railing}`)
  const stairParts = useParts(stairs, c, `${shellKey}|${c.railing}`)
  const canopyParts = useParts(canopy, c, `${shellKey}|${a.roof}|${c.lights}`)
  const accentParts = useParts(timberAccent, c, shellKey)
  return (
    // Tagged so the site reflection probe can leave the unit out of its capture.
    <group userData={{ unit: true }}>
      {/* The shell and its glazing (the door, the windows) are seen from both sides: an edit to
          them, a door opened, costs the spin its exterior ring and its panorama alike. */}
      <group userData={{ shared: true }}>
        <Parts parts={shell} />
        {glazing.length > 0 && <Parts parts={glazing} />}
      </group>
      {/* What is inside the room is marked, so an edit there costs the spin only its panorama,
          not the exterior ring (pathtrace.ts sceneSignature). */}
      <group userData={{ interior: true }}>
        <Parts parts={interior} />
      </group>
      <InteriorLights config={c} quality={quality} />
      {c.mirror && <MirrorWall config={c} quality={quality} />}
      {studio && <Signature length={c.length} />}
      {studio && c.accent && <Parts parts={accentParts} />}
      {a.deck && <Parts parts={deckParts} />}
      {studio && a.gazebo && <Parts parts={pergolaParts} />}
      {a.roof && <Parts parts={roofParts} />}
      {a.stairs && <Parts parts={stairParts} />}
      {!studio && a.canopy && <Parts parts={canopyParts} />}
      {c.items.map((item) => (
        <Equipment key={item.id} item={item} />
      ))}
      <SaunaLights items={c.items} />
    </group>
  )
}
