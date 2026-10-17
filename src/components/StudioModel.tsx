import { useEffect, useMemo, useRef } from 'react'
import { CanvasTexture, SRGBColorSpace } from 'three'
import type { Config } from '../lib/config'
import { interiorBounds } from '../render/architecture'
import { box } from '../render/geometry'
import { palette } from '../render/palette'
import { part, type Part } from '../render/parts'
import { UNIT_LISTS, type UnitList } from '../render/unitParts'
import { useMirror } from '../render/mirror'
import type { Quality } from '../render/quality'
import { Equipment, SaunaLights } from './Equipment'
import { InteriorLights } from './InteriorLights'
import { Mirror } from './Mirror'
import { Parts } from './Parts'

/**
 * The unit's part lists shown for a design (unitParts.ts), each rebuilt only when the inputs its
 * key names change.
 */
function useUnitParts(config: Config) {
  const cache = useRef(new Map<string, { key: string; parts: Part[] }>())
  const lists: { list: UnitList; parts: Part[] }[] = []
  for (const list of UNIT_LISTS) {
    if (!list.shown(config)) continue
    const key = list.key(config)
    let kept = cache.current.get(list.name)
    if (kept?.key !== key) {
      kept = { key, parts: list.build(config) }
      cache.current.set(list.name, kept)
    }
    lists.push({ list, parts: kept.parts })
  }
  return lists
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
  const lists = useUnitParts(c)
  // Each list's meshes carry its name, so the stills' prefetch can find them (siblings.ts).
  const scoped = (scope: UnitList['scope']) =>
    lists
      .filter(({ list }) => list.scope === scope)
      .map(({ list, parts }) => <Parts key={list.name} name={list.name} parts={parts} />)
  return (
    // Tagged so the site reflection probe can leave the unit out of its capture.
    <group userData={{ unit: true }}>
      {/* The shell and its glazing (the door, the windows) are seen from both sides: an edit to
          them, a door opened, costs the stills outside and inside alike. */}
      <group userData={{ shared: true }}>{scoped('shared')}</group>
      {/* What is inside the room is marked, so an edit there costs the stills only the interior
          angles, not the exterior ones (pathtrace.ts sceneSignature). */}
      <group userData={{ interior: true }}>{scoped('interior')}</group>
      <InteriorLights config={c} quality={quality} />
      {c.mirror && <MirrorWall config={c} quality={quality} />}
      {studio && <Signature length={c.length} />}
      {scoped('outside')}
      {c.items.map((item) => (
        <Equipment key={item.id} item={item} />
      ))}
      <SaunaLights items={c.items} />
    </group>
  )
}
