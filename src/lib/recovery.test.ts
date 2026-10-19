import { afterEach, describe, expect, it, vi } from 'vitest'
import { archiveLegacyOriginals, archiveRawValue } from './recovery'

function store(entries: [string, string][] = []) {
  const values = new Map(entries)
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('raw recovery storage', () => {
  it('archives opaque draft/library bytes before parsing, without writing a new design', () => {
    const entries: [string, string][] = [
      ['fury-draft-v1', 'old-compressed-payload'],
      ['fury-builds-v1', ' \n { corrupt JSON and future data }  '],
    ]
    const storage = store(entries)
    const result = archiveLegacyOriginals(storage)
    expect(result).toHaveLength(2)
    for (const { sourceKey, recoveryKey, raw } of result) {
      expect(storage.values.get(recoveryKey)).toBe(raw)
      expect(storage.values.get(sourceKey)).toBe(raw)
      expect(storage.setItem).not.toHaveBeenCalledWith(sourceKey, expect.anything())
    }
  })

  it('distinguishes absent and empty originals', () => {
    const storage = store([['fury-draft-v1', '']])
    expect(archiveLegacyOriginals(storage)).toEqual([
      expect.objectContaining({ sourceKey: 'fury-draft-v1', raw: '' }),
    ])
    expect(archiveLegacyOriginals(store())).toEqual([])
  })

  it('fails closed on quota/read errors or silently discarded recovery writes', () => {
    for (const failure of ['quota', 'read', 'discard'] as const) {
      const storage = store([['fury-builds-v1', 'recover me']])
      if (failure === 'quota')
        storage.setItem.mockImplementation(() => {
          throw new Error('quota')
        })
      if (failure === 'read')
        storage.getItem.mockImplementation(() => {
          throw new Error('denied')
        })
      if (failure === 'discard') storage.setItem.mockImplementation(() => undefined)
      expect(() => archiveLegacyOriginals(storage)).toThrow()
      expect(storage.values.get('fury-builds-v1')).toBe('recover me')
    }
  })

  it('does not overwrite an existing recovery key on UUID collision', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000000')
    const key = 'fury-builds-v1-recovery-00000000-0000-0000-0000-000000000000'
    const storage = store([
      ['fury-builds-v1', 'new original'],
      [key, 'prior original'],
    ])
    expect(() => archiveLegacyOriginals(storage)).toThrow('Recovery key already exists')
    expect(storage.values.get(key)).toBe('prior original')
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('refuses an archive from an out-of-date snapshot', () => {
    const storage = store([['fury-builds-v1', 'newer']])
    expect(() => archiveRawValue(storage, 'fury-builds-v1', 'older')).toThrow('changed')
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})
