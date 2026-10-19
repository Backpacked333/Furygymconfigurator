import {
  constants,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  realpathSync,
  readFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { freezeDesignValue } from '../../domain/design'
import { bytesDigest, digest } from './identity'
import { parseP03AssetValidation, P03_EXECUTION_POLICY } from './p03Contract'

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const pinnedFileSchema = z
  .object({
    path: z
      .string()
      .regex(/^public\/textures\/(?:sources\.json|[a-z0-9_]+\/(?:albedo|normal|arm)\.webp)$/),
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
const inventorySchema = z
  .object({
    contract: z.literal('fury.p03-pinned-assets@1'),
    basis: z.string().min(1),
    files: z.array(pinnedFileSchema).length(79),
    rights: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_]+$/),
            source: z.string().url().nullable(),
            authors: z.array(z.string()),
            licenseEvidence: z.literal(
              'credited-origin-only-no-byte-to-license-acquisition-receipt',
            ),
            scopes: z.tuple([
              z.literal('browser-distribution'),
              z.literal('cloud-processing'),
              z.literal('streaming'),
              z.literal('downloadable-derivatives'),
            ]),
            status: z.literal('held'),
          })
          .strict(),
      )
      .length(27),
  })
  .strict()
export const PREPARATION_ASSET_INVENTORY = freezeDesignValue(
  inventorySchema.parse(
    JSON.parse(readFileSync(new URL('./assetInventory.json', import.meta.url), 'utf8')),
  ),
)
const pins = new Map(PREPARATION_ASSET_INVENTORY.files.map((file) => [file.path, file]))
if (
  pins.size !== PREPARATION_ASSET_INVENTORY.files.length ||
  new Set(PREPARATION_ASSET_INVENTORY.rights.map((r) => r.id)).size !== 27
)
  throw new Error('Duplicate trusted asset inventory entry.')
for (const file of pins.values()) {
  if (
    file.path.endsWith('.webp') &&
    !PREPARATION_ASSET_INVENTORY.rights.some((r) =>
      file.path.startsWith(`public/textures/${r.id}/`),
    )
  )
    throw new Error('Asset has no rights record.')
}

/** Internal bounded verifier; a production design/request can never supply these arguments. */
export function verifyPinnedFile(base: string, entry: unknown) {
  const pin = pinnedFileSchema.parse(entry)
  const path = resolve(base, pin.path)
  if (realpathSync(base) !== base || realpathSync(path) !== path || !path.startsWith(`${base}/`))
    throw new Error('Pinned asset path escapes or traverses a symlink.')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size !== pin.bytes)
      throw new Error(`Pinned asset size mismatch: ${pin.path}`)
    const bytes = Buffer.alloc(pin.bytes)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!read) throw new Error(`Pinned asset truncated: ${pin.path}`)
      offset += read
    }
    const after = fstatSync(fd)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      bytesDigest(bytes) !== pin.digest
    )
      throw new Error(`Pinned asset hash mismatch: ${pin.path}`)
    return { path: pin.path, status: 'present' as const, bytes: pin.bytes, digest: pin.digest }
  } finally {
    closeSync(fd)
  }
}

export function verifyPreparationAsset(path: string) {
  const pin = pins.get(path)
  if (!pin) throw new Error(`Unauthorized preparation asset: ${path}`)
  return verifyPinnedFile(root, pin)
}

export function validatePreparationAssets() {
  const records = PREPARATION_ASSET_INVENTORY.files.map((file) => verifyPreparationAsset(file.path))
  return parseP03AssetValidation({
    contract: 'fury.p03-asset-validation@1',
    inventoryDigest: digest(PREPARATION_ASSET_INVENTORY),
    closureDigest: digest(records),
    integrity: 'verified',
    rights: 'held',
    execution: P03_EXECUTION_POLICY,
    holds: [
      ...PREPARATION_ASSET_INVENTORY.rights.map((right) => ({
        gate: 'asset-rights',
        subject: right.id,
        reason: `${right.source ? 'Credited upstream source; acquisition/license evidence for these exact processed bytes is missing' : 'Generated texture; authorship and distribution authorization need confirmation'}. Scopes: ${right.scopes.join(', ')}.`,
      })),
      {
        gate: 'asset-rights',
        subject: 'fury-product-equipment-brand-arrangements',
        reason:
          'Confirm rights to model, distribute and render the product geometry, fixed equipment designs and Fury marks; repository possession is not a license grant.',
      },
      {
        gate: 'renderer-conversion',
        subject: 'console-signature-system-fonts',
        reason:
          'Generic sans-serif depends on worker font mapping; pin font files and license evidence before cross-host pixel equivalence.',
      },
      {
        gate: 'execution-authorization',
        subject: 'P03',
        reason:
          'Preparation only; no render, reference dispatch, paid execution or production authorization.',
      },
    ],
  })
}
