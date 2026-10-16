import type { Quaternion, Vector3 } from 'three'

/** OrbitControls' own damping, applied while the camera glides visibly. */
export const DAMPING = 0.05
/** Damping once the glide drops below TAIL_PX, so its invisible tail ends in a few frames. */
export const TAIL_DAMPING = 0.25
/** Per-frame motion (pixels) below which a glide counts as its tail. */
export const TAIL_PX = 0.6
/** Per-frame motion (pixels) below which the glide is stopped outright. */
export const STOP_PX = 0.05

/**
 * How far the image moved between two camera poses, in pixels: rotation plus translation seen at
 * `distance` (the orbit target), over a vertical field of view of `fov` degrees spanning `height`.
 */
export function motionPixels(
  fromPosition: Vector3,
  fromQuaternion: Quaternion,
  toPosition: Vector3,
  toQuaternion: Quaternion,
  distance: number,
  fov: number,
  height: number,
) {
  // Exactly zero for a camera that has not moved: a unit quaternion's dot with itself can round
  // to just under 1, which would read as a never-ending sliver of motion.
  if (fromPosition.equals(toPosition) && fromQuaternion.equals(toQuaternion)) return 0
  const rotation = 2 * Math.acos(Math.min(1, Math.abs(fromQuaternion.dot(toQuaternion))))
  const translation = fromPosition.distanceTo(toPosition) / Math.max(distance, 1e-3)
  return ((rotation + translation) * height) / ((fov * Math.PI) / 180)
}

/**
 * What to do with OrbitControls' damping after a frame that moved the camera by `pixels`. Its glide
 * shrinks 5% a frame, so the last fraction of a pixel takes hundreds of frames during which the
 * view is never still: the path tracer could not start for 10-20 seconds after a drag. Below
 * TAIL_PX the glide decays faster, and below STOP_PX it is stopped (less than 0.2 px of travel
 * remains), so the camera is exactly still within a few frames of the glide becoming invisible.
 */
export function glideStep(pixels: number): 'glide' | 'tail' | 'stop' {
  if (pixels >= TAIL_PX) return 'glide'
  return pixels >= STOP_PX ? 'tail' : 'stop'
}

type Damped = { enableDamping: boolean; dampingFactor: number; update: () => unknown }

/** Applies `glideStep` to OrbitControls after a frame moved the camera. True if it stopped. */
export function settleGlide(controls: Damped, pixels: number) {
  const step = glideStep(pixels)
  if (step === 'tail') controls.dampingFactor = TAIL_DAMPING
  if (step !== 'stop') return false
  // Without damping, one update applies what remains of the glide and clears it.
  controls.enableDamping = false
  controls.update()
  controls.enableDamping = true
  controls.dampingFactor = DAMPING
  return true
}
