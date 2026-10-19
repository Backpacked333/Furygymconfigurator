import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { defaultDesign, parseDesign, serializeDesign } from '../domain/design'
import { CAMERA_REFS, DRAFT_LOOKS, LOOK_REFS, resolveCamera } from '../domain/presentation'
import {
  CONTRACT_VERSION,
  MAX_IMAGE_BYTES,
  RECIPE_RELEASE,
  SEED_MANIFEST_SHA256,
  createJobRequestSchema,
  imageDescriptorSchema,
  lookupRequestSchema,
  lookupResponseSchema,
  retryJobRequestSchema,
  safeError,
  safeErrorSchema,
  setSnapshotSchema,
} from './contracts'
import {
  canonicalJson,
  computeSetIdentity,
  identityPayload,
  verifyImageDescriptor,
} from './identity'
import {
  CUSTOMER_CAMERA_REFS,
  customerAngle,
  fiveViewDesigns,
  normalizeCustomerDesign,
} from './views'
import {
  artifactReceiptSchema,
  dispatchEnvelopeSchema,
  dispatchResultSchema,
  workerClaimSchema,
  workerEventSchema,
} from './workerProtocol'
import { seedImagesForSet, verifySeedManifest } from './server/seedCache'
import { verifyArtifactReceipt, verifyWorkerClaim } from './server/validation'
import { contractFixtures } from '../../scripts/native-render-contract-fixtures'
import http from './fixtures/http-contract.json'
import worker from './fixtures/worker-adapter.json'

const root = resolve(import.meta.dirname, '../..')
const manifestBytes = readFileSync(resolve(root, 'public/native-library/manifest.json'))
const design = defaultDesign()
const claim = workerClaimSchema.parse(worker.claim)
const registration = {
  releaseId: RECIPE_RELEASE.id,
  workerBuildSha256: claim.workerBuildSha256,
  recipeBundleSha256: claim.recipeBundleSha256,
  geometrySha256: '1'.repeat(64),
  materialsSha256: '2'.repeat(64),
  camerasSha256: '3'.repeat(64),
  rendererSha256: '4'.repeat(64),
}

describe('five-view customer loading and canonical identity', () => {
  it('defaults only new designs to Studio Day and preserves all historical parsers', () => {
    expect(design.presentation.lookRef).toBe('studio-day-draft@1')
    expect(CUSTOMER_CAMERA_REFS).toHaveLength(5)
    expect(CAMERA_REFS).toHaveLength(7)
    expect(LOOK_REFS).toHaveLength(9)
    expect(DRAFT_LOOKS).toHaveLength(8)
    for (const cameraRef of CAMERA_REFS) {
      const old = parseDesign({
        ...design,
        presentation: {
          ...design.presentation,
          cameraRef,
          lookRef: 'desert-night-draft@1',
          doorPose: 'open',
          aspect: 'tall',
        },
      })
      expect(resolveCamera(cameraRef).ref).toBe(cameraRef)
      expect(parseDesign(JSON.parse(serializeDesign(old)))).toEqual(old)
      const normalized = normalizeCustomerDesign(old)
      expect(CUSTOMER_CAMERA_REFS).toContain(normalized.presentation.cameraRef)
      expect({ ...normalized.presentation, cameraRef }).toEqual(old.presentation)
      expect(normalized.config).toEqual(old.config)
    }
    expect(customerAngle('top')).toBe('front-left')
    expect(customerAngle('centre')).toBe('entry')
    expect(customerAngle('back')).toBe('entry')
    expect(customerAngle('rear')).toBe('rear-left')
    const neutral = parseDesign({
      ...design,
      presentation: { ...design.presentation, lookRef: 'studio-neutral-draft@1' },
    })
    expect(neutral.presentation.lookRef).toBe('studio-neutral-draft@1')
    expect(normalizeCustomerDesign(neutral).presentation.lookRef).toBe('studio-day-draft@1')
  })
  it('matches cross-language pinned vectors and removes only camera for set identity', async () => {
    expect(await computeSetIdentity(design)).toEqual(http.identity)
    expect(identityPayload(design, 'set')).toBe(http.canonicalSet)
    expect(identityPayload(design, 'image')).toBe(http.canonicalImage)
    const identities = await Promise.all(fiveViewDesigns(design).map(computeSetIdentity))
    expect(identities.every((entry) => entry.setKey === http.identity.setKey)).toBe(true)
    expect(new Set(Object.values(identities[0].imageKeys)).size).toBe(5)
    for (const view of fiveViewDesigns(design)) {
      const payload = JSON.parse(identityPayload(view, 'image'))
      delete payload.design.presentation.cameraRef
      payload.kind = 'set'
      expect(canonicalJson(payload)).toBe(http.canonicalSet)
    }
  })
  it.each([
    { doorPose: 'open' },
    { lookRef: 'studio-night-draft@1' },
    { lookRef: 'campus-day-draft@1' },
    { lookRef: 'desert-day-draft@1' },
    { lookRef: 'courtyard-day-draft@1' },
    { aspect: 'tall' },
  ])('binds presentation change %j to different set/images', async (patch) => {
    const changed = { ...design, presentation: { ...design.presentation, ...patch } }
    const next = await computeSetIdentity(changed)
    expect(next.setKey).not.toBe(http.identity.setKey)
    for (const camera of CUSTOMER_CAMERA_REFS)
      expect(next.imageKeys[camera]).not.toBe(http.identity.imageKeys[camera])
  })
  it('binds full configuration and rejects noncanonical arrangement/output profile', async () => {
    const changed = {
      ...design,
      config: { ...design.config, appearance: { ...design.config.appearance, mirror: true } },
    }
    expect((await computeSetIdentity(changed)).setKey).not.toBe(http.identity.setKey)
    expect(() =>
      identityPayload(
        { ...design, config: { ...design.config, arrangementRef: 'invented' } },
        'set',
      ),
    ).toThrow()
    expect(() => identityPayload({ ...design, outputProfile: 'web-thumbnail' }, 'set')).toThrow()
    expect(JSON.parse(http.canonicalSet).recipeRelease).toEqual(RECIPE_RELEASE)
    const forged = JSON.parse(http.canonicalSet)
    forged.recipeRelease.renderer = 'different'
    expect(`set_${createHash('sha256').update(canonicalJson(forged)).digest('hex')}`).not.toBe(
      http.identity.setKey,
    )
  })
  it('sorts object keys, retains array order and rejects non-JSON values', () => {
    expect(canonicalJson({ z: 1, a: { z: 2, a: [3, 1] } })).toBe('{"a":{"a":[3,1],"z":2},"z":1}')
    for (const value of [undefined, Infinity, NaN, new Date(), { bad: undefined }])
      expect(() => canonicalJson(value)).toThrow()
  })
})

describe('strict public requests and honest snapshots', () => {
  it('keeps lookup and explicit create/retry intent separate', () => {
    expect(lookupRequestSchema.parse(http.lookup)).toEqual(http.lookup)
    expect(createJobRequestSchema.safeParse(http.lookup).success).toBe(false)
    expect(lookupRequestSchema.safeParse(http.create).success).toBe(false)
    expect(createJobRequestSchema.parse(http.create)).toEqual(http.create)
    expect(
      retryJobRequestSchema.safeParse({ ...http.create, intent: 'retry-failed-missing' }).success,
    ).toBe(false)
  })
  it.each([
    'setKey',
    'imageKey',
    'url',
    'cost',
    'status',
    'provider',
    'scene',
    'command',
    'approval',
  ])('rejects client-supplied %s claims', (field) => {
    expect(createJobRequestSchema.safeParse({ ...http.create, [field]: 'untrusted' }).success).toBe(
      false,
    )
  })
  it('does not silently normalize historical cameras at the HTTP boundary', () => {
    const old = {
      ...http.lookup,
      design: { ...design, presentation: { ...design.presentation, cameraRef: 'top-draft@1' } },
    }
    expect(lookupRequestSchema.safeParse(old).success).toBe(false)
    expect(
      lookupRequestSchema.safeParse({ ...old, design: normalizeCustomerDesign(old.design) })
        .success,
    ).toBe(true)
  })
  it('validates missing, partial, complete, unavailable and every async stage without fabricated telemetry', () => {
    for (const value of [
      http.missing,
      http.partial,
      http.complete,
      http.lookupFailure,
      ...Object.values(http.jobStates),
    ])
      expect(lookupResponseSchema.safeParse(value).success).toBe(true)
    expect(http.partial.views.filter((view) => view.status === 'ready')).toHaveLength(1)
    expect(http.complete.views.filter((view) => view.status === 'ready')).toHaveLength(5)
    expect('coverage' in http.lookupFailure).toBe(false)
    const snapshot = setSnapshotSchema.parse(http.partial)
    expect(setSnapshotSchema.safeParse({ ...snapshot, coverage: 'complete' }).success).toBe(false)
    expect(
      setSnapshotSchema.safeParse({
        ...snapshot,
        views: [...snapshot.views.slice(0, 4), snapshot.views[0]],
      }).success,
    ).toBe(false)
    const uncertain = http.jobStates['dispatch-uncertain']
    expect(
      setSnapshotSchema.safeParse({ ...uncertain, job: { ...uncertain.job, retrySafe: true } })
        .success,
    ).toBe(false)
    expect(
      setSnapshotSchema.safeParse({ ...uncertain, job: { ...uncertain.job, completedImages: 4 } })
        .success,
    ).toBe(false)
    expect(
      setSnapshotSchema.safeParse({ ...uncertain, job: { ...uncertain.job, percent: 99 } }).success,
    ).toBe(false)
  })
  it('allows only public-safe error messages and no retry on ambiguous dispatch', () => {
    expect(
      safeErrorSchema.safeParse({ ...safeError('worker-failed'), message: 'raw provider secret' })
        .success,
    ).toBe(false)
    expect(() => safeError('dispatch-uncertain', true)).toThrow()
  })
})

describe('native manifest compatibility and immutable descriptors', () => {
  it('pins exact historical manifest bytes and retains original receipt evidence', async () => {
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(SEED_MANIFEST_SHA256)
    const manifest = verifySeedManifest(manifestBytes)
    expect(manifest.entries).toHaveLength(400)
    expect(() => verifySeedManifest(Buffer.concat([manifestBytes, Buffer.from('\n')]))).toThrow()
    const images = await seedImagesForSet(manifestBytes, design)
    expect(images).toHaveLength(4)
    for (const image of images) {
      expect(image.provenance.kind).toBe('seed-cache')
      if (image.provenance.kind !== 'seed-cache') throw new Error('wrong seed provenance')
      const provenance = image.provenance
      const entry = manifest.entries.find((entry) => entry.id === provenance.entryId)!
      expect(image.provenance.historicalRecipeDigest).toBe(entry.recipeDigest)
      expect(image.provenance.historicalWorkerSha256).toBe(entry.workerSha256)
      expect(image.provenance.historicalManifestSha256).toBe(entry.manifestSha256)
      expect(image.sha256).toBe(entry.imageSha256)
      expect(await verifyImageDescriptor(image, image.design, [])).toEqual(image)
    }
  })
  it('preserves four Day exteriors and one Night hero without reusing old interior pixels', async () => {
    const manifest = verifySeedManifest(manifestBytes)
    const heroes = manifest.entries.filter(
      (entry) => entry.design.presentation.cameraRef === 'front-left-draft@1',
    )
    expect(heroes).toHaveLength(100)
    for (const hero of heroes) {
      const images = await seedImagesForSet(manifestBytes, hero.design)
      expect(images).toHaveLength(hero.design.presentation.lookRef === 'studio-day-draft@1' ? 4 : 1)
      expect(images.some((image) => image.design.presentation.cameraRef === 'entry-draft@1')).toBe(
        false,
      )
    }
  }, 30000)
  it.each([{ lookRef: 'desert-day-draft@1' }, { aspect: 'tall' }, { doorPose: 'open' }])(
    'does not substitute seed pixels for %j',
    async (patch) => {
      expect(
        await seedImagesForSet(
          manifestBytes,
          parseDesign({ ...design, presentation: { ...design.presentation, ...patch } }),
        ),
      ).toHaveLength(0)
    },
  )
  it('checks exact design, hash URL, approved origin and object path before delivery', async () => {
    const seed = imageDescriptorSchema.parse(http.complete.views[0].image)
    await expect(
      verifyImageDescriptor(
        seed,
        { ...design, presentation: { ...design.presentation, doorPose: 'open' } },
        [],
      ),
    ).rejects.toThrow()
    const image = imageDescriptorSchema.parse({
      ...seed,
      provenance: {
        kind: 'native-worker',
        jobId: claim.jobId,
        attemptId: claim.attemptId,
        workerBuildSha256: claim.workerBuildSha256,
        recipeBundleSha256: claim.recipeBundleSha256,
        receiptSha256: 'f'.repeat(64),
      },
      url: `https://storage.example/storage/v1/object/public/render-library/${seed.setKey}/${seed.imageKey}/${seed.sha256}.webp`,
    })
    expect(await verifyImageDescriptor(image, image.design, ['https://storage.example'])).toEqual(
      image,
    )
    await expect(verifyImageDescriptor(image, image.design, [])).rejects.toThrow()
    await expect(
      verifyImageDescriptor(
        { ...image, url: image.url.replace(image.imageKey, `img_${'0'.repeat(64)}`) },
        image.design,
        ['https://storage.example'],
      ),
    ).rejects.toThrow()
    for (const patch of [
      { bytes: MAX_IMAGE_BYTES + 1 },
      { samples: 128 },
      { adaptiveSampling: true },
      { quality: 90 },
      { width: 100 },
      { visuallyQualified: true },
      { url: image.url + '?editable=true' },
    ])
      expect(imageDescriptorSchema.safeParse({ ...image, ...patch }).success).toBe(false)
  })
})

describe('private worker binding and cross-language fixtures', () => {
  it('dispatches identifiers only and keeps uncertainty explicit', () => {
    expect(dispatchEnvelopeSchema.parse(worker.dispatch)).toEqual(worker.dispatch)
    expect(dispatchEnvelopeSchema.safeParse({ ...worker.dispatch, design }).success).toBe(false)
    expect(dispatchResultSchema.parse(worker.uncertain).status).toBe('uncertain')
    expect(workerEventSchema.parse(worker.progress).kind).toBe('progress')
  })
  it('recomputes claimed identities and pins the registered worker build', async () => {
    expect(await verifyWorkerClaim(claim, registration)).toEqual(claim)
    await expect(
      verifyWorkerClaim({ ...claim, workerBuildSha256: '0'.repeat(64) }, registration),
    ).rejects.toThrow()
    await expect(
      verifyWorkerClaim(
        { ...claim, identity: { ...claim.identity, setKey: `set_${'0'.repeat(64)}` } },
        registration,
      ),
    ).rejects.toThrow()
    expect(
      workerClaimSchema.safeParse({ ...claim, views: [claim.views[0], claim.views[0]] }).success,
    ).toBe(false)
    expect(
      workerClaimSchema.safeParse({ ...claim, limits: { ...claim.limits, providerRetries: 1 } })
        .success,
    ).toBe(false)
  })
  it('rejects wrong view/design/attempt/recipe and CPU or partial sample receipts', async () => {
    expect(await verifyArtifactReceipt(worker.receipt, claim)).toEqual(worker.receipt)
    for (const patch of [
      { cpuFallback: true },
      { device: 'CPU' },
      { backend: 'CUDA' },
      { completedSamples: 32 },
      { adaptiveSampling: true },
      { bytes: MAX_IMAGE_BYTES + 1 },
      { renderSeconds: 301 },
    ])
      expect(artifactReceiptSchema.safeParse({ ...worker.receipt, ...patch }).success).toBe(false)
    for (const patch of [
      { workerBuildSha256: '0'.repeat(64) },
      { imageKey: `img_${'0'.repeat(64)}` },
      { attemptId: worker.dispatch.dispatchId },
      { design },
    ])
      await expect(verifyArtifactReceipt({ ...worker.receipt, ...patch }, claim)).rejects.toThrow()
  })
  it('reproduces all committed contract fixtures without network or provider access', async () => {
    const files = await contractFixtures(root)
    for (const [name, fixture] of Object.entries(files))
      expect(
        JSON.parse(readFileSync(resolve(root, 'src/render-library/fixtures', name), 'utf8')),
        name,
      ).toEqual(fixture)
    expect(CONTRACT_VERSION).toBe(worker.contractVersion)
  })
})
