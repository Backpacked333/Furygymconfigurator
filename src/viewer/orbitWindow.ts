/**
 * An exterior orbit limited to a window of azimuths (`?arc=`, viewer/arc.ts), as CameraRig keeps
 * the camera within it. Free of the design and of three.js, so the rig the legacy route shares
 * takes on nothing but this.
 */

const DEGREE = Math.PI / 180
const TURN = 2 * Math.PI

/**
 * Azimuth limits in OrbitControls' terms: radians, atan2(x, z) of the camera about the orbit
 * target. `min` ≤ `max`, centred within ±π, so an end may lie past ±π (the window crosses behind
 * the build), which OrbitControls folds back itself. ±Infinity is no limit.
 */
export type ArcWindow = Readonly<{ min: number; max: number }>
export const FREE_ORBIT: ArcWindow = Object.freeze({ min: -Infinity, max: Infinity })

/**
 * A window this wide (degrees) or wider is no limit at all. three-stdlib's clamp folds each limit
 * back into ±180° once, so toward a full turn the two meet and pin the camera to one azimuth.
 */
export const UNLIMITED_ARC = 350
/**
 * How far inside an end the camera stops when it is turned by position (arrow keys, the sweep).
 * An end exactly at ±180° would otherwise leave rounding to decide which side of it the camera
 * lands, and three-stdlib's clamp throws a camera just past ±180° to the far end.
 */
const INSET = 1e-6

/** An angle brought within half a turn either side of zero. */
export const wrapAngle = (angle: number) => angle - TURN * Math.round(angle / TURN)

const limited = (window: ArcWindow) => Number.isFinite(window.min) && Number.isFinite(window.max)

/** `theta` expressed within half a turn of the window's centre, so it compares with its ends. */
const within = (window: ArcWindow, theta: number) => {
  const centre = (window.min + window.max) / 2
  return centre + wrapAngle(theta - centre)
}

/**
 * The window widened just enough to hold `theta`, so putting it on the controls never moves a
 * camera that stands outside it. FREE_ORBIT if that would make it UNLIMITED_ARC or wider.
 */
export function widen(window: ArcWindow, theta: number): ArcWindow {
  if (!limited(window)) return FREE_ORBIT
  const at = within(window, theta)
  if (at >= window.min && at <= window.max) return window
  const min = Math.min(window.min, at),
    max = Math.max(window.max, at)
  return max - min >= UNLIMITED_ARC * DEGREE ? FREE_ORBIT : Object.freeze({ min, max })
}

/**
 * How far (radians) a camera at `theta` may still turn within the window, toward `max` (way 1,
 * the way ArrowLeft turns) or `min` (-1). Infinite for no limit.
 */
export function room(window: ArcWindow, theta: number, way: 1 | -1) {
  if (!limited(window)) return Infinity
  const at = within(window, theta)
  return Math.max(0, way > 0 ? window.max - at - INSET : at - window.min - INSET)
}

/** Auto-rotation under a limited arc at full speed, degrees a second. */
export const SWEEP_SPEED = 2
/** The share of that speed the sweep slows to at each end, where it turns around. */
export const SWEEP_SLOWEST = 0.25
/** Degrees from an end over which the sweep slows. */
export const SWEEP_EASE = 15

/**
 * One frame of auto-rotation under a limited arc, `seconds` long: back and forth between the
 * window's ends, turning `way` (1 toward `max`) now. OrbitControls' own auto-rotate turns a fixed
 * angle each frame (faster on a 120 Hz screen), one way only, so under a limit it creeps to an end
 * and stops there, still switched on. The sweep slows toward an end but never stops: it lands on
 * the end and heads back the next frame, so the view is never still long enough for a trace to
 * start (ProgressiveRenderer's REST_MS) only to be dropped as the camera moves on.
 */
export function sweep(
  window: ArcWindow,
  theta: number,
  way: 1 | -1,
  seconds: number,
): { turn: number; way: 1 | -1 } {
  const back = -way as 1 | -1
  const ahead = room(window, theta, way),
    behind = room(window, theta, back)
  const near = Math.min(ahead, behind) / (SWEEP_EASE * DEGREE)
  const ease = near >= 1 ? 1 : near * near * (3 - 2 * near)
  const step = SWEEP_SPEED * DEGREE * (SWEEP_SLOWEST + (1 - SWEEP_SLOWEST) * ease) * seconds
  if (step < ahead) return { turn: way * step, way }
  // At an end already: back the other way within this same frame.
  if (ahead <= 0) return { turn: back * Math.min(step, behind), way: back }
  return { turn: way * ahead, way: back }
}
