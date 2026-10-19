// Synthetic contract fixtures only. No browser launch, capture, ledger, service or image file.
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { build as viteBuild } from 'vite'
import { defaultDesign, designReviewHolds, parseDesign } from '../domain/design'
import { designIdentity } from '../domain/designIdentity'
import { createImageRequest, imageReplySchema, parseImageRequest } from './protocol'
import {
  CAPTURE_EFFECTS,
  LOCAL_REVIEW_PROFILES,
  captureIdentity,
  createCaptureSamples,
} from '../render/prototype/capture/contract'
import { decodeCapturePng } from '../render/prototype/capture/artifacts'
import {
  LOCAL_RENDER_EFFECTS,
  LOCAL_RENDER_FLAGS,
  LOCAL_RENDER_LABEL,
  LOCAL_RENDER_PROFILE,
  LOCAL_RENDER_SAMPLES,
  MAX_LOCAL_RENDER_REQUEST_BYTES,
  UnsupportedLocalRenderDesignError,
  createLocalRenderRequest,
  isCurrentLocalRenderDesign,
  isLocalRenderSelection,
  localRenderArtifactSchema,
  localRenderBuildSchema,
  localRenderDesign,
  localRenderImagePath,
  localRenderReplyBase,
  localRenderReplySchema,
  localRenderRuntimeSchema,
  localRenderStatusPath,
  matchLocalRenderSample,
  parseLocalRenderReply,
  parseLocalRenderRequest,
  parseLocalRenderRequestText,
  parseLocalRenderStatusReply,
  parseLocalRenderSubmissionReply,
  validateLocalRenderImage,
} from './localRenderProtocol'

const hash = (char: string) => `sha256:${char.repeat(64)}`
const syntheticBuild = {
  sourceManifestDigest: hash('a'),
  assetManifestDigest: hash('b'),
  bundleDigest: hash('c'),
  lockfileDigest: hash('d'),
  threeRevision: '186',
}
const interestId = 'synthetic-interest-00000001'
const omitted = new Set([
  'ambient-occlusion',
  'screen-space-gi',
  'screen-space-reflections',
  'bloom',
  'path-tracing',
])
const runtime = () => ({
  backend: 'webgl2',
  acceleration: 'software',
  adapter: 'SYNTHETIC software test adapter',
  browserVersion: 'TEST ONLY',
  userAgent: 'TEST ONLY',
  effects: LOCAL_RENDER_EFFECTS.map((id) => ({
    id,
    state: omitted.has(id) ? 'omitted' : id === 'mirror' ? 'approximate' : 'enabled',
    detail: 'Synthetic contract test, not observed rendering.',
  })),
})
async function fixture(finish: 'obsidian' | 'bronze' = 'obsidian') {
  const design = localRenderDesign(finish)
  const sample = createCaptureSamples().find(
    (entry) => entry.id === matchLocalRenderSample(design)!.id,
  )!
  const identity = await captureIdentity(sample.request, syntheticBuild)
  return {
    ...localRenderReplyBase(interestId, identity, {
      captureDigest: identity.captureDigest,
      build: syntheticBuild,
      profile: LOCAL_RENDER_PROFILE,
    }),
    state: 'ready' as const,
    artifact: {
      checksum: hash('e'),
      mediaType: 'image/png',
      src: localRenderImagePath(interestId, hash('e')),
      width: 640,
      height: 400,
      byteLength: 44,
      exactMatch: true,
      approvedCurrentImage: false,
      cacheStatus: 'verified-exact-hit',
      provenance: {
        kind: 'local-three-capture',
        label: LOCAL_RENDER_LABEL,
        captureProtocol: 'fury.local-three-capture@1',
        jobId: 'synthetic-job',
        sampleId: sample.id,
        receiptDigest: hash('f'),
        runtime: runtime(),
        holds: designReviewHolds(design),
        flags: LOCAL_RENDER_FLAGS,
      },
    },
  }
}

/** Actual decodable generated PNG, entirely synthetic gradient; never persisted or called a render. */
function syntheticPng() {
  const chunk = (name: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(name), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(640, 0)
  header.writeUInt32BE(400, 4)
  header[8] = 8
  header[9] = 6
  const scanlines = Buffer.alloc((640 * 4 + 1) * 400)
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 640; x++) {
      const i = y * (640 * 4 + 1) + 1 + x * 4
      scanlines[i] = x % 256
      scanlines[i + 1] = y % 256
      scanlines[i + 2] = (x + y) % 256
      scanlines[i + 3] = 255
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', new Uint8Array()),
  ])
}

describe('strict real local wire, separate from mock v1', () => {
  it('derives exactly two full frozen designs without changing canonical defaults or aliasing capture', () => {
    expect(LOCAL_RENDER_SAMPLES).toHaveLength(2)
    expect(localRenderDesign('obsidian')).toEqual(defaultDesign())
    const bronze = localRenderDesign('bronze')
    expect(
      parseDesign({
        ...bronze,
        config: {
          ...bronze.config,
          appearance: { ...bronze.config.appearance, finish: 'obsidian' },
        },
      }),
    ).toEqual(defaultDesign())
    expect(defaultDesign().config.appearance.finish).toBe('obsidian')
    expect(Object.isFrozen(bronze.config.structure.addons)).toBe(true)
    for (const sample of LOCAL_RENDER_SAMPLES) {
      expect(matchLocalRenderSample(sample.design)?.id).toBe(sample.id)
      expect(
        createCaptureSamples().filter(
          (entry) => JSON.stringify(entry.request.design) === JSON.stringify(sample.design),
        ),
      ).toHaveLength(1)
      expect(
        parseLocalRenderRequestText(JSON.stringify(createLocalRenderRequest(sample.design))).design,
      ).toEqual(sample.design)
    }
    expect(LOCAL_RENDER_PROFILE).toEqual(LOCAL_REVIEW_PROFILES.wide)
    expect(LOCAL_RENDER_EFFECTS).toEqual(CAPTURE_EFFECTS)
  })

  it('separates logical/capture/byte identity and changes finish without changing the presentation', async () => {
    const charcoal = await fixture('obsidian'),
      bronze = await fixture('bronze')
    expect(charcoal.requested).toEqual(await designIdentity(defaultDesign()))
    expect(charcoal.requested).not.toHaveProperty('captureDigest')
    expect(bronze.requested.designDigest).not.toBe(charcoal.requested.designDigest)
    expect(bronze.requested.presentationDigest).toBe(charcoal.requested.presentationDigest)
    expect(bronze.requested.requestDigest).not.toBe(charcoal.requested.requestDigest)
    expect(bronze.capture.captureDigest).not.toBe(charcoal.capture.captureDigest)
    expect((await fixture('obsidian')).capture).toEqual(charcoal.capture)
    // Metadata in this fixture is synthetic, not a rendered-image checksum assertion.
    expect(charcoal.artifact.checksum).not.toBe(charcoal.capture.captureDigest)
  })

  it('rejects every other full design dimension rather than approximating it', () => {
    const d = defaultDesign()
    const variations = [
      defaultDesign({ family: 'studio', lengthFt: 40 }),
      defaultDesign({ family: 'container', lengthFt: 20 }),
      ...['finish', 'accent', 'interior', 'floor', 'mirror'].map((key, i) => ({
        ...d,
        config: {
          ...d.config,
          appearance: { ...d.config.appearance, [key]: ['chalk', true, 'slatted', 'oak', true][i] },
        },
      })),
      ...[{ door: 'sliding' }, { addons: ['deck'] }, { railing: 'cable' }].map((change) => ({
        ...d,
        config: { ...d.config, structure: { ...d.config.structure, ...change } },
      })),
      ...[
        { lookRef: 'courtyard-night-draft@1' },
        { doorPose: 'open' },
        { cameraRef: 'entry-draft@1' },
        { aspect: 'tall' },
      ].map((change) => ({ ...d, presentation: { ...d.presentation, ...change } })),
      { ...d, outputProfile: 'web-thumbnail' },
    ]
    for (const design of variations) {
      expect(matchLocalRenderSample(design)).toBeNull()
      expect(() => createLocalRenderRequest(design)).toThrow(UnsupportedLocalRenderDesignError)
      expect(isCurrentLocalRenderDesign(d, design)).toBe(false)
    }
    expect(() =>
      createLocalRenderRequest({ ...d, config: { ...d.config, arrangementRef: 'forged' } }),
    ).toThrow()
  })

  it('keeps mock v1 immutable and rejects unknown modes, fields, URLs, versions and byte overflow', () => {
    const d = defaultDesign(),
      real = createLocalRenderRequest(d),
      mock = createImageRequest(d)
    expect(() => parseImageRequest(real)).toThrow()
    expect(() => parseLocalRenderRequest(mock)).toThrow()
    for (const change of [
      { protocolVersion: 2 },
      { mode: 'mock' },
      { url: 'https://bad.invalid' },
      { sampleId: 'anything' },
      { idempotencyKey: 'arbitrary' },
      { backend: 'webgpu' },
      { design: { ...d, extra: true } },
    ])
      expect(() => parseLocalRenderRequest({ ...real, ...change })).toThrow()
    expect(() => parseLocalRenderRequestText('é'.repeat(MAX_LOCAL_RENDER_REQUEST_BYTES))).toThrow()
    expect(() => parseLocalRenderRequestText('{')).toThrow()
    expect(
      localRenderBuildSchema.safeParse({ ...syntheticBuild, sourcePath: '/tmp' }).success,
    ).toBe(false)
  })

  it('requires explicit DEV selection and fixed capability paths without arbitrary URLs', () => {
    expect(isLocalRenderSelection(true, '?prototype=images&imageMode=local-real')).toBe(true)
    for (const search of [
      '',
      '?prototype=images',
      '?prototype=images&imageMode=mock',
      '?prototype=images&imageMode=local-real&imageMode=local-real',
    ])
      expect(isLocalRenderSelection(true, search)).toBe(false)
    expect(isLocalRenderSelection(false, '?prototype=images&imageMode=local-real')).toBe(false)
    expect(() => localRenderStatusPath('../bad')).toThrow()
    expect(() => localRenderImagePath(interestId, 'https://bad.invalid')).toThrow()
  })

  it('validates current logical selection, status binding, holds and exact delivery path independently of ready JSON shape', async () => {
    const reply = await fixture(),
      d = defaultDesign()
    await expect(parseLocalRenderSubmissionReply(200, reply, d)).resolves.toMatchObject({
      status: 200,
    })
    expect(imageReplySchema.safeParse(reply).success).toBe(false)
    await expect(parseLocalRenderReply(reply, localRenderDesign('bronze'))).rejects.toThrow()
    await expect(
      parseLocalRenderStatusReply(reply, d, 'different-interest-000000001', reply.capture),
    ).rejects.toThrow()
    for (const field of [
      'sourceManifestDigest',
      'assetManifestDigest',
      'bundleDigest',
      'lockfileDigest',
    ] as const)
      await expect(
        parseLocalRenderStatusReply(
          {
            ...reply,
            capture: { ...reply.capture, build: { ...reply.capture.build, [field]: hash('0') } },
          },
          d,
          interestId,
          reply.capture,
        ),
      ).rejects.toThrow()
    await expect(
      parseLocalRenderStatusReply(
        { ...reply, capture: { ...reply.capture, captureDigest: hash('0') } },
        d,
        interestId,
        reply.capture,
      ),
    ).rejects.toThrow()
    for (const artifact of [
      { ...reply.artifact, src: localRenderImagePath(interestId, hash('0')) },
      {
        ...reply.artifact,
        provenance: { ...reply.artifact.provenance, sampleId: 'studio-20-bronze-front-left-wide' },
      },
      { ...reply.artifact, provenance: { ...reply.artifact.provenance, holds: ['approved'] } },
    ])
      await expect(parseLocalRenderReply({ ...reply, artifact }, d)).rejects.toThrow()
    expect(
      localRenderReplySchema.safeParse({
        ...reply,
        capture: { ...reply.capture, profile: LOCAL_REVIEW_PROFILES.tall },
      }).success,
    ).toBe(false)
  })

  it('separates asynchronous states and denies wrong HTTP status or artifact on pending', async () => {
    const ready = await fixture()
    const { artifact, ...base } = ready
    expect(artifact.mediaType).toBe('image/png')
    const pending = { ...base, state: 'queued', retryAfterMs: 500 }
    await expect(
      parseLocalRenderSubmissionReply(202, pending, defaultDesign()),
    ).resolves.toMatchObject({ status: 202 })
    await expect(parseLocalRenderSubmissionReply(200, pending, defaultDesign())).rejects.toThrow()
    await expect(parseLocalRenderSubmissionReply(202, ready, defaultDesign())).rejects.toThrow()
    expect(localRenderReplySchema.safeParse({ ...pending, artifact: ready.artifact }).success).toBe(
      false,
    )
    expect(
      localRenderReplySchema.safeParse({
        ...base,
        state: 'cancelled',
        cancellationScope: 'interest-only',
        sharedWorkCancelled: false,
      }).success,
    ).toBe(true)
  })

  it('cannot claim approved imagery, hardware qualification, unreported effects or higher quality', async () => {
    const reply = await fixture()
    for (const change of [
      { approvedCurrentImage: true },
      { mediaType: 'image/svg+xml' },
      { width: 960 },
      { src: 'https://bad.invalid/image.png' },
      { src: '/stills/historical.png' },
    ])
      expect(localRenderArtifactSchema.safeParse({ ...reply.artifact, ...change }).success).toBe(
        false,
      )
    expect(
      localRenderRuntimeSchema.safeParse({ ...runtime(), acceleration: 'hardware' }).success,
    ).toBe(false)
    for (const id of ['path-tracing', 'mirror']) {
      const changed = runtime()
      changed.effects.find((effect) => effect.id === id)!.state = 'enabled'
      expect(localRenderRuntimeSchema.safeParse(changed).success).toBe(false)
    }
    const missing = runtime()
    missing.effects[0] = missing.effects[1]
    expect(localRenderRuntimeSchema.safeParse(missing).success).toBe(false)
  })
})

describe('actual PNG verification, synthetic bytes not capture evidence', () => {
  it('hashes bytes and independently decodes dimensions; rejects mutation, truncation and fake decode', async () => {
    const bytes = syntheticPng(),
      reply = await fixture()
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const artifact = {
      ...reply.artifact,
      byteLength: bytes.length,
      checksum,
      src: localRenderImagePath(interestId, checksum),
    }
    const decode = vi.fn(async (png: Uint8Array) =>
      decodeCapturePng(Buffer.from(png), LOCAL_REVIEW_PROFILES.wide),
    )
    await expect(validateLocalRenderImage(artifact, bytes, decode)).resolves.toBeUndefined()
    expect(decode).toHaveBeenCalledTimes(1)
    const changed = new Uint8Array(bytes)
    changed[changed.length - 1] ^= 1
    await expect(validateLocalRenderImage(artifact, changed, decode)).rejects.toThrow('checksum')
    await expect(validateLocalRenderImage(artifact, bytes.subarray(1), decode)).rejects.toThrow()
    await expect(
      validateLocalRenderImage(artifact, bytes, async () => ({ width: 400, height: 500 })),
    ).rejects.toThrow('Decoded')
    await expect(
      validateLocalRenderImage(artifact, bytes, async () => {
        throw new Error('decode failed')
      }),
    ).rejects.toThrow('decode failed')
    const header = new Uint8Array(bytes)
    new DataView(header.buffer).setUint32(16, 400)
    await expect(validateLocalRenderImage(artifact, header, decode)).rejects.toThrow('dimensions')
    const svg = new TextEncoder().encode('<svg>Mock diagnostic is not a PNG image.</svg>')
    await expect(
      validateLocalRenderImage({ ...artifact, byteLength: svg.length }, svg, decode),
    ).rejects.toThrow()
  })

  it('bundles the public protocol without Three, Node or private capture code', async () => {
    const result = await viteBuild({
      configFile: false,
      envFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: 'src/image-service/localRenderProtocol.ts',
          preserveEntrySignatures: 'strict',
        },
      },
    })
    if ('on' in result) throw new Error('Unexpected watcher')
    for (const bundle of Array.isArray(result) ? result : [result])
      for (const output of bundle.output) {
        if (output.type !== 'chunk') continue
        expect(
          Object.keys(output.modules).some((name) =>
            /\/render\/|\/three\/|node:|\/image-service\/(?:http|service|store|protocol)\./.test(
              name,
            ),
          ),
        ).toBe(false)
        expect(output.code).not.toMatch(
          /node:crypto|node:fs|__FURY_LOCAL_CAPTURE__|diagnostic-svg@1/,
        )
      }
  }, 30000)
})
