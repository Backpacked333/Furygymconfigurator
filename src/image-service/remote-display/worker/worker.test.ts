import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defaultDesign } from '../../../domain/design'
import { applyDesignCommand, transitionDesign } from '../../../domain/designTransitions'
import { bindCloudRecipe, cloudProofSchema } from '../../../display/cloudContract'
import { DISPLAY_PROTOCOL, stableDisplayJson } from '../../../display/contract'
import { validateDisplayJob } from '../../../display/session'
import { displayCameraDigest } from '../../../render/display/input'
import { manifestHash, sha } from '../../../render/display/build'
import { CloudDispatchDenied, createRemoteDisplayBackend } from './backend'
import {
  assertPortableName,
  CLOUD_SOURCE,
  CLOUD_RUNTIME_POLICY,
  verifyPortableFiles,
  packageBytes,
} from './package'
import { externalApprovalSchema, verifyExternalApproval } from './admission'
import {
  candidateSessionState,
  decodeWorkerRequest,
  remoteWorkerEntrypoint,
  type CandidateSessionOptions,
} from './transport'
import { validateCloudProof, verifyCloudRenderOutput } from './receipt'

const digest = `sha256:${'a'.repeat(64)}`
const other = `sha256:${'b'.repeat(64)}`
const sessionId = 'test_only_cloud_session_123456789'
const build = {
  sourceManifestDigest: digest,
  assetManifestDigest: digest,
  bundleDigest: digest,
  lockfileDigest: digest,
  runtimePolicyDigest: digest,
  threeRevision: '186',
}
async function fixture() {
  const design = defaultDesign()
  const recipe = await bindCloudRecipe(design, build, digest, await displayCameraDigest(design))
  const job = await validateDisplayJob(
    {
      protocol: DISPLAY_PROTOCOL,
      jobId: 'test_only_cloud_job_123456789012',
      sessionId,
      revision: 1,
      design,
      binding: recipe.binding,
    },
    build,
  )
  return { design, recipe, job }
}
function options(): CandidateSessionOptions {
  return {
    sessionId,
    packageDigest: digest,
    runtimePolicyDigest: digest,
    expiresAt: 10000,
    maxJobs: 2,
    maxOutputBytes: 1000,
    now: () => 1000,
    driver: {
      render: vi.fn(async () => {
        throw new Error('inert driver: no pixels')
      }),
      requestTermination: vi.fn(async () => {}),
      observeTerminal: vi.fn(async () => ({
        processExited: false,
        providerTerminated: false,
        billingFinal: false,
      })),
    },
    journal: {
      reserve: vi.fn(async () => {}),
      output: vi.fn(async () => {}),
      quarantine: vi.fn(async () => {}),
      closed: vi.fn(async () => {}),
    },
    revalidate: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
  }
}

describe('cloud worker hard production admission', () => {
  it('does not read even adversarial approval properties before denial', async () => {
    const touched = vi.fn(() => {
      throw new Error('approval accessed')
    })
    const approval = new Proxy({}, { get: touched, ownKeys: touched })
    const backend = createRemoteDisplayBackend()
    await expect(backend.open(approval)).rejects.toBeInstanceOf(CloudDispatchDenied)
    await backend.close()
    await expect(
      backend.open({ paidExecutionAllowed: true, productionAllowed: true }),
    ).rejects.toBeInstanceOf(CloudDispatchDenied)
    expect(touched).not.toHaveBeenCalled()
    await expect(remoteWorkerEntrypoint(new Uint8Array())).rejects.toBeInstanceOf(
      CloudDispatchDenied,
    )
  })
  it('refuses local permits and unsigned/arbitrary external approvals', () => {
    expect(
      externalApprovalSchema.safeParse({
        kind: 'operator-local-only',
        paidExecutionAllowed: false,
        productionAllowed: false,
      }).success,
    ).toBe(false)
    expect(() =>
      verifyExternalApproval(
        {},
        {
          publicKeys: new Map(),
          ownerDigest: digest,
          workerPackageDigest: digest,
          runtimePolicyDigest: digest,
          imageDigest: digest,
          runtimeFilesDigest: digest,
          fontFilesDigest: digest,
          sdkVersion: '1.1.4',
          sdkWheelDigest: digest,
          now: 1000,
        },
      ),
    ).toThrow()
    expect(CLOUD_RUNTIME_POLICY.imageDigest).toBeNull()
    expect(CLOUD_RUNTIME_POLICY.sdkLaunchPin).toBeNull()
  })
})
describe('portable bytes and immutable identity', () => {
  it('detects changed, removed, added, traversal and oversized package bytes', () => {
    const files = new Map([['source/a.ts', Buffer.from('actual source bytes')]])
    const expected = manifestHash(
      [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, digest: sha(bytes) })),
    )
    expect(() => verifyPortableFiles(files, expected)).not.toThrow()
    files.set('source/a.ts', Buffer.from('tamper'))
    expect(() => verifyPortableFiles(files, expected)).toThrow()
    expect(() => verifyPortableFiles(new Map(), expected)).toThrow()
    expect(() =>
      verifyPortableFiles(new Map([['source/a.ts', Buffer.alloc(16 * 1024 * 1024 + 1)]]), expected),
    ).toThrow()
    for (const name of [
      '../private',
      '/etc/passwd',
      'a//b',
      'a/../b',
      '.git/config',
      'operator/token',
      'captures/old.png',
      'a%2fb',
      'a\\b',
    ])
      expect(() => assertPortableName(name)).toThrow()
  })
  it('uses isolated root and rejects escaped source bytes', async () => {
    expect(CLOUD_SOURCE).toBe(
      fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, ''),
    )
    await expect(
      packageBytes(`${CLOUD_SOURCE}/package.json`, CLOUD_SOURCE),
    ).resolves.toBeInstanceOf(Buffer)
    await expect(packageBytes('/etc/passwd', CLOUD_SOURCE)).rejects.toThrow()
  })
  it('full Studio-20 Obsidian/Bronze/Obsidian metadata returns exactly, not pixels', async () => {
    const { design, recipe } = await fixture()
    expect(design.config.product).toEqual({ family: 'studio', lengthFt: 20 })
    const bronze = applyDesignCommand(
      design,
      transitionDesign(design, { type: 'update-appearance', patch: { finish: 'bronze' } }).command,
    )
    const bronzeRecipe = await bindCloudRecipe(
      bronze,
      build,
      digest,
      await displayCameraDigest(bronze),
    )
    expect(bronzeRecipe.recipeDigest).not.toBe(recipe.recipeDigest)
    const returned = applyDesignCommand(
      bronze,
      transitionDesign(bronze, { type: 'update-appearance', patch: { finish: 'obsidian' } })
        .command,
    )
    expect(returned).toEqual(design)
    expect(
      await bindCloudRecipe(returned, build, digest, await displayCameraDigest(returned)),
    ).toEqual(recipe)
    expect(
      (await bindCloudRecipe(design, build, other, recipe.cameraDigest)).recipeDigest,
    ).not.toBe(recipe.recipeDigest)
    expect((await bindCloudRecipe(design, build, digest, other)).recipeDigest).not.toBe(
      recipe.recipeDigest,
    )
    expect(await bindCloudRecipe(design, build, digest, recipe.cameraDigest)).toEqual(recipe)
  })
  it('retains the frozen browser safety strings and independent pidfd cleanup', async () => {
    const source = await readFile(
      `${CLOUD_SOURCE}/src/image-service/remote-display/worker/supervisor.py`,
      'utf8',
    )
    for (const forbidden of [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      '--disable-gpu-sandbox',
      '--use-gl=swiftshader',
      'killpg(',
      'os.kill(',
    ])
      expect(source).not.toContain(forbidden)
    for (const required of [
      'os.pidfd_open',
      'signal.pidfd_send_signal',
      'prctl(36, 1',
      'parent_identity(parent) != identity',
      'DISPATCH_ALLOWED = False',
    ])
      expect(source).toContain(required)
    expect(source).not.toContain('operator.json')
  })
})
describe('private bounded protocol and nonresettable candidate session', () => {
  it('independently validates full job/recipe and forbids arbitrary worker controls', async () => {
    const { job, recipe } = await fixture()
    const request = { kind: 'cloud-private-worker-job@1', job, recipe }
    expect(await decodeWorkerRequest(Buffer.from(JSON.stringify(request)))).toEqual(request)
    for (const field of [
      'provider',
      'endpoint',
      'gpu',
      'script',
      'url',
      'budget',
      'priority',
      'camera',
    ])
      await expect(
        decodeWorkerRequest(Buffer.from(JSON.stringify({ ...request, [field]: 'injected' }))),
      ).rejects.toThrow()
    await expect(decodeWorkerRequest(Buffer.alloc(65537))).rejects.toThrow()
    await expect(decodeWorkerRequest(new Uint8Array([255]))).rejects.toThrow()
    await expect(
      decodeWorkerRequest(
        Buffer.from(JSON.stringify({ ...request, recipe: { ...recipe, cameraDigest: other } })),
      ),
    ).rejects.toThrow()
  })
  it('rejects bad identity before journal reservation and driver; permanently poisons', async () => {
    const { job, recipe } = await fixture()
    const o = options(),
      session = candidateSessionState(o)
    await expect(
      session.render(
        { ...job, sessionId: 'another_cloud_session_123456789' },
        recipe,
        new AbortController().signal,
      ),
    ).rejects.toThrow('poisoned')
    expect(o.journal.reserve).not.toHaveBeenCalled()
    expect(o.driver.render).not.toHaveBeenCalled()
    expect(o.journal.quarantine).toHaveBeenCalledOnce()
    expect(o.journal.closed).not.toHaveBeenCalled()
    await expect(session.render(job, recipe, new AbortController().signal)).rejects.toThrow(
      'unavailable',
    )
    await expect(session.close('shutdown')).rejects.toThrow('unproven')
    expect(o.driver.requestTermination).toHaveBeenCalledOnce()
  })
  it('persist-before-call is mandatory, and failed reservation makes zero render calls', async () => {
    const { job, recipe } = await fixture()
    const o = options()
    o.journal.reserve = vi.fn(async () => {
      throw new Error('durable storage unavailable')
    })
    const session = candidateSessionState(o)
    await expect(session.render(job, recipe, new AbortController().signal)).rejects.toThrow()
    expect(o.driver.render).not.toHaveBeenCalled()
    expect(o.journal.quarantine).toHaveBeenCalledOnce()
  })
  it('failed inert transport consumes reservation and never publishes output', async () => {
    const { job, recipe } = await fixture()
    const o = options()
    await expect(
      candidateSessionState(o).render(job, recipe, new AbortController().signal),
    ).rejects.toThrow('poisoned')
    expect(o.journal.reserve).toHaveBeenCalledOnce()
    expect(o.driver.render).toHaveBeenCalledOnce()
    expect(vi.mocked(o.journal.reserve).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(o.driver.render).mock.invocationCallOrder[0],
    )
    expect(o.journal.output).not.toHaveBeenCalled()
  })
  it('termination request and local exit cannot settle provider termination or billing', async () => {
    const o = options()
    o.driver.observeTerminal = vi.fn(async () => ({
      processExited: true,
      providerTerminated: false,
      billingFinal: false,
    }))
    await expect(candidateSessionState(o).close('shutdown')).rejects.toThrow('unproven')
    expect(o.journal.closed).not.toHaveBeenCalled()
    const next = options()
    next.driver.observeTerminal = vi.fn(async () => ({
      processExited: true,
      providerTerminated: true,
      billingFinal: false,
    }))
    await candidateSessionState(next).close('shutdown')
    expect(next.journal.closed).toHaveBeenCalledWith({
      processExited: true,
      providerTerminated: true,
      billingFinal: false,
    })
  })
  it('bounds uncertain cleanup even when the inert transport never responds', async () => {
    vi.useFakeTimers()
    try {
      const o = options()
      o.driver.requestTermination = vi.fn(() => new Promise<void>(() => {}))
      const session = candidateSessionState(o)
      const rejected = expect(session.close('shutdown')).rejects.toThrow('deadline')
      await vi.advanceTimersByTimeAsync(5001)
      await rejected
      expect(o.journal.quarantine).toHaveBeenCalledOnce()
      expect(o.driver.observeTerminal).not.toHaveBeenCalled()
      expect(o.journal.closed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('requests termination even when durable quarantine rejects, without releasing ownership', async () => {
    const o = options()
    o.journal.quarantine = vi.fn(async () => {
      throw new Error('quarantine storage unavailable')
    })
    o.driver.observeTerminal = vi.fn(async () => ({
      processExited: true,
      providerTerminated: true,
      billingFinal: false,
    }))
    const session = candidateSessionState(o)
    await expect(session.close('shutdown')).rejects.toThrow('quarantine storage unavailable')
    expect(o.driver.requestTermination).toHaveBeenCalledExactlyOnceWith('shutdown')
    expect(o.driver.observeTerminal).toHaveBeenCalledOnce()
    expect(o.journal.closed).not.toHaveBeenCalled()
    await expect(session.close('shutdown')).rejects.toThrow('quarantine storage unavailable')
    expect(o.driver.requestTermination).toHaveBeenCalledOnce()
  })
  it('bounds a hanging durable quarantine while still requesting and observing termination', async () => {
    vi.useFakeTimers()
    try {
      const o = options()
      o.journal.quarantine = vi.fn(() => new Promise<void>(() => {}))
      o.driver.observeTerminal = vi.fn(async () => ({
        processExited: true,
        providerTerminated: true,
        billingFinal: false,
      }))
      const session = candidateSessionState(o)
      const rejected = expect(session.close('shutdown')).rejects.toThrow('deadline')
      await vi.advanceTimersByTimeAsync(5001)
      await rejected
      expect(o.driver.requestTermination).toHaveBeenCalledExactlyOnceWith('shutdown')
      expect(o.driver.observeTerminal).toHaveBeenCalledOnce()
      expect(o.journal.closed).not.toHaveBeenCalled()
      await expect(session.close('shutdown')).rejects.toThrow('deadline')
      expect(o.driver.requestTermination).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('idle expiry closes without a render call and cannot reset lifetime', async () => {
    vi.useFakeTimers()
    try {
      const o = options()
      o.expiresAt = 600000
      candidateSessionState(o)
      await vi.advanceTimersByTimeAsync(30001)
      expect(o.driver.requestTermination).toHaveBeenCalledWith('idle')
      expect(o.driver.render).not.toHaveBeenCalled()
      expect(o.journal.reserve).not.toHaveBeenCalled()
      expect(o.journal.closed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('already aborted requests do not consume a render attempt', async () => {
    const { job, recipe } = await fixture()
    const o = options(),
      abort = new AbortController()
    abort.abort()
    await expect(candidateSessionState(o).render(job, recipe, abort.signal)).rejects.toThrow()
    expect(o.journal.reserve).not.toHaveBeenCalled()
    expect(o.driver.render).not.toHaveBeenCalled()
  })
})
describe('observations are not arbitrary digests or configured resources', () => {
  it('rejects outer camera/package/approval mismatch before any evidence or pixel access', async () => {
    const { job, recipe } = await fixture()
    const unobserved = { state: 'unobserved' as const, evidenceDigest: null }
    const proof = cloudProofSchema.parse({
      kind: 'external-private-gpu-proof@1',
      workerPackageDigest: digest,
      runtimePolicyDigest: digest,
      observedRuntime: unobserved,
      observedHardware: unobserved,
      observedProcessExit: unobserved,
      observedProviderTermination: unobserved,
      observedBillingFinal: unobserved,
    })
    const image = {
      protocol: DISPLAY_PROTOCOL,
      kind: 'private-three-display',
      jobId: job.jobId,
      sessionId,
      revision: 1,
      binding: job.binding,
      cameraDigest: recipe.cameraDigest,
      checksum: digest,
      width: job.binding.profile.width,
      height: job.binding.profile.height,
      byteLength: 44,
      readiness: {
        revision: 1,
        resources: 'all-current-revision',
        temporalFrames: 40,
        postReadyFrames: 2,
      },
      runtime: {
        backend: 'webgpu',
        acceleration: 'hardware',
        adapter: 'inert metadata only',
        browserVersion: 'Chrome/137.0.7118.2',
      },
      elapsedMs: 1,
      hostShutdownProven: false,
      billingFinal: false,
    }
    const receipt = {
      kind: 'external-private-three-display-receipt@1',
      recipe,
      image,
      proof,
      approvalDigest: digest,
    }
    const read = vi.fn(async () => {
      throw new Error('Evidence must not be touched')
    })
    const trust = {
      approvalDigest: digest,
      runtimeFilesDigest: digest,
      fontFilesDigest: digest,
      commandPolicyDigest: digest,
      providerObjectDigest: digest,
      evidence: { read, observerKeys: new Map() },
    }
    for (const bad of [
      { ...receipt, approvalDigest: other },
      { ...receipt, image: { ...image, cameraDigest: other } },
      { ...receipt, proof: { ...proof, workerPackageDigest: other } },
      { ...receipt, recipe: { ...recipe, recipeDigest: other } },
    ])
      await expect(
        verifyCloudRenderOutput(job, recipe, bad, new Uint8Array(), trust),
      ).rejects.toThrow('mismatch')
    expect(read).not.toHaveBeenCalled()
    await expect(
      verifyCloudRenderOutput(job, recipe, receipt, new Uint8Array(), trust),
    ).rejects.toThrow('unobserved')
  })
  it('requires runtime/hardware evidence, leaves stop/billing unobserved, rejects forged evidence', async () => {
    const unobserved = { state: 'unobserved', evidenceDigest: null }
    const proof = cloudProofSchema.parse({
      kind: 'external-private-gpu-proof@1',
      workerPackageDigest: digest,
      runtimePolicyDigest: digest,
      observedRuntime: unobserved,
      observedHardware: unobserved,
      observedProcessExit: unobserved,
      observedProviderTermination: unobserved,
      observedBillingFinal: unobserved,
    })
    const read = vi.fn(async () => Buffer.from('{}'))
    const trust = {
      approvalDigest: digest,
      runtimeFilesDigest: digest,
      fontFilesDigest: digest,
      commandPolicyDigest: digest,
      providerObjectDigest: digest,
      evidence: { read, observerKeys: new Map() },
    }
    await expect(validateCloudProof(proof, sessionId, trust)).rejects.toThrow('unobserved')
    expect(read).not.toHaveBeenCalled()
    await expect(
      validateCloudProof(
        { ...proof, observedRuntime: { state: 'observed', evidenceDigest: digest } },
        sessionId,
        trust,
      ),
    ).rejects.toThrow('digest')
    expect(stableDisplayJson(proof)).not.toContain('"state":"observed"')
  })
})
