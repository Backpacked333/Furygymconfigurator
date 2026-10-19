import { archiveRawValue, type RecoveryStorage } from '../lib/recovery'
import { deserializeDesign, parseDesign, serializeDesign, type DesignEnvelope } from './design'

/** Isolated from fury-draft-v1, fury-builds-v1 and fury-fixed-review-v1. No legacy reads/migration. */
export const PROTOTYPE_STORAGE_KEY = 'fury-prototype-v4-draft-1' as const
export const PROTOTYPE_RECOVERY_PREFIX = `${PROTOTYPE_STORAGE_KEY}-recovery-` as const
export type PrototypeRead =
  | Readonly<{ status: 'empty'; raw: null }>
  | Readonly<{ status: 'ready'; raw: string; design: DesignEnvelope }>
  | Readonly<{ status: 'recovery-required'; raw: string }>
  | Readonly<{ status: 'storage-error'; raw: null }>

export function readPrototypeDesign(storage: RecoveryStorage): PrototypeRead {
  try {
    const raw = storage.getItem(PROTOTYPE_STORAGE_KEY)
    if (raw === null) return { status: 'empty', raw }
    const design = deserializeDesign(raw)
    return design ? { status: 'ready', raw, design } : { status: 'recovery-required', raw }
  } catch {
    return { status: 'storage-error', raw: null }
  }
}

export type PrototypeWrite =
  | Readonly<{ status: 'saved'; raw: string; design: DesignEnvelope; recoveryKey: string | null }>
  | Readonly<{
      status: 'conflict' | 'recovery-required' | 'storage-error'
      recoveryKey: string | null
    }>

/**
 * Preserve BEFORE replace, verify the copy, and compare the caller's exact observed raw value.
 * Unreadable/future data needs explicit consent, never auto-migration. Storage/quota failures
 * fail closed. This synchronous localStorage guard is not a cross-tab transaction: integrations
 * needing concurrent writers must serialize them (e.g. Web Locks) and handle conflict receipts.
 */
export function savePrototypeDesign(
  storage: RecoveryStorage,
  input: unknown,
  expectedRaw: string | null,
  allowRecoveryReplacement = false,
): PrototypeWrite {
  const design = parseDesign(input)
  const raw = serializeDesign(design)
  let recoveryKey: string | null = null
  try {
    const previous = storage.getItem(PROTOTYPE_STORAGE_KEY)
    if (previous !== expectedRaw) return { status: 'conflict', recoveryKey }
    if (previous !== null && !deserializeDesign(previous) && allowRecoveryReplacement !== true)
      return { status: 'recovery-required', recoveryKey }
    if (previous === raw) return { status: 'saved', raw, design, recoveryKey }
    if (previous !== null)
      recoveryKey = archiveRawValue(
        storage,
        PROTOTYPE_STORAGE_KEY,
        previous,
        PROTOTYPE_RECOVERY_PREFIX,
      ).recoveryKey
    if (storage.getItem(PROTOTYPE_STORAGE_KEY) !== previous)
      return { status: 'conflict', recoveryKey }
    storage.setItem(PROTOTYPE_STORAGE_KEY, raw)
    if (storage.getItem(PROTOTYPE_STORAGE_KEY) !== raw) return { status: 'conflict', recoveryKey }
    return { status: 'saved', raw, design, recoveryKey }
  } catch {
    return { status: 'storage-error', recoveryKey }
  }
}
