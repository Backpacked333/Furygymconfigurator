export type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>

export function archiveRawValue(
  storage: RecoveryStorage,
  sourceKey: string,
  raw: string,
  recoveryPrefix = `${sourceKey}-recovery-`,
) {
  if (storage.getItem(sourceKey) !== raw)
    throw new Error('The stored design changed. Reload before replacing it.')
  const recoveryKey = `${recoveryPrefix}${crypto.randomUUID()}`
  if (storage.getItem(recoveryKey) !== null) throw new Error('Recovery key already exists.')
  storage.setItem(recoveryKey, raw)
  if (storage.getItem(recoveryKey) !== raw)
    throw new Error('The original design could not be verified in recovery storage.')
  return Object.freeze({ sourceKey, recoveryKey, raw })
}

/** Archive both original namespaces before a future migration parses or writes anything. */
export function archiveLegacyOriginals(storage: RecoveryStorage) {
  return ['fury-draft-v1', 'fury-builds-v1'].flatMap((sourceKey) => {
    const raw = storage.getItem(sourceKey)
    return raw === null ? [] : [archiveRawValue(storage, sourceKey, raw)]
  })
}
