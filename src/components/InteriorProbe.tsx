import { useMemo } from 'react'
import { CubeProbe } from '@fury/viewer360/3d'
import { productHeight, type Config } from '../lib/config'
import { setInteriorEnvironment } from '../render/materials'

/**
 * Interior image-based lighting: a radiance cube captured from the middle of the room is the
 * environment of interior surfaces, so walls, floor, and equipment are lit and reflected by the
 * room itself (light through the glazing, luminaires, finishes) rather than the open sky. The
 * tier sets its size and bounces; stills ask for more.
 */
export function InteriorProbe({
  config,
  debounce,
  passes,
  size,
}: {
  config: Config
  /** Stills capture at once; the live view waits for a burst of changes to end. */
  debounce?: number
  /** Captures per change: each adds a diffuse bounce. */
  passes?: number
  size?: number
}) {
  // Everything in the configuration can show in, or light, the room.
  const captureKey = useMemo(() => JSON.stringify(config), [config])
  const height = productHeight(config)
  const position = useMemo(() => [0, height * 0.52, 0.3] as const, [height])
  return (
    <CubeProbe
      position={position}
      captureKey={captureKey}
      onCapture={setInteriorEnvironment}
      debounce={debounce}
      passes={passes}
      size={size}
    />
  )
}
