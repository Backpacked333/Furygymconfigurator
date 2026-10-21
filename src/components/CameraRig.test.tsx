// @vitest-environment jsdom
import { act, useEffect, useRef, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../lib/config'
import type { GalleryCamera } from '../render/gallery'
import type { ArcWindow } from '../viewer/orbitWindow'
import { CameraRig } from './CameraRig'

const state = vi.hoisted(() => ({
  three: {} as Record<string, unknown>,
  frames: new Map<symbol, { callback: (state: unknown, dt: number) => void; priority: number }>(),
  controls: null as OrbitControlsImpl | null,
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
      enableDamping = true,
      onStart,
      onEnd,
      ...props
    }: Partial<OrbitControlsImpl> & {
      ref: React.Ref<OrbitControlsImpl>
      onStart?: () => void
      onEnd?: () => void
    }) => {
      const controls = useMemo(() => new OrbitControls(state.three.camera as PerspectiveCamera), [])
      Object.assign(controls, { enableDamping, ...props })
      useImperativeHandle(ref, () => controls, [controls])
      useFrame(() => {
        if (controls.enabled) controls.update()
      }, -1)
      // As drei does: the controls listen on the canvas, and report a drag's start and end.
      useEffect(() => {
        state.controls = controls
        controls.connect((state.three.gl as { domElement: HTMLElement }).domElement)
        return () => controls.dispose()
      }, [controls])
      useEffect(() => {
        const start = () => onStart?.(),
          end = () => onEnd?.()
        controls.addEventListener('start', start)
        controls.addEventListener('end', end)
        return () => {
          controls.removeEventListener('start', start)
          controls.removeEventListener('end', end)
        }
      }, [controls, onStart, onEnd])
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

  describe('within an exterior arc (?arc=)', () => {
    const deg = Math.PI / 180
    /** An exterior pose at `degrees` azimuth about the orbit target. */
    const at = (degrees: number): GalleryCamera => ({
      position: [36 * Math.sin(degrees * deg), 12, 36 * Math.cos(degrees * deg)],
      target: [0, 4, 0],
      fov: 34,
    })
    const arc = (min: number, max: number): ArcWindow => ({ min: min * deg, max: max * deg })
    const controls = () => state.controls!
    /** The limits on the controls, degrees. */
    const limits = () => [controls().minAzimuthAngle / deg, controls().maxAzimuthAngle / deg]
    /** The camera's azimuth as OrbitControls reads it, degrees. */
    const theta = () => {
      const target = controls().target
      return Math.atan2(camera.position.x - target.x, camera.position.z - target.z) / deg
    }
    /** How far apart two azimuths are, the short way round, degrees. */
    const apart = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180)
    const canvas = () => (state.three.gl as { domElement: HTMLCanvasElement }).domElement
    const press = (key: string) =>
      act(() => {
        canvas().dispatchEvent(new KeyboardEvent('keydown', { key }))
      })
    /** OrbitControls reporting a drag's start or end, as a pointer would make it. */
    const drag = (type: 'start' | 'end') =>
      act(() => controls().dispatchEvent({ type, target: controls() }))

    it('enters at the selected camera with the arc on the controls', () => {
      render({ pose: at(29.7), arc: arc(-10, 151.5) })
      frame()
      expectPose(at(29.7))
      expect(limits()[0]).toBeCloseTo(-10)
      expect(limits()[1]).toBeCloseTo(151.5)
      expect(controls().rotateSpeed).toBeLessThan(1)
    })

    it('lifts the arc while easing and puts it back on landing', () => {
      render({ pose: at(29.7), arc: arc(-10, 151.5) })
      for (let i = 0; i < 10; i++) press('ArrowLeft')
      render({ reset: 1 })
      frame(3)
      expect(limits()).toEqual([-Infinity, Infinity])
      frame(300)
      expectPose(at(29.7))
      expect(limits()[0]).toBeCloseTo(-10)
      expect(limits()[1]).toBeCloseTo(151.5)
    })

    it('eases the straight way to a camera across the build, though that leaves the arc', () => {
      // A courtyard's rear three-quarter view, taken from the other rear quarter: the straight way
      // to it from the side view passes behind the build, outside the window, not held at its end.
      render({ angle: 'left', pose: at(85.4), arc: arc(-126.5, 95.4) })
      frame()
      render({ angle: 'rear-left', pose: at(-116.5) })
      let behind = false
      for (let i = 0; i < 600; i++) {
        frame()
        if (theta() > 95.4 + 1 || theta() < -126.5 - 1) behind = true
      }
      expect(behind).toBe(true)
      expectPose(at(-116.5))
      expect(limits()[0]).toBeCloseTo(-126.5)
      expect(limits()[1]).toBeCloseTo(95.4)
    })

    it.each([
      ['one that stops short of ±180°', 74, arc(-6, 176)],
      ['one that crosses ±180°', 150, arc(100, 260)],
    ])('turns by arrow keys to each end of %s, never thrown to the far end', (_, start, window) => {
      render({ pose: at(start), arc: window })
      for (const [key, end] of [
        ['ArrowLeft', window.max],
        ['ArrowRight', window.min],
        ['ArrowLeft', window.max],
      ] as const) {
        for (let i = 0; i < 60; i++) {
          const before = theta()
          press(key)
          frame()
          expect(apart(theta(), before)).toBeLessThanOrEqual(0.1 / deg + 1e-6)
        }
        expect(apart(theta(), end / deg)).toBeLessThan(1e-3)
      }
    })

    it('stops a fling at an end, and the next turn back is not pulled to it again', () => {
      render({ pose: at(29.7), arc: arc(-10, 151.5) })
      Object.defineProperty(canvas(), 'clientHeight', { value: 625 })
      canvas().releasePointerCapture = () => {}
      const pointer = (type: string, target: EventTarget, clientX: number) =>
        act(() => {
          const event = new MouseEvent(type, { clientX, clientY: 300, button: 0, bubbles: true })
          target.dispatchEvent(Object.assign(event, { pointerId: 1, pointerType: 'mouse' }))
        })
      pointer('pointerdown', canvas(), 600)
      pointer('pointermove', document, 0)
      frame()
      pointer('pointerup', document, 0)
      frame(30)
      expect(apart(theta(), 151.5)).toBeLessThan(1e-3)
      press('ArrowRight')
      frame(120)
      expect(apart(theta(), 151.5 - 0.1 / deg)).toBeLessThan(1e-3)
    })

    it('takes a new window under a still camera without moving it', () => {
      render({ pose: at(29.7), arc: arc(-10, 151.5) })
      frame()
      // The look changed while the view was open: the cameras moved, not this one.
      render({ arc: arc(60, 200) })
      frame(30)
      expectPose(at(29.7))
      expect(limits()[0]).toBeCloseTo(29.7)
      expect(limits()[1]).toBeCloseTo(200)
    })

    it('sweeps back and forth within the arc instead of auto-rotating to an end', () => {
      render({ pose: at(29.7), arc: arc(20, 40), autoRotate: true })
      expect(controls().autoRotate).toBe(false)
      let low = Infinity,
        high = -Infinity,
        last = theta()
      for (let i = 0; i < 60 * 60; i++) {
        frame()
        const now = theta()
        // Moving every frame: never still long enough to start a trace it would drop.
        expect(now).not.toBe(last)
        expect(now).toBeGreaterThanOrEqual(20 - 1e-6)
        expect(now).toBeLessThanOrEqual(40 + 1e-6)
        low = Math.min(low, now)
        high = Math.max(high, now)
        last = now
      }
      expect(low).toBeCloseTo(20, 3)
      expect(high).toBeCloseTo(40, 3)
      // A drag holds it, and letting go draws again to carry on.
      drag('start')
      const held = theta()
      frame(30)
      expect(theta()).toBe(held)
      const invalidate = vi.mocked(state.three.invalidate as () => void)
      invalidate.mockClear()
      drag('end')
      expect(invalidate).toHaveBeenCalled()
      frame()
      expect(theta()).not.toBe(held)
    })

    it('leaves the orbit free without an arc, as on the legacy route', () => {
      window.history.replaceState(null, '', '/?arc=180')
      render({ pose: at(150), autoRotate: true })
      expect(limits()).toEqual([-Infinity, Infinity])
      expect(controls().rotateSpeed).toBe(1)
      expect(controls().autoRotate).toBe(true)
      render({ autoRotate: false })
      // More than a full turn, every step whole.
      for (let i = 0; i < 70; i++) {
        const before = theta()
        press('ArrowLeft')
        frame()
        expect(apart(theta(), before)).toBeCloseTo(0.1 / deg, 6)
      }
      render({ reset: 1 })
      frame(300)
      expectPose(at(150))
      expect(limits()).toEqual([-Infinity, Infinity])
      // Letting go of a drag draws nothing more than it did.
      const invalidate = vi.mocked(state.three.invalidate as () => void)
      invalidate.mockClear()
      drag('end')
      expect(invalidate).not.toHaveBeenCalled()
      window.history.replaceState(null, '', '/')
    })
  })
})
