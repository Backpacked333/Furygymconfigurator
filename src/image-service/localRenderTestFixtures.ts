// SYNTHETIC test fixtures only, not real rendering, not a substitute or production adapter.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import {
  createCaptureJob,
  createCaptureSamples,
  type CaptureAttempt,
  type CaptureBuild,
} from '../render/prototype/capture/contract'
import {
  ExclusiveDirectory,
  jsonBytes,
  publishCapture,
} from '../render/prototype/capture/artifacts'
import {
  SYNTHETIC_BROWSER,
  syntheticResult,
  TEST_BUILD,
} from '../render/prototype/capture/artifacts-fixtures'
import { LocalRenderCache } from './localRenderCache'
import type { LocalRenderBackend, LocalRenderPrepared } from './localRenderPrivate'
import type { LocalRenderSampleId } from './localRenderProtocol'

export async function localRenderFixture() {
  const root = await mkdtemp(join(tmpdir(), 'fury-synthetic-service-test-'))
  const cache = new LocalRenderCache({
    outputs: root,
    index: join(root, 'index'),
    history: join(root, 'synthetic-history'),
  })
  let build: CaptureBuild = TEST_BUILD
  let sequence = 0
  const revalidate = vi.fn(async () => {})
  const prepare = vi.fn<LocalRenderBackend['prepare']>(async (): Promise<LocalRenderPrepared> => {
    const snapshot = build
    return {
      build: snapshot,
      manifests: { sources: [], assets: [], bundle: [] },
      revalidate: async () => {
        if (build !== snapshot)
          throw Object.assign(new Error('Synthetic source changed'), { code: 'identity-mismatch' })
        await revalidate()
      },
    }
  })
  const outputs: string[] = []
  async function publish(
    sampleId: LocalRenderSampleId,
    outputDirectory: string,
    state: CaptureAttempt['state'] = 'succeeded',
  ) {
    await mkdir(cache.paths.history, { recursive: true })
    const index = ++sequence
    const sample = createCaptureSamples().find((value) => value.id === sampleId)!
    const job = await createCaptureJob(
      `synthetic-service-${index}`,
      sampleId,
      sample.request,
      build,
    )
    const prefix = join(cache.paths.history, `attempt-${String(index).padStart(2, '0')}`)
    const attempt: CaptureAttempt = { jobId: job.jobId, sampleId, kind: 'sample', state: 'running' }
    await writeFile(
      `${prefix}.started.json`,
      jsonBytes({ attempt, startedAt: Date.now(), outputDirectory }),
    )
    const directory = await ExclusiveDirectory.create(outputDirectory)
    outputs.push(outputDirectory)
    if (state === 'running') return { state: 'failed' }
    if (state !== 'succeeded') {
      await writeFile(
        `${prefix}.finished.json`,
        jsonBytes({ attempt: { ...attempt, state }, elapsedMs: 10, code: 'unsupported-renderer' }),
      )
      return { state: 'failed' }
    }
    await directory.write('job.json', jsonBytes(job))
    await directory.write('build.json', jsonBytes(build))
    const result = syntheticResult(job)
    await directory.write('browser.json', jsonBytes(SYNTHETIC_BROWSER))
    const marker = await publishCapture({
      directory,
      job,
      result,
      elapsedMs: () => 20,
      fence: () => {},
      revalidateSources: revalidate,
    })
    await writeFile(
      `${prefix}.finished.json`,
      jsonBytes({ attempt: { ...attempt, state }, elapsedMs: 20, code: null }),
    )
    return { state: 'complete', marker }
  }
  const capture = vi.fn<LocalRenderBackend['capture']>((sample, output) => publish(sample, output))
  return {
    root,
    cache,
    backend: { prepare, capture },
    publish,
    outputs,
    revalidate,
    changeBuild: () => {
      build = { ...build, sourceManifestDigest: `sha256:${'e'.repeat(64)}` }
    },
  }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
