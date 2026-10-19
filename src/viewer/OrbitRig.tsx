import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Euler, PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'

export type Vec3 = readonly [number, number, number]

/** Where the camera stands, what it looks at, and its vertical field of view. */
export type CameraPose = { position: Vec3; target: Vec3; fov: number }

/**
 * Orbit damping per frame. Higher stops sooner: at 0.14 an orbit glides to rest in about a third
 * of a second (three's default, 0.05, trails on for ~190 frames of full-cost rendering).
 */
export const DAMPING = 0.14

export type OrbitLimits = {
  minDistance: number
  maxDistance: number
  minPolarAngle: number
  maxPolarAngle: number
}
const DEFAULT_LIMITS: OrbitLimits = {
  minDistance: 2,
  maxDistance: 500,
  minPolarAngle: 0.05,
  maxPolarAngle: Math.PI / 2 - 0.015,
}

/**
 * The camera. Not interactive, it snaps exactly to `pose` (a still's viewpoint). Interactive, it
 * eases to each new pose, then orbits (`mode: 'orbit'`) or looks around from where it stands
 * (`mode: 'look'`), with pointer and keyboard. `fitFov` adapts the pose's field of view to the
 * canvas aspect (for example to match how a still is cropped).
 */
export function OrbitRig({
  pose,
  mode = 'orbit',
  interactive,
  reset = 0,
  autoRotate = false,
  limits = DEFAULT_LIMITS,
  fitFov,
  label = 'Interactive 3D view. Arrow keys rotate; plus and minus zoom.',
}: {
  pose: CameraPose
  mode?: 'orbit' | 'look'
  interactive: boolean
  /** Bump to return to `pose`. */
  reset?: number
  autoRotate?: boolean
  limits?: OrbitLimits
  fitFov?: (fov: number, aspect: number) => number
  label?: string
}) {
  const { camera, size, gl, invalidate } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)
  const targetPosition = useRef(new Vector3()),
    targetLook = useRef(new Vector3()),
    moving = useRef(false),
    stalled = useRef(0)
  const yaw = useRef(0),
    pitch = useRef(0)
  const easing = useRef(false)
  easing.current = interactive
  const fit = useRef(fitFov)
  fit.current = fitFov
  useEffect(() => {
    const p = camera as PerspectiveCamera
    const aspect = size.width / size.height
    p.fov = fit.current ? fit.current(pose.fov, aspect) : pose.fov
    p.updateProjectionMatrix()
    targetPosition.current.set(...pose.position)
    targetLook.current.set(...pose.target)
    const direction = targetLook.current.clone().sub(targetPosition.current).normalize()
    yaw.current = Math.atan2(-direction.x, -direction.z)
    pitch.current = Math.asin(direction.y)
    stalled.current = 0
    if (easing.current) moving.current = true
    else {
      // A still swaps instantly; only the interactive view travels between poses.
      moving.current = false
      camera.position.copy(targetPosition.current)
      camera.lookAt(targetLook.current)
      if (controls.current) {
        controls.current.target.copy(targetLook.current)
        controls.current.update()
      }
    }
    invalidate()
  }, [camera, size.width, size.height, pose, reset, invalidate])
  useEffect(() => {
    if (!interactive) return
    const el = gl.domElement
    let drag = false,
      lastX = 0,
      lastY = 0
    const look = () =>
      camera.quaternion.setFromEuler(new Euler(pitch.current, yaw.current, 0, 'YXZ'))
    const down = (e: PointerEvent) => {
      moving.current = false
      drag = true
      lastX = e.clientX
      lastY = e.clientY
    }
    const move = (e: PointerEvent) => {
      if (!drag || mode !== 'look') return
      yaw.current -= (e.clientX - lastX) * 0.005
      pitch.current = Math.max(-0.7, Math.min(0.7, pitch.current - (e.clientY - lastY) * 0.005))
      lastX = e.clientX
      lastY = e.clientY
      look()
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
      if (mode === 'look') {
        yaw.current += e.key === 'ArrowLeft' ? 0.12 : e.key === 'ArrowRight' ? -0.12 : 0
        pitch.current = Math.max(
          -0.7,
          Math.min(
            0.7,
            pitch.current + (e.key === 'ArrowUp' ? 0.08 : e.key === 'ArrowDown' ? -0.08 : 0),
          ),
        )
        look()
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
    el.tabIndex = 0
    el.setAttribute('aria-label', label)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('keydown', key)
    return () => {
      el.removeAttribute('tabindex')
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('keydown', key)
    }
  }, [camera, gl, mode, interactive, label, invalidate])
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), [])
  useFrame((_, delta) => {
    if (!moving.current) return
    // R3F's first delta after an idle stretch is the whole idle time, which made a transition
    // jump in one frame instead of easing; a frame never advances it more than 1/30 s.
    const t = reducedMotion.matches ? 1 : 1 - Math.exp(-Math.min(delta, 1 / 30) * 7)
    const before = camera.position.distanceTo(targetPosition.current)
    camera.position.lerp(targetPosition.current, t)
    if (controls.current && mode === 'orbit') {
      controls.current.target.lerp(targetLook.current, t)
      controls.current.update()
    } else camera.lookAt(targetLook.current)
    const after = camera.position.distanceTo(targetPosition.current)
    // Arrived, or the orbit limits or auto-rotation kept the camera from making the progress the
    // easing asked for: either way, stop instead of rendering forever. Sliding around the
    // minimum-distance sphere is progress the straight-line measure undercounts, so it never
    // counts as held.
    const pinned =
      !!controls.current &&
      mode === 'orbit' &&
      controls.current.getDistance() <= controls.current.minDistance + 1e-3
    stalled.current = !pinned && after > before - 0.5 * t * before ? stalled.current + 1 : 0
    if (after < 0.015 || stalled.current >= 8) moving.current = false
    invalidate()
  })
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={interactive && mode === 'orbit'}
      enablePan={false}
      enableDamping
      dampingFactor={DAMPING}
      {...limits}
      autoRotate={interactive && autoRotate && mode === 'orbit'}
      autoRotateSpeed={0.45}
      onStart={() => {
        moving.current = false
      }}
    />
  )
}
