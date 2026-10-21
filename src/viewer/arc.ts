import type { DesignEnvelope } from '../domain/design'
import { CUSTOMER_CAMERAS, resolveCamera } from '../domain/presentation'
import { resolveNativeCamera } from '../render/nativeCamera'
import { FREE_ORBIT, UNLIMITED_ARC, wrapAngle, type ArcWindow } from './orbitWindow'

/**
 * `?arc=N`: an experimental limit on the 360° view's exterior orbit (ADR-003), library route
 * only. It lives here, not in src/render, so it never changes the renderer's version
 * (scripts/render-version.ts); CameraRig keeps the camera within it (orbitWindow.ts).
 *
 * N is a minimum. The window always covers the four exterior customer cameras and the design's
 * own camera, with ARC_MARGIN to spare on either side: on a courtyard design the rear
 * three-quarter view is taken from the other rear quarter (gallery.ts exteriorCamera), so those
 * cameras alone can span more than 200°, and a fixed 180° would leave one out of reach.
 */

const DEGREE = Math.PI / 180
const TURN = 2 * Math.PI

/** The narrowest window `?arc=` may ask for, degrees. */
export const MIN_ARC = 30
/** Room past the outermost camera on either side, degrees. */
export const ARC_MARGIN = 10

/** `?arc=N`, in degrees: a number from MIN_ARC up to (not including) a full turn, else none. */
export function requestedArc(search = window.location.search): number | null {
  const value = new URLSearchParams(search).get('arc')
  if (value === null || value.trim() === '') return null
  const degrees = Number(value)
  return Number.isFinite(degrees) && degrees >= MIN_ARC && degrees < 360 ? degrees : null
}

/** The azimuth OrbitControls reads for a camera at `position` orbiting `target`. */
export const azimuthOf = (position: readonly number[], target: readonly number[]) =>
  Math.atan2(position[0] - target[0], position[2] - target[2])

/**
 * The smallest arc that holds every azimuth: it starts after the widest gap between neighbours,
 * going round. Not the plain lowest to highest, which is the long way round for azimuths either
 * side of ±180°.
 */
export function coveringArc(azimuths: readonly number[]): { start: number; span: number } {
  const sorted = azimuths.map((a) => ((a % TURN) + TURN) % TURN).sort((a, b) => a - b)
  let gap = -1,
    start = 0
  sorted.forEach((a, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + TURN
    if (next - a > gap) {
      gap = next - a
      start = next
    }
  })
  return { start: wrapAngle(start), span: TURN - gap }
}

/**
 * The window around `azimuths` (radians): their covering arc with ARC_MARGIN either side, widened
 * evenly to `degrees` if that is wider. FREE_ORBIT from UNLIMITED_ARC up.
 */
export function arcAround(azimuths: readonly number[], degrees: number): ArcWindow {
  const { start, span } = coveringArc(azimuths)
  const width = Math.max(degrees * DEGREE, span + 2 * ARC_MARGIN * DEGREE)
  if (width >= UNLIMITED_ARC * DEGREE) return FREE_ORBIT
  const centre = wrapAngle(start + span / 2)
  return Object.freeze({ min: centre - width / 2, max: centre + width / 2 })
}

/**
 * The azimuths a design's window must reach: its exterior customer cameras, and its own camera
 * when that is an exterior one (a saved design may still open at the retired view from above).
 * Each is resolved exactly as its gallery image is (nativeCamera.ts), for this design's look, size
 * and stage shape.
 */
export function cameraAzimuths(design: DesignEnvelope): number[] {
  const refs = new Set<string>(
    CUSTOMER_CAMERAS.filter((camera) => camera.group === 'exterior').map((camera) => camera.ref),
  )
  if (resolveCamera(design.presentation.cameraRef).group === 'exterior')
    refs.add(design.presentation.cameraRef)
  return [...refs].map((cameraRef) => {
    const camera = resolveNativeCamera({
      ...design,
      presentation: { ...design.presentation, cameraRef },
    })
    return azimuthOf(camera.position, camera.target)
  })
}

/** The exterior orbit's window for a design under `?arc=degrees`. */
export const arcWindow = (design: DesignEnvelope, degrees: number): ArcWindow =>
  arcAround(cameraAzimuths(design), degrees)
