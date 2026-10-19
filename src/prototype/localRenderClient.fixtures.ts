// Test-only synthetic wire/PNG-header fixtures. Fake decoders; NOT captured or decodable image evidence.
import { designIdentity } from '../domain/designIdentity'
import { designReviewHolds } from '../domain/design'
import {
  LOCAL_RENDER_EFFECTS,
  LOCAL_RENDER_FLAGS,
  LOCAL_RENDER_LABEL,
  LOCAL_RENDER_PROFILE,
  localRenderDesign,
  localRenderReplyBase,
  localRenderImagePath,
  matchLocalRenderSample,
  type LocalRenderReadyReply,
} from '../image-service/localRenderProtocol'

export const TEST_ORIGIN = 'http://localhost:3000'
export const syntheticHash = (char: string) => `sha256:${char.repeat(64)}`
export async function localFixture(finish: 'obsidian' | 'bronze' = 'obsidian', suffix = '1') {
  const design = localRenderDesign(finish)
  const bytes = new Uint8Array(44)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  view.setUint32(12, 0x49484452)
  view.setUint32(16, 640)
  view.setUint32(20, 400)
  bytes[43] = finish === 'bronze' ? 1 : 0
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const checksum = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  const id = `synthetic-client-interest-0000000${suffix}`
  const omitted = new Set([
    'ambient-occlusion',
    'screen-space-gi',
    'screen-space-reflections',
    'bloom',
    'path-tracing',
  ])
  const reply: LocalRenderReadyReply = {
    ...localRenderReplyBase(id, await designIdentity(design), {
      captureDigest: syntheticHash(finish === 'obsidian' ? 'a' : 'b'),
      build: {
        sourceManifestDigest: syntheticHash('c'),
        assetManifestDigest: syntheticHash('d'),
        bundleDigest: syntheticHash('e'),
        lockfileDigest: syntheticHash('f'),
        threeRevision: '186',
      },
      profile: LOCAL_RENDER_PROFILE,
    }),
    state: 'ready',
    artifact: {
      checksum,
      src: localRenderImagePath(id, checksum),
      mediaType: 'image/png',
      width: 640,
      height: 400,
      byteLength: bytes.length,
      exactMatch: true,
      approvedCurrentImage: false,
      cacheStatus: 'verified-exact-hit',
      provenance: {
        kind: 'local-three-capture',
        label: LOCAL_RENDER_LABEL,
        captureProtocol: 'fury.local-three-capture@1',
        jobId: 'synthetic-client-test',
        sampleId: matchLocalRenderSample(design)!.id,
        receiptDigest: syntheticHash('1'),
        runtime: {
          backend: 'webgl2',
          acceleration: 'software',
          adapter: 'SYNTHETIC software test adapter',
          browserVersion: 'SYNTHETIC TEST',
          userAgent: 'SYNTHETIC TEST',
          effects: LOCAL_RENDER_EFFECTS.map((id) => ({
            id,
            state: omitted.has(id)
              ? 'omitted'
              : ['mirror', 'thin-glass', 'site-light-field'].includes(id)
                ? 'approximate'
                : 'enabled',
            detail: 'Synthetic test observation, not rendering evidence.',
          })),
        },
        holds: [...designReviewHolds(design)],
        flags: LOCAL_RENDER_FLAGS,
      },
    },
  }
  const base = localRenderReplyBase(reply.interestId, reply.requested, reply.capture)
  return { design, bytes, reply, pending: { ...base, state: 'queued' as const, retryAfterMs: 500 } }
}
export function fakeResponse(url: string, body: unknown, status = 200, png = false) {
  const response = new Response(png ? new Uint8Array(body as Uint8Array) : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': png ? 'image/png' : 'application/json' },
  })
  Object.defineProperty(response, 'url', { value: url, configurable: true })
  return response
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
