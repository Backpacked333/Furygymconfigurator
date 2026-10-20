import { createHash } from 'node:crypto'
import { constants, linkSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { designReviewHolds } from '../../../domain/design'
import {
  CAPTURE_FLAGS,
  CAPTURE_LIMITS,
  CAPTURE_PROTOCOL,
  CaptureContractError,
  captureCompleteSchema,
  validateCaptureReceipt,
  validateDecodedArtifact,
  type CaptureComplete,
  type CaptureJob,
  type CaptureProfile,
  type CaptureRuntime,
  type WorkerResult,
} from './contract'

/** Compare independently observed CDP metadata with the page's unmodified UA fields.
 * Chromium reduces the page UA to major.0.0.0 while CDP reports its full product version.
 * Accept only that known reduction (same major) or an exact full version; never rewrite
 * either observation or infer an unobserved patch version for the page receipt. */
export function matchesObservedBrowserRuntime(
  runtime: Pick<CaptureRuntime, 'userAgent' | 'browserVersion'>,
  observed: { product: string; userAgent: string },
): boolean {
  const page = observed.userAgent.match(
    /(?:^|\s)((?:HeadlessChrome|Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+))(?=\s|$)/,
  )
  const product = observed.product.match(/^(?:HeadlessChrome|Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (
    !page ||
    !product ||
    runtime.userAgent !== observed.userAgent ||
    runtime.browserVersion !== page[1]
  )
    return false
  const pageParts = page.slice(2)
  const productParts = product.slice(1)
  return (
    pageParts.every((part, i) => part === productParts[i]) ||
    (pageParts[0] === productParts[0] && pageParts.slice(1).every((part) => part === '0'))
  )
}

export function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
export function jsonBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.length > CAPTURE_LIMITS.metadataBytes)
    throw new CaptureContractError('limit-exceeded', 'Metadata exceeds byte cap.')
  return bytes
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function pngCrc(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function invalidPng(): never {
  throw new CaptureContractError('invalid-artifact', 'PNG decoding or integrity check failed.')
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Legacy Lite wrapper retains its original byte cap and profile contract. */
export function decodeCapturePng(bytes: Buffer, profile: CaptureProfile) {
  return decodeBoundedPng(bytes, {
    width: profile.width,
    height: profile.height,
    maxBytes: CAPTURE_LIMITS.pngBytes,
    maxPixels: profile.width * profile.height,
  })
}

/** Pure bounded RGB/RGBA8 decoder; no capture admission, profile casts or rendering. */
export function decodeBoundedPng(
  bytes: Buffer,
  profile: { width: number; height: number; maxBytes: number; maxPixels: number },
) {
  if (
    ![profile.width, profile.height, profile.maxBytes, profile.maxPixels].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    profile.maxBytes > 16 * 1024 * 1024 ||
    profile.maxPixels > 4_000_000 ||
    profile.width * profile.height > profile.maxPixels ||
    bytes.length < 57 ||
    bytes.length > profile.maxBytes ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    invalidPng()
  let offset = 8,
    chunks = 0,
    width = 0,
    height = 0,
    channels = 0
  let idatStarted = false,
    idatEnded = false,
    ended = false
  const data: Buffer[] = [],
    seen = new Set<string>()
  while (offset < bytes.length) {
    if (++chunks > 512 || offset + 12 > bytes.length) invalidPng()
    const size = bytes.readUInt32BE(offset)
    if (size > profile.maxBytes || offset + 12 + size > bytes.length) invalidPng()
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    if (
      !typeBytes.every((byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) ||
      typeBytes[2] < 65 ||
      typeBytes[2] > 90
    )
      invalidPng()
    const type = typeBytes.toString('ascii')
    const body = bytes.subarray(offset + 8, offset + 8 + size)
    if (
      pngCrc(bytes.subarray(offset + 4, offset + 8 + size)) !==
      bytes.readUInt32BE(offset + 8 + size)
    )
      invalidPng()
    if (chunks === 1 && type !== 'IHDR') invalidPng()
    if (type === 'IHDR') {
      if (chunks !== 1 || size !== 13) invalidPng()
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (
        width !== profile.width ||
        height !== profile.height ||
        body[8] !== 8 ||
        ![2, 6].includes(body[9]) ||
        body[10] ||
        body[11] ||
        body[12]
      )
        invalidPng()
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      if (!channels || idatEnded) invalidPng()
      idatStarted = true
      data.push(body)
    } else if (type === 'IEND') {
      if (size || !idatStarted || offset + 12 !== bytes.length) invalidPng()
      ended = true
    } else {
      // These fixed-size colour/physical hints don't alter decoded samples. Everything else fails closed.
      const sizes: Record<string, number> = { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 }
      if (idatStarted) idatEnded = true
      if (!(type in sizes) || size !== sizes[type] || seen.has(type) || idatStarted) invalidPng()
      if ((type === 'sRGB' && body[0] > 3) || (type === 'pHYs' && body[8] > 1)) invalidPng()
      seen.add(type)
    }
    offset += size + 12
  }
  if (!ended) invalidPng()
  const stride = width * channels,
    expected = (stride + 1) * height
  let raw: Buffer
  try {
    const compressed = Buffer.concat(data)
    const result = inflateSync(compressed, {
      maxOutputLength: expected,
      info: true,
    }) as unknown as {
      buffer: Buffer
      engine: { bytesWritten: number }
    }
    if (result.buffer.length !== expected || result.engine.bytesWritten !== compressed.length)
      invalidPng()
    raw = result.buffer
  } catch {
    invalidPng()
  }
  const scan = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter > 4) invalidPng()
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? scan[y * stride + x - channels] : 0
      const b = y ? scan[(y - 1) * stride + x] : 0
      const c = y && x >= channels ? scan[(y - 1) * stride + x - channels] : 0
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]
      scan[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = scan[p * channels]
    rgba[p * 4 + 1] = scan[p * channels + 1]
    rgba[p * 4 + 2] = scan[p * channels + 2]
    rgba[p * 4 + 3] = channels === 4 ? scan[p * channels + 3] : 255
  }
  return { width, height, rgba }
}

/** Local same-UID interference is not sandboxed. Parent and inode checks reject accidental replacement. */
export class ExclusiveDirectory {
  private constructor(
    readonly path: string,
    private readonly device: number,
    private readonly inode: number,
  ) {}
  static async create(path: string, sourceRoot?: string) {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      !/^[a-zA-Z0-9._-]+$/.test(basename(path)) ||
      (sourceRoot && (path === sourceRoot || path.startsWith(`${sourceRoot}/`))) ||
      (await realpath(dirname(path))) !== dirname(path)
    )
      throw new CaptureContractError(
        'invalid-input',
        'Output requires a real absolute parent outside source.',
      )
    await mkdir(path, { mode: 0o700 }) // Never recursive; existing directories are never adopted.
    const stat = await lstat(path)
    return new ExclusiveDirectory(path, stat.dev, stat.ino)
  }
  assertOwned() {
    const stat = lstatSync(this.path)
    if (
      realpathSync(this.path) !== this.path ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.device ||
      stat.ino !== this.inode
    )
      throw new CaptureContractError('publication-failed', 'Owned output directory changed.')
  }
  private file(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name))
      throw new CaptureContractError('invalid-input', 'Invalid private output filename.')
    this.assertOwned()
    return join(this.path, name)
  }
  async write(name: string, bytes: Uint8Array, maxBytes = CAPTURE_LIMITS.metadataBytes as number) {
    if (!bytes.length || bytes.length > maxBytes)
      throw new CaptureContractError('limit-exceeded', 'Output byte cap exceeded.')
    const file = this.file(name)
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.verify(name, bytes)
  }
  verify(name: string, expected: Uint8Array) {
    const file = this.file(name),
      stat = lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== expected.byteLength ||
      !readFileSync(file).equals(Buffer.from(expected))
    )
      throw new CaptureContractError('publication-failed', 'Output readback differs.')
  }
  commit(pending: string, final: string, bytes: Uint8Array, fence: () => void) {
    this.verify(pending, bytes)
    fence()
    // No await between the final cancellation check and the exclusive publication commit point.
    linkSync(this.file(pending), this.file(final))
  }
}

export async function publishCapture(options: {
  directory: ExclusiveDirectory
  job: CaptureJob
  result: Extract<WorkerResult, { state: 'captured' }>
  elapsedMs: () => number
  fence: () => void
  revalidateSources: () => Promise<void>
  onCommitted?: (marker: CaptureComplete) => void
}) {
  const { directory, job, result, fence } = options
  fence()
  const bytes = Buffer.from(result.pngBase64, 'base64')
  if (bytes.toString('base64') !== result.pngBase64) invalidPng()
  const artifact = await validateDecodedArtifact(
    job.profile,
    bytes,
    decodeCapturePng(bytes, job.profile),
  )
  fence()
  const receipt = await validateCaptureReceipt(
    {
      protocol: CAPTURE_PROTOCOL,
      state: 'validated-draft-capture',
      job,
      artifact,
      camera: result.camera,
      runtime: result.runtime,
      renderedFrames: result.renderedFrames,
      elapsedMs: options.elapsedMs(),
      holds: designReviewHolds(job.request.design),
      flags: CAPTURE_FLAGS,
    },
    job,
  )
  fence()
  const receiptBytes = jsonBytes(receipt)
  await directory.write('image.png', bytes, CAPTURE_LIMITS.pngBytes)
  fence()
  await directory.write('receipt.json', receiptBytes)
  fence()
  await options.revalidateSources()
  fence()
  directory.verify('image.png', bytes)
  directory.verify('receipt.json', receiptBytes)
  const marker = captureCompleteSchema.parse({
    protocol: CAPTURE_PROTOCOL,
    state: 'complete-draft-capture',
    jobId: job.jobId,
    captureDigest: job.identity.captureDigest,
    image: artifact,
    receipt: { filename: 'receipt.json', bytes: receiptBytes.length, digest: digest(receiptBytes) },
    flags: CAPTURE_FLAGS,
  })
  const markerBytes = jsonBytes(marker)
  await directory.write('COMPLETE.pending.json', markerBytes)
  fence()
  directory.verify('image.png', bytes)
  directory.verify('receipt.json', receiptBytes)
  directory.commit('COMPLETE.pending.json', 'COMPLETE.json', markerBytes, fence)
  options.onCommitted?.(marker)
  // pending is deliberately retained: immutable recovery evidence, never a success marker itself.
  return marker
}
