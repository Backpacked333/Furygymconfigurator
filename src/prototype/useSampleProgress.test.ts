import { expect, it } from 'vitest'
import { defaultDesign } from '../domain/design'
import { sampleProgressSchema, type SampleProgress } from '../render-library/sampleProgress'
import { snapshotFixture, queued } from './renderLibraryClient.fixtures'
import { currentSample } from './useSampleProgress'

async function fixture() {
  const snapshot = queued(await snapshotFixture(defaultDesign(), 2))
  const view = {
    cameraRef: snapshot.views[2].cameraRef,
    imageKey: snapshot.views[2].imageKey,
    status: 'pending' as const,
    stage: 'rendering' as const,
  }
  snapshot.views[2] = view
  snapshot.job!.stage = 'rendering'
  snapshot.job!.currentCamera = view.cameraRef
  const sample: SampleProgress = {
    jobId: snapshot.job!.id,
    attemptId: '11111111-1111-4111-8111-111111111111',
    fence: 1,
    cameraRef: view.cameraRef,
    imageKey: view.imageKey,
    completed: 528,
    total: 1024,
    observedAt: new Date().toISOString(),
  }
  return { snapshot, sample }
}

it('accepts measured current-image progress, not elapsed-time guesses', async () => {
  const { snapshot, sample } = await fixture()
  expect(currentSample(snapshot.job, snapshot.views, sample)).toEqual(sample)
  expect(currentSample(snapshot.job, snapshot.views, null)).toBeNull()
})

it('drops stale, future, wrong job, wrong camera and wrong image observations', async () => {
  const { snapshot, sample } = await fixture()
  for (const invalid of [
    { ...sample, jobId: '22222222-2222-4222-8222-222222222222' },
    { ...sample, cameraRef: 'entry-draft@1' as const },
    { ...sample, imageKey: 'img_' + 'a'.repeat(64) },
    { ...sample, observedAt: new Date(Date.now() - 16_000).toISOString() },
    { ...sample, observedAt: new Date(Date.now() + 4_000).toISOString() },
  ])
    expect(currentSample(snapshot.job, snapshot.views, invalid)).toBeNull()
})

it('does not reuse samples for saving or completed work', async () => {
  const { snapshot, sample } = await fixture()
  snapshot.job!.stage = 'saving'
  expect(currentSample(snapshot.job, snapshot.views, sample)).toBeNull()
  snapshot.job!.stage = 'complete'
  expect(currentSample(snapshot.job, snapshot.views, sample)).toBeNull()
})

it('bounds the telemetry contract without altering the existing snapshot contract', async () => {
  const { sample } = await fixture()
  expect(sampleProgressSchema.safeParse(sample).success).toBe(true)
  for (const completed of [-1, 1025, 0.5, NaN])
    expect(sampleProgressSchema.safeParse({ ...sample, completed }).success).toBe(false)
  expect(sampleProgressSchema.safeParse({ ...sample, total: 32 }).success).toBe(false)
})
