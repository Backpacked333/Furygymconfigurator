// @vitest-environment jsdom
import { Matrix4, Scene, Vector3 } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkyLook } from '../lib/visuals'
import {
  Busy,
  Full,
  Outdated,
  Superseded,
  captureScene,
  type CloudCamera,
  type CloudClient,
} from './cloud'
import { ORBIT_LIMITS } from './orbit'
import { planJobs } from './plan'
import {
  DEFAULT_LEVEL,
  GATE_MAX_MS,
  HOLD_FRAMES,
  METER_DEBOUNCE_MS,
  SETTLE_MS,
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

type Open = {
  request: FrameRequest
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * A client that records the frame requests open (with the signal each may be dropped by) and
 * answers them when told to; one the session drops leaves the list, answered as fetch answers an
 * abort. The exposure meter's frames (channel "m") answer at once, with a traced key of 0, unless
 * `fake.holdMeters`, when they wait to be answered too. `fake.warm` is the cloud's warmth as the
 * session reads it.
 */
function fakeClient() {
  const requests: Open[] = []
  const meters: Open[] = []
  const frame = vi.fn(
    (_captured: unknown, request: FrameRequest, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        const open: Open = { request, signal, resolve: () => resolve(answerFrame()), reject }
        if (request.channel === 'm') {
          meters.push(open)
          if (!fake.holdMeters) open.resolve()
        } else requests.push(open)
        signal.addEventListener(
          'abort',
          () => {
            const at = requests.indexOf(open)
            if (at >= 0) requests.splice(at, 1)
            reject(new DOMException('The request was aborted.', 'AbortError'))
          },
          { once: true },
        )
      }),
  )
  const fake = { frame, warm: false, holdMeters: false }
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
/** Lets the textures' latch pass (every set in for SETTLE_MS), seen by a frame drawn after. */
const latched = async () => {
  await tick(SETTLE_MS)
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
  /**
   * Syncs a design with its textures in and sees the spin through to its settled state: the
   * textures' latch (every set in for SETTLE_MS, seen by a frame drawn after), then the meter
   * run again with them in. What went out before (the visitor's preview with a gain of 1 before
   * the meter answered, then with the gain metered before the textures) was dropped at each
   * step, so the requests open after are the settled scene's.
   */
  const settled = async (
    session: SpinSession,
    keys: SceneKeys,
    state: SpinState,
    rasterKey: MeterRaster = meter,
  ) => {
    session.sync(scene, look as SkyLook, keys, state, rasterKey)
    await latched()
    session.sync(scene, look as SkyLook, keys, state, rasterKey)
    await metered()
  }
  /** Syncs a changed design on two frames running: the session takes it up once it has held one. */
  const edit = (session: SpinSession, keys: SceneKeys, state: SpinState) => {
    session.sync(scene, look as SkyLook, keys, state, meter)
    session.sync(scene, look as SkyLook, keys, state, meter)
  }

  it('meters the first design at once, then renders the visible frame and the angles nearest it', async () => {
    const { client, requests, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    // The page's first design is metered without waiting for it to hold still (a later design
    // waits, as a slider drag is a run of them).
    await tick()
    await tick()
    // A frame for each view meters its exposure, at the raster frame's size: outside at the
    // visitor's frame, inside at the interior's view.
    expect(meters).toHaveLength(2)
    expect([meters[0].request.width, meters[0].request.height]).toEqual([900, 600])
    const outside = spinCamera(spec, { level: DEFAULT_LEVEL, azimuth: 5 }, lens)
    expect(meters[0].request.camera.matrix).toEqual(outside.matrix)
    expect(meters[1].request.camera.matrix).toEqual(spinState('exterior').interior.view.matrix)
    // The textures are not in yet (a frame has to find every set in for SETTLE_MS): only the
    // visitor's preview and the panorama's, on the visitor's channel.
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    expect(requests[0].request.channel).toBe('f')
    // Once they are, the look is metered again with them in, and the ring goes out: the visible
    // frame at once on the visitor's channel; three more keep one GPU busy, so the next one asked
    // for is the one most wanted.
    await latched()
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(meters).toHaveLength(4)
    const sent = requests.map((r) => r.request)
    expect(sent).toHaveLength(4)
    expect(sent.map(label)).toEqual(['5 preview', '6 preview', '4 preview', '7 preview'])
    expect(sent.map((r) => r.priority)).toEqual([0, 1, 1, 2])
    expect(sent.map((r) => r.channel)).toEqual(['f', 's', 's', 's'])
    // Previews are rendered at the screen's CSS size.
    expect([sent[0].width, sent[0].height]).toEqual([1200, 800])
    // Another design in the same light keeps the gains.
    edit(session, design('b'), spinState('exterior'))
    await metered()
    expect(meters).toHaveLength(4)
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
    // A run of changes, as a slider drag makes: none is taken up until it holds for a frame, and
    // no meter runs until they stop for a moment.
    const dragged: MeterRaster = async (at) => raster(Math.log(2), at)
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), dragged)
    await tick(METER_DEBOUNCE_MS / 2)
    session.sync(scene, look as SkyLook, design('c'), spinState('exterior'), dragged)
    await tick(METER_DEBOUNCE_MS / 2 + 1)
    session.sync(scene, look as SkyLook, design('c'), spinState('exterior'), dragged)
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
    await settled(session, design('a'), spinState('interior'))
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
    await settled(session, design('a'), spinState('exterior'))
    const old = [...requests]
    const generation = Math.min(...old.map((r) => r.request.generation))
    edit(session, design('b'), spinState('exterior'))
    await metered()
    // The design before's requests are dropped, and the new design's frames are requested under
    // a newer generation.
    expect(old.every((r) => r.signal.aborted)).toBe(true)
    expect(requests.every((r) => !r.signal.aborted)).toBe(true)
    // On each channel (the visitor's frame has one of its own), a newer number than before.
    for (const r of requests) {
      const was = old.find((o) => o.request.channel === r.request.channel)!
      expect(r.request.generation).toBeGreaterThan(was.request.generation)
    }
    expect(Math.min(...requests.map((r) => r.request.generation))).toBeGreaterThan(generation)
    // Counted from here: the exposure meter's answer redrew once already (it tells the gate the
    // cloud is warm). A frame of the current design counts.
    const redrawn = changes
    requests[0].resolve()
    await tick()
    expect(changes).toBe(redrawn + 1)
    session.dispose()
  })

  it('waits out a busy server, twice as long each time, and asks at once again after an answer', async () => {
    let asked = 0
    let answers = 0
    let counting = false
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') return answerFrame()
      // The stand-ins asked for before the textures settle never answer; they are dropped then.
      if (!counting) return new Promise<never>(() => {})
      asked++
      if (answers > 0) {
        answers--
        return answerFrame()
      }
      throw new Busy('cloud renderer busy (503)')
    })
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await latched()
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    counting = true
    // The clock on the wait starts with the first answer.
    await metered()
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
    const answer = fake.frame.getMockImplementation()!
    let busy = 1
    fake.frame.mockImplementation((captured: unknown, request: FrameRequest, signal) => {
      if (request.channel === 'm' && busy-- > 0) return Promise.reject(new Busy('busy'))
      return answer(captured, request, signal)
    })
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(meters).toHaveLength(0)
    // The visitor's preview does not wait for the meter: it went out with a gain of 1.
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    const early = [...requests]
    await tick(2000)
    await tick()
    expect(meters).toHaveLength(2)
    // Metered: asked for again with the gain, in place of the early ones.
    expect(early.every((r) => r.signal.aborted)).toBe(true)
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
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
    // The requests already open (the visitor's preview and the panorama's, sent before the
    // meter answered) were all it sent; nothing more is asked of it, not after an edit or a new
    // framing either: it gave up for the page.
    expect(asked).toBe(2)
    edit(session, design('b'), spinState('exterior'))
    await metered()
    session.sync(
      scene,
      look as SkyLook,
      design('b'),
      spinState('exterior', 5, { width: 1200, height: 600 }),
      meter,
    )
    await metered()
    expect(asked).toBe(2)
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
    // The visitor's preview and the panorama's went out alongside the meter's first frame; no
    // second frame of the meter's, and nothing more.
    expect(frame).toHaveBeenCalledTimes(3)
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
    await settled(session, design('a'), spinState('exterior'))
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
    await settled(session, design('a'), spinState('exterior'))
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
    await settled(session, design('a'), spinState('exterior'))
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
    await settled(session, design('a'), spinState('exterior', 5, { drift: 1 }))
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
    await settled(session, design('a'), spinState('exterior', 5, { idle: false }))
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
    await settled(session, design('a'), spinState('exterior'))
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
    await settled(session, design('a'), spinState('exterior'))
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
    expect(session.texture()).toMatchObject({ tier: 'final', stage: 2 })
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('tells RenderEffects which frame may stay on screen through a design change', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    await settled(session, design('a'), spinState('exterior'))
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
    edit(session, design('b'), spinState('exterior'))
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
    await settled(session, design('a'), spinState('interior'))
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
    edit(session, design('a', { interior: 'b' }), spinState('interior'))
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
    edit(session, design('c', { interior: 'b' }), spinState('interior'))
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
    let counting = false
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') return answerFrame()
      // The stand-ins asked for before the textures settle never answer; they are dropped then.
      if (!counting) return new Promise<never>(() => {})
      asked++
      throw new Full('every cloud GPU is in use')
    })
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await latched()
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    counting = true
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
    expect(session.texture()).toMatchObject({ tier: 'final', stage: 1 })
    // The textures come in: the full render and the preview are both asked for again.
    await settled(session, design('a'), spinState('exterior'))
    expect(requests.slice(0, 2).map((r) => label(r.request))).toEqual(['5 final', '5 preview'])
    // The preview with the real materials lands first and takes over from the grey full render,
    // which is not kept: an export waits for the full render made with them.
    requests.splice(1, 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'preview', stage: 2 })
    requests.splice(0, 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'final', stage: 2 })
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('renders both views again for an edit seen from both sides, such as a door opened', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    await settled(session, design('a'), spinState('interior'))
    const [panorama, , five] = requests
    const before = [...requests]
    await answer(requests, 1)
    session.texture()
    await tick()
    expect(session.texture()?.key.startsWith('i|')).toBe(true)
    // The door opens: the shell is in both fingerprints (StudioModel marks it shared), so the
    // panorama on screen goes and both views' requests are made again under newer generations.
    edit(session, design('b'), spinState('interior'))
    await tick()
    expect(session.texture()).toBeNull()
    expect(before.slice(1).every((r) => r.signal.aborted)).toBe(true)
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
    await settled(session, design('a'), spinState('exterior'))
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

  it('meters a look once before the textures and once after, however often they flip', async () => {
    const { client, meters } = fakeClient()
    const session = new SpinSession(client, () => {})
    const textures = (settled: boolean) =>
      session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter, settled)
    textures(false)
    await metered()
    expect(meters).toHaveLength(2)
    // Sets stream in: what is loaded catches up with what was asked for and falls behind again
    // as more is asked for. None of it is settled, and none of it meters.
    for (let i = 0; i < 4; i++) {
      textures(true)
      await tick(SETTLE_MS / 2)
      textures(false)
      await tick(SETTLE_MS / 2)
    }
    expect(meters).toHaveLength(2)
    // Every set is in and stays in: once that has held SETTLE_MS, the look is metered again,
    // with the textures' brightness, once the design has held still too.
    textures(true)
    await tick(SETTLE_MS - 1)
    textures(true)
    await metered()
    expect(meters).toHaveLength(2)
    await tick(1)
    textures(true)
    await metered()
    expect(meters).toHaveLength(4)
    // A set asked for later (a new finish) and in again: the look is metered already.
    textures(false)
    await tick()
    textures(true)
    await latched()
    textures(true)
    await metered()
    expect(meters).toHaveLength(4)
    session.dispose()
  })

  it("drops a meter's frames in flight when a new chain starts, so one chain runs at most", async () => {
    const { client, fake, meters, requests } = fakeClient()
    fake.holdMeters = true
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await tick()
    await tick()
    // The chain's first frame is rendering.
    expect(meters).toHaveLength(1)
    expect(meters[0].signal.aborted).toBe(false)
    // The time of day changes: a new look, so a new chain, and the old one's frame is dropped.
    const dusk = { ...(look as SkyLook), night: 0.6 }
    const edited = () => session.sync(scene, dusk, design('a'), spinState('exterior'), meter)
    edited()
    edited()
    expect(meters[0].signal.aborted).toBe(true)
    await metered()
    expect(meters).toHaveLength(2)
    expect(meters.filter((m) => !m.signal.aborted)).toHaveLength(1)
    // Its answer comes, and the chain goes on to the interior: still one frame open.
    meters[1].resolve()
    await tick()
    await tick()
    expect(meters).toHaveLength(3)
    expect(meters.filter((m) => !m.signal.aborted)).toHaveLength(2)
    meters[2].resolve()
    await tick()
    await tick()
    expect(requests.length).toBeGreaterThan(0)
    session.dispose()
  })

  it("sends the visitor's preview with a gain of 1 before the meter answers, and again once metered", async () => {
    const { client, fake, meters, requests } = fakeClient()
    fake.holdMeters = true
    const session = new SpinSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), async (at) =>
      raster(Math.log(2), at),
    )
    await tick()
    await tick()
    // Before any meter answer: the visitor's preview, on its channel, and the panorama's inside,
    // with a gain of 1; nothing else waits on the meter so.
    expect(meters).toHaveLength(1)
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    expect(requests.map((r) => r.request.finish.gain)).toEqual([1, 1])
    expect(requests[0].request.channel).toBe('f')
    const early = [...requests]
    // The meter answers for both views: the raster is twice as bright as the traced frame, so
    // the gain is 2, and the preview is asked for again with it, in place of the early one.
    meters[0].resolve()
    await tick()
    await tick()
    meters[1].resolve()
    await tick()
    await tick()
    expect(early.every((r) => r.signal.aborted)).toBe(true)
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    expect(requests.map((r) => r.request.finish.gain.toFixed(3))).toEqual(['2.000', '2.000'])
    expect(requests[0].request.generation).toBeGreaterThan(early[0].request.generation)
    session.dispose()
  })

  it('renders a stand-in panorama again only once the visitor rests, like the ring', async () => {
    const { client, fake, meters, requests } = fakeClient()
    fake.holdMeters = true
    const session = new SpinSession(client, () => {})
    // Still editing outside: the visitor's preview and the panorama's go out before the meter.
    session.sync(
      scene,
      look as SkyLook,
      design('a'),
      spinState('exterior', 5, { idle: false }),
      meter,
    )
    await tick()
    await tick()
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    const panorama = requests.findIndex((r) => label(r.request) === 'panorama preview')
    requests.splice(panorama, 1)[0].resolve()
    await tick()
    // The meter answers: the visitor's preview is rendered again with the gain at once; the
    // panorama, a stand-in for a step inside, waits for the ring's turn.
    meters[0].resolve()
    await tick()
    await tick()
    meters[1].resolve()
    await tick()
    await tick()
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview'])
    // Resting, with the textures in: fetched ahead in its turn, after the ring.
    fake.holdMeters = false
    await settled(session, design('a'), spinState('exterior'))
    expect(requests.map((r) => label(r.request))).toEqual([
      '5 preview',
      '6 preview',
      '4 preview',
      '7 preview',
    ])
    const answered = await answer(requests, SPIN_STEPS + 1)
    expect(answered).not.toContain('panorama preview')
    expect(requests.map((r) => label(r.request))).toContain('panorama preview')
    session.dispose()
  })

  it('takes a changed design up once it has held for a frame: one edit, one generation', async () => {
    const { client, requests } = fakeClient()
    let changes = 0
    const session = new SpinSession(client, () => changes++)
    await settled(session, design('a'), spinState('exterior'))
    const open = [...requests]
    // An edit lands as a run of keys over a few frames (new meshes, their world matrices, the
    // textures they ask for): none is taken up while they keep changing, and a redraw is asked
    // for to see each again.
    const redrawn = changes
    session.sync(scene, look as SkyLook, design('b'), spinState('exterior'), meter)
    expect(changes).toBe(redrawn + 1)
    session.sync(scene, look as SkyLook, design('c'), spinState('exterior'), meter)
    await tick()
    expect(open.every((r) => !r.signal.aborted)).toBe(true)
    expect(requests).toEqual(open)
    expect(session.currentDesign()).toContain('a')
    // The key holds for a frame: taken up, once, under one new generation on each channel (the
    // visitor's frame has one of its own, the rest of the ring another).
    session.sync(scene, look as SkyLook, design('c'), spinState('exterior'), meter)
    await metered()
    expect(open.every((r) => r.signal.aborted)).toBe(true)
    expect(session.currentDesign()).toContain('c')
    for (const channel of ['f', 's']) {
      const was = open.find((r) => r.request.channel === channel)!.request.generation
      const generations = new Set(
        requests.filter((r) => r.request.channel === channel).map((r) => r.request.generation),
      )
      expect(generations.size).toBe(1)
      expect([...generations][0]).toBe(was + 1)
    }
    expect(requests.filter((r) => r.request.channel === 'f')).toHaveLength(1)
    session.dispose()
  })

  it('stops a meter for a design on its way, and takes the textures up with the key: one meter per view', async () => {
    const { client, fake, meters, requests } = fakeClient()
    fake.holdMeters = true
    const captures = vi.mocked(captureScene)
    const session = new SpinSession(client, () => {})
    const textures = (keys: SceneKeys, settled: boolean) =>
      session.sync(scene, look as SkyLook, keys, spinState('exterior'), meter, settled)
    textures(design('a'), false)
    await tick()
    await tick()
    captures.mockClear()
    // The first design's chain has its exterior frame rendering when the textures come in and
    // change the key (their maps are new versions of the materials): the chain stops, its frame
    // with it, rather than metering a scene about to change.
    expect(meters).toHaveLength(1)
    textures(design('a2'), true)
    expect(meters[0].signal.aborted).toBe(true)
    await metered()
    expect(meters).toHaveLength(1)
    // The latch passes while the key is held back: nothing is captured or metered for the design
    // before, and the visitor's early preview stays open.
    await latched()
    expect(captures).not.toHaveBeenCalled()
    expect(requests.map((r) => label(r.request))).toEqual(['5 preview', 'panorama preview'])
    // The key holds: taken up with the textures in the same frame, so one capture and one chain,
    // whose frames are never dropped: one meter for each view.
    textures(design('a2'), true)
    await metered()
    expect(captures).toHaveBeenCalledTimes(1)
    expect(meters).toHaveLength(2)
    meters[1].resolve()
    await tick()
    await tick()
    expect(meters).toHaveLength(3)
    meters[2].resolve()
    await tick()
    await tick()
    expect(meters.filter((m) => !m.signal.aborted)).toHaveLength(2)
    expect(requests.map((r) => label(r.request))).toEqual([
      '5 preview',
      '6 preview',
      '4 preview',
      '7 preview',
    ])
    // A new look meters again; its key changes for a frame and goes back (a version bumped and
    // put back): the chain stopped for the change starts again for the design in hand.
    const dusk = { ...(look as SkyLook), night: 0.6 }
    const at = (keys: SceneKeys) => session.sync(scene, dusk, keys, spinState('exterior'), meter)
    at(design('a2'))
    at(design('a2'))
    await metered()
    expect(meters).toHaveLength(4)
    at(design('a3'))
    expect(meters[3].signal.aborted).toBe(true)
    at(design('a2'))
    await metered()
    expect(meters).toHaveLength(5)
    expect(meters[4].signal.aborted).toBe(false)
    expect(session.currentDesign()).toContain('a2')
    session.dispose()
  })

  it('takes a request the browser cut short as no failure, nor one it dropped itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    await settled(session, design('a'), spinState('exterior'))
    // A fetch the browser aborted for its own reasons answers as an abort: nothing to count.
    requests[0].reject(new DOMException('The user aborted a request.', 'AbortError'))
    await tick()
    expect(session.progress.failed).toBe(false)
    // The page unloads: its open fetches fail as fetches do then, which is no failure of the
    // cloud's, so nothing is warned of or given up on while the page goes.
    window.dispatchEvent(new Event('pagehide'))
    for (const r of [...requests]) r.reject(new TypeError('Failed to fetch'))
    await tick()
    expect(session.progress.failed).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    session.dispose()
  })

  it('keeps the ring in flight through a set asked for inside, and asks the panorama again once it is in', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    const state = spinState('interior')
    await settled(session, design('a'), state)
    const ring = requests.filter((r) => r.request.channel === 's')
    expect(ring.map((r) => label(r.request))).toEqual(['5 preview', '6 preview'])
    // A finish picked inside asks for a set not loaded yet: the panorama is asked for again
    // without it, while the ring, rendered with the textures in, carries on.
    const keys = design('a', { interior: 'b' })
    const textures = (settled: boolean) =>
      session.sync(scene, look as SkyLook, keys, state, meter, settled)
    textures(false)
    textures(false)
    await tick()
    expect(ring.every((r) => !r.signal.aborted)).toBe(true)
    const early = requests.filter((r) => r.request.channel === 'p')
    expect(early.map((r) => label(r.request))).toEqual(['panorama preview'])
    // The set comes in and holds: the panorama's early request makes way for one with the
    // textures in, under a newer generation on its channel; the ring's requests are left alone.
    textures(true)
    await latched()
    textures(true)
    await tick()
    expect(ring.every((r) => !r.signal.aborted)).toBe(true)
    expect(early[0].signal.aborted).toBe(true)
    const again = requests.filter((r) => r.request.channel === 'p')
    expect(again.map((r) => label(r.request))).toEqual(['panorama preview', 'panorama good'])
    for (const r of again) expect(r.request.generation).toBeGreaterThan(early[0].request.generation)
    expect(requests.filter((r) => r.request.channel === 's')).toEqual(ring)
    // A ring frame landing now is kept, as the real thing: a step outside shows it.
    requests.splice(requests.indexOf(ring[0]), 1)[0].resolve()
    await tick()
    session.sync(scene, look as SkyLook, keys, spinState('exterior'), meter, true)
    session.texture()
    expect(session.progress.ready).toBe(1)
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'preview', stage: 2 })
    expect(session.texture()!.key.endsWith('|5')).toBe(true)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('asks for the full render of a frame made with the textures in only once they are in again', async () => {
    stubBitmaps()
    const { client, requests } = fakeClient()
    const session = new SpinSession(client, () => {})
    const state = spinState('exterior')
    await settled(session, design('a'), state)
    // The visitor's preview lands, with the textures in.
    const five = requests.findIndex((r) => label(r.request) === '5 preview')
    requests.splice(five, 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'preview', stage: 2 })
    // A finish picked inside asks for a set not loaded yet, and an export is asked for while it
    // loads: a full render made now would be thrown away as it lands, for the preview here of
    // a later stage, so none is asked for (over and over) until the set is in.
    const keys = design('a', { interior: 'b' })
    const textures = (settled: boolean) =>
      session.sync(scene, look as SkyLook, keys, state, meter, settled)
    textures(false)
    textures(false)
    await tick()
    session.wantFinal(session.focusKey())
    for (let i = 0; i < 20; i++) {
      textures(false)
      await tick(16)
    }
    expect(requests.filter((r) => label(r.request) === '5 final')).toHaveLength(0)
    textures(true)
    await latched()
    textures(true)
    await tick()
    const finals = requests.filter((r) => label(r.request) === '5 final')
    expect(finals).toHaveLength(1)
    expect(finals[0].request.channel).toBe('f')
    requests.splice(requests.indexOf(finals[0]), 1)[0].resolve()
    await tick()
    session.texture()
    await tick()
    expect(session.texture()).toMatchObject({ tier: 'final', stage: 2 })
    expect(requests.filter((r) => label(r.request) === '5 final')).toHaveLength(0)
    vi.unstubAllGlobals()
    session.dispose()
  })

  it('asks the page for no raster frame for a chain stopped while the scene was captured', async () => {
    const { client, fake, meters } = fakeClient()
    fake.holdMeters = true
    const captures = vi.mocked(captureScene)
    const pending: ((captured: unknown) => void)[] = []
    captures.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve as never)) as never,
    )
    const rasterKey = vi.fn(meter)
    const session = new SpinSession(client, () => {})
    try {
      session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), rasterKey)
      await tick()
      // The first chain waits for the page's first capture (seconds on a real page); the time
      // of day changes meanwhile: a new look, so the chain is stopped and another starts,
      // waiting for the new capture.
      expect(pending).toHaveLength(1)
      const dusk = { ...(look as SkyLook), night: 0.6 }
      session.sync(scene, dusk, design('a'), spinState('exterior'), rasterKey)
      session.sync(scene, dusk, design('a'), spinState('exterior'), rasterKey)
      await metered()
      expect(pending).toHaveLength(2)
      // The first capture lands: the stopped chain asks for no raster frame (RenderEffects
      // would draw the view at its cameras for one), and sends nothing.
      pending[0]({})
      await tick()
      await tick()
      expect(rasterKey).not.toHaveBeenCalled()
      expect(meters).toHaveLength(0)
      // The new look's capture lands: its chain meters.
      pending[1]({})
      await tick()
      await tick()
      expect(rasterKey).toHaveBeenCalledTimes(1)
      expect(meters).toHaveLength(1)
      expect(meters[0].signal.aborted).toBe(false)
    } finally {
      captures.mockImplementation(async () => ({}) as never)
      session.dispose()
    }
  })

  it('captures and meters nothing once it gave up for the page', async () => {
    const frame = vi.fn(async () => {
      throw new Outdated('old server')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const captures = vi.mocked(captureScene)
    const session = new SpinSession({ frame } as unknown as CloudClient, () => {})
    session.sync(scene, look as SkyLook, design('a'), spinState('exterior'), meter)
    await metered()
    expect(session.progress.failed).toBe(true)
    const sent = frame.mock.calls.length
    captures.mockClear()
    // A new look and a new design: nothing to capture (seconds of the main thread) or meter
    // for frames that are never asked for. The design is still kept up, so a frame left on
    // screen is told from the one before.
    const dusk = { ...(look as SkyLook), night: 0.6 }
    session.sync(scene, dusk, design('b'), spinState('exterior'), meter)
    session.sync(scene, dusk, design('b'), spinState('exterior'), meter)
    session.sync(scene, dusk, design('b'), spinState('exterior'), meter)
    await metered()
    await tick(SETTLE_MS)
    session.sync(scene, dusk, design('b'), spinState('exterior'), meter)
    await metered()
    expect(captures).not.toHaveBeenCalled()
    expect(frame.mock.calls.length).toBe(sent)
    expect(session.currentDesign()).toContain('b|')
    expect(session.currentDesign()).toContain('|0.600')
    warn.mockRestore()
    session.dispose()
  })

  it('takes a key that changes from frame to frame up once, and leaves one that takes turns with it alone', async () => {
    const { client, fake, meters } = fakeClient()
    fake.holdMeters = true
    let changes = 0
    const session = new SpinSession(client, () => changes++)
    await settled(session, design('a'), spinState('exterior'))
    const before = meters.length
    // A new look while something signs the interior anew every other frame (a key alternating
    // between two values): neither holds for a frame, so neither would ever be taken up, and
    // the redraw asked for while it is held would keep the page drawing.
    const dusk = { ...(look as SkyLook), night: 0.6 }
    let frames = 0
    const frame = () => {
      session.sync(
        scene,
        dusk,
        design('a', { interior: frames++ % 2 ? 'a' : 'b' }),
        spinState('exterior'),
        meter,
      )
    }
    for (let i = 0; i < 3; i++) {
      frame()
      await tick(16)
    }
    // Taken up: the key back from two frames ago, under the new look.
    expect(session.currentDesign('exterior')).toContain('|0.600')
    expect(session.currentDesign('interior')).toContain('|0.600')
    const taken = session.currentDesign('interior')
    // From here the other key takes turns with the one in hand: left alone, no redraw asked for,
    // and the look metered once.
    const redrawn = changes
    for (let i = 0; i < 40; i++) {
      frame()
      await tick(16)
    }
    expect(session.currentDesign('interior')).toBe(taken)
    expect(changes).toBe(redrawn)
    expect(meters).toHaveLength(before + 1)
    expect(meters[before].signal.aborted).toBe(false)
    // A key new every frame (something never signed the same twice) is taken after a while
    // rather than never, so the design is still metered and rendered.
    let fresh = 0
    for (let i = 0; i < HOLD_FRAMES + 2; i++) {
      session.sync(
        scene,
        dusk,
        design('a', { interior: `n${fresh++}` }),
        spinState('exterior'),
        meter,
      )
      await tick(16)
    }
    expect(session.currentDesign('interior')).toContain(`n${HOLD_FRAMES}|`)
    session.dispose()
  })
})
