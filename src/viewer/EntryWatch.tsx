import { useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import type { GalleryCamera } from '../render/gallery'
import { pixelsFromPose } from './entryPose'

/**
 * Travel from the saved image's camera, in stage pixels, below which the live view still shows
 * that image's framing. The controls hold an untouched camera within 1e-4 px of its pose, and the
 * smallest key step moves it by well over 100 px, so half a pixel separates the two cleanly.
 */
export const ENTRY_TOLERANCE_PX = 0.5

/**
 * Reports, once per opening, the first frame whose camera has left `pose`: the camera of the
 * gallery image the 360° view opened on, which stays on the stage until then. Measured from the
 * pose itself rather than from the controls' events, so a drag, a key, a zoom, an interior look or
 * auto-rotation all count, and a Reset view back to the pose does not.
 */
export function EntryWatch({
  active,
  pose,
  onLeave,
}: {
  active: boolean
  pose: GalleryCamera
  onLeave?: () => void
}) {
  const { camera, size } = useThree()
  const left = useRef(false)
  const latest = useRef({ pose, onLeave })
  latest.current = { pose, onLeave }
  // Every opening starts at the pose again (CameraRig enters there), so it reports afresh.
  useLayoutEffect(() => {
    if (active) left.current = false
  }, [active])
  // After OrbitControls (-1), CameraRig (0) and ProgressiveRenderer's render (1): the camera this
  // frame was drawn from. Every camera change asks for a frame, so none goes unseen.
  useFrame(() => {
    const { pose, onLeave } = latest.current
    if (!active || left.current || !onLeave) return
    if (pixelsFromPose(camera as PerspectiveCamera, pose, size.height) <= ENTRY_TOLERANCE_PX) return
    left.current = true
    onLeave()
  }, 2)
  return null
}
