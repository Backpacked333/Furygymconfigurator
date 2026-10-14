import { useLayoutEffect, useMemo, useRef } from 'react'
import { RectAreaLight, SpotLight } from 'three'
import type { Config } from '../lib/config'
import { FLOOR_Y, interiorBounds } from '../render/architecture'
import { cylinder, lathe, box } from '../render/geometry'
import { palette } from '../render/palette'
import { part, type Part } from '../render/parts'
import type { Quality } from '../render/quality'
import { Parts } from './Parts'

/** 2700 K warm-white architectural LEDs. */
const WARM = '#ffd9ad'

function Downlight({
  position,
  intensity,
  shadow,
}: {
  position: [number, number, number]
  intensity: number
  shadow: boolean
}) {
  const light = useRef<SpotLight>(null)
  useLayoutEffect(() => {
    const spot = light.current
    if (!spot) return
    spot.target.position.set(position[0], FLOOR_Y, position[2] - 0.4)
    spot.target.updateMatrixWorld()
  }, [position])
  return (
    <spotLight
      ref={light}
      position={position}
      color={WARM}
      intensity={intensity}
      angle={0.78}
      penumbra={0.85}
      decay={2}
      distance={0}
      castShadow={shadow}
      shadow-mapSize={[512, 512]}
      shadow-bias={-0.0006}
      shadow-normalBias={0.02}
      shadow-radius={3}
      shadow-camera-near={0.2}
      shadow-camera-far={14}
    />
  )
}

/** Linear LED wash: an area light whose emitting face looks toward `target`. */
function Wash({
  position,
  target,
  width,
  height,
  intensity,
}: {
  position: [number, number, number]
  target: [number, number, number]
  width: number
  height: number
  intensity: number
}) {
  const light = useRef<RectAreaLight>(null)
  useLayoutEffect(() => {
    light.current?.lookAt(...target)
  }, [target])
  return (
    <rectAreaLight
      ref={light}
      position={position}
      width={width}
      height={height}
      intensity={intensity}
      color={WARM}
    />
  )
}

/**
 * Architectural lighting: recessed downlights between the ceiling slats, a cove grazing the
 * back wall, and a toe-kick line. Fixtures stay visible when switched off.
 */
export function InteriorLights({ config: c, quality }: { config: Config; quality: Quality }) {
  const b = interiorBounds(c)
  const L = c.length
  const on = c.lights
  const columns = L === 20 ? [-6, -2, 2, 6] : [-16, -12, -8, -4, 0, 4, 8, 12, 16]
  const rows = [-1.3, 1.5]
  const fixtures = useMemo<Part[]>(() => {
    const trim = palette.powder('#141515')
    const lens = on ? palette.emitter('#fff3e2', 7) : palette.plastic('#d8d4cb', 0.3)
    const strip = on ? palette.emitter(WARM, 5) : palette.plastic('#cfcac0', 0.4)
    const puck = lathe(
      'downlight',
      [
        [0, 0],
        [0.2, 0],
        [0.2, 0.03],
        [0.15, 0.05],
        [0.12, 0.2],
        [0, 0.2],
      ],
      32,
    )
    const parts: Part[] = []
    for (const x of columns)
      for (const z of rows) {
        parts.push(part(puck, trim, [x + 0.12, b.ceiling - 0.03, z], undefined, undefined, false))
        parts.push(
          part(
            cylinder(0.11, 0.11, 0.01, 24),
            lens,
            [x + 0.12, b.ceiling - 0.005, z],
            undefined,
            undefined,
            false,
          ),
        )
      }
    // Cove channel at the back wall head, toe-kick channel at its base.
    parts.push(
      part(
        box(L - 2.6, 0.04, 0.05),
        strip,
        [0, b.ceiling - 0.06, b.back + 0.08],
        undefined,
        undefined,
        false,
      ),
    )
    parts.push(
      part(
        box(L - 2.6, 0.12, 0.12),
        palette.powder('#141515'),
        [0, b.ceiling - 0.02, b.back + 0.1],
        undefined,
        undefined,
        false,
      ),
    )
    parts.push(
      part(
        box(L - 1.6, 0.025, 0.04),
        strip,
        [0, FLOOR_Y + 0.23, b.back + 0.05],
        undefined,
        undefined,
        false,
      ),
    )
    return parts
    // Rebuild only when geometry-affecting inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, on, b.ceiling, b.back, c.family])
  const spotIntensity = 46
  return (
    <>
      <Parts parts={fixtures} />
      {on &&
        columns.map((x, i) => (
          <Downlight
            key={x}
            position={[x + 0.12, b.ceiling - 0.08, 0.1]}
            intensity={spotIntensity}
            shadow={quality === 'ultra' && (i === 1 || i === columns.length - 2)}
          />
        ))}
      {on && quality !== 'lite' && (
        <>
          <Wash
            position={[0, b.ceiling - 0.1, b.back + 0.12]}
            target={[0, FLOOR_Y + 3, b.back - 0.6]}
            width={L - 2.6}
            height={0.12}
            intensity={26}
          />
          <Wash
            position={[0, FLOOR_Y + 0.24, b.back + 0.1]}
            target={[0, b.ceiling, b.back - 0.4]}
            width={L - 1.6}
            height={0.06}
            intensity={16}
          />
        </>
      )}
    </>
  )
}
