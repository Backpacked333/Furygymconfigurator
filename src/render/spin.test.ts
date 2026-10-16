// @vitest-environment jsdom
import { Matrix4, Scene, Vector3 } from 'three/webgpu'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkyLook } from '../lib/visuals'
import { Busy, Full, Outdated, Superseded, type CloudCamera, type CloudClient } from './cloud'
import { ORBIT_LIMITS } from './orbit'
import {
  DEFAULT_LEVEL,
  LOADING_TIMEOUT_MS,
  NEAR,
  SPIN_LEVELS,
  SPIN_STEPS,
  SpinSession,
  levelOrbit,
  nearestSpinPose,
  panoramaUV,
  ringOrder,
  specFrom,
  spinCamera,
  spinPosition,
  type MeterRaster,
  type SpinState,
} from './spin'

// The session's scene capture is stubbed: these tests cover scheduling.
vi.mock('./cloud', async (original) => ({
  ...(await original<typeof import('./cloud')>()),
  captureScene: vi.fn(async () => ({})),
}))

const target = new Vector3(1, 4, -2)
const spec = specFrom(new Vector3(1, 14, 38), target)
const STEP = (2 * Math.PI) / SPIN_STEPS

describe('spin geometry', () => {
  it('rests on the framed view at the default level', () => {
    const pose = nearestSpinPose(spec, spinPosition(spec, { level: DEFAULT_LEVEL, azimuth: 0 }))
    expect(pose).toEqual({ level: DEFAULT_LEVEL, azimuth: 0 })
    expect(spinPosition(spec, pose).distanceTo(new Vector3(1, 14, 38))).toBeCloseTo(0, 6)
  })

  it('round-trips every frame of every level', () => {
    for (let level = 0; level < SPIN_LEVELS.length; level++)
      for (let azimuth = 0; azimuth < SPIN_STEPS; azimuth++)
        expect(nearestSpinPose(spec, spinPosition(spec, { level, azimuth }))).toEqual({
          level,
          azimuth,
        })
  })

  it('picks the nearest azimuth and wraps around', () => {
    const near = (theta: number) => {
      const { radius, polar } = levelOrbit(spec, DEFAULT_LEVEL)
      return new Vector3(
        radius * Math.sin(polar) * Math.sin(theta),
        radius * Math.cos(polar),
        radius * Math.sin(polar) * Math.cos(theta),
      ).add(target)
    }
    expect(nearestSpinPose(spec, near(10.4 * STEP)).azimuth).toBe(10)
    expect(nearestSpinPose(spec, near(10.6 * STEP)).azimuth).toBe(11)
    expect(nearestSpinPose(spec, near(-0.4 * STEP)).azimuth).toBe(0)
    expect(nearestSpinPose(spec, near(-1 * STEP)).azimuth).toBe(SPIN_STEPS - 1)
  })

  it('keeps every level within the orbit limits', () => {
    const far = specFrom(new Vector3(0, 10, 160), new Vector3())
    expect(levelOrbit(far, 2).radius).toBe(ORBIT_LIMITS.maxDistance)
    const high = specFrom(new Vector3(0, 100, 1), new Vector3())
    expect(levelOrbit(high, 2).polar).toBe(ORBIT_LIMITS.minPolarAngle)
  })

  it('looks at the target from the frame position', () => {
    const camera = spinCamera(spec, { level: 0, azimuth: 9 }, { fov: 34, near: 0.1, far: 900 })
    const matrix = new Matrix4().fromArray(camera.matrix)
    const eye = new Vector3().setFromMatrixPosition(matrix)
    expect(eye.distanceTo(spinPosition(spec, { level: 0, azimuth: 9 }))).toBeCloseTo(0, 6)
    // A camera looks down its -Z axis.
    const forward = new Vector3(0, 0, -1).transformDirection(matrix)
    expect(forward.dot(target.clone().sub(eye).normalize())).toBeCloseTo(1, 6)
  })

  it('orders a ring nearest first, alternating sides', () => {
    const order = ringOrder(0)
    expect(order.slice(0, 5)).toEqual([0, 1, SPIN_STEPS - 1, 2, SPIN_STEPS - 2])
    expect(new Set(order).size).toBe(SPIN_STEPS)
  })

  it("maps directions as Cycles' equirectangular camera does", () => {
    expect(panoramaUV(new Vector3(0, 0, -1))).toEqual({ u: 0.5, v: 0.5 })
    expect(panoramaUV(new Vector3(1, 0, 0)).u).toBeCloseTo(0.75, 6)
    expect(panoramaUV(new Vector3(-1, 0, 0)).u).toBeCloseTo(0.25, 6)
    expect(panoramaUV(new Vector3(0, 1, 0)).v).toBeCloseTo(0, 6)
    expect(panoramaUV(new Vector3(0, -1, 0)).v).toBeCloseTo(1, 6)
  })
})

type FrameRequest = {
  priority: number
  generation: number
  width: number
  height: number
  camera: { matrix: number[]; panorama?: boolean }
  finish: { exposure: number; gain: number }
  quality: { samples: number }
  channel?: string
}

/**
 * A client that records frame requests and answers them when told to. The exposure meter's
 * frames (channel "m") answer at once, with a traced key of 0.
 */
function fakeClient() {
  const requests: { request: FrameRequest; resolve: () => void }[] = []
  const meters: { request: FrameRequest; signal: AbortSignal }[] = []
  const answer = { image: new Blob(['x']), cached: false, renderMs: 1, totalMs: 1, tracedKey: 0 }
  const frame = vi.fn((_captured: unknown, request: FrameRequest, signal: AbortSignal) => {
    if (request.channel === 'm') {
      meters.push({ request, signal })
      return Promise.resolve(answer)
    }
    return new Promise((resolve) => requests.push({ request, resolve: () => resolve(answer) }))
  })
  return { client: { frame } as unknown as CloudClient, requests, meters }
}

const look = { environment: 'meadow', sunlight: { direction: [0, 1, 0] }, night: 0 } as never
const lens = { fov: 34, near: 0.1, far: 900 }
function spinState(active: 'exterior' | 'interior', azimuth = 5): SpinState {
  return {
    active,
    exterior: { spec, pose: { level: DEFAULT_LEVEL, azimuth }, width: 1200, height: 800, lens },
    interior: {
      eye: new Vector3(0, 1.6, 0),
      width: 4096,
      lens,
      view: { matrix: new Matrix4().makeTranslation(0, 1.6, 0).toArray(), ...lens },
    },
    exposure: { exterior: 1, interior: 1.6 },
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
/** What a frame request is for: an azimuth or the panorama, as a preview or at full quality. */
const label = (r: FrameRequest) =>
  `${
    r.camera.panorama
      ? 'panorama'
      : nearestSpinPose(
          spec,
          new Vector3().setFromMatrixPosition(new Matrix4().fromArray(r.camera.matrix)),
        ).azimuth
  } ${r.quality.samples === 64 ? 'preview' : 'final'}`
/** Answers the oldest open request, as one GPU would, `count` times; the labels answered. */
async function answer(requests: ReturnType<typeof fakeClient>['requests'], count: number) {
  const answered: string[] = []
  for (let i = 0; i < count; i++) {
    const next = requests.shift()!
    answered.push(label(next.request))
    next.resolve()
    await settle()
  }
  return answered
}
/** Decodes frames without a browser: any blob is a 1×1 image. */
const stubBitmaps = () =>
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1, height: 1, close() {} })),
  )
/** The raster meter at the camera asked for, as RenderEffects measures it. */
const raster = (key: number, at: CloudCamera | null = null) => ({
  key,
  camera: at ?? { matrix: new Matrix4().toArray(), ...lens },
  width: 900,
  height: 600,
})

describe('spin session', () => {
  let scene: Scene
  beforeEach(() => {
    scene = new Scene()
  })

  it('meters once, then renders the visible frame, then the angles nearest it', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    // A frame for each view meters its exposure, at the raster frame's size, before any other is
    // requested: outside at the visitor's frame, inside at the interior's view.
    expect(meters).toHaveLength(2)
    expect([meters[0].request.width, meters[0].request.height]).toEqual([900, 600])
    const outside = spinCamera(spec, { level: DEFAULT_LEVEL, azimuth: 5 }, lens)
    expect(meters[0].request.camera.matrix).toEqual(outside.matrix)
    expect(meters[1].request.camera.matrix).toEqual(spinState('exterior').interior.view.matrix)
    const sent = requests.map((r) => r.request)
    // One GPU: three requests open at once, so the next one asked for is the one most wanted.
    expect(sent).toHaveLength(3)
    // The visible frame as a preview and at full quality, then previews around it.
    expect(sent.map((r) => r.priority)).toEqual([0, 0, 1])
    expect(sent.map(label)).toEqual(['5 preview', '5 final', '6 preview'])
    // Another design in the same light keeps the gains.
    session.sync(scene, look as SkyLook, 'design-b', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    expect(meters).toHaveLength(2)
    session.dispose()
  })

  it('matches the raster brightness, even when the view changes while metering', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    // The exterior ring is framed a moment after the session starts.
    const start = { ...spinState('exterior'), exterior: null }
    session.sync(scene, look as SkyLook, 'design-a', start, async (at) => raster(Math.log(2), at))
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(Math.log(2), at),
    )
    await settle()
    expect(meters[0].signal.aborted).toBe(false)
    // The traced key is 0, the raster's log 2: twice as bright.
    expect(requests[0].request.finish.gain).toBeCloseTo(2, 6)
    session.dispose()
  })

  it('meters again when the design changes while metering', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async () => {
      await held
      return raster(Math.log(3))
    })
    session.sync(scene, look as SkyLook, 'design-b', spinState('exterior'), async (at) =>
      raster(Math.log(2), at),
    )
    release()
    await settle()
    await settle()
    // Only design B's meter counts: its frames have its gain.
    expect(meters).toHaveLength(4)
    expect(new Set(requests.map((r) => r.request.finish.gain.toFixed(3)))).toEqual(
      new Set(['2.000']),
    )
    session.dispose()
  })

  it('renders the panorama first when the visitor is inside', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('interior'), async (at) =>
      raster(0, at),
    )
    await settle()
    const first = requests[0].request
    expect(first.camera.panorama).toBe(true)
    expect(first.width).toBe(2 * first.height)
    session.dispose()
  })

  it('drops frames of a design that changed while they rendered', async () => {
    const { client, requests } = fakeClient()
    let changes = 0
    const session = new SpinSession(client, () => changes++)
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    const before = requests.length
    session.sync(scene, look as SkyLook, 'design-b', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    // The new design's frames are requested under a newer generation.
    const generations = requests.map((r) => r.request.generation)
    expect(Math.max(...generations.slice(before))).toBeGreaterThan(generations[0])
    requests[0].resolve()
    await settle()
    expect(changes).toBe(0)
    // A frame of the current design counts.
    requests[before].resolve()
    await settle()
    expect(changes).toBe(1)
    session.dispose()
  })

  it('waits out a busy server without giving up', async () => {
    const meters: FrameRequest[] = []
    let asked = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') {
        meters.push(request)
        return { image: new Blob(['x']), cached: false, renderMs: 1, totalMs: 1, tracedKey: 0 }
      }
      asked++
      throw new Busy('cloud renderer busy (503)')
    })
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    await settle()
    // Each open request was turned away once; none is asked again at once, and it is no failure.
    expect(asked).toBe(3)
    expect(session.progress.failed).toBe(false)
    session.dispose()
  })

  it('gives up waiting a minute and a half after opening, scene loading included', async () => {
    const { client } = fakeClient()
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const session = new SpinSession(client, () => {})
    const meter: MeterRaster = async (at) => raster(0, at)
    // Textures load for 20 s before the design is known.
    session.sync(scene, look as SkyLook, '', spinState('exterior'), meter, false)
    session.texture()
    now.mockReturnValue(21_000)
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), meter)
    session.texture()
    expect(session.progress.loading).toBe(true)
    now.mockReturnValue(1000 + LOADING_TIMEOUT_MS + 1)
    session.texture()
    expect(session.progress.loading).toBe(false)
    // The interior's first visit waits anew.
    session.sync(scene, look as SkyLook, 'design-a', spinState('interior'), meter)
    session.texture()
    expect(session.progress.loading).toBe(true)
    now.mockRestore()
    session.dispose()
  })

  it('gives up at once on a server that predates the spin', async () => {
    let asked = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm')
        return { image: new Blob(['x']), cached: false, renderMs: 1, totalMs: 1, tracedKey: 0 }
      asked++
      throw new Outdated('old server')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let changes = 0
    const session = new SpinSession({ frame } as unknown as CloudClient, () => changes++)
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    await settle()
    expect(session.progress.failed).toBe(true)
    expect(changes).toBeGreaterThan(0)
    // The requests already open were all it sent; nothing more is asked of it.
    expect(asked).toBe(3)
    warn.mockRestore()
    session.dispose()
  })

  it('gives up when the exposure meter finds an outdated server', async () => {
    const frame = vi.fn(async () => {
      throw new Outdated('old server')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    await settle()
    expect(session.progress.failed).toBe(true)
    expect(frame).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    session.dispose()
  })

  it('gives up on a frame that is not an image', async () => {
    const { client, requests } = fakeClient()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('not an image'))),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    requests[0].resolve()
    await settle()
    expect(session.texture()).toBeNull()
    await settle()
    expect(session.progress.failed).toBe(true)
    warn.mockRestore()
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('pauses while the page is hidden', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    expect(requests).toHaveLength(0)
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(requests).toHaveLength(3)
    hidden.mockRestore()
    session.dispose()
  })

  it("renders the visitor's frame, the angles near it, the panorama's preview, then the rest", async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    expect(await answer(requests, 21)).toEqual([
      '5 preview',
      '5 final',
      // What the loading screen waits for: the angles either side, as previews.
      ...['6', '4', '7', '3', '8', '2', '9', '1'].map((a) => `${a} preview`),
      // Stepping inside soon shows a path-traced view too.
      'panorama preview',
      // Then the near angles at full quality, and the rest of the ring nearest first.
      ...['6', '4', '7', '3', '8', '2', '9', '1'].map((a) => `${a} final`),
      '10 preview',
      '0 preview',
    ])
    session.dispose()
  })

  it('renders next wherever the visitor turns to', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    const meter: MeterRaster = async (at) => raster(0, at)
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), meter)
    await settle()
    const before = requests.slice(0, 2).map((r) => r.request)
    await answer(requests, 3)
    // Three requests from the old plan are open; the angle turned to is asked for at once, on the
    // visitor's channel with a newer sequence, so the server drops what is queued for the old one.
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior', 30), meter)
    await settle()
    const asked = requests.slice(3).map((r) => r.request)
    expect(asked.map(label)).toEqual(['30 preview', '30 final'])
    expect(asked.every((r) => r.channel === 'f')).toBe(true)
    expect(before.every((r) => r.channel === 'f')).toBe(true)
    expect(asked[0].generation).toBeGreaterThan(before[0].generation)
    // As the old plan's requests are answered, the angles near the new one follow, three open in
    // all, so a GPU's queue stays short.
    await answer(requests, 3)
    expect(requests.map((r) => label(r.request))).toEqual(['30 preview', '30 final', '31 preview'])
    session.dispose()
  })

  it('opens once the view is final and the angles near it are ready', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    session.texture()
    expect(session.progress).toMatchObject({ loading: true, waitReady: 0, waitTotal: 1 + 2 * NEAR })
    // The view's preview, its final, and all but one of the near angles.
    await answer(requests, 1 + 2 * NEAR)
    session.texture()
    expect(session.progress).toMatchObject({ loading: true, waitReady: 2 * NEAR })
    await answer(requests, 1)
    session.texture()
    expect(session.progress).toMatchObject({ loading: false, waitReady: 1 + 2 * NEAR })
    // The badge still counts the whole ring.
    expect(session.progress.total).toBe(SPIN_STEPS)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('shows the nearest ready angle until the one turned to arrives', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    const meter: MeterRaster = async (at) => raster(0, at)
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), meter)
    await settle()
    await answer(requests, 2)
    // Turned three steps: angle 8 has no frame yet, so angle 5 stands in for it.
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior', 8), meter)
    session.texture()
    await settle()
    const standIn = session.texture()!
    expect(standIn.key.endsWith('|5')).toBe(true)
    expect(session.isFocus(standIn)).toBe(false)
    while (!requests.some((r) => label(r.request) === '8 preview')) await answer(requests, 1)
    const eight = requests.findIndex((r) => label(r.request) === '8 preview')
    requests.splice(eight, 1)[0].resolve()
    await settle()
    session.texture()
    await settle()
    const own = session.texture()!
    expect(own.key.endsWith('|8')).toBe(true)
    expect(session.isFocus(own)).toBe(true)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('takes a frame the server dropped for an angle turned past as no failure', async () => {
    let asked = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm')
        return { image: new Blob(['x']), cached: false, renderMs: 1, totalMs: 1, tracedKey: 0 }
      if (asked++ < 3) throw new Superseded()
      return new Promise(() => {})
    })
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    await settle()
    expect(session.progress.failed).toBe(false)
    // Each dropped request made way for the next one wanted.
    expect(asked).toBeGreaterThan(3)
    session.dispose()
  })

  it('renders on this device at once when every cloud GPU is in use', async () => {
    let asked = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm')
        return { image: new Blob(['x']), cached: false, renderMs: 1, totalMs: 1, tracedKey: 0 }
      asked++
      throw new Full('every cloud GPU is in use')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), async (at) =>
      raster(0, at),
    )
    await settle()
    await settle()
    expect(session.progress.failed).toBe(true)
    expect(asked).toBe(3)
    warn.mockRestore()
    session.dispose()
  })

  it('holds the design while the scene is still loading', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    const meter: MeterRaster = async (at) => raster(0, at)
    // Nothing starts before the scene has settled once.
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), meter, false)
    await settle()
    expect(meters).toHaveLength(0)
    session.sync(scene, look as SkyLook, 'design-a', spinState('exterior'), meter)
    await settle()
    // A change arriving with textures still loading keeps the frames of the design on screen,
    // following the view: the ring's requests keep the design's generation.
    const ring = (r: FrameRequest) => r.channel === undefined
    const generation = requests.map((r) => r.request).find(ring)!.generation
    session.sync(scene, look as SkyLook, 'design-b', spinState('exterior', 9), meter, false)
    requests[0].resolve()
    await settle()
    const turned = requests.map((r) => r.request)
    expect(turned.filter(ring).every((r) => r.generation === generation)).toBe(true)
    // The angle turned to is asked for at once.
    expect(turned.filter((r) => r.channel === 'f').map(label)).toContain('9 preview')
    expect(meters).toHaveLength(2)
    expect(session.progress.failed).toBe(false)
    session.dispose()
  })
})
