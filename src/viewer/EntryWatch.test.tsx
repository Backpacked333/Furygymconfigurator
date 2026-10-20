// @vitest-environment jsdom
import { act, useEffect, useRef, type ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot, type Root } from 'react-dom/client'
import { PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { OrbitControls, type OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraRig } from '../components/CameraRig'
import { resolveCamera } from '../domain/presentation'
import { DEFAULT_CONFIG } from '../lib/config'
import type { GalleryCamera } from '../render/gallery'
import { DAMPING } from '../render/motion'
import { resolveNativeCamera } from '../render/nativeCamera'
import { ORBIT_LIMITS } from '../render/orbit'
import { nativeLibrarySchema } from '../render-library/seedManifest'
import { ENTRY_TOLERANCE_PX, EntryWatch } from './EntryWatch'
import { pixelsFromPose } from './entryPose'

const state = vi.hoisted(() => ({
  three: {} as Record<string, unknown>,
  frames: new Map<symbol, { callback: (state: unknown, dt: number) => void; priority: number }>(),
}))
vi.mock('@react-three/fiber', () => ({
  useThree: () => state.three,
  useFrame: (callback: (state: unknown, dt: number) => void, priority = 0) => {
    const key = useRef(Symbol()).current
    state.frames.set(key, { callback, priority })
    useEffect(
      () => () => {
        state.frames.delete(key)
      },
      [key],
    )
  },
}))
// CameraRig's controls: the real three-stdlib orbit math, updated each frame as drei does.
vi.mock('@react-three/drei', async () => {
  const { useMemo, useImperativeHandle, useEffect } = await import('react')
  const { OrbitControls } = await import('three-stdlib')
  const { useFrame } = await import('@react-three/fiber')
  return {
    OrbitControls: ({
      ref,
      // drei's own default: the controls glide, and keep what a glide still owes between frames.
      enableDamping = true,
      ...props
    }: Partial<OrbitControlsImpl> & { ref: React.Ref<OrbitControlsImpl> }) => {
      const controls = useMemo(() => new OrbitControls(state.three.camera as PerspectiveCamera), [])
      Object.assign(controls, { enableDamping, ...props })
      useImperativeHandle(ref, () => controls, [controls])
      useFrame(() => {
        if (controls.enabled) controls.update()
      }, -1)
      useEffect(() => () => controls.dispose(), [controls])
      return null
    },
  }
})

const HEIGHT = 625
const exterior: GalleryCamera = { position: [35, 12, 10], target: [0, 4, 0], fov: 34 }
const interior: GalleryCamera = { position: [9, 6, 3], target: [0, 3, -2], fov: 64 }
/** As CameraRig enters the 360° view: the pose's position, looking at its target. */
function placed(pose: GalleryCamera, camera = new PerspectiveCamera()) {
  camera.fov = pose.fov
  camera.updateProjectionMatrix()
  camera.position.set(...pose.position)
  camera.lookAt(...pose.target)
  camera.updateMatrixWorld()
  return camera
}
/** One ArrowLeft step of CameraRig's exterior orbit: 0.1 rad about the target. */
function orbitStep(camera: PerspectiveCamera, pose: GalleryCamera) {
  const target = new Vector3(...pose.target)
  camera.position
    .sub(target)
    .applyAxisAngle(new Vector3(0, 1, 0), 0.1)
    .add(target)
  camera.lookAt(target)
}

describe('pixelsFromPose', () => {
  it('is exactly zero for a camera placed at the pose', () => {
    expect(pixelsFromPose(placed(exterior), exterior, HEIGHT)).toBe(0)
    expect(pixelsFromPose(placed(interior), interior, HEIGHT)).toBe(0)
  })

  it('separates a held camera from the smallest deliberate move', () => {
    const camera = placed(exterior)
    // A turn of about 0.3 px: rounding and damping noise, still the image's framing.
    const radians = (0.3 * ((exterior.fov * Math.PI) / 180)) / HEIGHT
    camera.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), radians))
    const held = pixelsFromPose(camera, exterior, HEIGHT)
    expect(held).toBeGreaterThan(0)
    expect(held).toBeLessThan(ENTRY_TOLERANCE_PX)
    const moved = placed(exterior)
    orbitStep(moved, exterior)
    expect(pixelsFromPose(moved, exterior, HEIGHT)).toBeGreaterThan(100)
  })

  it('never counts another field of view as the pose', () => {
    const camera = placed(exterior)
    camera.fov = exterior.fov + 0.5
    expect(pixelsFromPose(camera, exterior, HEIGHT)).toBe(Infinity)
  })

  it('holds every saved exterior image within a hundredth of a pixel once the controls run', () => {
    const library = nativeLibrarySchema.parse(
      JSON.parse(readFileSync('public/native-library/manifest.json', 'utf8')),
    )
    let worst = 0
    let orbits = 0
    // Interior views look around without OrbitControls. Exterior ones orbit with its limits and
    // damping, which must neither clamp nor drift a camera standing at the pose.
    for (const entry of library.entries) {
      if (resolveCamera(entry.design.presentation.cameraRef).group !== 'exterior') continue
      orbits++
      const pose = resolveNativeCamera(entry.design)
      const camera = placed(pose)
      expect(pixelsFromPose(camera, pose, HEIGHT)).toBe(0)
      const controls = new OrbitControls(camera)
      Object.assign(controls, ORBIT_LIMITS, {
        enablePan: false,
        enableDamping: true,
        dampingFactor: DAMPING,
      })
      controls.target.set(...pose.target)
      for (let frame = 0; frame < 120; frame++) controls.update()
      worst = Math.max(worst, pixelsFromPose(camera, pose, HEIGHT))
      controls.dispose()
    }
    expect(orbits).toBeGreaterThan(200)
    expect(worst).toBeLessThan(0.01)
  })
})

describe('EntryWatch (no GPU)', () => {
  let root: Root, camera: PerspectiveCamera
  const frame = (count = 1) =>
    act(() => {
      for (let i = 0; i < count; i++)
        for (const { callback } of [...state.frames.values()].sort(
          (a, b) => a.priority - b.priority,
        ))
          callback(state.three, 1 / 60)
    })
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    state.frames.clear()
    camera = new PerspectiveCamera()
    state.three = {
      camera,
      gl: { domElement: document.createElement('canvas') },
      size: { width: 1000, height: HEIGHT },
      invalidate: vi.fn(),
    }
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })

  describe('alone', () => {
    const render = (props: ComponentProps<typeof EntryWatch>) =>
      act(() => root.render(<EntryWatch {...props} />))

    it('watches after the scene has drawn the frame', () => {
      render({ active: true, pose: exterior, onLeave: vi.fn() })
      expect([...state.frames.values()].map(({ priority }) => priority)).toEqual([2])
    })

    it('stays quiet at the pose and reports the first move exactly once', () => {
      const onLeave = vi.fn()
      placed(exterior, camera)
      render({ active: true, pose: exterior, onLeave })
      frame(50)
      expect(onLeave).not.toHaveBeenCalled()
      orbitStep(camera, exterior)
      frame()
      expect(onLeave).toHaveBeenCalledTimes(1)
      orbitStep(camera, exterior)
      frame(20)
      expect(onLeave).toHaveBeenCalledTimes(1)
    })

    it('reports a change of field of view', () => {
      const onLeave = vi.fn()
      placed(exterior, camera)
      render({ active: true, pose: exterior, onLeave })
      camera.fov = 40
      frame()
      expect(onLeave).toHaveBeenCalledTimes(1)
    })

    it('reports nothing while inactive, and afresh for each opening', () => {
      const onLeave = vi.fn()
      // Under the floor plan, or before the first opening: the camera is anywhere.
      render({ active: false, pose: exterior, onLeave })
      frame(5)
      expect(onLeave).not.toHaveBeenCalled()
      placed(exterior, camera)
      render({ active: true, pose: exterior, onLeave })
      orbitStep(camera, exterior)
      frame()
      expect(onLeave).toHaveBeenCalledTimes(1)
      render({ active: false, pose: exterior, onLeave })
      frame(5)
      expect(onLeave).toHaveBeenCalledTimes(1)
      placed(exterior, camera)
      render({ active: true, pose: exterior, onLeave })
      frame(5)
      expect(onLeave).toHaveBeenCalledTimes(1)
      orbitStep(camera, exterior)
      frame()
      expect(onLeave).toHaveBeenCalledTimes(2)
    })

    it('measures from the latest pose', () => {
      const onLeave = vi.fn()
      placed(exterior, camera)
      render({ active: true, pose: exterior, onLeave })
      frame()
      render({ active: true, pose: { ...exterior, position: [-35, 12, 10] }, onLeave })
      frame()
      expect(onLeave).toHaveBeenCalledTimes(1)
    })

    it('does nothing without a listener', () => {
      render({ active: true, pose: exterior })
      expect(() => frame(3)).not.toThrow()
    })
  })

  describe('with CameraRig and real orbit controls', () => {
    let rig: ComponentProps<typeof CameraRig>
    let onLeave: ReturnType<typeof vi.fn<() => void>>
    const render = (patch: Partial<ComponentProps<typeof CameraRig>> = {}) => {
      rig = { ...rig, ...patch }
      act(() =>
        root.render(
          <>
            <CameraRig {...rig} />
            <EntryWatch active={rig.active} pose={rig.pose!} onLeave={onLeave} />
          </>,
        ),
      )
    }
    const canvas = () => (state.three.gl as { domElement: HTMLCanvasElement }).domElement
    beforeEach(() => {
      onLeave = vi.fn<() => void>()
      rig = {
        config: structuredClone(DEFAULT_CONFIG),
        view: 'exterior',
        reset: 0,
        direction: [0.48, 0.24, 0.84],
        autoRotate: false,
        angle: 'left',
        gallery: false,
        active: true,
        pose: exterior,
      }
    })

    it('holds the entry through damping and a Reset view at the pose', () => {
      render()
      frame(120)
      render({ reset: 1 })
      frame(200)
      expect(onLeave).not.toHaveBeenCalled()
    })

    it('reports an arrow key orbit', () => {
      render()
      frame(3)
      act(() => canvas().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })))
      frame()
      expect(onLeave).toHaveBeenCalledTimes(1)
    })

    it('reports auto-rotation', () => {
      render()
      frame(3)
      render({ autoRotate: true })
      // Damped, the rotation builds over its first frames; a fraction of a second shows it.
      frame(30)
      expect(onLeave).toHaveBeenCalledTimes(1)
    })

    it('opens again at the pose, whatever motion was left when the view closed', () => {
      render()
      frame(3)
      // Closed while rotating automatically: the controls hold the damped rotation still owed.
      render({ autoRotate: true })
      frame(180)
      render({ active: false, autoRotate: false })
      onLeave.mockClear()
      render({ active: true })
      frame(120)
      expect(onLeave).not.toHaveBeenCalled()
      expect(pixelsFromPose(camera, rig.pose!, HEIGHT)).toBeLessThanOrEqual(ENTRY_TOLERANCE_PX)
    })

    it('reports looking around inside', () => {
      render({ view: 'interior', angle: 'entry', pose: interior })
      frame(3)
      expect(onLeave).not.toHaveBeenCalled()
      act(() => {
        canvas().dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100 }))
        canvas().dispatchEvent(new MouseEvent('pointermove', { clientX: 104, clientY: 100 }))
      })
      frame()
      expect(onLeave).toHaveBeenCalledTimes(1)
    })
  })
})
