// @vitest-environment jsdom
import { Matrix4, Scene, Vector3 } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkyLook } from '../lib/visuals'
import { Busy, Full, Outdated, type CloudCamera, type CloudClient } from './cloud'
import { GALLERY_ANGLES, galleryCamera, type AngleId } from './gallery'
import { DEFAULT_CONFIG } from '../lib/config'
import { planStills } from './plan'
import { FIRST_FRAME_MS, renderRate } from './progress'
import {
  METER_DEBOUNCE_MS,
  QUALITY,
  QUIET_MS,
  SETTLE_MS,
  StillSession,
  cloudCamera,
  stillSize,
  type MeterRaster,
  type SceneKeys,
  type StillState,
} from './stills'

// The session's scene capture is stubbed: these tests cover scheduling.
vi.mock('./cloud', async (original) => ({
  ...(await original<typeof import('./cloud')>()),
  captureScene: vi.fn(async () => ({})),
}))
// The plan is watched: it must not be rebuilt for a frame that changed nothing.
vi.mock('./plan', async (original) => {
  const actual = await original<typeof import('./plan')>()
  return { ...actual, planStills: vi.fn(actual.planStills) }
})

const ANGLES = GALLERY_ANGLES.map((a) => a.id)
const lens = { fov: 34, near: 0.1, far: 900 }
/** Each angle's camera stands at x = its index, so a request says which angle it is for. */
const cameras = Object.fromEntries(
  ANGLES.map((id, i) => [
    id,
    { matrix: new Matrix4().makeTranslation(i, 0, 0).toArray(), ...lens },
  ]),
) as Record<AngleId, CloudCamera>
const angleKeys = Object.fromEntries(ANGLES.map((id) => [id, id])) as Record<AngleId, string>
const stillState = (over: Partial<StillState> = {}): StillState => ({
  design: 'd1',
  angle: 'front-left',
  aspect: 'wide',
  stage: { width: 1000, height: 625, dpr: 1 },
  cameras,
  angleKeys,
  exposure: { exterior: 1, interior: 1.6 },
  idle: true,
  ...over,
})

type FrameRequest = {
  priority: number
  generation: number
  width: number
  height: number
  camera: { matrix: number[] }
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
  renderer: '' as const,
})
type Open = {
  request: FrameRequest
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * A client that records the frame requests open and answers them when told to; one the session
 * drops leaves the list. The exposure meter's frames (channel "m") answer at once with a traced
 * key of 0.
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
          open.resolve()
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
  return { client: { frame } as unknown as CloudClient, frame, requests, meters }
}

const look = { environment: 'meadow', sunlight: { direction: [0, 1, 0] }, night: 0 } as never
const design = (key: string, over: Partial<SceneKeys> = {}): SceneKeys => ({
  exterior: key,
  interior: key,
  ...over,
})
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
/** What a request is for: the angle (by its camera) and the tier (by its samples). */
const label = (r: FrameRequest) => {
  const angle =
    ANGLES[
      Math.round(new Vector3().setFromMatrixPosition(new Matrix4().fromArray(r.camera.matrix)).x)
    ]
  const tier = r.quality.samples === 64 ? 'thumb' : r.quality.samples === 256 ? 'still' : 'export'
  return `${angle} ${tier}`
}
const labels = (requests: Open[]) => requests.map((r) => label(r.request))
const raster = (key: number, at: CloudCamera) => ({ key, camera: at, width: 900, height: 600 })
const meter: MeterRaster = async (at) => raster(0, at)

describe('still geometry', () => {
  it('sizes thumbnails fixed, stills at the stage at up to 1.5x density, exports fixed', () => {
    const stage = { width: 1000, height: 625, dpr: 2 }
    expect(stillSize('thumb', 'wide', stage)).toEqual({ width: 320, height: 200 })
    expect(stillSize('thumb', 'tall', stage)).toEqual({ width: 320, height: 400 })
    expect(stillSize('still', 'wide', stage)).toEqual({ width: 1500, height: 938 })
    expect(stillSize('still', 'wide', { ...stage, width: 2400 })).toEqual({
      width: 1920,
      height: 1200,
    })
    expect(stillSize('still', 'tall', { width: 1600, height: 2000, dpr: 1 })).toEqual({
      width: 1536,
      height: 1920,
    })
    expect(stillSize('export', 'wide', stage)).toEqual({ width: 2400, height: 1500 })
  })

  it('renders each tier at its own quality', () => {
    expect(QUALITY.thumb.samples).toBe(64)
    expect(QUALITY.still).toEqual({ samples: 256, threshold: 0, timeLimit: 20 })
    expect(QUALITY.export).toEqual({ samples: 1024, threshold: 0.01, timeLimit: 60 })
  })

  it('looks from the gallery camera at its target', () => {
    const shot = galleryCamera(DEFAULT_CONFIG, 'rear', 'wide')
    const camera = cloudCamera(shot, 0.1, 900)
    const matrix = new Matrix4().fromArray(camera.matrix)
    const eye = new Vector3().setFromMatrixPosition(matrix)
    expect(eye.toArray()).toEqual(shot.position.map((v) => expect.closeTo(v, 6)))
    const forward = new Vector3(0, 0, -1).transformDirection(matrix)
    const toward = new Vector3(...shot.target).sub(eye).normalize()
    expect(forward.dot(toward)).toBeCloseTo(1, 6)
    expect(camera.fov).toBe(shot.fov)
  })
})

describe('still session', () => {
  let scene: Scene
  let urls = 0
  beforeEach(() => {
    scene = new Scene()
    urls = 0
    renderRate.reset()
    vi.useFakeTimers()
    URL.createObjectURL = vi.fn(() => `blob:still-${urls++}`)
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  /** Syncs a design with its textures in and sees it through to settled and metered. */
  const settled = async (session: StillSession, keys: SceneKeys, state: StillState) => {
    session.sync(scene, look as SkyLook, keys, state, meter)
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, keys, state, meter)
    await tick(METER_DEBOUNCE_MS)
    await tick()
  }
  /** Syncs a changed design on two frames running: it is taken up once it has held one. */
  const edit = (session: StillSession, keys: SceneKeys, state: StillState) => {
    session.sync(scene, look as SkyLook, keys, state, meter)
    session.sync(scene, look as SkyLook, keys, state, meter)
  }
  /** Answers the oldest open request, `count` times; the labels answered. */
  const answer = async (requests: Open[], count = 1) => {
    const answered: string[] = []
    for (let i = 0; i < count; i++) {
      const next = requests.shift()!
      answered.push(label(next.request))
      next.resolve()
      await tick()
    }
    return answered
  }

  it("meters at fixed angles, then asks for the stage's still alone, on its own channel", async () => {
    const { client, requests, meters } = fakeClient()
    const session = new StillSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    await tick()
    await tick()
    // Nothing is metered or rendered before the textures are in: no stand-in ever reaches the
    // stage, and a meter without them would cost the GPU a frame for nothing.
    expect(meters).toHaveLength(0)
    expect(requests).toHaveLength(0)
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    await tick()
    await tick()
    // Metered at the front three-quarter view outside and the entry inside, whatever the visitor
    // looks at, so a design always gets the same gain.
    expect(meters.map((m) => m.request.camera.matrix)).toEqual([
      cameras['front-left'].matrix,
      cameras.entry.matrix,
    ])
    expect(labels(requests)).toEqual(['front-left still'])
    const [still] = requests.map((r) => r.request)
    expect(still.channel).toBe('f')
    expect(still.priority).toBe(0)
    expect([still.width, still.height]).toEqual([1000, 625])
    expect(still.finish).toEqual({ exposure: 1, gain: 1 })
    session.dispose()
  })

  it('then thumbnails of the other angles, nearest first, and their stills once the visitor rests', async () => {
    const { client, requests } = fakeClient()
    const session = new StillSession(client, () => {})
    await settled(session, design('a'), stillState({ idle: false }))
    expect(await answer(requests)).toEqual(['front-left still'])
    // Three open at once keep the GPU busy; outside before inside.
    expect(labels(requests)).toEqual(['front thumb', 'left thumb', 'rear-left thumb'])
    expect(requests.map((r) => r.request.channel)).toEqual(['s', 's', 's'])
    expect(requests.map((r) => [r.request.width, r.request.height])).toEqual([
      [320, 200],
      [320, 200],
      [320, 200],
    ])
    await answer(requests, 5)
    expect(labels(requests)).toEqual(['entry thumb', 'centre thumb', 'back thumb'])
    expect(requests.map((r) => r.request.channel)).toEqual(['i', 'i', 'i'])
    await answer(requests, 3)
    // The longer renders wait for the visitor to rest on the design.
    expect(requests).toHaveLength(0)
    session.setIdle(true)
    await tick()
    expect(labels(requests)).toEqual(['front still', 'left still', 'rear-left still'])
    session.dispose()
  })

  it("names a design's stills only once its scene has held, and says which are on their way", async () => {
    const { client, requests } = fakeClient()
    const session = new StillSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    expect(session.snapshot().design).toBe('')
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    const waiting = session.snapshot()
    expect(waiting).toMatchObject({ source: 'cloud', design: 'd1', aspect: 'wide', images: {} })
    expect(waiting.pending['front-left']).toBe(true)
    expect(waiting.pending.rear).toBe(true)
    // The page's first still allows for the uploads and a GPU that may be starting.
    expect(waiting.progress).toMatchObject({ kind: 'estimate' })
    expect(waiting.progress?.kind === 'estimate' && waiting.progress.expectedMs).toBeGreaterThan(
      FIRST_FRAME_MS,
    )
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    await tick(METER_DEBOUNCE_MS)
    await tick()
    await answer(requests)
    const shown = session.snapshot()
    expect(shown.images['front-left']).toEqual({ still: { tier: 'still', url: 'blob:still-0' } })
    expect(shown.pending['front-left']).toBe(false)
    expect(shown.progress).toBeNull()
    // A new design is not named until its scene holds: the stills of the one before never
    // pass for it.
    edit(session, design('b'), stillState({ design: 'd2' }))
    expect(session.snapshot().design).toBe('')
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, design('b'), stillState({ design: 'd2' }), meter)
    expect(session.snapshot()).toMatchObject({ design: 'd2', images: {} })
    session.dispose()
  })

  it("keeps the outside's stills for an edit in the room, and renders the room's again", async () => {
    const { client, requests } = fakeClient()
    const session = new StillSession(client, () => {})
    await settled(session, design('a'), stillState())
    await answer(requests, 9)
    expect(requests.length).toBeGreaterThan(0)
    const before = session.snapshot()
    expect(Object.keys(before.images)).toHaveLength(9)
    // The mirror wall: the interior's scene changes, the exterior's does not.
    const inside = design('a', { interior: 'mirror' })
    edit(session, inside, stillState({ design: 'd2' }))
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, inside, stillState({ design: 'd2' }), meter)
    const after = session.snapshot()
    expect(after.design).toBe('d2')
    for (const angle of ['front-left', 'front', 'left', 'rear-left', 'rear', 'top'] as const)
      expect(after.images[angle]).toEqual(before.images[angle])
    for (const angle of ['entry', 'centre', 'back'] as const) {
      expect(after.images[angle]).toBeUndefined()
      expect(after.pending[angle]).toBe(true)
    }
    session.dispose()
  })

  it('drops the requests of a design that changed while they rendered', async () => {
    const { client, requests } = fakeClient()
    let changes = 0
    const session = new StillSession(client, () => changes++)
    await settled(session, design('a'), stillState())
    const old = [...requests]
    const generation = old[0].request.generation
    edit(session, design('b'), stillState({ design: 'd2' }))
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, design('b'), stillState({ design: 'd2' }), meter)
    await tick()
    expect(old.every((r) => r.signal.aborted)).toBe(true)
    // The new design's still goes out under a newer number on the stage's channel, so the
    // server drops what is still queued for the one before.
    expect(labels(requests)).toEqual(['front-left still'])
    expect(requests[0].request.generation).toBeGreaterThan(generation)
    const redrawn = changes
    await answer(requests)
    expect(changes).toBe(redrawn + 1)
    session.dispose()
  })

  it('builds the plan only when something it is made from changed', async () => {
    const { client } = fakeClient()
    const session = new StillSession(client, () => {})
    await settled(session, design('a'), stillState())
    const plans = vi.mocked(planStills).mock.calls.length
    for (let i = 0; i < 5; i++)
      session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    expect(vi.mocked(planStills).mock.calls.length).toBe(plans)
    session.sync(scene, look as SkyLook, design('a'), stillState({ angle: 'rear' }), meter)
    expect(vi.mocked(planStills).mock.calls.length).toBe(plans + 1)
    session.dispose()
  })

  it("asks for the stage's export first while a download waits for it", async () => {
    const { client, requests } = fakeClient()
    const session = new StillSession(client, () => {})
    await settled(session, design('a'), stillState())
    await answer(requests)
    session.wantExport(true)
    await tick()
    const exported = requests.find((r) => label(r.request) === 'front-left export')!
    expect(exported.request.channel).toBe('x')
    expect(exported.request.priority).toBe(0)
    expect([exported.request.width, exported.request.height]).toEqual([2400, 1500])
    expect(session.best()?.tier).toBe('still')
    exported.resolve()
    await tick()
    expect(session.best()?.tier).toBe('export')
    expect(session.snapshot().images['front-left']?.still?.tier).toBe('export')
    session.dispose()
  })

  it('waits out a busy server, twice as long each time', async () => {
    let asked = 0
    let counting = false
    const frame = vi.fn(async (_captured: unknown, request: FrameRequest) => {
      if (request.channel === 'm') return answerFrame()
      if (!counting) return new Promise<never>(() => {})
      asked++
      throw new Busy('cloud renderer busy (503)')
    })
    const session = new StillSession({ frame } as unknown as CloudClient, () => {})
    counting = true
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    await tick(SETTLE_MS)
    // The textures in: metered at once, and the still asked for, and turned away.
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    await tick()
    await tick()
    expect(asked).toBe(1)
    for (const wait of [2000, 4000, 8000]) {
      await tick(wait - 1)
      const before = asked
      await tick(1)
      await tick()
      expect(asked).toBe(before + 1)
    }
    expect(session.snapshot().source).toBe('cloud')
    session.dispose()
  })

  it("hands the stage's still to this device's tracer while every cloud GPU is in use", async () => {
    const { client, frame, requests } = fakeClient()
    const answer = frame.getMockImplementation()!
    frame.mockImplementation((captured: unknown, request: FrameRequest, signal) =>
      request.channel === 'f'
        ? Promise.reject(new Full('full'))
        : answer(captured, request, signal),
    )
    const session = new StillSession(client, () => {})
    session.setLocalAvailable(true)
    await settled(session, design('a'), stillState())
    await tick()
    expect(requests).toHaveLength(0)
    expect(session.snapshot().source).toBe('local')
    const job = session.localJob()!
    expect(job).toMatchObject({ angle: 'front-left', tier: 'still' })
    session.reportLocal(job, 0.5, 4000)
    expect(session.snapshot().progress).toEqual({
      kind: 'measured',
      fraction: 0.5,
      remainingMs: 4000,
    })
    session.deliverLocal(job, new Blob(['traced']))
    expect(session.snapshot().images['front-left']?.still?.tier).toBe('still')
    expect(session.localJob()).toBeNull()
    // A minute on, the cloud is asked again.
    frame.mockImplementation(answer)
    await tick(60_000)
    expect(session.snapshot().source).toBe('cloud')
    session.dispose()
  })

  it('gives up on a server that predates finished frames, for this device or the live view', async () => {
    const { client, frame } = fakeClient()
    frame.mockImplementation(() => Promise.reject(new Outdated('old')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new StillSession(client, () => {})
    await settled(session, design('a'), stillState())
    expect(session.snapshot().source).toBeNull()
    session.setLocalAvailable(true)
    expect(session.snapshot().source).toBe('local')
    expect(session.localJob()).toMatchObject({ angle: 'front-left' })
    warn.mockRestore()
    session.dispose()
  })

  it("renders on this device alone without a cloud, and only the stage's still", async () => {
    const session = new StillSession(null, () => {})
    session.setLocalAvailable(true)
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    expect(session.localJob()).toBeNull()
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState(), meter)
    const job = session.localJob()!
    expect(job.tier).toBe('still')
    session.deliverLocal(job, new Blob(['traced']))
    const snapshot = session.snapshot()
    expect(snapshot.source).toBe('local')
    expect(snapshot.pending).toMatchObject({ 'front-left': false, rear: false })
    // A still traced for a design the visitor has since left is not kept for the new one.
    edit(session, design('b'), stillState({ design: 'd2' }))
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, design('b'), stillState({ design: 'd2' }), meter)
    const next = session.localJob()!
    session.deliverLocal(job, new Blob(['late']))
    expect(session.snapshot().images['front-left']).toBeUndefined()
    expect(session.localJob()).toEqual(next)
    session.dispose()
  })

  it('stands down in the 360° view, and picks up where it was back in the gallery', async () => {
    const { client, requests } = fakeClient()
    const session = new StillSession(client, () => {})
    session.setActive(false)
    await settled(session, design('a'), stillState())
    expect(requests).toHaveLength(0)
    session.setActive(true)
    await tick()
    expect(labels(requests)).toEqual(['front-left still'])
    session.dispose()
  })
})
