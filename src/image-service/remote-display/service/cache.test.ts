// Protocol/storage tests ONLY. The pixel verifier is an explicit inert double; no pixels are generated.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultDesign } from '../../../domain/design'
import { bindCloudRecipe, createCloudDisplayRequest } from '../../../display/cloudContract'
import { DISPLAY_PROTOCOL, stableDisplayJson } from '../../../display/contract'
import { validateDisplayJob } from '../../../display/session'
import { type CloudWorkerReceipt } from '../../../display/cloudSession'
import { displayCameraDigest } from '../../../render/display/input'
import { DisplayDirectory, hash } from '../../display/files'
import { CloudCache, cloudArtifact, verifyCloudOutput } from './cache'
import { createCloudDisplayService } from './service'
import { createCloudEvidenceVerifier, unconfiguredEvidence } from './evidence'
import { verifyDisplayPixels } from '../../display/cache'

vi.mock('../../display/cache', () => ({ verifyDisplayPixels: vi.fn((_job, receipt) => receipt) }))
const roots: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'fury-display-cache-test-'))
  roots.push(path)
  return new DisplayDirectory(path)
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.clearAllMocks()
})
async function fixture() {
  const build = {
    sourceManifestDigest: hash('test source'),
    assetManifestDigest: hash('test assets'),
    bundleDigest: hash('test bundle'),
    lockfileDigest: hash('test lock'),
    runtimePolicyDigest: hash('test runtime'),
    threeRevision: '186',
  }
  const design = defaultDesign(),
    recipe = await bindCloudRecipe(
      design,
      build,
      hash('inert package'),
      await displayCameraDigest(design),
    )
  const job = await validateDisplayJob(
    {
      protocol: DISPLAY_PROTOCOL,
      jobId: 'inert_cloud_job_12345678901234',
      sessionId: 'inert_cloud_session_1234567890',
      revision: 1,
      design,
      binding: recipe.binding,
    },
    build,
  )
  const png = Buffer.from(
    'INERT BYTE TOKEN ONLY - NOT A PNG, NOT GPU OUTPUT, NOT PIXELS - TEST ONLY',
  )
  const unknown = { state: 'unobserved' as const, evidenceDigest: null }
  const receipt: CloudWorkerReceipt = {
    kind: 'external-private-three-display-receipt@1',
    recipe,
    approvalDigest: hash('inert non-authorizing approval record'),
    image: {
      protocol: DISPLAY_PROTOCOL,
      kind: 'private-three-display',
      jobId: job.jobId,
      sessionId: job.sessionId,
      revision: job.revision,
      binding: job.binding,
      cameraDigest: recipe.cameraDigest,
      checksum: hash(png),
      width: job.binding.profile.width,
      height: job.binding.profile.height,
      byteLength: png.length,
      readiness: {
        revision: 1,
        resources: 'all-current-revision',
        temporalFrames: 40,
        postReadyFrames: 2,
      },
      runtime: {
        backend: 'webgpu',
        acceleration: 'hardware',
        adapter: 'INERT METADATA ONLY',
        browserVersion: 'INERT METADATA ONLY',
      },
      elapsedMs: 1,
      hostShutdownProven: false,
      billingFinal: false,
    },
    proof: {
      kind: 'external-private-gpu-proof@1',
      workerPackageDigest: recipe.workerPackageDigest,
      runtimePolicyDigest: build.runtimePolicyDigest,
      observedRuntime: { state: 'observed', evidenceDigest: hash('inert runtime record') },
      observedHardware: { state: 'observed', evidenceDigest: hash('inert hardware record') },
      observedProcessExit: unknown,
      observedProviderTermination: unknown,
      observedBillingFinal: unknown,
    },
  }
  return { recipe, job, png, receipt, evidence: { verify: vi.fn(async () => {}) } }
}
describe('cloud outer identity and provenance (pixel and observer doubles are not evidence)', () => {
  it('fails without a configured observer even if every digest looks valid', async () => {
    const f = await fixture()
    await expect(verifyCloudOutput(f.job, f.recipe, f.receipt, f.png)).rejects.toThrow()
    await expect(unconfiguredEvidence.verify(f.receipt)).rejects.toThrow()
    const identity = {
      workerPackageDigest: f.recipe.workerPackageDigest,
      runtimePolicyDigest: f.recipe.binding.build.runtimePolicyDigest,
      runtimeFilesDigest: hash('files'),
      fontFilesDigest: hash('fonts'),
    }
    await expect(
      createCloudEvidenceVerifier(directory(), {
        receipt: {
          ...identity,
          approvalDigest: f.receipt.approvalDigest,
          commandPolicyDigest: hash('command'),
          providerObjectDigest: hash('provider'),
        },
        observerKeys: new Map(),
        approval: {
          ...identity,
          publicKeys: new Map(),
          ownerDigest: hash('owner'),
          imageDigest: hash('image'),
          sdkVersion: '1.1.4',
          sdkWheelDigest: hash('sdk'),
          now: 1,
        },
      }).verify(f.receipt),
    ).rejects.toThrow()
    expect(verifyDisplayPixels).not.toHaveBeenCalled()
  })
  it('checks camera, package, policy, complete recipe, observation and distinct outer kind before pixels', async () => {
    const f = await fixture()
    const mutations = [
      { ...f.receipt, kind: 'private-three-display' },
      { ...f.receipt, kind: 'p04-fake-provider' },
      { ...f.receipt, image: { ...f.receipt.image, cameraDigest: hash('wrong camera') } },
      { ...f.receipt, recipe: { ...f.recipe, workerPackageDigest: hash('wrong package') } },
      { ...f.receipt, proof: { ...f.receipt.proof, workerPackageDigest: hash('wrong package') } },
      { ...f.receipt, proof: { ...f.receipt.proof, runtimePolicyDigest: hash('wrong runtime') } },
      {
        ...f.receipt,
        proof: {
          ...f.receipt.proof,
          observedHardware: { state: 'unobserved', evidenceDigest: null },
        },
      },
    ]
    for (const receipt of mutations)
      await expect(verifyCloudOutput(f.job, f.recipe, receipt, f.png, f.evidence)).rejects.toThrow()
    expect(verifyDisplayPixels).not.toHaveBeenCalled()
    await verifyCloudOutput(f.job, f.recipe, f.receipt, f.png, f.evidence)
    expect(f.evidence.verify).toHaveBeenCalledWith(f.receipt)
    expect(verifyDisplayPixels).toHaveBeenCalledWith(f.job, f.receipt.image, f.png)
  })
  it('atomic cache round-trip preserves exact outer receipt/proof and return pixels identity without job accounting', async () => {
    const f = await fixture(),
      root = directory(),
      cache = new CloudCache(new DisplayDirectory(root.file('cloud-objects')), f.evidence)
    const revalidate = vi.fn(async () => {}),
      fence = vi.fn()
    const saved = await cache.put(f.job, f.recipe, f.receipt, f.png, revalidate, fence)
    expect(saved.png.equals(f.png)).toBe(true)
    expect(saved.receiptDigest).toBe(hash(stableDisplayJson(f.receipt)))
    expect(saved.proofDigest).toBe(hash(stableDisplayJson(f.receipt.proof)))
    const backend = {
      prepare: vi.fn(async () => f.recipe),
      revalidate,
      open: vi.fn(async () => {
        throw new Error('NO DISPATCH')
      }),
      close: vi.fn(async () => {}),
    }
    const service = createCloudDisplayService({
      directory: root.path,
      backend,
      evidence: f.evidence,
    })
    try {
      const owner = 'inert_authenticated_owner_12345',
        other = 'inert_foreign_owner_1234567890'
      const a = await service.submit(owner, createCloudDisplayRequest(defaultDesign()))
      const b = await service.submit(owner, createCloudDisplayRequest(defaultDesign()))
      expect(a.body.state).toBe('ready')
      expect(b.body.state).toBe('ready')
      if (a.body.state !== 'ready' || b.body.state !== 'ready')
        throw new Error('Expected protocol ready')
      expect(b.body.artifact.receiptDigest).toBe(a.body.artifact.receiptDigest)
      expect(b.body.artifact.provenance).toEqual(a.body.artifact.provenance)
      expect(b.body.artifact.cacheStatus).toBe('verified-exact-hit')
      expect(a.body.artifact.provenance.kind).toBe('external-private-three-display')
      expect(a.body.artifact.approvedCurrentImage).toBe(false)
      expect(a.body.artifact.src).not.toBe(b.body.artifact.src)
      expect(await service.image(owner, a.body.interestId, f.receipt.image.checksum)).toEqual(f.png)
      await expect(
        service.image(other, a.body.interestId, f.receipt.image.checksum),
      ).rejects.toThrow()
      await expect(service.status(other, a.body.interestId)).rejects.toThrow()
      await expect(service.cancel(other, a.body.interestId)).rejects.toThrow()
      await service.cancel(owner, a.body.interestId)
      await expect(
        service.image(owner, a.body.interestId, f.receipt.image.checksum),
      ).rejects.toThrow()
      expect((await service.status(owner, b.body.interestId)).state).toBe('ready')
      expect(backend.open).not.toHaveBeenCalled()
      await service.close()
      const restarted = createCloudDisplayService({
        directory: root.path,
        backend,
        evidence: f.evidence,
      })
      try {
        const recovered = await restarted.status(owner, b.body.interestId)
        expect(recovered).toEqual(b.body)
        expect(await restarted.image(owner, b.body.interestId, f.receipt.image.checksum)).toEqual(
          f.png,
        )
        expect(backend.open).not.toHaveBeenCalled()
      } finally {
        await restarted.close()
      }
    } finally {
      await service.close()
    }
    expect(root.names(3)).toEqual(['cloud-journal', 'cloud-objects'])
    expect(cloudArtifact(saved, 'inert_new_interest_12345678901', true).provenance.qualified).toBe(
      false,
    )
    const journal = new DisplayDirectory(join(root.path, 'cloud-journal'))
    for (const name of journal.names(10))
      expect(JSON.parse(journal.read(name, 128 * 1024).toString()).run).toMatchObject({
        claimed: false,
        attempts: 0,
        outputBytes: 0,
      })
  })
  it('changes in exact package identity miss, and interrupted publication is quarantined rather than adopted', async () => {
    const f = await fixture(),
      d = directory(),
      cache = new CloudCache(d, f.evidence)
    await cache.put(
      f.job,
      f.recipe,
      f.receipt,
      f.png,
      async () => {},
      () => {},
    )
    const changed = await bindCloudRecipe(
      defaultDesign(),
      f.recipe.binding.build,
      hash('new package'),
      f.recipe.cameraDigest,
    )
    expect(await cache.get(changed)).toBeNull()
    const partial = directory(),
      partialCache = new CloudCache(partial, f.evidence)
    let calls = 0
    await expect(
      partialCache.put(
        f.job,
        f.recipe,
        f.receipt,
        f.png,
        async () => {},
        () => {
          if (++calls === 2) throw new Error('inert cancellation')
        },
      ),
    ).rejects.toThrow()
    await expect(partialCache.get(f.recipe)).rejects.toThrow()
  })
})
