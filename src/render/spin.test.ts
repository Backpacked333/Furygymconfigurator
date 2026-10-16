// @vitest-environment jsdom
import { Matrix4, Scene, Vector3 } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkyLook } from '../lib/visuals'
import { Busy, Full, Outdated, Superseded, type CloudCamera, type CloudClient } from './cloud'
import { ORBIT_LIMITS } from './orbit'
import { planJobs } from './plan'
import {
  DEFAULT_LEVEL,
  GATE_MAX_MS,
  METER_DEBOUNCE_MS,
  SPIN_LEVELS,
  SPIN_STEPS,
  SpinSession,
  frameSize,
  levelOrbit,
  nearestSpinPose,
  panoramaUV,
  ringOrder,
  specFrom,
  spinCamera,
  spinPosition,
  turnDirection,
  type MeterRaster,
  type SceneKeys,
  type SpinState,
} from './spin'

// The session's scene capture is stubbed: these tests cover scheduling.
vi.mock('./cloud', async (original) => ({
  ...(await original<typeof import('./cloud')>()),
  captureScene: vi.fn(async () => ({})),
}))
// The plan is watched: it must not be rebuilt for a frame that changed nothing.
vi.mock('./plan', async (original) => {
  const actual = await original<typeof import('./plan')>()
  return { ...actual, planJobs: vi.fn(actual.planJobs) }
})

const target = new Vector3(1, 4, -2)
const spec = specFrom(new Vector3(1, 14, 38), target)
const STEP = (2 * Math.PI) / SPIN_STEPS

describe('spin geometry', () => {
  it('is a ring of 36 angles at two distances, resting on the framed view', () => {
    expect(SPIN_STEPS).toBe(36)
    expect(SPIN_LEVELS).toHaveLength(2)
    expect(DEFAULT_LEVEL).toBe(1)
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
    const far = specFrom(new Vector3(0, 10, 200), new Vector3())
    expect(levelOrbit(far, 1).radius).toBe(ORBIT_LIMITS.maxDistance)
    const close = specFrom(new Vector3(0, 3, 9.5), new Vector3())
    expect(levelOrbit(close, 0).radius).toBe(ORBIT_LIMITS.minDistance)
    const high = specFrom(new Vector3(0, 100, 1), new Vector3())
    expect(levelOrbit(high, 1).polar).toBe(ORBIT_LIMITS.minPolarAngle)
    const low = specFrom(new Vector3(0, 0.5, 40), new Vector3())
    expect(levelOrbit(low, 0).polar).toBe(ORBIT_LIMITS.maxPolarAngle)
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

  it('tells which way round a turn goes', () => {
    expect(turnDirection(5, 6)).toBe(1)
    expect(turnDirection(5, 4)).toBe(-1)
    expect(turnDirection(5, 5)).toBe(0)
    expect(turnDirection(SPIN_STEPS - 1, 0)).toBe(1)
    expect(turnDirection(0, SPIN_STEPS - 1)).toBe(-1)
  })

  it('sizes previews at CSS pixels and the other tiers at device pixels, capped', () => {
    const retina = { width: 2880, height: 1800, dpr: 2 }
    expect(frameSize('preview', retina)).toEqual({ width: 1200, height: 750 })
    expect(frameSize('good', retina)).toEqual({ width: 1920, height: 1200 })
    expect(frameSize('final', retina)).toEqual({ width: 2880, height: 1800 })
    expect(frameSize('final', { width: 4000, height: 2500, dpr: 1 })).toEqual({
      width: 3200,
      height: 2000,
    })
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

const answerFrame = () => ({
  image: new Blob(['x']),
  cached: false,
  renderMs: 1,
  finishMs: 1,
  totalMs: 1,
  tracedKey: 0,
})

/**
 * A client that records frame requests (with the signal each may be dropped by) and answers them
 * when told to. The exposure meter's frames (channel "m") answer at once, with a traced key of 0.
 * `fake.warm` is the cloud's warmth as the session reads it.
 */
function fakeClient() {
  const requests: { request: FrameRequest; signal: AbortSignal; resolve: () => void }[] = []
  const meters: { request: FrameRequest; signal: AbortSignal }[] = []
  const frame = vi.fn((_captured: unknown, request: FrameRequest, signal: AbortSignal) => {
    if (request.channel === 'm') {
      meters.push({ request, signal })
      return Promise.resolve(answerFrame())
    }
    return new Promise((resolve) =>
      requests.push({ request, signal, resolve: () => resolve(answerFrame()) }),
    )
  })
  const fake = { frame, warm: false }
  return { client: fake as unknown as CloudClient, fake, requests, meters }
}

const look = { environment: 'meadow', sunlight: { direction: [0, 1, 0] }, night: 0 } as never
/** A design's scene keys: the same scene outside and in, unless one view's own is given. */
const design = (key: string, over: Partial<SceneKeys> = {}): SceneKeys => ({
  exterior: key,
  interior: key,
  ...over,
})
const lens = { fov: 34, near: 0.1, far: 900 }
function spinState(
  active: 'exterior' | 'interior',
  azimuth = 5,
  over: Partial<SpinState> = {},
): SpinState {
  return {
    active,
    width: 1200,
    height: 800,
    dpr: 1,
    exterior: { spec, pose: { level: DEFAULT_LEVEL, azimuth }, lens },
    interior: {
      eye: new Vector3(0, 1.6, 0),
      width: 4096,
      lens,
      view: { matrix: new Matrix4().makeTranslation(0, 1.6, 0).toArray(), ...lens },
    },
    exposure: { exterior: 1, interior: 1.6 },
    drift: 0,
    idle: true,
    ...over,
  }
}
/** Lets timers up to `ms` from now fire, and everything they settle. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
/** Lets the exposure meter run: it waits for the design to hold still first. */
const metered = async () => {
  await tick(METER_DEBOUNCE_MS)
  await tick()
}
/** What a frame request is for: a pose (level/azimuth) or the panorama, at which tier. */
const label = (r: FrameRequest) => {
  const tier = r.quality.samples === 64 ? 'preview' : r.quality.samples === 256 ? 'good' : 'final'
  if (r.camera.panorama) return `panorama ${tier}`
  const pose = nearestSpinPose(
    spec,
    new Vector3().setFromMatrixPosition(new Matrix4().fromArray(r.camera.matrix)),
  )
  return `${pose.level === DEFAULT_LEVEL ? '' : `${pose.level}/`}${pose.azimuth} ${tier}`
}
/** Answers the oldest open request, as one GPU would, `count` times; the labels answered. */
async function answer(requests: ReturnType<typeof fakeClient>['requests'], count: number) {
  const answered: string[] = []
  for (let i = 0; i < count; i++) {
    const next = requests.shift()!
    answered.push(label(next.request))
    next.resolve()
    await tick()
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
const meter: MeterRaster = async (at) => raster(0, at)

describe('spin session', () => {
  let scene: Scene
  beforeEach(() => {
    scene = new Scene()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('meters the first design at once, then renders the visible frame and the angles nearest it', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    // The page's first design is metered without waiting for it to hold still (a later design
    // waits, as a slider drag is a run of them), so its first preview is not held back.
    await tick()
    await tick()
    // A frame for each view meters its exposure, at the raster frame's size, before any other is
    // requested: outside at the visitor's frame, inside at the interior's view.
    expect(meters).toHaveLength(2)
    expect([meters[0].request.width, meters[0].request.height]).toEqual([900, 600])
    const outside = spinCamera(spec, { level: DEFAULT_LEVEL, azimuth: 5 }, lens)
    expect(meters[0].request.camera.matrix).toEqual(outside.matrix)
    expect(meters[1].request.camera.matrix).toEqual(spinState('exterior').interior.view.matrix)
    const sent = requests.map((r) => r.request)
    // The visible frame goes out at once on the visitor's channel; three more keep one GPU busy,
    // so the next one asked for is the one most wanted.
    expect(sent).toHaveLength(4)
    expect(sent.map(label)).toEqual(['5 preview', '6 preview', '4 preview', '7 preview'])
    expect(sent.map((r) => r.priority)).toEqual([0, 1, 1, 2])
    expect(sent.map((r) => r.channel)).toEqual(['f', 's', 's', 's'])
    // Previews are rendered at the screen's CSS size.
    expect([sent[0].width, sent[0].height]).toEqual([1200, 800])
    // Another design in the same light keeps the gains.
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), meter)
    await metered()
    expect(meters).toHaveLength(2)
    session.dispose()
  })

  it('matches the raster brightness, even when the view changes while metering', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    // The exterior ring is framed a moment after the session starts.
    const start = { ...spinState('exterior'), exterior: null }
    session.sync(scene, look as SkyLook, design('a'), start, async (at) => raster(Math.log(2), at))
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), async (at) =>
      raster(Math.log(2), at),
    )
    await metered()
    expect(meters).toHaveLength(2)
    expect(meters[0].signal.aborted).toBe(false)
    // The traced key is 0, the raster's log 2: twice as bright.
    expect(requests[0].request.finish.gain).toBeCloseTo(2, 6)
    session.dispose()
  })

  it('drops a meter under way when the design changes, and waits for the new one to hold still', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), async () => {
      await held
      return raster(Math.log(3))
    })
    // Design A's meter starts, and waits on the raster frame.
    await metered()
    expect(meters).toHaveLength(0)
    // A run of changes, as a slider drag makes: no meter until they stop for a moment.
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), async (at) =>
      raster(Math.log(2), at),
    )
    await tick(METER_DEBOUNCE_MS / 2)
    session.sync(scene, look as SkyLook, design('c'), spinState('exterior'), async (at) =>
      raster(Math.log(2), at),
    )
    await tick(METER_DEBOUNCE_MS / 2 + 1)
    expect(meters).toHaveLength(0)
    await metered()
    expect(meters).toHaveLength(2)
    // Design A's raster reading comes late: its chain was dropped, so it asks for no frame.
    release()
    await tick()
    expect(meters).toHaveLength(2)
    // Only design C's meter counts: its frames have its gain.
    expect(new Set(requests.map((r) => r.request.finish.gain.toFixed(3)))).toEqual(
      new Set(['2.000']),
    )
    session.dispose()
  })

  it('renders the panorama first, on a channel of its own, when the visitor is inside', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('interior'), meter)
    await metered()
    const first = requests[0].request
    expect(first.camera.panorama).toBe(true)
    expect(first.width).toBe(2 * first.height)
    expect(first.channel).toBe('p')
    expect(first.priority).toBe(0)
    // Then the panorama at good quality and the exterior, off the visitor's channel: three open
    // besides the panorama.
    expect(requests.slice(1).map((r) => label(r.request))).toEqual([
      'panorama good',
      '5 preview',
      '6 preview',
    ])
    expect(requests.slice(1).map((r) => r.request.channel)).toEqual(['p', 's', 's'])
    session.dispose()
  })

  it('drops frames of a design that changed while they rendered', async () => {
    const { client, requests } = fakeClient()
    let changes = 0
    const session = new SpinSession(client, () => changes++)
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    const before = requests.length
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), meter)
    await metered()
    // The new design's frames are requested under a newer generation.
    const generations = requests.map((r) => r.request.generation)
    expect(Math.max(...generations.slice(before))).toBeGreaterThan(generations[0])
    // Counted from here: the exposure meter's answer redrew once already (it tells the gate the
    // cloud is warm).
    const redrawn = changes
    requests[0].resolve()
    await tick()
    expect(changes).toBe(redrawn)
    // A frame of the current design counts.
    requests[before].resolve()
    await tick()
    expect(changes).toBe(redrawn + 1)
    session.dispose()
  })

  it('waits out a busy server, twice as long each time, and asks at once again after an answer', async () => {
    let asked = 0
    let answers = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') return answerFrame()
      asked++
      if (answers > 0) {
        answers--
        return answerFrame()
      }
      throw new Busy('cloud renderer busy (503)')
    })
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    // The first design is metered at once, so the clock on the wait starts here.
    await tick()
    await tick()
    // Each open request was turned away once; none is asked again at once, and it is no failure.
    expect(asked).toBe(4)
    expect(session.progress.failed).toBe(false)
    // Asked again after 2 s, then 4, 8, 16, and 30 at most.
    const waits = [2000, 4000, 8000, 16_000, 30_000, 30_000]
    for (const [i, wait] of waits.entries()) {
      await tick(wait - 1)
      expect(asked).toBe(4 * (i + 1))
      await tick(1)
      await tick()
      expect(asked).toBe(4 * (i + 2))
    }
    expect(session.progress.failed).toBe(false)
    // One frame comes: the wait starts over at 2 s for the next busy answer.
    answers = 1
    await tick(30_000)
    await tick()
    const after = asked
    await tick(2000)
    await tick()
    expect(asked).toBeGreaterThan(after)
    session.dispose()
  })

  it('meters again after a busy answer', async () => {
    const { client, fake, requests, meters } = fakeClient()
    let busy = 1
    fake.frame.mockImplementation((_captured: unknown, request: FrameRequest, signal) => {
      if (request.channel === 'm' && busy-- > 0) return Promise.reject(new Busy('busy'))
      if (request.channel === 'm') {
        meters.push({ request, signal })
        return Promise.resolve(answerFrame())
      }
      return new Promise((resolve) =>
        requests.push({ request, signal, resolve: () => resolve(answerFrame()) }),
      )
    })
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(meters).toHaveLength(0)
    expect(requests).toHaveLength(0)
    await tick(2000)
    await tick()
    expect(meters).toHaveLength(2)
    expect(requests.length).toBeGreaterThan(0)
    session.dispose()
  })

  // Replaces the minute-and-a-half wait: the page never blocks, so the clock only tells the gate
  // when a warm cloud's preview is no longer worth a short wait, and never restarts.
  it('counts the gate from the first design, not from each change or the other view', async () => {
    const { client } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter, false)
    await tick(2500)
    session.texture()
    expect(session.progress.gateMs).toBe(2500)
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), meter)
    await tick(17_500)
    session.texture()
    expect(session.progress).toMatchObject({ loading: true, gateMs: 20_000 })
    session.sync(scene, look as SkyLook, design('b'), spinState('interior'), meter)
    session.texture()
    expect(session.progress.gateMs).toBe(20_000)
    expect(GATE_MAX_MS).toBe(5000)
    session.dispose()
  })

  it('gives up at once on a server that predates the spin', async () => {
    let asked = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') return answerFrame()
      asked++
      throw new Outdated('old server')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let changes = 0
    const session = new SpinSession({ frame } as unknown as CloudClient, () => changes++)
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(session.progress.failed).toBe(true)
    expect(changes).toBeGreaterThan(0)
    // The requests already open were all it sent; nothing more is asked of it, not after an edit
    // or a new framing either: it gave up for the page.
    expect(asked).toBe(4)
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), meter)
    await metered()
    session.sync(
      scene,
      look as SkyLook,
      design('b'),
      spinState('exterior', 5, { width: 1200, height: 600 }),
      meter,
    )
    await metered()
    expect(asked).toBe(4)
    expect(session.progress).toMatchObject({ failed: true, loading: false })
    warn.mockRestore()
    session.dispose()
  })

  it('gives up when the exposure meter finds an outdated server', async () => {
    const frame = vi.fn(async () => {
      throw new Outdated('old server')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
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
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    requests[0].resolve()
    await tick()
    expect(session.texture()).toBeNull()
    await tick()
    expect(session.progress.failed).toBe(true)
    warn.mockRestore()
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('pauses while the page is hidden', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(requests).toHaveLength(0)
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()
    expect(requests).toHaveLength(4)
    hidden.mockRestore()
    session.dispose()
  })

  it("covers the visitor's ring outward from their frame before anything renders longer", async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(await answer(requests, 41)).toEqual([
      '5 preview',
      // The whole ring as previews, outward from the visitor's frame, so turning anywhere soon
      // shows a frame.
      ...[
        6, 4, 7, 3, 8, 2, 9, 1, 10, 0, 11, 35, 12, 34, 13, 33, 14, 32, 15, 31, 16, 30, 17, 29, 18,
        28, 19, 27, 20, 26, 21, 25, 22, 24, 23,
      ].map((a) => `${a} preview`),
      // The visitor's frame at good quality, once the previews around it were done; then the
      // panorama, so stepping inside shows a path-traced view too; then the other distance.
      '5 good',
      'panorama preview',
      '0/5 preview',
      '0/6 preview',
      '0/4 preview',
    ])
    session.dispose()
  })

  it('renders next wherever the visitor turns to', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    const before = requests[0].request
    await answer(requests, 3)
    // Three requests from the old plan are open; the angle turned to is asked for at once, on the
    // visitor's channel with a newer sequence, so the server drops what is queued for the old one.
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior', 30), meter)
    await tick()
    const asked = requests.slice(3).map((r) => r.request)
    expect(asked.map(label)).toEqual(['30 preview'])
    expect(asked[0].channel).toBe('f')
    expect(before.channel).toBe('f')
    expect(asked[0].generation).toBeGreaterThan(before.generation)
    // As the old plan's requests are answered, the angles near the new one follow, three open
    // besides the visitor's own, so a GPU's queue stays short.
    await answer(requests, 3)
    expect(requests.map((r) => label(r.request))).toEqual([
      '30 preview',
      '31 preview',
      '29 preview',
      '32 preview',
    ])
    session.dispose()
  })

  it('leads with the side the visitor is turning to', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior', 5, { drift: 1 }), meter)
    await metered()
    expect(requests.map((r) => label(r.request))).toEqual([
      '5 preview',
      '6 preview',
      '7 preview',
      '4 preview',
    ])
    session.dispose()
  })

  it('fetches ahead only once the visitor rests on the design', async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    // Still editing: only the frame they look at, and the panorama for a step inside.
    session.sync(
      scene,
      look as SkyLook,
      design('a'),
      spinState('exterior', 5, { idle: false }),
      meter,
    )
    await metered()
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    // Resting: the ring around them.
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await tick()
    expect(requests.map((r) => label(r.request))).toEqual([
      '5 preview',
      'panorama preview',
      '6 preview',
      '4 preview',
    ])
    // The floor plan opens (no frame runs to say so): nothing more goes ahead.
    await answer(requests, 1)
    session.setIdle(false)
    await answer(requests, 1)
    expect(requests.map((r) => label(r.request))).toEqual(['6 preview', '4 preview'])
    session.dispose()
  })

  it('builds the plan only when something it is made from changed', async () => {
    const plans = vi.mocked(planJobs)
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    plans.mockClear()
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    const built = plans.mock.calls.length
    expect(built).toBeGreaterThan(0)
    // Frames drawn with nothing changed reuse it.
    for (let i = 0; i < 5; i++)
      session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    expect(plans.mock.calls.length).toBe(built)
    // Turning rebuilds it, as does a frame landing.
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior', 6), meter)
    expect(plans.mock.calls.length).toBe(built + 1)
    await answer(requests, 1)
    expect(plans.mock.calls.length).toBeGreaterThan(built + 1)
    session.dispose()
  })

  it("asks for the full render only for an export, at once and on the visitor's channel", async () => {
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    const retina = spinState('exterior', 5, { dpr: 2 })
    session.sync(scene, look as SkyLook, design('a'), retina, meter)
    await metered()
    expect(requests.map((r) => label(r.request))).not.toContain('5 final')
    // The preview at CSS size.
    expect([requests[0].request.width, requests[0].request.height]).toEqual([600, 400])
    session.wantFinal(session.focusKey())
    await tick()
    const final = requests.find((r) => label(r.request) === '5 final')!.request
    expect(final).toMatchObject({ channel: 'f', priority: 0, width: 1200, height: 800 })
    // Nothing else goes out for it, and asking again changes nothing.
    const count = requests.length
    session.wantFinal(session.focusKey())
    session.wantFinal(null)
    await tick()
    expect(requests).toHaveLength(count)
    // Inside, the panorama's full render, on its channel.
    session.sync(scene, look as SkyLook, design('a'), spinState('interior'), meter)
    session.wantFinal(session.focusKey())
    await tick()
    const panorama = requests.find((r) => label(r.request) === 'panorama final')!.request
    expect(panorama).toMatchObject({ channel: 'p', priority: 0 })
    session.dispose()
  })

  it('keeps every frame through a resize at the same aspect, none through a new one', async () => {
    stubBitmaps()
    const plans = vi.mocked(planJobs)
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    await answer(requests, 1)
    session.texture()
    await tick()
    expect(session.texture()).not.toBeNull()
    const key = session.focusKey()
    const open = requests.length
    const built = plans.mock.calls.length
    // Smaller at the same aspect, and at another pixel density: the frames stay and the requests
    // open stay open; the next one is at the new size.
    session.sync(
      scene,
      look as SkyLook,
      design('a'),
      spinState('exterior', 5, { width: 600, height: 400 }),
      meter,
    )
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior', 5, { dpr: 2 }), meter)
    await tick()
    expect(session.focusKey()).toBe(key)
    expect(session.texture()).not.toBeNull()
    expect(requests).toHaveLength(open)
    // The plan is sized when it is made, so each new size makes it again (whether or not a
    // frame lands in between), and nothing queued goes out at the old size.
    expect(plans.mock.calls.length).toBe(built + 2)
    await answer(requests, 1)
    const next = requests[requests.length - 1].request
    expect([next.width, next.height]).toEqual([600, 400])
    // A new aspect reframes the view: its frames are gone.
    session.sync(
      scene,
      look as SkyLook,
      design('a'),
      spinState('exterior', 5, { width: 1200, height: 600 }),
      meter,
    )
    expect(session.focusKey()).not.toBe(key)
    expect(session.texture()).toBeNull()
    vi.unstubAllGlobals()
    session.dispose()
  })

  // Replaces "opens once the view is final and the angles near it are ready": the live view
  // shows at once, and the gate waits for nothing but the visitor's own preview.
  it("is loading only until the preview of the visitor's frame is on screen", async () => {
    stubBitmaps()
    const { client, fake, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    session.texture()
    // A cold cloud: the App shows no gate, whatever `loading` says.
    expect(session.progress).toMatchObject({ loading: true, warm: false, ready: 0 })
    fake.warm = true
    await answer(requests, 1)
    // Stored is not on screen: decoded is.
    session.texture()
    expect(session.progress).toMatchObject({ loading: true, warm: true, ready: 1 })
    await tick()
    session.texture()
    expect(session.progress).toMatchObject({ loading: false, good: 0 })
    // The badge counts the whole ring.
    expect(session.progress.total).toBe(SPIN_STEPS)
    // The interior's first visit does not start loading again for the gate's sake.
    session.sync(scene, look as SkyLook, design('a'), spinState('interior'), meter)
    session.texture()
    expect(session.progress).toMatchObject({ loading: true, ready: 0, total: 1 })
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('shows the better frame even when its preview is still decoding when it lands', async () => {
    const bitmaps: (() => void)[] = []
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise((resolve) =>
            bitmaps.push(() => resolve({ width: 1, height: 1, close() {} })),
          ),
      ),
    )
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    // An export asks for the full render alongside.
    session.wantFinal(session.focusKey())
    await tick()
    await answer(requests, 1)
    session.texture()
    expect(bitmaps).toHaveLength(1)
    // The full frame lands while the preview decodes: it decodes too, without waiting.
    const final = requests.findIndex((r) => label(r.request) === '5 final')
    requests.splice(final, 1)[0].resolve()
    await tick()
    session.texture()
    expect(bitmaps).toHaveLength(2)
    // The preview finishes first, late: dropped, since the full frame is on its way.
    bitmaps[0]()
    await tick()
    expect(session.texture()).toBeNull()
    bitmaps[1]()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'final', provisional: false })
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('tells RenderEffects which frame may stay on screen through a design change', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    // The visitor's frame as a preview.
    await answer(requests, 1)
    session.texture()
    await tick()
    const shown = session.texture()!
    expect(shown.tier).toBe('preview')
    expect(session.focusKey()).toBe(shown.key)
    expect(session.currentDesign()).toBe(shown.design)
    expect(session.isCurrent(shown)).toBe(true)
    expect(session.isFocus(shown)).toBe(true)
    // The design changes at the same pose: nothing of it is decoded yet, but the frame on screen
    // is for the pose, so RenderEffects keeps it until its replacement lands.
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), meter)
    expect(session.texture()).toBeNull()
    expect(session.focusKey()).toBe(shown.key)
    // Kept on screen, but never an export: a final at the focus pose satisfies one only when it
    // is of the current design (RenderEffects compares all three), so the held frame of the
    // design before does not.
    expect(session.currentDesign()).not.toBe(shown.design)
    expect(session.isCurrent(shown)).toBe(false)
    // Turned to another angle: no frame of it either, and the one on screen is not for it, so
    // the live view shows instead.
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior', 8), meter)
    expect(session.texture()).toBeNull()
    expect(session.focusKey()).not.toBe(shown.key)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('renders again only the view an edit touched: the panorama for the room, the ring for outside', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('interior'), meter)
    await metered()
    expect(requests.map((r) => label(r.request))).toEqual([
      'panorama preview',
      'panorama good',
      '5 preview',
      '6 preview',
    ])
    const [first, good] = requests
    await answer(requests, 1)
    // The visitor's exterior frame lands too, and is decoded for a step outside.
    const five = requests.findIndex((r) => label(r.request) === '5 preview')
    requests.splice(five, 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()?.key.startsWith('i|')).toBe(true)
    const ring = requests.filter((r) => !r.request.camera.panorama)
    expect(ring.map((r) => label(r.request))).toEqual(['6 preview', '4 preview'])
    // The flooring changes: the panorama on screen is of the room before, so it goes, and so does
    // its good frame still rendering; both are asked for again under a newer generation on its
    // channel, while the ring's requests stay open and its stored frame stays.
    session.sync(
      scene,
      look as SkyLook,
      design('a', { interior: 'b' }),
      spinState('interior'),
      meter,
    )
    await tick()
    expect(session.texture()).toBeNull()
    expect(good.signal.aborted).toBe(true)
    expect(ring.every((r) => !r.signal.aborted)).toBe(true)
    const again = requests.filter((r) => r.request.camera.panorama && !r.signal.aborted)
    expect(again.map((r) => label(r.request))).toEqual(['panorama preview', 'panorama good'])
    expect(again[0].request.channel).toBe('p')
    expect(again[0].request.generation).toBeGreaterThan(first.request.generation)
    expect(requests.filter((r) => !r.request.camera.panorama)).toEqual(ring)
    // A step outside shows the frame rendered before the edit, still current, with no new request
    // for it.
    session.sync(
      scene,
      look as SkyLook,
      design('a', { interior: 'b' }),
      spinState('exterior'),
      meter,
    )
    await tick()
    const outside = session.texture()!
    expect(outside.key.endsWith('|5')).toBe(true)
    expect(session.isCurrent(outside)).toBe(true)
    expect(session.isFocus(outside)).toBe(true)
    expect(requests.filter((r) => label(r.request) === '5 preview')).toHaveLength(0)
    session.sync(
      scene,
      look as SkyLook,
      design('a', { interior: 'b' }),
      spinState('interior'),
      meter,
    )
    again[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()?.key.startsWith('i|')).toBe(true)
    // The facade changes: the ring's requests are dropped and made again under a newer generation;
    // the panorama stays on screen, still current, its requests untouched.
    session.sync(
      scene,
      look as SkyLook,
      design('c', { interior: 'b' }),
      spinState('interior'),
      meter,
    )
    await tick()
    const panorama = session.texture()!
    expect(panorama.key.startsWith('i|')).toBe(true)
    expect(session.isCurrent(panorama)).toBe(true)
    expect(ring.every((r) => r.signal.aborted)).toBe(true)
    expect(again[1].signal.aborted).toBe(false)
    const renewed = requests.filter((r) => !r.request.camera.panorama && !r.signal.aborted)
    expect(renewed.map((r) => label(r.request))).toEqual(['5 preview', '6 preview'])
    expect(renewed[0].request.generation).toBeGreaterThan(ring[0].request.generation)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('shows the nearest ready angle until the one turned to arrives', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    await answer(requests, 1)
    // Turned three steps: angle 8 has no frame yet, so angle 5 stands in for it.
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior', 8), meter)
    session.texture()
    await tick()
    const standIn = session.texture()!
    expect(standIn.key.endsWith('|5')).toBe(true)
    expect(session.isFocus(standIn)).toBe(false)
    const eight = requests.findIndex((r) => label(r.request) === '8 preview')
    expect(eight).toBeGreaterThanOrEqual(0)
    requests.splice(eight, 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    const own = session.texture()!
    expect(own.key.endsWith('|8')).toBe(true)
    expect(session.isFocus(own)).toBe(true)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('keeps the stand-in on screen while the frame turned to decodes', async () => {
    const bitmaps: (() => void)[] = []
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise((resolve) =>
            bitmaps.push(() => resolve({ width: 1, height: 1, close() {} })),
          ),
      ),
    )
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    await answer(requests, 1)
    session.texture()
    bitmaps.shift()!()
    await tick()
    // Turned three steps: angle 5 stands in for angle 8, whose frame then lands.
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior', 8), meter)
    await tick()
    expect(session.texture()!.key.endsWith('|5')).toBe(true)
    const eight = requests.findIndex((r) => label(r.request) === '8 preview')
    expect(eight).toBeGreaterThanOrEqual(0)
    requests.splice(eight, 1)[0].resolve()
    await tick()
    // Decoding it takes a moment, during which the stand-in stays rather than the live view
    // showing for a few frames between the two.
    const standIn = session.texture()
    expect(bitmaps).toHaveLength(1)
    expect(standIn?.key.endsWith('|5')).toBe(true)
    expect(session.isFocus(standIn!)).toBe(false)
    bitmaps.shift()!()
    await tick()
    expect(session.texture()!.key.endsWith('|8')).toBe(true)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('takes a frame the server dropped for an angle turned past as no failure', async () => {
    let asked = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') return answerFrame()
      if (asked++ < 4) throw new Superseded()
      return new Promise(() => {})
    })
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(session.progress.failed).toBe(false)
    // Each dropped request made way for the next one wanted.
    expect(asked).toBeGreaterThan(4)
    session.dispose()
  })

  // Replaces "renders on this device at once when every cloud GPU is in use": the live view (and
  // the local tracer) carry on meanwhile anyway, so the spin need not give up for the page.
  it('waits a minute when every cloud GPU is in use, then asks again', async () => {
    let asked = 0
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') return answerFrame()
      asked++
      throw new Full('every cloud GPU is in use')
    })
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(asked).toBe(4)
    expect(session.progress.failed).toBe(false)
    await tick(59_000)
    expect(asked).toBe(4)
    await tick(1000)
    await tick()
    expect(asked).toBe(8)
    expect(session.progress.failed).toBe(false)
    session.dispose()
  })

  it('renders an early export again once the textures are in, the real preview over its full render', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter, false)
    await metered()
    // A capture before the textures asks for the full render alongside the preview; both land as
    // stand-ins, and the full render shows.
    session.wantFinal(session.focusKey())
    await tick()
    expect(requests.map((r) => label(r.request))).toEqual([
      '5 preview',
      'panorama preview',
      '5 final',
    ])
    await answer(requests, 3)
    session.texture()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'final', provisional: true })
    // The textures come in: the full render and the preview are both asked for again.
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(requests.slice(0, 2).map((r) => label(r.request))).toEqual(['5 final', '5 preview'])
    // The preview with the real materials lands first and takes over from the grey full render,
    // which is not kept: an export waits for the full render made with them.
    requests.splice(1, 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'preview', provisional: false })
    requests.splice(0, 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'final', provisional: false })
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('renders both views again for an edit seen from both sides, such as a door opened', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('interior'), meter)
    await metered()
    const [panorama, , five] = requests
    await answer(requests, 1)
    session.texture()
    await tick()
    expect(session.texture()?.key.startsWith('i|')).toBe(true)
    // The door opens: the shell is in both fingerprints (StudioModel marks it shared), so the
    // panorama on screen goes and both views' requests are made again under newer generations.
    session.sync(scene, look as SkyLook, design('b'), spinState('interior'), meter)
    await tick()
    expect(session.texture()).toBeNull()
    expect(requests.every((r) => r.signal.aborted || r.request.generation > 0)).toBe(true)
    const renewed = requests.filter((r) => !r.signal.aborted)
    expect(renewed.map((r) => label(r.request))).toEqual([
      'panorama preview',
      'panorama good',
      '5 preview',
      '6 preview',
    ])
    expect(renewed[0].request.generation).toBeGreaterThan(panorama.request.generation)
    expect(renewed[2].request.generation).toBeGreaterThan(five.request.generation)
    vi.unstubAllGlobals()
    session.dispose()
  })

  // Replaces "holds the design while the scene is still loading": a preview of what the visitor
  // looks at no longer waits for the textures.
  it("renders the visitor's preview before the textures, the rest once they are in", async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter, false)
    await metered()
    // The exposure is metered, so the first preview has a gain, and only that frame (and the
    // panorama's preview, for a step inside) is asked for.
    expect(meters).toHaveLength(2)
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    expect(requests[0].request.channel).toBe('f')
    await answer(requests, 2)
    expect(requests).toHaveLength(0)
    // The textures are in: metered again (they change the brightness), then everything is asked
    // for, the early preview included, which stands in meanwhile.
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(meters).toHaveLength(4)
    expect(requests.map((r) => label(r.request))).toEqual([
      '5 preview',
      '6 preview',
      '4 preview',
      '7 preview',
    ])
    expect(session.progress.failed).toBe(false)
    session.dispose()
    // Inside, the panorama's preview is what goes out early.
    const second = fakeClient()
    const inside = new SpinSession(second.client, () => {})
    inside.sync(scene, look as SkyLook, design('a'), spinState('interior'), meter, false)
    await metered()
    expect(second.requests.map((r) => label(r.request))).toEqual(['panorama preview', '5 preview'])
    inside.dispose()
  })
})
