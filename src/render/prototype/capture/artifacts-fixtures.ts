/** Synthetic unit-test fixtures only. Never renderer evidence, never imported by the private page/CLI. */
import { deflateSync } from 'node:zlib'
import {
  CAPTURE_EFFECTS,
  CAPTURE_FLAGS,
  CAPTURE_PROTOCOL,
  LOCAL_REVIEW_PROFILES,
  resolveCaptureCamera,
  type CaptureBuild,
  type CaptureJob,
  type CaptureProfile,
  type WorkerResult,
} from './contract'
// Synthetic metadata models Chromium's reduced page UA vs full CDP product version.
// These strings are fixtures, not an observation or evidence of rendering.
export const SYNTHETIC_BROWSER = {
  product: 'Chrome/137.0.7118.2',
  userAgent: 'Synthetic test only HeadlessChrome/137.0.0.0',
} as const
export const TEST_BUILD: CaptureBuild = {
  sourceManifestDigest: `sha256:${'a'.repeat(64)}`,
  assetManifestDigest: `sha256:${'b'.repeat(64)}`,
  bundleDigest: `sha256:${'c'.repeat(64)}`,
  lockfileDigest: `sha256:${'d'.repeat(64)}`,
  threeRevision: '186',
}
export function testChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data])
  // Independent slow reference CRC implementation, not the production decoder's table.
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
export function syntheticPng(
  options: {
    profile?: CaptureProfile
    channels?: 3 | 4
    filter?: number
    blank?: boolean
    transparent?: boolean
    inflateExtra?: number
    header?: (header: Buffer) => void
    extra?: Buffer[]
    compressedSuffix?: Buffer
  } = {},
) {
  const { width, height } = options.profile ?? LOCAL_REVIEW_PROFILES.wide,
    channels = options.channels ?? 4
  const pixels = Buffer.alloc(width * height * channels),
    rgba = Buffer.alloc(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    const rgb = options.blank ? [0, 0, 0] : [p % 256, Math.floor(p / width) % 256, (p * 17) % 256]
    for (let c = 0; c < 3; c++) {
      pixels[p * channels + c] = rgb[c]
      rgba[p * 4 + c] = rgb[c]
    }
    rgba[p * 4 + 3] = options.transparent ? 0 : 255
    if (channels === 4) pixels[p * channels + 3] = rgba[p * 4 + 3]
  }
  const stride = width * channels,
    raw = Buffer.alloc((stride + 1) * height + (options.inflateExtra ?? 0)),
    filter = options.filter ?? 0
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0,
        b = y ? pixels[(y - 1) * stride + x] : 0,
        c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c)
      const predictor =
        [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0
      raw[y * (stride + 1) + x + 1] = (pixels[y * stride + x] - predictor + 256) & 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  options.header?.(header)
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    testChunk('IHDR', header),
    ...(options.extra ?? []),
    testChunk(
      'IDAT',
      Buffer.concat([deflateSync(raw), options.compressedSuffix ?? Buffer.alloc(0)]),
    ),
    testChunk('IEND', Buffer.alloc(0)),
  ])
  return { png, rgba, width, height }
}
export function syntheticResult(
  job: CaptureJob,
  options: Parameters<typeof syntheticPng>[0] = {},
): Extract<WorkerResult, { state: 'captured' }> {
  const omitted = new Set([
    'ambient-occlusion',
    'screen-space-gi',
    'screen-space-reflections',
    'bloom',
    'path-tracing',
  ])
  return {
    protocol: CAPTURE_PROTOCOL,
    state: 'captured',
    jobId: job.jobId,
    captureDigest: job.identity.captureDigest,
    pngBase64: syntheticPng({ profile: job.profile, ...options }).png.toString('base64'),
    camera: resolveCaptureCamera(job.request.design),
    runtime: {
      backend: 'webgl2',
      acceleration: 'software',
      adapter: 'Synthetic test SwiftShader; not a measured renderer',
      browserVersion: 'HeadlessChrome/137.0.0.0',
      userAgent: SYNTHETIC_BROWSER.userAgent,
      effects: CAPTURE_EFFECTS.map((id) => ({
        id,
        state: omitted.has(id) ? 'omitted' : id === 'mirror' ? 'approximate' : 'enabled',
        detail: 'Synthetic unit-test assertion only',
      })),
    },
    renderedFrames: 8,
    elapsedMs: 20,
    flags: CAPTURE_FLAGS,
  }
}
