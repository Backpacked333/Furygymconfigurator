import type { Bounds3 } from './spatial'

export function fitCameraToBounds(bounds: Bounds3, aspect: number, fov = 32) {
  const target: [number, number, number] = [
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2,
  ]
  const radius =
    Math.hypot(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z,
    ) / 2
  const vertical = (fov * Math.PI) / 360
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(0.1, aspect))
  const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.05
  const direction = [0.48, 0.24, 0.84]
  const magnitude = Math.hypot(...direction)
  const position = target.map(
    (value, axis) => value + (direction[axis] / magnitude) * distance,
  ) as [number, number, number]
  return { target, position }
}

export type CameraSnapshot = {
  position: [number, number, number]
  quaternion: [number, number, number, number]
  target: [number, number, number]
  fov: number
  bounds: string
  reset: number
}
export type CameraMemory = Partial<Record<'exterior' | 'interior', CameraSnapshot>>
export type CameraMemoryRef = { current: CameraMemory }

export function canRestoreCamera(
  snapshot: CameraSnapshot | undefined,
  bounds: string,
  reset: number,
) {
  return !!snapshot && snapshot.bounds === bounds && snapshot.reset === reset
}

export function transitionFraction(
  elapsedSeconds: number,
  reducedMotion: boolean,
  duration = 0.65,
) {
  if (reducedMotion) return 1
  const t = Math.max(0, Math.min(1, elapsedSeconds / duration))
  return t * t * (3 - 2 * t)
}

/** Preview rectangle for a centered crop; normalized to the live viewport. */
export function presentationFrame(width: number, height: number, aspect = 16 / 9) {
  if (width <= 0 || height <= 0 || aspect <= 0) return { x: 0, y: 0, width: 1, height: 1 }
  const live = width / height
  const w = live > aspect ? aspect / live : 1
  const h = live > aspect ? 1 : live / aspect
  return { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h }
}

/** FOV for that same centered crop, not a stretched or newly composed image. */
export function captureFov(fov: number, sourceAspect: number, targetAspect: number) {
  return targetAspect > sourceAspect
    ? (2 * Math.atan((Math.tan((fov * Math.PI) / 360) * sourceAspect) / targetAspect) * 180) /
        Math.PI
    : fov
}
