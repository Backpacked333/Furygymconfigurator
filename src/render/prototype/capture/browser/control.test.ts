import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_EFFECTS,
  CAPTURE_FLAGS,
  CAPTURE_LIMITS,
  CAPTURE_PROTOCOL,
  CaptureContractError,
  createCaptureJob,
  createCaptureSamples,
  resolveCaptureCamera,
  type CaptureBuild,
} from '../contract'
import {
  CaptureScope,
  SettleGate,
  createCaptureWorker,
  workerFailureDiagnostic,
  type SceneCapture,
  type SceneDriver,
} from './control'

const build: CaptureBuild = {
  sourceManifestDigest: `sha256:${'a'.repeat(64)}`,
  assetManifestDigest: `sha256:${'b'.repeat(64)}`,
  bundleDigest: `sha256:${'c'.repeat(64)}`,
  lockfileDigest: `sha256:${'d'.repeat(64)}`,
  threeRevision: '186',
}
const sample = createCaptureSamples()[0]
const newJob = () => createCaptureJob('browser-unit-test', sample.id, sample.request, build)
const never = () => new Promise<never>(() => {})
afterEach(() => vi.useRealTimers())

it('classifies private worker failures without forwarding arbitrary text', () => {
  expect(
    workerFailureDiagnostic(
      new CaptureContractError('scene-failed', 'Private graphics API reported an error.'),
    ),
  ).toBe('graphics-api-error')
  expect(workerFailureDiagnostic(new TypeError('private/path/url'))).toBe('javascript-type-error')
  expect(
    workerFailureDiagnostic(
      new CaptureContractError('scene-failed', 'Private site field was invalid.'),
    ),
  ).toBe('site-field-invalid')
  expect(workerFailureDiagnostic(new Error('private/path/url'))).toBe('unclassified-scene-failure')
  expect(workerFailureDiagnostic(new CaptureContractError('scene-failed', '__proto__'))).toBe(
    'unclassified-scene-failure',
  )
})

/** Protocol-only sentinel; not PNG pixels, never persisted or claimed as a render. */
function syntheticDriverResult(): SceneCapture {
  const omitted = new Set([
    'ambient-occlusion',
    'screen-space-gi',
    'screen-space-reflections',
    'bloom',
    'path-tracing',
  ])
  return {
    pngBase64: 'A'.repeat(44),
    camera: resolveCaptureCamera(sample.request.design),
    renderedFrames: 8,
    runtime: {
      backend: 'webgl2',
      acceleration: 'unknown',
      adapter: 'Unit-test only',
      browserVersion: 'Unit-test only',
      userAgent: 'Unit-test only',
      effects: CAPTURE_EFFECTS.map((id) => ({
        id,
        state: omitted.has(id) ? 'omitted' : 'approximate',
        detail: 'Unit-test only, no rendering.',
      })),
    },
  }
}

describe('single-use private page protocol', () => {
  it('reports protocol readiness without touching the scene driver', async () => {
    const driver = vi.fn<SceneDriver>()
    const worker = createCaptureWorker(build, driver)
    expect(await worker.ready()).toEqual({
      protocol: CAPTURE_PROTOCOL,
      state: 'ready',
      build,
      flags: CAPTURE_FLAGS,
    })
    expect(worker.progress()).toBeNull()
    expect(driver).not.toHaveBeenCalled()
    await worker.dispose()
    await expect(worker.ready()).rejects.toMatchObject({ code: 'cancelled' })
  })
  it('rejects arbitrary configuration and consumes the page before any scene work', async () => {
    const job = await newJob()
    const driver = vi.fn<SceneDriver>()
    const worker = createCaptureWorker(build, driver)
    await expect(
      worker.render({ ...job, arbitraryPlacement: [1, 2, 3] } as typeof job),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(worker.render(job)).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(driver).not.toHaveBeenCalled()
  })
  it('rejects identity mismatch before calling the driver', async () => {
    const job = await newJob()
    const driver = vi.fn<SceneDriver>()
    const worker = createCaptureWorker(
      { ...build, bundleDigest: `sha256:${'e'.repeat(64)}` },
      driver,
    )
    await expect(worker.render(job)).rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(driver).not.toHaveBeenCalled()
  })
  it('binds a successful driver envelope and monotonically reports progress, disposing before return', async () => {
    const job = await newJob()
    const cleanup = vi.fn()
    const worker = createCaptureWorker(build, async (_job, scope, progress) => {
      scope.own(cleanup)
      progress('assembling', 0)
      progress('warming', 0)
      progress('settling', 8)
      progress('encoding', 8)
      return syntheticDriverResult()
    })
    const result = await worker.render(job)
    expect(result).toMatchObject({
      state: 'captured',
      jobId: job.jobId,
      captureDigest: job.identity.captureDigest,
      flags: CAPTURE_FLAGS,
    })
    expect(worker.progress()).toMatchObject({ phase: 'encoding', sequence: 4, renderedFrames: 8 })
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(worker.render(job)).rejects.toMatchObject({ code: 'limit-exceeded' })
  })
  it('reports an explicit sanitized failure, not an image fallback', async () => {
    const worker = createCaptureWorker(build, async () => {
      throw new Error('private-exception-detail')
    })
    const result = await worker.render(await newJob())
    expect(result).toMatchObject({
      state: 'failed',
      code: 'scene-failed',
      message: 'Private scene failed.',
      flags: CAPTURE_FLAGS,
    })
    expect(JSON.stringify(result)).not.toContain('private-exception-detail')
    expect(result).not.toHaveProperty('pngBase64')
  })
  it('rejects a driver result with the wrong named camera', async () => {
    const worker = createCaptureWorker(build, async () => {
      const result = syntheticDriverResult()
      result.camera.position[0] += 1
      return result
    })
    expect(await worker.render(await newJob())).toMatchObject({
      state: 'failed',
      code: 'identity-mismatch',
    })
  })
  it('denies concurrent render and cancellation wins pending scene work', async () => {
    const job = await newJob()
    let began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const cleanup = vi.fn()
    const worker = createCaptureWorker(build, async (_job, scope) => {
      scope.own(cleanup)
      began()
      return never()
    })
    const pending = worker.render(job)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await started
    await expect(worker.render(job)).rejects.toMatchObject({ code: 'limit-exceeded' })
    await worker.dispose()
    await rejected
    expect(cleanup).toHaveBeenCalledOnce()
  })
})

describe('bounded lifetime', () => {
  it('aborts an unresolved operation at the 180s deadline', async () => {
    vi.useFakeTimers()
    const scope = new CaptureScope()
    const rejected = expect(scope.wait(never())).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(CAPTURE_LIMITS.jobMs)
    await rejected
    expect(scope.signal.aborted).toBe(true)
    await scope.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases in reverse order once and reports a disposal failure after attempting every release', async () => {
    const scope = new CaptureScope()
    const calls: number[] = []
    scope.own(() => {
      calls.push(1)
    })
    scope.own(() => {
      calls.push(2)
      throw new Error('synthetic disposal failure')
    })
    scope.own(() => {
      calls.push(3)
    })
    const first = scope.close()
    expect(scope.close()).toBe(first)
    await expect(first).rejects.toMatchObject({ code: 'scene-failed' })
    expect(calls).toEqual([3, 2, 1])
    const late = vi.fn()
    scope.own(late)
    await Promise.resolve()
    expect(late).toHaveBeenCalledOnce()
  })
  it('bounds hung cleanup and still invokes later releases', async () => {
    vi.useFakeTimers()
    const scope = new CaptureScope()
    const release = vi.fn()
    scope.own(release)
    scope.own(never)
    const rejected = expect(scope.close()).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(CAPTURE_LIMITS.cleanupMs)
    await rejected
    expect(release).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels pauses and rejects closed-scope work', async () => {
    vi.useFakeTimers()
    const scope = new CaptureScope()
    const rejected = expect(scope.pause(2000)).rejects.toMatchObject({ code: 'cancelled' })
    scope.cancel()
    await rejected
    await scope.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => scope.check()).toThrow(CaptureContractError)
  })
})

function completeProbes(gate: SettleGate, now: number) {
  gate.capture('sky', now)
  for (let i = 0; i < 2; i++) gate.capture('environment', now)
  for (let i = 0; i < 4; i++) gate.capture('interior', now)
  gate.capture('site', now)
}
describe('observed settle gate', () => {
  it('requires real captures, loaded materials, field, quiet time, then two post-ready frames', () => {
    const gate = new SettleGate(500)
    gate.materials = true
    expect(gate.frame(1000)).toBe(false)
    completeProbes(gate, 1000)
    expect(gate.frame(2000)).toBe(false)
    gate.siteField = true
    expect(gate.frame(1499)).toBe(false)
    expect(gate.frame(1500)).toBe(false)
    for (let i = 0; i < 8; i++) expect(gate.settled(1500)).toBe(false)
    expect(gate.frame(1501)).toBe(false)
    expect(gate.frame(1502)).toBe(true)
  })
  it('requires fresh environment/interior/site captures after texture changes', () => {
    const gate = new SettleGate(500)
    gate.materials = gate.siteField = true
    completeProbes(gate, 0)
    gate.changed(1000, true)
    for (let i = 0; i < 8; i++) expect(gate.frame(5000 + i)).toBe(false)
    completeProbes(gate, 6000)
    expect(gate.frame(6500)).toBe(false)
    expect(gate.frame(6501)).toBe(false)
    expect(gate.frame(6502)).toBe(true)
    gate.changed(7000)
    expect(gate.frame(7500)).toBe(false)
  })
})
