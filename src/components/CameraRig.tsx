import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Euler, PerspectiveCamera, Quaternion, Vector3, type Camera } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { productHeight, type Config, type View } from '../lib/config'
import { deckFront, roofTop } from '../render/envelope'
import { aspectClassOf, galleryCamera, type AngleId, type GalleryCamera } from '../render/gallery'
import { DAMPING, motionPixels, settleGlide } from '../render/motion'
import { ORBIT_LIMITS } from '../render/orbit'
import { FREE_ORBIT, room, sweep, widen, type ArcWindow } from '../viewer/orbitWindow'

/** OrbitControls' rotateSpeed under a limited arc: a drag turns the view more steadily. */
const ARC_ROTATE_SPEED = 0.6
/** Within this many radians of an end of the arc (about 0.006°), the camera stands on it. */
const AT_END = 1e-4
const UP = new Vector3(0, 1, 0)

/** The azimuth OrbitControls reads for the camera (orbitWindow.ts ArcWindow). */
const azimuth = (camera: Camera, orbit: OrbitControlsImpl) =>
  Math.atan2(camera.position.x - orbit.target.x, camera.position.z - orbit.target.z)

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
  arc,
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
  /**
   * The exterior orbit's azimuth window (`?arc=`, viewer/arc.ts), from the library's 360° view
   * only. None by default: the orbit goes all the way round.
   */
  arc?: ArcWindow
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
  // Numbers, not the window object, so a new object for the same window changes nothing.
  const arcMin = arc?.min ?? -Infinity,
    arcMax = arc?.max ?? Infinity
  const limited = Number.isFinite(arcMin) && Number.isFinite(arcMax)
  // Auto-rotation within a limited arc is a sweep back and forth (orbitWindow.ts), not
  // OrbitControls' own, which would creep to an end and stop there.
  const sweeping = live && autoRotate && view === 'exterior' && limited
  // The arc is put on the controls here, not passed as props: none while the camera eases between
  // poses (three-stdlib clamps the straight path it takes, which would pin it at an end short of
  // where it is going, or throw it to the far end past ±180°), and, once it rests, the window
  // widened just enough to hold where it stands, so taking effect never moves the camera.
  const designed = useRef<ArcWindow>(FREE_ORBIT),
    held = useRef<ArcWindow>(FREE_ORBIT)
  const hold = useCallback((window: ArcWindow) => {
    held.current = window
    const orbit = controls.current
    if (!orbit) return
    orbit.minAzimuthAngle = window.min
    orbit.maxAzimuthAngle = window.max
  }, [])
  /** The camera has stopped easing, or never was: the arc holds it from where it stands. */
  const rest = useCallback(() => {
    moving.current = false
    const orbit = controls.current
    if (orbit) hold(widen(designed.current, azimuth(camera, orbit)))
  }, [camera, hold])
  useLayoutEffect(() => {
    designed.current = limited ? { min: arcMin, max: arcMax } : FREE_ORBIT
    // A new window (a look or the stage's shape moves the cameras) takes effect under a still
    // camera only widened to hold it; an ease under way takes it on landing.
    if (!moving.current) rest()
  }, [arcMin, arcMax, limited, rest])
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
  const settleOnEntry = useRef(false)
  settleOnEntry.current = pose !== undefined
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
      // What was left of a fling or of auto-rotation when the view last closed (the controls froze
      // with the frame loop) would replay on the first frame and carry the camera off the image's
      // pose with no input. The library's 360° view, which opens on that image, ends it first.
      const orbit = controls.current
      if (settleOnEntry.current && orbit) {
        // Without damping, one update spends what is owed and clears it; the pose is set after.
        const damping = orbit.enableDamping
        orbit.enableDamping = false
        orbit.update()
        orbit.enableDamping = damping
      }
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
      rest()
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
    hold(FREE_ORBIT)
    invalidate()
  }, [camera, framingKey, view, angle, reset, invalidate, live, rest, hold])
  useEffect(() => {
    const el = gl.domElement
    // In the gallery the canvas is a picture: it takes no focus, and drags do nothing.
    el.tabIndex = live ? 0 : -1
    if (!live) return
    let drag = false,
      lastX = 0,
      lastY = 0
    const down = (e: PointerEvent) => {
      rest()
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
      rest()
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
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const way = e.key === 'ArrowLeft' ? 1 : -1
          // No further than the arc's end: a camera turned past ±180° by position would be
          // clamped to the far end instead.
          const turn = Math.min(0.1, room(held.current, Math.atan2(offset.x, offset.z), way))
          offset.applyAxisAngle(UP, way * turn)
        }
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
  }, [camera, gl, view, invalidate, live, rest])
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
    if (!orbit?.enabled || last.dragging || moving.current || orbit.autoRotate || sweeping) return
    if (pixels > 0) {
      if (settleGlide(orbit, pixels)) invalidate()
      return
    }
    // Held still at an end of the arc while what is left of a fling pushes on into it, unseen
    // (settleGlide waits for motion, so it never ends it): stopped outright, or the next turn back
    // would be pulled to the end again.
    const theta = azimuth(camera, orbit)
    if (room(held.current, theta, 1) < AT_END || room(held.current, theta, -1) < AT_END)
      settleGlide(orbit, 0)
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
      rest()
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
    if (stalled.current >= 8) rest()
    invalidate()
  })
  const sweepWay = useRef<1 | -1>(-1)
  useFrame((_, delta) => {
    const orbit = controls.current
    if (!sweeping || !orbit || moving.current || glide.current.dragging) return
    // Timed in seconds, a frame never more than 1/30 s as the ease above.
    const offset = camera.position.clone().sub(orbit.target)
    const step = sweep(
      held.current,
      Math.atan2(offset.x, offset.z),
      sweepWay.current,
      Math.min(delta, 1 / 30),
    )
    sweepWay.current = step.way
    camera.position.copy(orbit.target).add(offset.applyAxisAngle(UP, step.turn))
    camera.lookAt(orbit.target)
    invalidate()
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={live && view !== 'interior'}
      enablePan={false}
      {...ORBIT_LIMITS}
      rotateSpeed={limited ? ARC_ROTATE_SPEED : 1}
      autoRotate={live && autoRotate && view === 'exterior' && !limited}
      autoRotateSpeed={0.45}
      dampingFactor={DAMPING}
      onStart={() => {
        rest()
        glide.current.dragging = true
        if (controls.current) controls.current.dampingFactor = DAMPING
      }}
      onEnd={() => {
        glide.current.dragging = false
        // A frame to resume the sweep, or to end a glide left pushing into an end of the arc.
        if (limited) invalidate()
      }}
    />
  )
}
