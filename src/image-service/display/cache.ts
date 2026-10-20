import { z } from 'zod'
import {
  DISPLAY_FLAGS,
  DISPLAY_LABEL,
  DISPLAY_LIMITS,
  displayHolds,
  displayImagePath,
  stableDisplayJson,
  type DisplayArtifact,
  type DisplayBinding,
} from '../../display/contract'
import {
  displayJobSchema,
  displayReceiptSchema,
  parseDisplayReceipt,
  validateDisplayJob,
  type DisplayJob,
  type DisplayReceipt,
} from '../../display/session'
import { decodeBoundedPng } from '../../render/prototype/capture/artifacts'
import { DisplayDirectory, hash } from './files'
import { capacity, invalidArtifact } from './errors'

const metadataSchema = z
  .object({
    version: z.literal(1),
    job: displayJobSchema,
    receipt: displayReceiptSchema,
    receiptDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
export type CachedDisplay = {
  job: DisplayJob
  receipt: DisplayReceipt
  receiptDigest: string
  png: Buffer
}

/** Independently hashes, inflates, unfilters and inspects the actual bounded bytes. */
export function verifyDisplayPixels(
  job: DisplayJob,
  receiptInput: unknown,
  png: Uint8Array,
): DisplayReceipt {
  const receipt = parseDisplayReceipt(receiptInput, job)
  if (png.byteLength !== receipt.byteLength || hash(png) !== receipt.checksum)
    throw invalidArtifact()
  const { width, height } = job.binding.profile
  const decoded = decodeBoundedPng(Buffer.from(png), {
    width,
    height,
    maxBytes: DISPLAY_LIMITS.pngBytes,
    maxPixels: 1_800_000,
  })
  let min = 255,
    max = 0,
    opaque = 0,
    varies = false
  for (let i = 0; i < decoded.rgba.length; i += 4) {
    if (decoded.rgba[i + 3] === 255) opaque++
    for (let c = 0; c < 3; c++) {
      varies ||= decoded.rgba[i + c] !== decoded.rgba[c]
      min = Math.min(min, decoded.rgba[i + c])
      max = Math.max(max, decoded.rgba[i + c])
    }
  }
  if (opaque !== width * height || max - min < 2 || !varies) throw invalidArtifact()
  return receipt
}

export function displayArtifact(
  value: CachedDisplay,
  interestId: string,
  hit: boolean,
): DisplayArtifact {
  const { receipt, job } = value
  return {
    checksum: receipt.checksum,
    receiptDigest: value.receiptDigest,
    mediaType: 'image/png',
    byteLength: receipt.byteLength,
    width: receipt.width,
    height: receipt.height,
    src: displayImagePath(interestId, receipt.checksum),
    exactMatch: true,
    approvedCurrentImage: false,
    cacheStatus: hit ? 'verified-exact-hit' : 'rendered-miss',
    provenance: {
      kind: 'private-three-display',
      label: DISPLAY_LABEL,
      sessionId: receipt.sessionId,
      revision: receipt.revision,
      flags: DISPLAY_FLAGS,
      holds: displayHolds(job.design),
    },
  }
}

/** Immutable complete objects only. No LRU deletion can hide uncertain work or reset run budgets.
 * At retention capacity misses fail closed; operator review is required, not automatic cache reset. */
export class DisplayCache {
  constructor(private readonly directory: DisplayDirectory) {}
  private key(binding: DisplayBinding) {
    return binding.displayDigest.slice(7)
  }
  private inventory() {
    const names = this.directory.names(DISPLAY_LIMITS.cacheEntries * 3)
    if (
      names.some((name) => !/^(?:[a-f0-9]{64}\.(?:png|json)|pending-[A-Za-z0-9_-]{32})$/.test(name))
    )
      throw invalidArtifact()
    let bytes = 0
    for (const name of names)
      bytes += this.directory.size(
        name,
        name.endsWith('.json') ? DISPLAY_LIMITS.replyBytes : DISPLAY_LIMITS.pngBytes,
      )
    if (bytes > DISPLAY_LIMITS.cacheBytes) throw invalidArtifact()
    return { entries: names.filter((name) => name.endsWith('.json')).length, bytes }
  }
  async get(binding: DisplayBinding): Promise<CachedDisplay | null> {
    try {
      this.inventory()
      const key = this.key(binding)
      if (!this.directory.has(`${key}.json`)) {
        if (this.directory.has(`${key}.png`)) throw invalidArtifact()
        return null
      }
      const meta = metadataSchema.parse(
        JSON.parse(this.directory.read(`${key}.json`, DISPLAY_LIMITS.replyBytes).toString('utf8')),
      )
      const job = await validateDisplayJob(meta.job, binding.build)
      if (
        stableDisplayJson(job.binding) !== stableDisplayJson(binding) ||
        hash(stableDisplayJson(meta.receipt)) !== meta.receiptDigest
      )
        throw invalidArtifact()
      const png = this.directory.read(`${key}.png`, DISPLAY_LIMITS.pngBytes)
      const receipt = verifyDisplayPixels(job, meta.receipt, png)
      return { job, receipt, receiptDigest: meta.receiptDigest, png }
    } catch {
      throw invalidArtifact()
    }
  }
  async put(
    job: DisplayJob,
    receipt: DisplayReceipt,
    png: Uint8Array,
    fence: () => void,
    revalidate: () => Promise<void>,
  ): Promise<CachedDisplay> {
    await validateDisplayJob(job, job.binding.build)
    verifyDisplayPixels(job, receipt, png)
    const receiptDigest = hash(stableDisplayJson(receipt))
    const metadata = Buffer.from(stableDisplayJson({ version: 1, job, receipt, receiptDigest }))
    if (metadata.length > DISPLAY_LIMITS.replyBytes) throw invalidArtifact()
    const inventory = this.inventory()
    if (
      inventory.entries >= DISPLAY_LIMITS.cacheEntries ||
      inventory.bytes + png.byteLength + metadata.byteLength > DISPLAY_LIMITS.cacheBytes
    )
      throw capacity()
    const key = this.key(job.binding)
    await revalidate()
    fence()
    this.directory.publish(`${key}.png`, png)
    fence()
    this.directory.publish(`${key}.json`, metadata)
    const result = await this.get(job.binding)
    fence()
    if (!result) throw invalidArtifact()
    return result
  }
}
