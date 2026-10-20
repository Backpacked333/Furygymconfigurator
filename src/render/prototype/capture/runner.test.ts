// Orchestration fakes are explicitly synthetic. No installed browser is launched and no rendered pixels claimed.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_FLAGS,
  CAPTURE_PROTOCOL,
  CaptureContractError,
  createCaptureSamples,
  type CaptureJob,
} from './contract'
import { SYNTHETIC_BROWSER, TEST_BUILD, syntheticResult } from './artifacts-fixtures'
import { openAttemptHistory, parseCaptureCli, runCapture, type RunnerSeams } from './runner'
import type { OwnedBrowser } from './runner-browser'
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup() {
  const parent = await mkdtemp(join(tmpdir(), 'fury-runner-test-'))
  roots.push(parent)
  const options = {
    sampleId: createCaptureSamples()[0].id,
    outputDirectory: join(parent, 'attempt'),
    kind: 'sample' as const,
  }
  const controller = new AbortController(),
    stopped = vi.fn(async () => {}),
    disposed = vi.fn(async () => {}),
    closed = vi.fn(async () => {})
  const browser: OwnedBrowser = {
    ready: async () => ({
      protocol: CAPTURE_PROTOCOL,
      state: 'ready',
      build: TEST_BUILD,
      flags: CAPTURE_FLAGS,
    }),
    render: async (job) => syntheticResult(job),
    progress: async () => null,
    stop: stopped,
    dispose: disposed,
    observations: () => ({
      ...SYNTHETIC_BROWSER,
      ownedPid: null,
      exitCode: null,
      signal: null,
      stderrBytes: 0,
      consoleErrors: 0,
      requests: 0,
      launchBackend: 'webgl2',
      launchAcceleration: 'software',
    }),
  }
  const seams: RunnerSeams = {
    historyPath: join(parent, 'history'),
    prepare: async () => ({
      build: TEST_BUILD,
      resources: new Map(),
      manifests: { sources: [], assets: [], bundle: [] },
      revalidate: async () => {},
    }),
    host: async () => ({
      origin: 'http://127.0.0.1:1',
      pageUrl: 'http://127.0.0.1:1/test-only',
      allow: () => false,
      assertHealthy: () => {},
      close: closed,
      stats: () => ({ requests: 0, bytes: 0, denied: 0 }),
    }),
    browser: async () => browser,
  }
  return { parent, options, controller, browser, seams, stopped, disposed, closed }
}
async function files(path: string) {
  return readdir(path).catch(() => [])
}
describe('private CLI admission', () => {
  it.each(
    [
      [],
      ['--url', 'http://example.invalid'],
      ['--sample', 'other', '--out', '/tmp/new'],
      ['--sample', 'studio-20-front-left-wide', '--out', 'relative'],
      ['--sample', 'studio-20-front-left-wide', '--out', '/tmp/new', '--force'],
      ['--sample', 'studio-20-front-left-wide', '--out', '/tmp/new', '--request', '/tmp/untrusted'],
    ].map((args) => [args]),
  )('rejects unknown input %j before any launch', (args) =>
    expect(() => parseCaptureCli(args)).toThrow(),
  )
})
describe('immutable batch-wide attempt history', () => {
  it('reserves exactly once, excludes concurrent writers and preserves failed history across invocations', async () => {
    const fixture = await setup(),
      path = fixture.seams.historyPath!,
      history = await openAttemptHistory(path)
    const finish = await history.reserve(
      {
        jobId: 'synthetic-one',
        sampleId: fixture.options.sampleId,
        kind: 'sample',
        state: 'running',
      },
      fixture.options.outputDirectory,
    )
    await expect(openAttemptHistory(path)).rejects.toThrow()
    await finish('failed', 123, 'scene-failed')
    await history.release()
    const next = await openAttemptHistory(path)
    expect(next.history).toMatchObject([{ state: 'failed' }])
    expect(next.consumedMs).toBe(123)
    await expect(
      next.reserve(
        {
          jobId: 'synthetic-two',
          sampleId: fixture.options.sampleId,
          kind: 'sample',
          state: 'running',
        },
        join(fixture.parent, 'other'),
      ),
    ).rejects.toThrow()
    const retry = await next.reserve(
      {
        jobId: 'synthetic-two',
        sampleId: fixture.options.sampleId,
        kind: 'diagnostic-retry',
        state: 'running',
      },
      join(fixture.parent, 'other'),
    )
    await retry('failed', 33, 'scene-failed')
    await next.release()
    expect((await files(path)).sort()).toEqual([
      'attempt-01.finished.json',
      'attempt-01.started.json',
      'attempt-02.finished.json',
      'attempt-02.started.json',
    ])
  })
  it('never silently repairs unfinished/crashed reservations or unknown files', async () => {
    const fixture = await setup(),
      path = fixture.seams.historyPath!,
      history = await openAttemptHistory(path)
    await history.reserve(
      {
        jobId: 'synthetic-crash',
        sampleId: fixture.options.sampleId,
        kind: 'sample',
        state: 'running',
      },
      fixture.options.outputDirectory,
    )
    await history.release()
    const next = await openAttemptHistory(path)
    await expect(
      next.reserve(
        {
          jobId: 'synthetic-retry',
          sampleId: fixture.options.sampleId,
          kind: 'diagnostic-retry',
          state: 'running',
        },
        fixture.options.outputDirectory,
      ),
    ).rejects.toThrow()
    await next.release()
    await writeFile(join(path, 'unowned.txt'), 'preserve')
    await expect(openAttemptHistory(path)).rejects.toThrow()
    expect((await readFile(join(path, 'unowned.txt'))).toString()).toBe('preserve')
  })
})
describe('config-only runner fault fencing with declared fake worker', () => {
  it('validates real synthetic PNG decoding before COMPLETE, cleans owners, and refuses to rerender a successful sample', async () => {
    const fixture = await setup()
    const result = await runCapture(fixture.options, fixture.controller.signal, fixture.seams)
    expect(result.state).toBe('complete')
    expect(await files(fixture.options.outputDirectory)).toContain('COMPLETE.json')
    expect(fixture.stopped).toHaveBeenCalledOnce()
    expect(fixture.disposed).toHaveBeenCalledOnce()
    expect(fixture.closed).toHaveBeenCalledOnce()
    const second = await runCapture(
      { ...fixture.options, outputDirectory: join(fixture.parent, 'other') },
      fixture.controller.signal,
      fixture.seams,
    )
    expect(second).toMatchObject({ code: 'limit-exceeded' })
    expect(await files(join(fixture.parent, 'other'))).toEqual([])
  })
  it.each([
    'bad-pixels',
    'invalid-artifact',
    'identity-mismatch',
    'crash',
    'unsupported-renderer',
    'runtime',
  ])('retains failure without COMPLETE for %s', async (fault) => {
    const fixture = await setup()
    fixture.browser.render = async (job) => {
      if (fault === 'crash') throw new Error('Synthetic crash; no raw details should escape')
      if (fault === 'unsupported-renderer')
        throw new CaptureContractError('unsupported-renderer', 'Synthetic unavailable backend')
      const result = syntheticResult(job, { blank: fault === 'bad-pixels' })
      if (fault === 'invalid-artifact') result.pngBase64 = Buffer.alloc(64, 10).toString('base64')
      if (fault === 'identity-mismatch') result.captureDigest = `sha256:${'e'.repeat(64)}`
      if (fault === 'runtime') result.runtime.acceleration = 'hardware'
      return result
    }
    const result = await runCapture(fixture.options, fixture.controller.signal, fixture.seams)
    expect(result).toMatchObject({
      state: 'failed',
      code: fault === 'runtime' ? 'identity-mismatch' : fault === 'crash' ? 'scene-failed' : fault,
    })
    expect(await files(fixture.options.outputDirectory)).not.toContain('COMPLETE.json')
    expect(fixture.stopped).toHaveBeenCalledOnce()
    const failed = (
      await readFile(join(fixture.options.outputDirectory, 'failure.json'))
    ).toString()
    expect(failed).not.toContain('no raw details')
  })
  it.each(['product-major', 'page-user-agent', 'page-version'])(
    'rejects divergent browser %s before publication',
    async (fault) => {
      const fixture = await setup()
      if (fault === 'product-major') {
        const observed = fixture.browser.observations()
        fixture.browser.observations = () => ({ ...observed, product: 'Chrome/138.0.7118.2' })
      } else {
        fixture.browser.render = async (job) => {
          const result = syntheticResult(job)
          if (fault === 'page-user-agent') result.runtime.userAgent += ' changed'
          else result.runtime.browserVersion = SYNTHETIC_BROWSER.product
          return result
        }
      }
      expect(
        await runCapture(fixture.options, fixture.controller.signal, fixture.seams),
      ).toMatchObject({
        state: 'failed',
        code: 'identity-mismatch',
      })
      expect(await files(fixture.options.outputDirectory)).not.toContain('COMPLETE.json')
    },
  )
  it('cancel wins over a late render resolution and still cleans the owned fake', async () => {
    const fixture = await setup()
    let resolveRender: ((value: unknown) => void) | undefined, capturedJob: CaptureJob | undefined
    fixture.browser.render = (job) => {
      capturedJob = job
      fixture.controller.abort()
      return new Promise((resolve) => {
        resolveRender = resolve
      })
    }
    const result = await runCapture(fixture.options, fixture.controller.signal, fixture.seams)
    expect(result).toMatchObject({ code: 'cancelled' })
    resolveRender?.(syntheticResult(capturedJob!))
    await new Promise((resolve) => setImmediate(resolve))
    expect(await files(fixture.options.outputDirectory)).not.toContain('COMPLETE.json')
    expect(fixture.stopped).toHaveBeenCalledOnce()
  })
  it('outer hard job deadline defeats a permanently pending page call', async () => {
    const fixture = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let entered: (() => void) | undefined
    const rendering = new Promise<void>((resolve) => {
      entered = resolve
    })
    fixture.browser.render = () => {
      entered!()
      return new Promise(() => {})
    }
    const result = runCapture(fixture.options, fixture.controller.signal, fixture.seams)
    await Promise.race([
      rendering,
      result.then(() => {
        throw new Error('Fake failed before render entry')
      }),
    ])
    await vi.advanceTimersByTimeAsync(180_001)
    expect(await result).toMatchObject({ code: 'timeout' })
    expect(fixture.stopped).toHaveBeenCalledOnce()
    expect(await files(fixture.options.outputDirectory)).not.toContain('COMPLETE.json')
  })
  it('a denied request poisons even a later valid page result', async () => {
    const fixture = await setup()
    const original = fixture.seams.host!
    fixture.seams.host = async (resources, onDenied) => {
      const host = await original(resources, onDenied)
      queueMicrotask(onDenied)
      return host
    }
    expect(
      await runCapture(fixture.options, fixture.controller.signal, fixture.seams),
    ).toMatchObject({ code: 'network-denied' })
    expect(await files(fixture.options.outputDirectory)).not.toContain('COMPLETE.json')
  })
  it('retains the spend lock and cleanup evidence if process termination fails', async () => {
    const fixture = await setup()
    fixture.browser.stop = async () => {
      throw new CaptureContractError('scene-failed', 'Synthetic cleanup failure')
    }
    await expect(
      runCapture(fixture.options, fixture.controller.signal, fixture.seams),
    ).rejects.toThrow()
    expect(await files(fixture.seams.historyPath!)).toContain('runner.lock')
    expect(await files(fixture.options.outputDirectory)).not.toContain('COMPLETE.json')
    expect(
      JSON.parse(
        await readFile(join(fixture.options.outputDirectory, 'cleanup-failure.json'), 'utf8'),
      ),
    ).toMatchObject({ historyLockRetained: true })
    await expect(openAttemptHistory(fixture.seams.historyPath)).rejects.toThrow()
  })
  it('retains sanitized startup observations even if acquisition rejects before returning a browser', async () => {
    const fixture = await setup()
    fixture.seams.browser = async ({ onObservation }) => {
      onObservation?.({
        ...fixture.browser.observations(),
        ownedPid: 424242,
        exitCode: 1,
        cleanupConfirmed: true,
        diagnostics: ['sandbox-unavailable'],
      })
      throw new CaptureContractError('unsupported-renderer', 'Synthetic startup failure')
    }
    expect(
      await runCapture(fixture.options, fixture.controller.signal, fixture.seams),
    ).toMatchObject({ code: 'unsupported-renderer' })
    const failure = JSON.parse(
      await readFile(join(fixture.options.outputDirectory, 'failure.json'), 'utf8'),
    )
    expect(failure).toMatchObject({
      progress: [],
      browser: { diagnostics: ['sandbox-unavailable'] },
    })
    expect(await files(fixture.seams.historyPath!)).not.toContain('runner.lock')
  })
  it('existing output is never overwritten and no reservation is consumed', async () => {
    const fixture = await setup()
    await writeFile(fixture.options.outputDirectory, 'unowned prior bytes')
    expect(
      await runCapture(fixture.options, fixture.controller.signal, fixture.seams),
    ).not.toMatchObject({ state: 'complete' })
    expect((await readFile(fixture.options.outputDirectory)).toString()).toBe('unowned prior bytes')
    expect(await files(fixture.seams.historyPath!)).toEqual([])
  })
})
