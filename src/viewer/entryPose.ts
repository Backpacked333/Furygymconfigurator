import { Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three'
import type { GalleryCamera } from '../render/gallery'
import { motionPixels } from '../render/motion'

const UP = new Vector3(0, 1, 0)

/**
 * How far, in pixels of a stage `height` tall, the camera's view is from `pose`'s: zero for a
 * camera placed at the pose (CameraRig places it with the same lookAt). A different field of view
 * is a different image at any distance, so it never counts as at the pose.
 */
export function pixelsFromPose(camera: PerspectiveCamera, pose: GalleryCamera, height: number) {
  if (Math.abs(camera.fov - pose.fov) > 1e-6) return Infinity
  const position = new Vector3(...pose.position)
  const target = new Vector3(...pose.target)
  // A camera looks down its -z axis: Matrix4.lookAt(eye, target) is what Camera.lookAt applies.
  const facing = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, target, UP))
  return motionPixels(
    position,
    facing,
    camera.position,
    camera.quaternion,
    position.distanceTo(target),
    pose.fov,
    height,
  )
}
