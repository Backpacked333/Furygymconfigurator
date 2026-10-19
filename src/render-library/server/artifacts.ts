import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { MAX_IMAGE_BYTES, type ImageDescriptor } from '../contracts.js'
import { stagingObjectKey, uploadTicketSchema, type ArtifactReceipt } from '../workerProtocol.js'
import type { DesignEnvelope } from '../../domain/design.js'
import type { ImmutableArtifactStore } from './ports.js'
import { boundedBytes, httpsOrigin, ServiceError } from './httpSafety.js'
import { seedImagesForSet } from './seedCache.js'
import { SupabaseTransport } from './supabase.js'

export const checksum = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
export async function verifyPixels(
  bytes: Uint8Array,
  expected: Pick<ImageDescriptor, 'bytes' | 'sha256' | 'width' | 'height'>,
) {
  if (
    bytes.length !== expected.bytes ||
    bytes.length > MAX_IMAGE_BYTES ||
    checksum(bytes) !== expected.sha256
  )
    throw new ServiceError('verification-failed', 400)
  if (
    Buffer.from(bytes.subarray(0, 4)).toString() !== 'RIFF' ||
    Buffer.from(bytes.subarray(8, 12)).toString() !== 'WEBP'
  )
    throw new ServiceError('verification-failed', 400)
  const image = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: 1920 * 1500,
    sequentialRead: true,
  }).timeout({ seconds: 10 })
  const metadata = await image.metadata()
  if (
    metadata.format !== 'webp' ||
    metadata.width !== expected.width ||
    metadata.height !== expected.height ||
    (metadata.pages ?? 1) !== 1 ||
    (metadata.orientation && metadata.orientation !== 1)
  )
    throw new ServiceError('verification-failed', 400)
  // metadata() alone never decodes pixels. Materialize every pixel before publication.
  const decoded = await image.raw().toBuffer({ resolveWithObject: true })
  if (
    decoded.info.width !== expected.width ||
    decoded.info.height !== expected.height ||
    decoded.data.length !== expected.width * expected.height * decoded.info.channels
  )
    throw new ServiceError('verification-failed', 400)
}

export class StaticSeedSource {
  constructor(
    private readonly origin: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly manifestPath = join(process.cwd(), 'public/native-library/manifest.json'),
  ) {
    if (origin) httpsOrigin(origin)
  }
  async images(
    design: DesignEnvelope,
    readyImageKeys: readonly string[] = [],
  ): Promise<readonly ImageDescriptor[]> {
    const descriptors = (await seedImagesForSet(await readFile(this.manifestPath), design)).filter(
      (image) => !readyImageKeys.includes(image.imageKey),
    )
    if (descriptors.length && !this.origin) throw new ServiceError('lookup-unavailable', 503)
    // At most five bounded downloads; serial timeouts can exceed the API's 60s limit.
    await Promise.all(
      descriptors.map(async (image) => {
        const response = await this.fetcher(`${this.origin}${image.url}`, {
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new ServiceError('lookup-unavailable', 503)
        }
        await verifyPixels(await boundedBytes(response, MAX_IMAGE_BYTES), image)
      }),
    )
    return descriptors
  }
}

export class SupabaseArtifacts implements ImmutableArtifactStore {
  constructor(private readonly transport: SupabaseTransport) {}
  private key(value: string) {
    if (!/^set_[a-f0-9]{64}\/img_[a-f0-9]{64}\/[a-f0-9]{64}\.webp$/.test(value))
      throw new Error('Invalid object key')
    return value
  }
  async read(objectKey: string, maxBytes: number) {
    const response = await this.transport.request(
      `/storage/v1/object/authenticated/render-library/${this.key(objectKey)}`,
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new ServiceError('verification-failed', 503)
    }
    return boundedBytes(response, Math.min(maxBytes, MAX_IMAGE_BYTES))
  }
  async putIfAbsent(objectKey: string, bytes: Uint8Array, sha256: string) {
    this.key(objectKey)
    if (
      checksum(bytes) !== sha256 ||
      bytes.length > MAX_IMAGE_BYTES ||
      !objectKey.endsWith(`/${sha256}.webp`)
    )
      throw new ServiceError('verification-failed', 400)
    const response = await this.transport.request(
      `/storage/v1/object/render-library/${objectKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': '31536000', 'x-upsert': 'false' },
        body: Buffer.from(bytes),
      },
    )
    if (!response.ok) {
      await response.body?.cancel()
      // Supabase returns 400 for existing keys. Verify the existing bytes for ANY failed write;
      // a timeout is handled by caller replay, never by overwriting the object.
      const existing = await this.read(objectKey, MAX_IMAGE_BYTES)
      if (existing.length !== bytes.length || checksum(existing) !== sha256)
        throw new ServiceError('verification-failed', 503)
    } else await response.body?.cancel()
    return { url: `${this.transport.origin}/storage/v1/object/public/render-library/${objectKey}` }
  }
  async staging(receipt: ArtifactReceipt) {
    const response = await this.transport.request(
      `/storage/v1/object/authenticated/render-library-staging/${stagingObjectKey(receipt)}`,
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new ServiceError('verification-failed', 503)
    }
    return boundedBytes(response, Math.min(receipt.bytes, MAX_IMAGE_BYTES))
  }
  async uploadTicket(receipt: ArtifactReceipt) {
    const objectKey = stagingObjectKey(receipt)
    const result = (await this.transport.json(
      `/storage/v1/object/upload/sign/render-library-staging/${objectKey}`,
      { method: 'POST', headers: { 'x-upsert': 'false' } },
    )) as { url?: unknown }
    if (typeof result?.url !== 'string') throw new ServiceError('verification-failed', 503)
    const url = new URL(`${this.transport.origin}/storage/v1${result.url}`)
    if (
      url.origin !== this.transport.origin ||
      url.pathname !== `/storage/v1/object/upload/sign/render-library-staging/${objectKey}` ||
      !url.searchParams.get('token')
    )
      throw new ServiceError('verification-failed', 503)
    // Supabase upload signatures expire after two hours (not a caller-selected expiresIn).
    return uploadTicketSchema.parse({
      bucket: 'render-library-staging',
      objectKey,
      uploadUrl: url.href,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      maxBytes: receipt.bytes,
      overwrite: false,
    })
  }
}
