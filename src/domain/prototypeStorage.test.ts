import { describe, expect, it } from 'vitest'
import { defaultDesign, serializeDesign } from './design'
import {
  PROTOTYPE_RECOVERY_PREFIX,
  PROTOTYPE_STORAGE_KEY,
  readPrototypeDesign,
  savePrototypeDesign,
} from './prototypeStorage'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

describe('isolated v4 prototype storage', () => {
  it('does not read, migrate or overwrite legacy/review namespaces', () => {
    const original = {
      'fury-draft-v1': '{raw legacy',
      'fury-builds-v1': '[raw library',
      'fury-fixed-review-v1': 'raw review',
    }
    const store = storage(original)
    expect(readPrototypeDesign(store)).toEqual({ status: 'empty', raw: null })
    expect(savePrototypeDesign(store, defaultDesign(), null).status).toBe('saved')
    for (const [key, value] of Object.entries(original)) expect(store.values.get(key)).toBe(value)
    expect(readPrototypeDesign(store).status).toBe('ready')
  })

  it.each(['{bad', '{"config":{"schemaVersion":99}}', ' '.repeat(17000)])(
    'preserves malformed/future raw bytes before consented replacement',
    (raw) => {
      const store = storage({ [PROTOTYPE_STORAGE_KEY]: raw })
      expect(readPrototypeDesign(store)).toEqual({ status: 'recovery-required', raw })
      expect(savePrototypeDesign(store, defaultDesign(), raw).status).toBe('recovery-required')
      expect(store.values.size).toBe(1)
      const result = savePrototypeDesign(store, defaultDesign(), raw, true)
      expect(result.status).toBe('saved')
      expect(result.recoveryKey?.startsWith(PROTOTYPE_RECOVERY_PREFIX)).toBe(true)
      expect(store.values.get(result.recoveryKey!)).toBe(raw)
      expect(store.values.get(PROTOTYPE_STORAGE_KEY)).toBe(serializeDesign(defaultDesign()))
    },
  )

  it('archives valid prior revisions too and avoids needless writes for identical designs', () => {
    const old = serializeDesign(defaultDesign())
    const store = storage({ [PROTOTYPE_STORAGE_KEY]: old })
    expect(savePrototypeDesign(store, defaultDesign(), old)).toMatchObject({
      status: 'saved',
      recoveryKey: null,
    })
    expect(store.values.size).toBe(1)
    const result = savePrototypeDesign(
      store,
      defaultDesign({ family: 'container', lengthFt: 40 }),
      old,
    )
    expect(result.status).toBe('saved')
    expect(store.values.get(result.recoveryKey!)).toBe(old)
  })

  it('fails closed when reads or archive writes fail', () => {
    const raw = '{recover me'
    const store = storage({ [PROTOTYPE_STORAGE_KEY]: raw })
    const quota = {
      ...store,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(savePrototypeDesign(quota, defaultDesign(), raw, true).status).toBe('storage-error')
    expect(store.values.get(PROTOTYPE_STORAGE_KEY)).toBe(raw)
    expect(
      readPrototypeDesign({
        ...store,
        getItem: () => {
          throw new Error('denied')
        },
      }).status,
    ).toBe('storage-error')
  })

  it('does not replace an original if its recovery copy cannot be verified', () => {
    const raw = 'raw original'
    const store = storage({ [PROTOTYPE_STORAGE_KEY]: raw })
    const broken = { ...store, setItem: () => undefined }
    expect(savePrototypeDesign(broken, defaultDesign(), raw, true).status).toBe('storage-error')
    expect(store.values.get(PROTOTYPE_STORAGE_KEY)).toBe(raw)
  })

  it('keeps the verified archive when replacing the current key fails', () => {
    const raw = 'original'
    const store = storage({ [PROTOTYPE_STORAGE_KEY]: raw })
    const broken = {
      ...store,
      setItem: (key: string, value: string) => {
        if (key === PROTOTYPE_STORAGE_KEY) throw new Error('quota')
        store.setItem(key, value)
      },
    }
    const result = savePrototypeDesign(broken, defaultDesign(), raw, true)
    expect(result.status).toBe('storage-error')
    expect(store.values.get(result.recoveryKey!)).toBe(raw)
    expect(store.values.get(PROTOTYPE_STORAGE_KEY)).toBe(raw)
  })

  it('rejects stale observed raw and rechecks mutations during archival', () => {
    const raw = 'first'
    const store = storage({ [PROTOTYPE_STORAGE_KEY]: raw })
    expect(savePrototypeDesign(store, defaultDesign(), 'not current', true).status).toBe('conflict')
    const racing = {
      ...store,
      setItem: (key: string, value: string) => {
        store.setItem(key, value)
        if (key.startsWith(PROTOTYPE_RECOVERY_PREFIX))
          store.setItem(PROTOTYPE_STORAGE_KEY, 'other writer')
      },
    }
    const result = savePrototypeDesign(racing, defaultDesign(), raw, true)
    expect(result.status).toBe('conflict')
    expect(store.values.get(PROTOTYPE_STORAGE_KEY)).toBe('other writer')
    expect(store.values.get(result.recoveryKey!)).toBe(raw)
  })
})
