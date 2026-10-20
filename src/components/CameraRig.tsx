import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { productHeight, type Config, type View } from '../lib/config'
import { deckFront, roofTop } from '../render/envelope'
import { aspectClassOf, galleryCamera, type AngleId, type GalleryCamera } from '../render/gallery'
import { DAMPING, motionPixels, settleGlide } from '../render/motion'
import { ORBIT_LIMITS } from '../render/orbit'

export function CameraRig({
  config: c,
  view,
  reset,
  direction,
  autoRotate,
  angle,
  gallery,
  active,
  pose,
}: {
  config: Config
  view: View
  reset: number
  /** The direction of the front three-quarter view: the build's own. */
  direction: [number, number, number]
  autoRotate: boolean
  /**
   * The gallery angle on the stage, or last on it: the 360° view opens at its pose, and Reset view
   * returns there.
   */
  angle: AngleId
  /**
   * In the gallery the camera stands exactly where the angle's still is rendered from
   * (gallery.ts), and the controls rest; in the 360° view it moves freely from there.
   */
  gallery: boolean
  active: boolean
  pose?: GalleryCamera
}) {
  const { camera, size, gl, invalidate } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const targetPosition = useRef(new Vector3()),
    targetLook = useRef(new Vector3()),
    moving = useRef(false),
    stalled = useRef(0)
  const yaw = useRef(-1.25),
    pitch = useRef(0)
  const [dx, dy, dz] = direction
  const live = !gallery && active
  // Framing depends only on what changes the build's silhouette, not on every edit.
  const framingKey = JSON.stringify([
    c.length,
    productHeight(c),
    c.addons.deck,
    c.addons.gazebo,
    c.addons.stairs,
    c.addons.canopy,
    c.addons.roof,
    c.addons.deck ? deckFront(c) : 0,
    c.addons.roof || c.addons.stairs ? roofTop(c) : 0,
  ])
  // The angle's pose: a pure function of the design, the angle and the stage's shape. The gallery
  // stands the camera there; the 360° view starts there and Reset view returns there.
  const aspect = aspectClassOf(size.width, size.height)
  const home = pose ?? galleryCamera(c, angle, aspect, [dx, dy, dz])
  const homeRef = useRef(home)
  homeRef.current = home
  const poseKey = gallery ? JSON.stringify(home) : ''
  // Before the frame after the commit, so no frame of a new angle is drawn from the old pose.
  useLayoutEffect(() => {
    if (!poseKey) return
    const { position, target, fov } = JSON.parse(poseKey) as GalleryCamera
    const p = camera as PerspectiveCamera
    p.fov = fov
    p.updateProjectionMatrix()
    p.position.set(...position)
    p.lookAt(...target)
    p.updateMatrixWorld()
    controls.current?.target.set(...target)
    moving.current = false
    // Looking around inside carries on from this pose in the 360° view.
    const forward = new Vector3(...target).sub(p.position).normalize()
    yaw.current = Math.atan2(-forward.x, -forward.z)
    pitch.current = Math.asin(forward.y)
    invalidate()
  }, [camera, poseKey, invalidate])
  /** The 360° view has taken over the camera from the gallery's pose. */
  const entered = useRef(false)
  useLayoutEffect(() => {
    if (!live) {
      entered.current = false
      moving.current = false
      stalled.current = 0
      return
    }
    // Enter at the selected gallery image's camera pose.
    if (!entered.current) {
      entered.current = true
      const { position, target, fov } = homeRef.current
      const p = camera as PerspectiveCamera
      p.fov = fov
      p.updateProjectionMatrix()
      p.position.set(...position)
      p.lookAt(...target)
      p.updateMatrixWorld()
      controls.current?.target.set(...target)
      const forward = new Vector3(...target).sub(p.position).normalize()
      yaw.current = Math.atan2(-forward.x, -forward.z)
      pitch.current = Math.asin(forward.y)
      invalidate()
      return
    }
    // Reset view, a view switch, or a new silhouette (not every edit): back to the angle's pose.
    const { position, target, fov } = homeRef.current
    const p = camera as PerspectiveCamera
    p.fov = fov
    p.updateProjectionMatrix()
    targetPosition.current.set(...position)
    targetLook.current.set(...target)
    if (view === 'interior') {
      const direction = targetLook.current.clone().sub(targetPosition.current).normalize()
      yaw.current = Math.atan2(-direction.x, -direction.z)
      pitch.current = Math.asin(direction.y)
    }
    moving.current = true
    stalled.current = 0
    invalidate()
  }, [camera, framingKey, view, angle, reset, invalidate, live])
  useEffect(() => {
    const el = gl.domElement
    // In the gallery the canvas is a picture: it takes no focus, and drags do nothing.
    el.tabIndex = live ? 0 : -1
    if (!live) return
    let drag = false,
      lastX = 0,
      lastY = 0
    const down = (e: PointerEvent) => {
      moving.current = false
      drag = true
      lastX = e.clientX
      lastY = e.clientY
    }
    const move = (e: PointerEvent) => {
      if (!drag || view !== 'interior') return
      yaw.current -= (e.clientX - lastX) * 0.005
      pitch.current = Math.max(-0.7, Math.min(0.7, pitch.current - (e.clientY - lastY) * 0.005))
      lastX = e.clientX
      lastY = e.clientY
      camera.quaternion.setFromEuler(new Euler(pitch.current, yaw.current, 0, 'YXZ'))
      invalidate()
    }
    const up = () => {
      drag = false
    }
    const key = (e: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(e.key))
        return
      e.preventDefault()
      moving.current = false
      if (view === 'interior') {
        yaw.current += e.key === 'ArrowLeft' ? 0.12 : e.key === 'ArrowRight' ? -0.12 : 0
        pitch.current = Math.max(
          -0.7,
          Math.min(
            0.7,
            pitch.current + (e.key === 'ArrowUp' ? 0.08 : e.key === 'ArrowDown' ? -0.08 : 0),
          ),
        )
        camera.quaternion.setFromEuler(new Euler(pitch.current, yaw.current, 0, 'YXZ'))
      } else if (controls.current) {
        const offset = camera.position.clone().sub(controls.current.target)
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
          offset.applyAxisAngle(new Vector3(0, 1, 0), e.key === 'ArrowLeft' ? 0.1 : -0.1)
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown')
          offset.y = Math.max(2, offset.y + (e.key === 'ArrowUp' ? 2 : -2))
        if (e.key === '+' || e.key === '=') offset.multiplyScalar(0.92)
        if (e.key === '-') offset.multiplyScalar(1.08)
        camera.position.copy(controls.current.target).add(offset)
        controls.current.update()
      }
      invalidate()
    }
    el.setAttribute(
      'aria-label',
      'Interactive gym. Arrow keys rotate; plus and minus zoom. Interior view: arrows look around.',
    )
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('keydown', key)
    }
  }, [camera, gl, view, invalidate, live])
  // Ends an orbit's damped glide once it is no longer visible, so the view comes to rest (and its
  // settle run ends) promptly. Runs after OrbitControls' own update.
  const glide = useRef({ dragging: false, position: new Vector3(), quaternion: new Quaternion() })
  useFrame(() => {
    if (!live) return
    const orbit = controls.current
    const last = glide.current
    const pixels = motionPixels(
      last.position,
      last.quaternion,
      camera.position,
      camera.quaternion,
      orbit ? camera.position.distanceTo(orbit.target) : 1,
      (camera as PerspectiveCamera).fov,
      size.height,
    )
    last.position.copy(camera.position)
    last.quaternion.copy(camera.quaternion)
    if (!orbit?.enabled || last.dragging || moving.current || orbit.autoRotate) return
    if (pixels > 0 && settleGlide(orbit, pixels)) invalidate()
  })
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), [])
  useFrame((_, delta) => {
    if (!moving.current || !live) return
    // R3F's first delta after an idle stretch is the whole idle time, which made a transition
    // jump in one frame instead of easing; a frame never advances it more than 1/30 s.
    const t = reducedMotion.matches ? 1 : 1 - Math.exp(-Math.min(delta, 1 / 30) * 5)
    const before = camera.position.distanceTo(targetPosition.current)
    camera.position.lerp(targetPosition.current, t)
    const orbit = controls.current && view !== 'interior' ? controls.current : null
    if (orbit) orbit.target.lerp(targetLook.current, t)
    if (
      camera.position.distanceTo(targetPosition.current) < 0.015 &&
      (!orbit || orbit.target.distanceTo(targetLook.current) < 0.015)
    ) {
      // Land exactly, so the view is the same each time.
      camera.position.copy(targetPosition.current)
      orbit?.target.copy(targetLook.current)
      moving.current = false
    }
    if (orbit) orbit.update()
    else camera.lookAt(targetLook.current)
    // Measured after the controls' update, which is what holds the camera at the orbit limits.
    const after = camera.position.distanceTo(targetPosition.current)
    // The orbit limits (a framing distance beyond them on a narrow screen) or auto-rotation can
    // keep the camera from making the progress the easing asked for: stop instead of rendering
    // forever. Sliding around the minimum-distance sphere is progress the straight-line measure
    // undercounts, so it never counts as held.
    const pinned = !!orbit && orbit.getDistance() <= orbit.minDistance + 1e-3
    stalled.current = !pinned && after > before - 0.5 * t * before ? stalled.current + 1 : 0
    if (stalled.current >= 8) moving.current = false
    invalidate()
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={live && view !== 'interior'}
      enablePan={false}
      {...ORBIT_LIMITS}
      autoRotate={live && autoRotate && view === 'exterior'}
      autoRotateSpeed={0.45}
      dampingFactor={DAMPING}
      onStart={() => {
        moving.current = false
        glide.current.dragging = true
        if (controls.current) controls.current.dampingFactor = DAMPING
      }}
      onEnd={() => {
        glide.current.dragging = false
      }}
    />
  )
}
