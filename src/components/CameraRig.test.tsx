// @vitest-environment jsdom
import { act, useEffect, useRef, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import type { GalleryCamera } from '../render/gallery'
import { CameraRig } from './CameraRig'

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
vi.mock('@react-three/drei', async () => {
  const { useMemo, useImperativeHandle, useEffect } = await import('react')
  const { OrbitControls } = await import('three-stdlib')
  const { useFrame } = await import('@react-three/fiber')
  return {
    OrbitControls: ({
      ref,
      ...props
    }: Partial<OrbitControlsImpl> & { ref: React.Ref<OrbitControlsImpl> }) => {
      const controls = useMemo(() => new OrbitControls(state.three.camera as PerspectiveCamera), [])
      Object.assign(controls, props)
      useImperativeHandle(ref, () => controls, [controls])
      useFrame(() => {
        if (controls.enabled) controls.update()
      }, -1)
      useEffect(() => () => controls.dispose(), [controls])
      return null
    },
  }
})

describe('live camera transitions (real orbit math, no GPU)', () => {
  let root: Root, camera: PerspectiveCamera
  let props: ComponentProps<typeof CameraRig>
  const exterior: GalleryCamera = { position: [35, 12, 10], target: [0, 4, 0], fov: 34 }
  const interior: GalleryCamera = { position: [9, 6, 3], target: [0, 3, -2], fov: 64 }
  const render = (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch }
    act(() => root.render(<CameraRig {...props} />))
  }
  const frame = (count = 1) =>
    act(() => {
      for (let i = 0; i < count; i++)
        for (const { callback } of [...state.frames.values()].sort(
          (a, b) => a.priority - b.priority,
        ))
          callback(state.three, 1 / 60)
    })
  const expectPose = (pose: GalleryCamera) => {
    expect(camera.position.distanceTo(new Vector3(...pose.position))).toBeLessThan(1e-6)
    const forward = new Vector3(...pose.target).sub(camera.position).normalize()
    expect(camera.getWorldDirection(new Vector3()).distanceTo(forward)).toBeLessThan(1e-6)
    expect(camera.fov).toBe(pose.fov)
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    state.frames.clear()
    camera = new PerspectiveCamera()
    state.three = {
      camera,
      gl: { domElement: document.createElement('canvas') },
      size: { width: 1000, height: 625 },
      invalidate: vi.fn(),
    }
    props = {
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
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })

  it('opens at the selected exterior camera and preserves it after a frame', () => {
    render()
    frame()
    expectPose(exterior)
  })

  it('does not resume an obsolete exterior transition after reopening at an interior camera', () => {
    render()
    render({ reset: 1, pose: { ...exterior, position: [-35, 12, 10] } })
    frame(3)
    render({ active: false })
    render({ view: 'interior', angle: 'entry', pose: interior })
    render({ active: true })
    expectPose(interior)
    frame(200)
    expectPose(interior)
  })

  it('resets to the selected interior view without exterior orbit constraints', () => {
    render({ view: 'interior', angle: 'entry', pose: interior })
    camera.position.set(0, 5, 0)
    render({ reset: 1 })
    frame(200)
    expectPose(interior)
  })

  it('does not reframe an orbit for a finish-only edit', () => {
    render()
    camera.position.set(30, 10, 30)
    render({ config: { ...props.config, finish: 'bronze' } })
    frame(200)
    expect(camera.position.distanceTo(new Vector3(30, 10, 30))).toBeLessThan(1e-6)
  })
})
