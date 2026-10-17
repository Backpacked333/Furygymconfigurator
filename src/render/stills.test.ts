// @vitest-environment jsdom
import { Matrix4, Scene, Vector3 } from 'three/webgpu'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exposureAt, type SkyLook } from '../lib/visuals'
import { Busy, Full, Outdated, type CloudCamera, type CloudClient } from './cloud'
import { GALLERY_ANGLES, galleryCamera, type AngleId } from './gallery'
import { DEFAULT_CAMERA, DEFAULT_CONFIG } from '../lib/config'
import { bakeJobs } from './bake'
import { lookKey } from './pathtrace'
import { planStills } from './plan'
import { FIRST_FRAME_MS, renderRate } from './progress'
import { bench } from './bench'
import { PILL_DELAY_MS } from '../components/RenderStatus'
import {
  PREFETCH_IDLE_MS,
  PREFETCH_PAUSE_MS,
  PREFETCH_PER_DESIGN,
  PREFETCH_UNUSED_MAX,
  QUALITY,
  QUIET_MS,
  SETTLE_MS,
  SIBLING_LATER_MS,
  STILL_GAIN,
  StillSession,
  WARM_MS,
  cloudCamera,
  stillSize,
  type BakedLookup,
  type PrefetchSibling,
  type SceneKeys,
  type SiblingShot,
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
 * drops leaves the list.
 */
function fakeClient() {
  const requests: Open[] = []
  const frame = vi.fn(
    (_captured: unknown, request: FrameRequest, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        const open: Open = { request, signal, resolve: () => resolve(answerFrame()), reject }
        requests.push(open)
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
  return { client: { frame } as unknown as CloudClient, frame, requests }
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
  /** Syncs a design with its textures in and sees it through to settled. */
  const settled = async (session: StillSession, keys: SceneKeys, state: StillState) => {
    session.sync(scene, look as SkyLook, keys, state)
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, keys, state)
    await tick()
  }
  /** Syncs a changed design on two frames running: it is taken up once it has held one. */
  const edit = (session: StillSession, keys: SceneKeys, state: StillState) => {
    session.sync(scene, look as SkyLook, keys, state)
    session.sync(scene, look as SkyLook, keys, state)
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

  it("asks for the stage's still alone, on its own channel, once the textures are in", async () => {
    const { client, requests } = fakeClient()
    const session = new StillSession(client, () => {})
    session.sync(scene, look as SkyLook, design('a'), stillState())
    await tick()
    await tick()
    // Nothing is rendered before the textures are in: no stand-in ever reaches the stage.
    expect(requests).toHaveLength(0)
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState())
    await tick()
    await tick()
    // At once: nothing is metered first.
    expect(labels(requests)).toEqual(['front-left still'])
    const [still] = requests.map((r) => r.request)
    expect(still.channel).toBe('f')
    expect(still.priority).toBe(0)
    expect([still.width, still.height]).toEqual([1000, 625])
    expect(still.finish).toEqual({ exposure: 1, gain: 1 })
    session.dispose()
  })

  it("exposes every still at its part's camera exposure with no gain, so every tier asks for the same", async () => {
    // Exposure is a function of the time of day alone (visuals.ts exposureAt), which the live
    // view is exposed with too: nothing about a still is read off this device's raster, so a
    // design on Lite, High or Ultra asks the server (and its cache) for the very same frames.
    const exposure = exposureAt(15)
    const tiers = ['lite', 'high', 'ultra'].map(() => {
      const { client, frame, requests } = fakeClient()
      return { session: new StillSession(client, () => {}), frame, requests }
    })
    for (const { session, requests } of tiers) {
      await settled(session, design('a'), stillState({ exposure }))
      await answer(requests, 9)
    }
    const asked = tiers.map(({ frame }) =>
      frame.mock.calls.map(([, request]) => ({ ...request, generation: 0 })),
    )
    expect(asked[0].length).toBeGreaterThanOrEqual(9)
    expect(asked[1]).toEqual(asked[0])
    expect(asked[2]).toEqual(asked[0])
    // Nothing but stills goes out: no meter frame before the first.
    expect(new Set(asked[0].map((r) => r.channel))).toEqual(new Set(['f', 's', 'i']))
    for (const request of asked[0]) {
      const inside = ['entry', 'centre', 'back'].includes(label(request).split(' ')[0])
      expect(request.finish).toEqual({
        exposure: inside ? exposure.interior : exposure.exterior,
        gain: STILL_GAIN,
      })
    }
    expect(STILL_GAIN).toBe(1)
    for (const { session } of tiers) session.dispose()
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
    session.sync(scene, look as SkyLook, design('a'), stillState())
    expect(session.snapshot().design).toBe('')
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState())
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
    session.sync(scene, look as SkyLook, design('a'), stillState())
    await tick()
    await answer(requests)
    const shown = session.snapshot()
    expect(shown.images['front-left']).toEqual({
      still: { tier: 'still', url: 'blob:still-0', samples: QUALITY.still.samples, width: 1000 },
    })
    expect(shown.pending['front-left']).toBe(false)
    expect(shown.progress).toBeNull()
    // A new design is not named until its scene holds: the stills of the one before never
    // pass for it.
    edit(session, design('b'), stillState({ design: 'd2' }))
    expect(session.snapshot().design).toBe('')
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, design('b'), stillState({ design: 'd2' }))
    expect(session.snapshot()).toMatchObject({ design: 'd2', images: {} })
    session.dispose()
  })

  it('renders the stage still again, larger, for a stage grown past it, and never smaller', async () => {
    const { client, requests } = fakeClient()
    const session = new StillSession(client, () => {})
    const small = stillState({ idle: false })
    await settled(session, design('a'), small)
    await answer(requests, 9)
    expect(requests).toHaveLength(0)
    const sync = (state: StillState) => session.sync(scene, look as SkyLook, design('a'), state)
    // A little larger (within a quarter): the still serves.
    sync(stillState({ idle: false, stage: { width: 1240, height: 775, dpr: 1 } }))
    await tick()
    expect(requests).toHaveLength(0)
    // Full screen: the same tier again, at the stage's new size, on the stage's own channel...
    const big = stillState({ idle: false, stage: { width: 1600, height: 1000, dpr: 1 } })
    sync(big)
    await tick()
    expect(labels(requests)).toEqual(['front-left still'])
    expect(requests[0].request).toMatchObject({ width: 1600, height: 1000, channel: 'f' })
    // ...with no status: the stage shows the smaller still meanwhile, waiting for nothing.
    const meanwhile = session.snapshot()
    expect(meanwhile.pending['front-left']).toBe(false)
    expect(meanwhile.progress).toBeNull()
    expect(meanwhile.images['front-left']?.still?.width).toBe(1000)
    await answer(requests)
    const grown = session.snapshot().images['front-left']?.still
    expect(grown).toMatchObject({ tier: 'still', width: 1600 })
    // Back to the small stage: the larger still stays, and nothing is rendered smaller.
    sync(small)
    await tick()
    expect(requests).toHaveLength(0)
    expect(session.snapshot().images['front-left']?.still).toEqual(grown)
    // The other angles' stills, rendered at rest on the small stage, are rendered again on the
    // big one, the stage's first: each still the stage turns to fits it.
    session.setIdle(true)
    await tick()
    while (requests.length) await answer(requests)
    expect(session.snapshot().images.rear?.still?.width).toBe(1000)
    sync({ ...big, idle: true, angle: 'rear' })
    await tick()
    expect(labels(requests)[0]).toBe('rear still')
    expect(
      requests.every((r) => r.request.width === 1600 || label(r.request).includes('thumb')),
    ).toBe(true)
    while (requests.length) await answer(requests)
    expect(session.snapshot().images.rear?.still?.width).toBe(1600)
    session.dispose()
  })

  it("traces the stage's still again on this device for a grown stage, keeping the larger one", async () => {
    const session = new StillSession(null, () => {})
    session.setLocalAvailable(true)
    const small = stillState()
    const big = stillState({ stage: { width: 1600, height: 1000, dpr: 1 } })
    await settled(session, design('a'), small)
    const first = session.localJob()!
    session.deliverLocal(first, new Blob(['traced']), 256)
    expect(session.snapshot().images['front-left']?.still?.width).toBe(1000)
    expect(session.localJob()).toBeNull()
    // Full screen: traced again at the canvas's new size, while the smaller one stays up.
    session.sync(scene, look as SkyLook, design('a'), big)
    const again = session.localJob()!
    expect(again).toEqual(first)
    expect(session.snapshot().pending['front-left']).toBe(false)
    session.deliverLocal(again, new Blob(['larger']), 256)
    const larger = session.snapshot().images['front-left']?.still
    expect(larger?.width).toBe(1600)
    // Back to the small stage: nothing is traced smaller, and a trace finishing for the smaller
    // stage after the larger one is in never replaces it.
    session.sync(scene, look as SkyLook, design('a'), small)
    expect(session.localJob()).toBeNull()
    session.deliverLocal(first, new Blob(['late']), 256)
    expect(session.snapshot().images['front-left']?.still).toEqual(larger)
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
    session.sync(scene, look as SkyLook, inside, stillState({ design: 'd2' }))
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
    session.sync(scene, look as SkyLook, design('b'), stillState({ design: 'd2' }))
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
    for (let i = 0; i < 5; i++) session.sync(scene, look as SkyLook, design('a'), stillState())
    expect(vi.mocked(planStills).mock.calls.length).toBe(plans)
    session.sync(scene, look as SkyLook, design('a'), stillState({ angle: 'rear' }))
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
    const frame = vi.fn(async () => {
      if (!counting) return new Promise<never>(() => {})
      asked++
      throw new Busy('cloud renderer busy (503)')
    })
    const session = new StillSession({ frame } as unknown as CloudClient, () => {})
    counting = true
    session.sync(scene, look as SkyLook, design('a'), stillState())
    await tick(SETTLE_MS)
    // The textures in: the still asked for at once, and turned away.
    session.sync(scene, look as SkyLook, design('a'), stillState())
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
    session.deliverLocal(job, new Blob(['traced']), 256)
    expect(session.snapshot().images['front-left']?.still).toMatchObject({
      tier: 'still',
      samples: 256,
    })
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
    session.sync(scene, look as SkyLook, design('a'), stillState())
    expect(session.localJob()).toBeNull()
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState())
    const job = session.localJob()!
    expect(job.tier).toBe('still')
    session.deliverLocal(job, new Blob(['traced']), 256)
    const snapshot = session.snapshot()
    expect(snapshot.source).toBe('local')
    expect(snapshot.pending).toMatchObject({ 'front-left': false, rear: false })
    // A still traced for a design the visitor has since left is not kept for the new one.
    edit(session, design('b'), stillState({ design: 'd2' }))
    await tick(QUIET_MS)
    session.sync(scene, look as SkyLook, design('b'), stillState({ design: 'd2' }))
    const next = session.localJob()!
    session.deliverLocal(job, new Blob(['late']), 256)
    expect(session.snapshot().images['front-left']).toBeUndefined()
    expect(session.localJob()).toEqual(next)
    session.dispose()
  })

  it('never renders a baked still again, and renders the rest exposed as it was baked', async () => {
    const { client, requests } = fakeClient()
    let forgotten = false
    let revision = 0
    const baked: BakedLookup = {
      still: (key, angle, aspect) =>
        key === 'd1' &&
        aspect === 'wide' &&
        ['front-left', 'front', 'entry'].includes(angle) &&
        !(forgotten && angle === 'front-left')
          ? { url: `/stills/${angle}.webp`, tier: 'export' as const }
          : null,
      revision: () => revision,
    }
    const session = new StillSession(client, () => {}, baked)
    await settled(session, design('a'), stillState({ idle: false }))
    // The stage's angle is baked: on to the other angles' thumbnails, the baked ones left out.
    expect(labels(requests)).toEqual(['left thumb', 'rear-left thumb', 'rear thumb'])
    // At the camera's exposure, as a bake renders them: no gain between the two.
    expect(requests[0].request.finish).toEqual({ exposure: 1, gain: STILL_GAIN })
    const snapshot = session.snapshot()
    expect(snapshot.pending).toMatchObject({ 'front-left': false, front: false, left: true })
    expect(snapshot.progress).toBeNull()
    await answer(requests, 3)
    expect(labels(requests)).toEqual(['top thumb', 'centre thumb', 'back thumb'])
    expect(requests[1].request.finish).toEqual({ exposure: 1.6, gain: STILL_GAIN })
    // A download takes the baked still itself, and nothing is rendered for it.
    session.wantExport(true)
    await tick()
    expect(labels(requests)).not.toContain('front-left export')
    expect(session.best()).toEqual({ tier: 'export', url: '/stills/front-left.webp' })
    session.wantExport(false)
    // A baked still that failed to load is rendered like any other.
    forgotten = true
    revision++
    session.sync(scene, look as SkyLook, design('a'), stillState({ idle: false }))
    await tick()
    expect(labels(requests)).toContain('front-left still')
    expect(session.snapshot().pending['front-left']).toBe(true)
    session.dispose()
  })

  it('lets a quick bake stand in until its still renders, and never takes it for a download', async () => {
    const { client, requests } = fakeClient()
    const quick: BakedLookup = {
      still: (key, angle) =>
        key === 'd1' && angle === 'front-left'
          ? { url: `/stills/${angle}-640.webp`, tier: 'thumb' }
          : null,
      revision: () => 0,
    }
    const session = new StillSession(client, () => {}, quick)
    await settled(session, design('a'), stillState({ idle: false }))
    expect(labels(requests)).toEqual(['front-left still'])
    expect(session.snapshot().pending['front-left']).toBe(true)
    expect(session.best()).toBeNull()
    await answer(requests)
    expect(session.snapshot().images['front-left']?.still).toMatchObject({
      tier: 'still',
      samples: QUALITY.still.samples,
    })
    // Its filmstrip thumbnail is the quick bake: not rendered again.
    expect(labels(requests)).not.toContain('front-left thumb')
    session.dispose()
  })

  it('bakes every still it is given, exposed as the stills are, once the design is ready', async () => {
    const { client, requests } = fakeClient()
    const none: BakedLookup = { still: () => null, revision: () => 0 }
    const session = new StillSession(client, () => {}, none)
    // Bake mode asks for nothing else.
    session.setActive(false)
    session.sync(scene, look as SkyLook, design('a'), stillState())
    expect(session.bakeState()).toBe('waiting')
    await tick(SETTLE_MS)
    session.sync(scene, look as SkyLook, design('a'), stillState())
    expect(session.bakeState()).toBe('ready')
    expect(requests).toHaveLength(0)
    const jobs = bakeJobs({
      config: DEFAULT_CONFIG,
      hero: DEFAULT_CAMERA,
      aspects: ['wide', 'tall'],
      near: 0.1,
      far: 900,
    })
    const baked: string[] = []
    const done = session.bake(jobs, (job, frame) => {
      expect(frame.image).toBeInstanceOf(Blob)
      baked.push(`${job.angle}/${job.aspect}`)
    })
    await tick()
    // Two at a time, on a channel of their own, at the export tier, in order.
    expect(requests.map((r) => [r.request.channel, r.request.priority])).toEqual([
      ['b', 0],
      ['b', 1],
    ])
    expect(requests[0].request.quality.samples).toBe(1024)
    expect([requests[0].request.width, requests[0].request.height]).toEqual([2400, 1500])
    expect(requests[0].request.finish).toEqual({ exposure: 1, gain: 1 })
    while (requests.length) {
      requests.shift()!.resolve()
      await tick()
    }
    await expect(done).resolves.toEqual({
      lighting: lookKey(look),
      gains: { exterior: 1, interior: 1 },
    })
    expect(baked).toEqual(jobs.map((job) => `${job.angle}/${job.aspect}`))
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

  describe('prefetch', () => {
    const none: BakedLookup = { still: () => null, revision: () => 0 }
    /** A sibling design whose scene is captured as `keys`, at the current angle's camera. */
    const sibling = (
      design: string,
      keys: SceneKeys,
      shot?: (angle: AngleId) => SiblingShot,
    ): PrefetchSibling & { capture: ReturnType<typeof vi.fn>; take: ReturnType<typeof vi.fn> } => {
      // Its scene captured: its still is on its way to the GPU.
      const take = vi.fn(() => Promise.resolve({} as never))
      return {
        design,
        take,
        capture: vi.fn(
          (angle: AngleId) =>
            shot?.(angle) ?? {
              kind: 'ready' as const,
              keys,
              take,
              camera: cameras[angle],
              angleKey: angleKeys[angle],
            },
        ),
      }
    }
    const finishes = (...siblings: PrefetchSibling[]) => ({ section: 'finish', siblings })
    const prefetched = (requests: Open[]) =>
      requests.filter((r) => r.request.channel === 'p').map((r) => label(r.request))
    /** Answers the prefetch open. */
    const land = async (requests: Open[]) => {
      const open = requests.find((r) => r.request.channel === 'p')!
      requests.splice(requests.indexOf(open), 1)
      open.resolve()
      await tick()
      return open
    }
    /** The design 'a' settled, its stage still and its filmstrip in: what is open next. */
    const filmstrip = async (session: StillSession, requests: Open[], state: StillState) => {
      await settled(session, design('a'), state)
      await answer(requests)
      await answer(requests, 8)
      await tick()
    }

    beforeEach(() => bench.reset())

    it("renders the open section's siblings at the current angle once the filmstrip is in, one at a time", async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const [b, c] = [sibling('d2', design('b')), sibling('d3', design('c'))]
      const state = stillState({ idle: false, prefetch: finishes(b, c) })
      await settled(session, design('a'), state)
      // Nothing of the siblings before the stage's still and every thumbnail are in.
      expect(prefetched(requests)).toEqual([])
      await answer(requests)
      expect(prefetched(requests)).toEqual([])
      await answer(requests, 7)
      expect(prefetched(requests)).toEqual([])
      await answer(requests)
      await tick()
      expect(prefetched(requests)).toEqual(['front-left still'])
      const [first] = requests.filter((r) => r.request.channel === 'p')
      expect(first.request.priority).toBe(11)
      expect([first.request.width, first.request.height]).toEqual([1000, 625])
      expect(first.request.finish).toEqual({ exposure: 1, gain: 1 })
      // Captured against the live scene as the session signed it.
      expect(b.capture).toHaveBeenCalledWith('front-left', design('a'))
      expect(c.take).not.toHaveBeenCalled()
      expect(bench.get().prefetch).toEqual({ sent: 1, landed: 0, hits: 0 })
      await land(requests)
      expect(prefetched(requests)).toEqual(['front-left still'])
      expect(c.take).toHaveBeenCalledTimes(1)
      expect(bench.get().prefetch).toMatchObject({ sent: 2, landed: 1 })
      session.dispose()
    })

    it('swaps a prefetched sibling in on the frame a click builds it: no wait, no request', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const state = stillState({ idle: false, prefetch: finishes(sibling('d2', design('b'))) })
      await filmstrip(session, requests, state)
      await land(requests)
      const before = requests.length
      // The click: the scene is the sibling's, and nothing else has happened yet.
      const clicked = performance.now()
      edit(session, design('b'), { ...state, design: 'd2', prefetch: finishes() })
      const shown = session.snapshot()
      expect(performance.now() - clicked).toBeLessThan(PILL_DELAY_MS)
      expect(shown.design).toBe('d2')
      expect(shown.images['front-left']?.still?.tier).toBe('still')
      expect(shown.pending['front-left']).toBe(false)
      expect(shown.progress).toBeNull()
      await tick()
      // Not asked for again: the next requests are the new design's thumbnails.
      expect(labels(requests.slice(before))).not.toContain('front-left still')
      expect(bench.get().prefetch.hits).toBe(1)
      session.dispose()
    })

    it('has a click on a sibling still rendering wait for it, counting the time it has had', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const state = stillState({ idle: false, prefetch: finishes(sibling('d2', design('b'))) })
      await filmstrip(session, requests, state)
      const sentAt = performance.now()
      await tick(3000)
      edit(session, design('b'), { ...state, design: 'd2', prefetch: finishes() })
      await tick()
      // Not asked for a second time on the stage's channel.
      expect(requests.filter((r) => r.request.channel === 'f')).toEqual([])
      const waiting = session.snapshot()
      expect(waiting.pending['front-left']).toBe(true)
      expect(waiting.progress).toMatchObject({ kind: 'estimate', startedAt: sentAt })
      await land(requests)
      expect(session.snapshot().images['front-left']?.still?.tier).toBe('still')
      expect(session.snapshot().pending['front-left']).toBe(false)
      session.dispose()
    })

    it('takes the option pointed at next', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const [b, c, d] = [
        sibling('d2', design('b')),
        sibling('d3', design('c')),
        sibling('d4', design('d')),
      ]
      const state = stillState({ idle: false, prefetch: finishes(b, c, d) })
      await filmstrip(session, requests, state)
      expect(b.take).toHaveBeenCalledTimes(1)
      // Pointed at d4 while d2 renders: d4 is next, ahead of d3.
      const pointed = { ...state, prefetch: finishes(d, b, c) }
      session.sync(scene, look as SkyLook, design('a'), pointed)
      await land(requests)
      expect(d.take).toHaveBeenCalledTimes(1)
      expect(c.take).not.toHaveBeenCalled()
      session.dispose()
    })

    it('waits for the visitor to rest a second after an edit', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const b = sibling('d2', design('b'))
      const state = stillState({ idle: false, prefetch: finishes(b) })
      await filmstrip(session, requests, state)
      await land(requests)
      // An edit (another finish): its stage still and filmstrip, then the siblings once rested.
      const c = sibling('d3', design('c'))
      const edited = { ...state, design: 'd2', editedAt: performance.now(), prefetch: finishes(c) }
      edit(session, design('b'), edited)
      await tick()
      await answer(requests, 8)
      await tick()
      const rested = PREFETCH_IDLE_MS - (performance.now() - edited.editedAt)
      expect(rested).toBeGreaterThan(0)
      expect(c.capture).not.toHaveBeenCalled()
      await tick(rested - 1)
      expect(c.capture).not.toHaveBeenCalled()
      await tick(2)
      expect(c.capture).toHaveBeenCalledTimes(1)
      expect(prefetched(requests)).toEqual(['front-left still'])
      session.dispose()
    })

    it('runs only on a warm cloud: one that has answered in the last four minutes', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const state = stillState({ idle: false, prefetch: null })
      await filmstrip(session, requests, state)
      await tick(WARM_MS + 1)
      const b = sibling('d2', design('b'))
      session.sync(scene, look as SkyLook, design('a'), { ...state, prefetch: finishes(b) })
      await tick()
      expect(b.capture).not.toHaveBeenCalled()
      expect(prefetched(requests)).toEqual([])
      session.dispose()
    })

    it('stands down in the 360° view: what was on its way lands, nothing new goes out', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const [b, c] = [sibling('d2', design('b')), sibling('d3', design('c'))]
      const state = stillState({ idle: false, prefetch: finishes(b, c) })
      await filmstrip(session, requests, state)
      const open = requests.find((r) => r.request.channel === 'p')!
      session.setActive(false)
      // The GPU renders it whatever the page does: cut short, it would only be rendered again.
      expect(open.signal.aborted).toBe(false)
      await land(requests)
      session.sync(scene, look as SkyLook, design('a'), state)
      await tick()
      expect(prefetched(requests)).toEqual([])
      expect(c.take).not.toHaveBeenCalled()
      expect(bench.get().prefetch).toMatchObject({ sent: 1, landed: 1 })
      session.setActive(true)
      await tick()
      expect(prefetched(requests)).toEqual(['front-left still'])
      expect(c.take).toHaveBeenCalledTimes(1)
      session.dispose()
    })

    it('stops for the floor plan, letting the prefetch on its way land and sending no other', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const [b, c] = [sibling('d2', design('b')), sibling('d3', design('c'))]
      await filmstrip(session, requests, stillState({ idle: false, prefetch: finishes(b, c) }))
      const open = requests.find((r) => r.request.channel === 'p')!
      session.setIdle(false)
      expect(open.signal.aborted).toBe(false)
      await land(requests)
      expect(prefetched(requests)).toEqual([])
      expect(c.take).not.toHaveBeenCalled()
      session.dispose()
    })

    it('stops for a minute when the cloud says it is busy or full', async () => {
      for (const error of [new Busy('busy'), new Full('full')]) {
        const { client, frame, requests } = fakeClient()
        const answerWith = frame.getMockImplementation()!
        let refused = 0
        frame.mockImplementation(
          (captured: unknown, request: FrameRequest, signal: AbortSignal) => {
            if (request.channel !== 'p' || refused) return answerWith(captured, request, signal)
            refused++
            return Promise.reject(error)
          },
        )
        const session = new StillSession(client, () => {}, none)
        const [b, c] = [sibling('d2', design('b')), sibling('d3', design('c'))]
        await filmstrip(session, requests, stillState({ idle: false, prefetch: finishes(b, c) }))
        expect(refused).toBe(1)
        await tick(PREFETCH_PAUSE_MS - 1)
        expect(prefetched(requests)).toEqual([])
        await tick(2)
        await tick()
        expect(prefetched(requests)).toEqual(['front-left still'])
        session.dispose()
      }
    })

    it('prefetches one section at a time: the last one’s prefetch lands before the next goes', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const state = stillState({ idle: false, prefetch: finishes(sibling('d2', design('b'))) })
      await filmstrip(session, requests, state)
      const open = requests.find((r) => r.request.channel === 'p')!
      const floors = { section: 'flooring', siblings: [sibling('d5', design('e'))] }
      // The pointer moves to another section and back, and on again, while it renders.
      for (const prefetch of [floors, state.prefetch!, floors]) {
        session.sync(scene, look as SkyLook, design('a'), { ...state, prefetch })
        await tick()
      }
      expect(open.signal.aborted).toBe(false)
      expect(prefetched(requests)).toEqual(['front-left still'])
      expect(floors.siblings[0].take).not.toHaveBeenCalled()
      await land(requests)
      expect(floors.siblings[0].take).toHaveBeenCalledTimes(1)
      const next = requests.find((r) => r.request.channel === 'p')!
      expect(next).not.toBe(open)
      // A prefetch is never dropped by the server for a newer one: one is open at a time.
      expect(next.request.generation).toBe(open.request.generation)
      expect(bench.get().prefetch.sent).toBe(2)
      session.dispose()
    })

    it('keeps the prefetch a click waits for through a section change: never asked for twice', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const state = stillState({ idle: false, prefetch: finishes(sibling('d2', design('b'))) })
      await filmstrip(session, requests, state)
      const open = requests.find((r) => r.request.channel === 'p')!
      await tick(3000)
      const clicked = { ...state, design: 'd2', prefetch: finishes(sibling('d1', design('a'))) }
      edit(session, design('b'), clicked)
      await tick()
      const waiting = session.snapshot().progress
      // The pointer moves on to the door options (or the Interior step opens).
      const doors = { section: 'studioDoor', siblings: [] }
      session.sync(scene, look as SkyLook, design('b'), { ...clicked, prefetch: doors })
      await tick()
      expect(open.signal.aborted).toBe(false)
      expect(requests.filter((r) => r.request.channel === 'f')).toEqual([])
      expect(session.snapshot().progress).toEqual(waiting)
      await land(requests)
      expect(session.snapshot().images['front-left']?.still?.tier).toBe('still')
      session.dispose()
    })

    /** A sibling whose scans are not in until `scans` says whether they came. */
    const unloaded = (design: string, keys: SceneKeys, scans: Promise<boolean>) => {
      let loaded = false
      const load = vi.fn(() =>
        scans.then((came) => {
          loaded = came
          return came
        }),
      )
      const shot = sibling(design, keys, (angle) =>
        loaded
          ? {
              kind: 'ready',
              keys,
              take: () => Promise.resolve({} as never),
              camera: cameras[angle],
              angleKey: angleKeys[angle],
            }
          : { kind: 'unloaded', keys, camera: cameras[angle], angleKey: angleKeys[angle], load },
      )
      return Object.assign(shot, { load })
    }
    const deferred = () => {
      let settle: (came: boolean) => void = () => {}
      const promise = new Promise<boolean>((resolve) => (settle = resolve))
      return { promise, settle }
    }

    it('skips a sibling that cannot be prefetched, and waits on one whose scans are on their way', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const scans = deferred()
      const door = sibling('d2', design('b'), () => ({ kind: 'never' }))
      const floor = unloaded('d3', design('c'), scans.promise)
      const last = sibling('d4', design('d'))
      await filmstrip(
        session,
        requests,
        stillState({ idle: true, prefetch: finishes(door, floor, last) }),
      )
      // The door is not derivable; the floor's scans are coming, and the next sibling goes to the
      // GPU meanwhile. A download holds back none of the other angles' stills: none of it is on
      // its way to the GPU.
      expect(door.capture).toHaveBeenCalledTimes(1)
      expect(floor.load).toHaveBeenCalledTimes(1)
      expect(last.capture).toHaveBeenCalledTimes(1)
      expect(prefetched(requests)).toEqual(['front-left still'])
      expect(labels(requests)).toEqual([
        'front-left still',
        'front still',
        'left still',
        'rear-left still',
      ])
      // The floor's scans are in: its still follows the one on the GPU.
      scans.settle(true)
      await tick()
      const open = requests.find((r) => r.request.channel === 'p')!
      expect(prefetched(requests)).toEqual(['front-left still'])
      await land(requests)
      expect(requests.find((r) => r.request.channel === 'p')).not.toBe(open)
      expect(prefetched(requests)).toEqual(['front-left still'])
      expect(door.capture).toHaveBeenCalledTimes(1)
      expect(floor.load).toHaveBeenCalledTimes(1)
      expect(bench.get().prefetch.sent).toBe(2)
      session.dispose()
    })

    it('downloads one sibling’s scans at a time', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const [first, second] = [deferred(), deferred()]
      const stone = unloaded('d2', design('b'), first.promise)
      const oak = unloaded('d3', design('c'), second.promise)
      await filmstrip(session, requests, stillState({ idle: true, prefetch: finishes(stone, oak) }))
      expect(stone.load).toHaveBeenCalledTimes(1)
      expect(oak.load).not.toHaveBeenCalled()
      expect(labels(requests)).toEqual(['front still', 'left still', 'rear-left still'])
      // The first's scans are in: its still goes to the GPU, and the next download starts.
      first.settle(true)
      await tick()
      expect(prefetched(requests)).toEqual(['front-left still'])
      expect(oak.load).toHaveBeenCalledTimes(1)
      session.dispose()
    })

    it('leaves a sibling whose scans failed alone, and goes on to the next', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const scans = deferred()
      const stone = unloaded('d2', design('b'), scans.promise)
      const [oak, rubber] = [
        unloaded('d3', design('c'), deferred().promise),
        sibling('d4', design('d')),
      ]
      await filmstrip(
        session,
        requests,
        stillState({ idle: false, prefetch: finishes(stone, oak, rubber) }),
      )
      expect(oak.load).not.toHaveBeenCalled()
      scans.settle(false)
      await tick()
      // The next download starts, and the stone is not looked at again from this design.
      expect(oak.load).toHaveBeenCalledTimes(1)
      await land(requests)
      await tick(PREFETCH_IDLE_MS)
      expect(stone.load).toHaveBeenCalledTimes(1)
      expect(stone.capture).toHaveBeenCalledTimes(1)
      session.dispose()
    })

    it("downloads nothing for a sibling whose still at this angle is in already, and lets the other angles' stills go", async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      // Floors seen from outside: the exterior is the design's own, and so is the still.
      const never = new Promise<boolean>(() => {})
      const floors = {
        section: 'flooring',
        siblings: ['x', 'y', 'z'].map((floor, i) =>
          unloaded(`f${i}`, design('a', { interior: floor }), never),
        ),
      }
      await filmstrip(session, requests, stillState({ idle: true, prefetch: floors }))
      for (const floor of floors.siblings) expect(floor.load).not.toHaveBeenCalled()
      expect(prefetched(requests)).toEqual([])
      expect(labels(requests)).toEqual(['front still', 'left still', 'rear-left still'])
      session.dispose()
    })

    it("lets the other angles' stills go once a section turns out to have nothing to prefetch", async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      // The Setting step: no setting can be prefetched.
      const settings = {
        section: 'environment',
        siblings: [1, 2, 3].map((i) =>
          sibling(`e${i}`, design(`e${i}`), () => ({ kind: 'never' })),
        ),
      }
      await filmstrip(session, requests, stillState({ idle: true, prefetch: settings }))
      expect(labels(requests)).toEqual(['front still', 'left still', 'rear-left still'])
      for (const setting of settings.siblings) expect(setting.capture).toHaveBeenCalledTimes(1)
      session.dispose()
    })

    it('looks again at a sibling the scene could not be read for, then leaves it alone', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      let readable = false
      const b = sibling('d2', design('b'), (angle) =>
        readable
          ? {
              kind: 'ready',
              keys: design('b'),
              take: () => Promise.resolve({} as never),
              camera: cameras[angle],
              angleKey: angleKeys[angle],
            }
          : { kind: 'later' },
      )
      const c = sibling('d3', design('c'), () => ({ kind: 'later' }))
      await filmstrip(session, requests, stillState({ idle: true, prefetch: finishes(b, c) }))
      // Neither holds the other angles' stills back meanwhile.
      expect(labels(requests)).toEqual(['front still', 'left still', 'rear-left still'])
      readable = true
      await tick(300)
      expect(prefetched(requests)).toEqual(['front-left still'])
      await land(requests)
      const tries = c.capture.mock.calls.length
      await tick(SIBLING_LATER_MS)
      await tick(1000)
      const after = c.capture.mock.calls.length
      expect(after).toBeGreaterThan(tries)
      await tick(5000)
      expect(c.capture.mock.calls.length).toBe(after)
      session.dispose()
    })

    it("counts only the visitor's own GPU as warm, not the shared one answering while it starts", async () => {
      const { client, frame, requests } = fakeClient()
      const answerWith = frame.getMockImplementation()!
      frame.mockImplementation((captured: unknown, request: FrameRequest, signal: AbortSignal) =>
        (answerWith(captured, request, signal) as Promise<object>).then((answered) => ({
          ...answered,
          renderer: 'shared',
        })),
      )
      const session = new StillSession(client, () => {}, none)
      const b = sibling('d2', design('b'))
      await filmstrip(session, requests, stillState({ idle: false, prefetch: finishes(b) }))
      await tick(PREFETCH_IDLE_MS)
      expect(b.capture).not.toHaveBeenCalled()
      expect(prefetched(requests)).toEqual([])
      session.dispose()
    })

    it('spends at most a dozen prefetches on a design, and stops once many went unused', async () => {
      const { client, requests } = fakeClient()
      const session = new StillSession(client, () => {}, none)
      const siblingsOf = (key: string) =>
        finishes(
          ...Array.from({ length: 20 }, (_, i) => sibling(`${key}${i}`, design(`${key}${i}`))),
        )
      const state = stillState({ idle: false })
      const landAll = async () => {
        while (prefetched(requests).length) await land(requests)
      }
      await filmstrip(session, requests, { ...state, prefetch: siblingsOf('a') })
      await landAll()
      expect(bench.get().prefetch.sent).toBe(PREFETCH_PER_DESIGN)
      /** Another design, its stage still and filmstrip, and its siblings, none ever clicked. */
      const visit = async (key: string) => {
        const next = {
          ...state,
          design: key,
          editedAt: performance.now(),
          prefetch: siblingsOf(key),
        }
        edit(session, design(key), next)
        await tick(QUIET_MS + 1)
        session.sync(scene, look as SkyLook, design(key), next)
        await tick()
        await answer(requests)
        await answer(requests, 8)
        await tick(PREFETCH_IDLE_MS)
        await landAll()
      }
      await visit('b')
      expect(bench.get().prefetch.sent).toBe(2 * PREFETCH_PER_DESIGN)
      await visit('c')
      expect(bench.get().prefetch.sent).toBe(PREFETCH_UNUSED_MAX)
      await visit('d')
      expect(bench.get().prefetch.sent).toBe(PREFETCH_UNUSED_MAX)
      session.dispose()
    })

    it("never runs on this device's tracer", async () => {
      const session = new StillSession(null, () => {}, none)
      session.setLocalAvailable(true)
      const b = sibling('d2', design('b'))
      const state = stillState({ prefetch: finishes(b) })
      session.sync(scene, look as SkyLook, design('a'), state)
      await tick(SETTLE_MS)
      session.sync(scene, look as SkyLook, design('a'), state)
      const job = session.localJob()!
      session.deliverLocal(job, new Blob(['traced']), 256)
      await tick(PREFETCH_IDLE_MS)
      session.sync(scene, look as SkyLook, design('a'), state)
      expect(session.localJob()).toBeNull()
      expect(b.capture).not.toHaveBeenCalled()
      session.dispose()
    })
  })
})
