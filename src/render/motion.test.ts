// @vitest-environment jsdom
import { PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { OrbitControls } from 'three-stdlib'
import { describe, expect, it } from 'vitest'
import { DAMPING, glideStep, motionPixels, settleGlide } from './motion'

const HEIGHT = 640

/** Orbit controls on a stand-in element, dragged 25 px a frame for 8 frames and released. */
function releasedDrag() {
  const listeners: Record<string, ((e: object) => void)[]> = {}
  const add = (type: string, fn: (e: object) => void) => (listeners[type] ??= []).push(fn)
  const doc = { addEventListener: add, removeEventListener() {} }
  const element = {
    style: {},
    addEventListener: add,
    removeEventListener() {},
    ownerDocument: doc,
    getRootNode: () => doc,
    clientWidth: 1000,
    clientHeight: HEIGHT,
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
  }
  const fire = (type: string, x: number) =>
    listeners[type]?.forEach((fn) =>
      fn({
        preventDefault() {},
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: x,
        clientY: 320,
      }),
    )
  const camera = new PerspectiveCamera(32, 1000 / HEIGHT, 0.1, 2000)
  camera.position.set(30, 18, 35)
  const controls = new OrbitControls(camera, element as unknown as HTMLElement)
  controls.enableDamping = true
  controls.dampingFactor = DAMPING
  controls.update()
  fire('pointerdown', 500)
  for (let i = 1; i <= 8; i++) {
    fire('pointermove', 500 + 25 * i)
    controls.update()
  }
  fire('pointerup', 700)
  return { camera, controls }
}

/** Frames until the camera is exactly still, updating as the scene would each frame. */
function framesToRest(settle: boolean) {
  const { camera, controls } = releasedDrag()
  const position = camera.position.clone()
  const quaternion = camera.quaternion.clone()
  let largestStop = 0
  for (let frame = 1; frame < 5000; frame++) {
    controls.update()
    const pixels = motionPixels(
      position,
      quaternion,
      camera.position,
      camera.quaternion,
      camera.position.distanceTo(controls.target),
      camera.fov,
      HEIGHT,
    )
    if (pixels === 0) return { frame, largestStop }
    if (settle) {
      const before = { p: camera.position.clone(), q: camera.quaternion.clone() }
      if (settleGlide(controls, pixels)) {
        const jump = motionPixels(
          before.p,
          before.q,
          camera.position,
          camera.quaternion,
          camera.position.distanceTo(controls.target),
          camera.fov,
          HEIGHT,
        )
        largestStop = Math.max(largestStop, jump)
      }
    }
    position.copy(camera.position)
    quaternion.copy(camera.quaternion)
  }
  return { frame: Infinity, largestStop }
}

describe('camera rest after an orbit', () => {
  it('measures image motion in pixels', () => {
    const p = new Vector3(0, 0, 10)
    const q = new Quaternion()
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (32 * Math.PI) / 180)
    // Turning by the whole vertical field of view moves the image by the canvas height.
    expect(motionPixels(p, q, p, turned, 10, 32, HEIGHT)).toBeCloseTo(HEIGHT, 3)
    expect(motionPixels(p, q, p, q, 10, 32, HEIGHT)).toBe(0)
  })

  it('classifies glide, tail, and stop', () => {
    expect(glideStep(3)).toBe('glide')
    expect(glideStep(0.3)).toBe('tail')
    expect(glideStep(0.01)).toBe('stop')
  })

  it("left alone, OrbitControls' damping keeps the camera moving for hundreds of frames", () => {
    expect(framesToRest(false).frame).toBeGreaterThan(500)
  })

  it('settles the glide within a few frames of it becoming invisible, without a visible jump', () => {
    const { frame, largestStop } = framesToRest(true)
    expect(frame).toBeLessThan(160)
    expect(largestStop).toBeLessThan(0.25)
  })
})
