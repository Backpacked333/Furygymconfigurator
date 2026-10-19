import { describe, expect, it, vi, afterEach } from 'vitest'
import { deflateSync } from 'node:zlib'
import {
  bindDisplay,
  DISPLAY_LIMITS,
  DISPLAY_PROTOCOL,
  type DisplayBuild,
} from '../../display/contract'
import { defaultDesign, designEnvelopeSchema, type DesignEnvelope } from '../../domain/design'
import { createSceneDesignFixtures } from '../../domain/designFixtures'
import type { DisplayJob, DisplayReceipt, LocalDisplayPermit } from '../../display/session'
import { pngCrc } from '../prototype/capture/artifacts'
import { sha } from './build'
import { displayCameraDigest } from './input'
import { SupervisedDisplaySession, verifyDisplayResult, type DisplayDriver } from './backend'
import type { DisplayRunJournal } from './permit'

vi.mock('./permit', () => ({
  checkOperatorPermit: vi.fn(async (v: unknown) => v),
  ownDisplayRun: vi.fn(() => {
    throw new Error('Tests never open production runs.')
  }),
}))
const digest = `sha256:${'a'.repeat(64)}`
const build: DisplayBuild = {
  sourceManifestDigest: digest,
  assetManifestDigest: digest,
  bundleDigest: digest,
  lockfileDigest: digest,
  runtimePolicyDigest: digest,
  threeRevision: '186',
}
const sessionId = 's'.repeat(32)
const runtime: DisplayReceipt['runtime'] = {
  backend: 'webgpu',
  acceleration: 'hardware',
  adapter: 'TEST ONLY NVIDIA',
  browserVersion: 'Chrome/1.0',
}
const permit: LocalDisplayPermit = {
  kind: 'operator-local-only',
  runId: 'r'.repeat(32),
  approvalReference: 'TEST ONLY NOT PERMISSION',
  expiresAt: Date.now() + 600000,
  maxJobs: 24,
  maxOutputBytes: 128 * 1024 * 1024,
  paidExecutionAllowed: false,
  productionAllowed: false,
}
function chunk(name: string, body: Buffer) {
  const type = Buffer.from(name),
    out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length)
  type.copy(out, 4)
  body.copy(out, 8)
  out.writeUInt32BE(pngCrc(Buffer.concat([type, body])), body.length + 8)
  return out
}
/** Deliberately synthetic nonuniform PNG: unit testing only, never written/published as imagery. */
function syntheticPng(width: number, height: number) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height, 90)
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0
  pixels[1] = 180
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
async function job(revision = 1, design: DesignEnvelope = defaultDesign()): Promise<DisplayJob> {
  return {
    protocol: DISPLAY_PROTOCOL,
    sessionId,
    jobId: `${'j'.repeat(24)}${revision}`,
    revision,
    design: designEnvelopeSchema.parse(design),
    binding: await bindDisplay(design, build),
  }
}
async function result(job: DisplayJob) {
  const { width, height } = job.binding.profile,
    png = syntheticPng(width, height)
  const receipt: DisplayReceipt = {
    protocol: DISPLAY_PROTOCOL,
    kind: 'private-three-display',
    jobId: job.jobId,
    sessionId,
    revision: job.revision,
    binding: job.binding,
    cameraDigest: await displayCameraDigest(job.design),
    checksum: sha(png),
    width,
    height,
    byteLength: png.length,
    readiness: {
      revision: job.revision,
      resources: 'all-current-revision',
      temporalFrames: 40,
      postReadyFrames: 2,
    },
    runtime,
    elapsedMs: 1,
    hostShutdownProven: false,
    billingFinal: false,
  }
  return { receipt, base64: png.toString('base64') }
}
function setup(render: DisplayDriver['render'] = result, elapsed = 0) {
  const driver: DisplayDriver = {
    render: vi.fn(render),
    phase: vi.fn(),
    close: vi.fn(async () => {}),
  }
  const journal: DisplayRunJournal = {
    started: Date.now() - elapsed,
    permit: { ...permit, expiresAt: Date.now() + 600000 },
    check: vi.fn(async () => {}),
    attempt: vi.fn(async () => {}),
    output: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  }
  const revalidate = vi.fn(async () => {})
  const session = new SupervisedDisplaySession(
    sessionId,
    build,
    driver,
    journal,
    revalidate,
    runtime,
  )
  return { session, driver, journal, revalidate }
}
afterEach(() => vi.useRealTimers())
describe('owned display session host fencing (test pixels only)', () => {
  it('reuses one driver for A→B→A, arbitrary fixture replacements and increasing revisions', async () => {
    const s = setup(),
      fixtures = createSceneDesignFixtures()
    const designs = [fixtures[4].design, fixtures[3].design, fixtures[0].design, fixtures[4].design]
    for (const [i, design] of designs.entries()) {
      const response = await s.session.render(
        await job(i + 1, design),
        new AbortController().signal,
      )
      expect(response.receipt.revision).toBe(i + 1)
      expect(response.receipt.hostShutdownProven).toBe(false)
    }
    expect(s.driver.render).toHaveBeenCalledTimes(4)
    expect(s.journal.attempt).toHaveBeenCalledTimes(4)
    expect(s.driver.close).not.toHaveBeenCalled()
    await s.session.close('shutdown')
    expect(s.journal.finish).toHaveBeenCalledWith(true)
  })
  it('rejects overlap without a second mutation; abort tears down and fences late pixels', async () => {
    let resolve: ((v: unknown) => void) | undefined
    const s = setup(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      ),
      first = await job(),
      abort = new AbortController()
    const pending = s.session.render(first, abort.signal)
    await vi.waitFor(() => expect(s.driver.render).toHaveBeenCalledTimes(1))
    await expect(s.session.render(await job(2), new AbortController().signal)).rejects.toThrow(
      'Single-flight',
    )
    const rejected = expect(pending).rejects.toThrow()
    abort.abort()
    await rejected
    resolve?.(await result(first))
    expect(s.journal.output).not.toHaveBeenCalled()
    expect(s.driver.close).toHaveBeenCalledTimes(1)
    await expect(s.session.render(first, new AbortController().signal)).rejects.toThrow()
  })
  it('checks source identity before mutation and publication; poison cannot reuse', async () => {
    const s = setup()
    s.revalidate.mockRejectedValueOnce(new Error('Source changed'))
    await expect(s.session.render(await job(), new AbortController().signal)).rejects.toThrow(
      'Source changed',
    )
    expect(s.driver.render).not.toHaveBeenCalled()
    expect(s.driver.close).toHaveBeenCalledOnce()
    const late = setup()
    late.revalidate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Source changed at publication'))
    await expect(late.session.render(await job(), new AbortController().signal)).rejects.toThrow(
      'Source changed at publication',
    )
    expect(late.driver.render).toHaveBeenCalledOnce()
    expect(late.journal.output).not.toHaveBeenCalled()
    expect(late.driver.close).toHaveBeenCalledOnce()
  })
  it('independent orchestration timeout closes the driver and quarantines unobserved exit', async () => {
    vi.useFakeTimers()
    const s = setup(() => new Promise(() => {}))
    vi.mocked(s.driver.close).mockRejectedValue(new Error('unobserved exit'))
    const pending = s.session.render(await job(), new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('unobserved exit')
    await vi.advanceTimersByTimeAsync(DISPLAY_LIMITS.jobMs + 1)
    await rejected
    expect(s.journal.finish).toHaveBeenCalledWith(false)
    await expect(s.session.close('shutdown')).rejects.toThrow()
  })
  it('idle reuse never renews total lifetime and close is idempotent', async () => {
    vi.useFakeTimers()
    const s = setup()
    await vi.advanceTimersByTimeAsync(DISPLAY_LIMITS.idleMs + 1)
    await s.session.close('idle')
    await s.session.close('shutdown')
    expect(s.driver.close).toHaveBeenCalledOnce()
  })
  it('successful warm reuse cannot renew the original independent total lifetime', async () => {
    vi.useFakeTimers()
    const s = setup(result, DISPLAY_LIMITS.lifetimeMs - 5000)
    await s.session.render(await job(), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(4000)
    await s.session.render(await job(2), new AbortController().signal)
    expect(s.driver.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1001)
    expect(s.driver.close).toHaveBeenCalledOnce()
    await expect(s.session.render(await job(3), new AbortController().signal)).rejects.toThrow()
    await s.session.close('limit')
  })
  it('independently rejects bad PNG, checksum, camera, binding and false final billing', async () => {
    const j = await job(),
      valid = await result(j)
    await expect(verifyDisplayResult(valid, j, runtime)).resolves.toHaveProperty('png')
    for (const altered of [
      { ...valid, base64: 'AAAA' },
      { ...valid, receipt: { ...valid.receipt, checksum: `sha256:${'b'.repeat(64)}` } },
      { ...valid, receipt: { ...valid.receipt, cameraDigest: `sha256:${'b'.repeat(64)}` } },
      { ...valid, receipt: { ...valid.receipt, revision: 2 } },
      { ...valid, receipt: { ...valid.receipt, billingFinal: true } },
    ])
      await expect(verifyDisplayResult(altered, j, runtime)).rejects.toThrow()
  })
})
