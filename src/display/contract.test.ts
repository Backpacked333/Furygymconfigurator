import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { defaultDesign, parseDesign } from '../domain/design'
import { createSceneDesignFixtures } from '../domain/designFixtures'
import { DRAFT_CAMERAS, DRAFT_LOOKS } from '../domain/presentation'
import {
  bindDisplay,
  createDisplayRequest,
  displayBuildSchema,
  displayHolds,
  displayImagePath,
  displayProfileSchema,
  displayRequestSchema,
  DISPLAY_FLAGS,
  DISPLAY_LABEL,
  DISPLAY_LIMITS,
  DISPLAY_MODE,
  DISPLAY_PROFILES,
  DISPLAY_PROTOCOL,
  isDisplaySelection,
  parseDisplayReply,
  parseDisplayRequestText,
  validateDisplayImage,
  type DisplayArtifact,
} from './contract'
import {
  displayReceiptSchema,
  localDisplayPermitSchema,
  parseDisplayReceipt,
  validateDisplayJob,
} from './session'

// Entirely synthetic identities/byte headers for unit tests; NOT real build/capture evidence.
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const build = displayBuildSchema.parse({
  sourceManifestDigest: sha('source'),
  assetManifestDigest: sha('asset'),
  bundleDigest: sha('bundle'),
  lockfileDigest: sha('lock'),
  runtimePolicyDigest: sha('runtime'),
  threeRevision: '186',
})
const id = 'test_only_01234567890123456789'
const design = defaultDesign()
async function ready() {
  const binding = await bindDisplay(design, build)
  const artifact: DisplayArtifact = {
    checksum: sha('png'),
    receiptDigest: sha('receipt'),
    mediaType: 'image/png',
    byteLength: 44,
    width: 1600,
    height: 1000,
    src: displayImagePath(id, sha('png')),
    exactMatch: true,
    approvedCurrentImage: false,
    cacheStatus: 'rendered-miss',
    provenance: {
      kind: 'private-three-display',
      label: DISPLAY_LABEL,
      sessionId: id,
      revision: 1,
      flags: DISPLAY_FLAGS,
      holds: displayHolds(design),
    },
  }
  return {
    protocol: DISPLAY_PROTOCOL,
    mode: DISPLAY_MODE,
    interestId: id,
    binding,
    state: 'ready' as const,
    artifact,
  }
}
describe('frozen private display contract', () => {
  it('accepts six semantic fixtures, all eight current looks, seven named cameras and both aspects without rendering', () => {
    expect(createSceneDesignFixtures()).toHaveLength(6)
    expect(DRAFT_LOOKS).toHaveLength(8)
    for (const fixture of createSceneDesignFixtures())
      for (const look of DRAFT_LOOKS)
        for (const camera of DRAFT_CAMERAS)
          for (const aspect of ['wide', 'tall'] as const) {
            const candidate = parseDesign({
              ...fixture.design,
              presentation: {
                ...fixture.design.presentation,
                lookRef: look.ref,
                cameraRef: camera.ref,
                aspect,
              },
            })
            expect(createDisplayRequest(candidate).design).toEqual(candidate)
          }
  })
  it('preserves legacy neutral studio reading without adding a third lighting control', () => {
    const candidate = parseDesign({
      ...design,
      presentation: { ...design.presentation, lookRef: 'studio-neutral-draft@1' },
    })
    expect(createDisplayRequest(candidate).design.presentation.lookRef).toBe(
      'studio-neutral-draft@1',
    )
    expect(DRAFT_LOOKS.some((l) => String(l.ref) === 'studio-neutral-draft@1')).toBe(false)
  })
  it('rejects arbitrary geometry, equipment, URLs, quality, provider and fixed-arrangement mismatch', () => {
    for (const key of ['geometry', 'equipment', 'url', 'quality', 'provider', 'permit'])
      expect(
        displayRequestSchema.safeParse({ ...createDisplayRequest(design), [key]: 'injected' })
          .success,
      ).toBe(false)
    expect(() =>
      createDisplayRequest({ ...design, config: { ...design.config, arrangementRef: 'wrong' } }),
    ).toThrow()
    expect(() => parseDisplayRequestText(' '.repeat(DISPLAY_LIMITS.requestBytes + 1))).toThrow()
  })
  it('pins full Ultra wide and portrait profiles; rejects Lite and arbitrary output overrides', () => {
    expect(DISPLAY_PROFILES.wide.width).toBe(1600)
    expect(DISPLAY_PROFILES.tall.height).toBe(1500)
    for (const profile of Object.values(DISPLAY_PROFILES)) {
      expect(displayProfileSchema.parse(profile)).toEqual(profile)
      for (const patch of [
        { quality: 'lite' },
        { width: 640 },
        { temporalFrames: 1 },
        { fallbackAllowed: true },
        { provider: 'fake-local' },
      ])
        expect(displayProfileSchema.safeParse({ ...profile, ...patch }).success).toBe(false)
    }
  })
  it('keys every design/presentation/build/profile dependency and deterministically reuses A', async () => {
    const a = await bindDisplay(design, build)
    expect(await bindDisplay(design, build)).toEqual(a)
    for (const key of [
      'sourceManifestDigest',
      'assetManifestDigest',
      'bundleDigest',
      'lockfileDigest',
      'runtimePolicyDigest',
    ] as const)
      expect((await bindDisplay(design, { ...build, [key]: sha(key) })).displayDigest).not.toBe(
        a.displayDigest,
      )
    const changed = [
      parseDesign({
        ...design,
        config: { ...design.config, appearance: { ...design.config.appearance, finish: 'bronze' } },
      }),
      parseDesign({ ...design, presentation: { ...design.presentation, aspect: 'tall' } }),
      parseDesign({
        ...design,
        presentation: { ...design.presentation, lookRef: 'campus-night-draft@1' },
      }),
      parseDesign({
        ...design,
        presentation: { ...design.presentation, cameraRef: 'entry-draft@1' },
      }),
      parseDesign({ ...design, outputProfile: 'web-thumbnail' }),
    ]
    for (const candidate of changed)
      expect((await bindDisplay(candidate, build)).displayDigest).not.toBe(a.displayDigest)
  })
  it('requires explicit DEV opt-in and rejects duplicate selectors', () => {
    expect(isDisplaySelection(true, '?prototype=images&imageMode=private-display')).toBe(true)
    expect(isDisplaySelection(false, '?prototype=images&imageMode=private-display')).toBe(false)
    expect(
      isDisplaySelection(true, '?prototype=images&imageMode=private-display&imageMode=local-real'),
    ).toBe(false)
    expect(isDisplaySelection(true, '')).toBe(false)
  })
  it('validates immutable polling and exact artifacts; rejects stale/fake/remote/approved replacements', async () => {
    const reply = await ready()
    await expect(parseDisplayReply(reply, design)).resolves.toEqual(reply)
    for (const artifact of [
      { ...reply.artifact, src: 'https://example.com/image.png' },
      { ...reply.artifact, width: 640 },
      { ...reply.artifact, mediaType: 'image/svg+xml' },
      { ...reply.artifact, approvedCurrentImage: true },
      { ...reply.artifact, provenance: { ...reply.artifact.provenance, kind: 'fake-local' } },
      { ...reply.artifact, provenance: { ...reply.artifact.provenance, holds: ['approved'] } },
    ])
      await expect(parseDisplayReply({ ...reply, artifact }, design)).rejects.toThrow()
    await expect(
      parseDisplayReply(reply, design, { interestId: `${id}_other`, binding: reply.binding }),
    ).rejects.toThrow()
    const other = await bindDisplay(design, { ...build, bundleDigest: sha('other') })
    await expect(
      parseDisplayReply(reply, design, { interestId: id, binding: other }),
    ).rejects.toThrow()
  })
  it('hashes actual bounded bytes before decode and rejects decode mismatch (test double only)', async () => {
    const { artifact } = await ready()
    const bytes = new Uint8Array(44)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(bytes.buffer)
    view.setUint32(8, 13)
    view.setUint32(12, 0x49484452)
    view.setUint32(16, 1600)
    view.setUint32(20, 1000)
    const input = {
      ...artifact,
      checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }
    const decode = vi.fn(async () => ({ width: 1600, height: 1000 }))
    await validateDisplayImage(input, bytes, decode)
    expect(decode).toHaveBeenCalledOnce()
    bytes[43] = 1
    await expect(validateDisplayImage(input, bytes, decode)).rejects.toThrow('checksum')
    expect(decode).toHaveBeenCalledOnce()
    bytes[43] = 0
    await expect(
      validateDisplayImage(input, bytes, async () => ({ width: 640, height: 400 })),
    ).rejects.toThrow('decode')
  })
  it('binds the private job and receipt to a single scene revision, not host shutdown or settlement', async () => {
    const binding = await bindDisplay(design, build)
    const job = await validateDisplayJob(
      { protocol: DISPLAY_PROTOCOL, jobId: id, sessionId: id, revision: 1, design, binding },
      build,
    )
    const receipt = displayReceiptSchema.parse({
      protocol: DISPLAY_PROTOCOL,
      kind: 'private-three-display',
      jobId: id,
      sessionId: id,
      revision: 1,
      binding,
      cameraDigest: sha('camera'),
      checksum: sha('png'),
      width: 1600,
      height: 1000,
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
        adapter: 'test-only',
        browserVersion: 'test-only',
      },
      elapsedMs: 100,
      hostShutdownProven: false,
      billingFinal: false,
    })
    expect(parseDisplayReceipt(receipt, job)).toEqual(receipt)
    for (const patch of [
      { revision: 2 },
      { width: 640 },
      { hostShutdownProven: true },
      { billingFinal: true },
    ])
      expect(() => parseDisplayReceipt({ ...receipt, ...patch }, job)).toThrow()
    await expect(
      validateDisplayJob(job, { ...build, bundleDigest: sha('different') }),
    ).rejects.toThrow()
    expect(
      localDisplayPermitSchema.safeParse({ provider: 'modal', paidExecutionAllowed: true }).success,
    ).toBe(false)
  })
})
