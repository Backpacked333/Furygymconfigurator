import { useLayoutEffect, useMemo, useRef } from 'react'
import { RectAreaLight, SpotLight } from 'three'
import type { Config } from '../lib/config'
import { canopyLights } from '../render/addons'
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

/** Linear LED channel rows (z) for the gallery and birch interiors. */
const LINEAR_ROWS = [-1.45, 1.35]

/**
 * Architectural lighting. Slatted and cedar interiors use recessed downlights; gallery and birch
 * interiors use two continuous linear LED channels in the flat ceiling. Every style keeps the
 * back-wall cove and toe-kick. Fixtures stay visible when switched off.
 */
export function InteriorLights({ config: c, quality }: { config: Config; quality: Quality }) {
  const b = interiorBounds(c)
  const L = c.length
  const on = c.lights
  const linear = c.interiorStyle === 'gallery' || c.interiorStyle === 'birch'
  const columns = L === 20 ? [-6, -2, 2, 6] : [-16, -12, -8, -4, 0, 4, 8, 12, 16]
  const rows = [-1.3, 1.5]
  const channel = L - 3.4
  const fixtures = useMemo<Part[]>(() => {
    const trim = palette.powder('#141515')
    const lens = on ? palette.emitter('#fff3e2', 7) : palette.plastic('#d8d4cb', 0.3)
    const strip = on ? palette.emitter(WARM, 5) : palette.plastic('#cfcac0', 0.4)
    const parts: Part[] = []
    if (linear) {
      // Recessed aluminum channels with opal diffusers, flush with the ceiling.
      const diffuser = on ? palette.emitter('#fff1df', 6) : palette.plastic('#e9e6df', 0.3)
      for (const z of LINEAR_ROWS) {
        parts.push(
          part(
            box(channel + 0.12, 0.02, 0.24),
            trim,
            [0, b.ceiling - 0.008, z],
            undefined,
            undefined,
            false,
          ),
        )
        parts.push(
          part(
            box(channel, 0.02, 0.14),
            diffuser,
            [0, b.ceiling - 0.016, z],
            undefined,
            undefined,
            false,
          ),
        )
      }
    } else {
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
  }, [L, on, linear, b.ceiling, b.back, c.family])
  // Switched-off lights stay mounted at zero intensity: adding or removing lights changes every
  // lit material's shader, so the switch would otherwise recompile the whole scene.
  const level = on ? 1 : 0
  const spotIntensity = 46
  return (
    <>
      <Parts parts={fixtures} />
      {(!linear || quality === 'lite') &&
        columns.map((x, i) => (
          <Downlight
            key={x}
            position={[x + 0.12, b.ceiling - 0.08, 0.1]}
            intensity={(linear ? spotIntensity * 0.8 : spotIntensity) * level}
            shadow={quality === 'ultra' && (i === 1 || i === columns.length - 2)}
          />
        ))}
      {linear &&
        quality !== 'lite' &&
        LINEAR_ROWS.map((z) => (
          <Wash
            key={z}
            position={[0, b.ceiling - 0.03, z]}
            target={[0, FLOOR_Y, z]}
            width={channel}
            height={0.14}
            intensity={52 * level}
          />
        ))}
      {quality !== 'lite' && (
        <>
          <Wash
            position={[0, b.ceiling - 0.1, b.back + 0.12]}
            target={[0, FLOOR_Y + 3, b.back - 0.6]}
            width={L - 2.6}
            height={0.12}
            intensity={26 * level}
          />
          <Wash
            position={[0, FLOOR_Y + 0.24, b.back + 0.1]}
            target={[0, b.ceiling, b.back - 0.4]}
            width={L - 1.6}
            height={0.06}
            intensity={16 * level}
          />
        </>
      )}
      {c.family === 'container' && c.addons.canopy && <CanopyLights config={c} level={level} />}
    </>
  )
}

/** Exterior downlights in the canopy soffit washing the deck or paving below. */
function CanopyLights({ config, level }: { config: Config; level: number }) {
  return (
    <>
      {canopyLights(config).map(([x, y, z]) => (
        <Downlight key={x} position={[x, y - 0.05, z]} intensity={38 * level} shadow={false} />
      ))}
    </>
  )
}
