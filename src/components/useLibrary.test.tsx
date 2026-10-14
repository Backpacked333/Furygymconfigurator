// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repository from '../lib/repository'
import { TestBackend } from '../lib/persistenceTestFixtures'
import { DEFAULT_CONFIG } from '../lib/config'
import { useLibrary } from './useLibrary'

describe('library UI transaction adapter', () => {
  let root: Root, host: HTMLDivElement, backend: TestBackend
  let library: ReturnType<typeof useLibrary>
  function Harness() {
    library = useLibrary()
    return <span>{library.snapshot === null ? 'not loaded' : library.snapshot.entries.length}</span>
  }
  const mount = async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      )
    })
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    backend = new TestBackend()
    vi.spyOn(repository, 'openDocumentRepository').mockImplementation(async () => ({
      ok: true,
      value: new repository.DocumentRepository(backend, false),
    }))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('keeps good builds beside rejected originals instead of treating a mixed library as empty', async () => {
    const build = repository.buildFromConfig(DEFAULT_CONFIG, 'Preserved')
    backend.rows.set(`build:${build.id}`, {
      key: `build:${build.id}`,
      version: 1,
      revision: 1,
      raw: JSON.stringify(build),
    })
    backend.rows.set('build:future', {
      key: 'build:future',
      version: 12,
      revision: 4,
      raw: 'exact future bytes',
    })
    await mount()
    expect(library.snapshot?.entries[0].build.name).toBe('Preserved')
    expect(library.snapshot?.rejected[0].raw).toBe('exact future bytes')
    expect(backend.writes).toBe(0)
  })
  it('retains a loaded snapshot and reports quota failure without success', async () => {
    await mount()
    const build = repository.buildFromConfig(DEFAULT_CONFIG, 'Pending idea')
    backend.fail = 'quota'
    await act(async () => {
      expect(await library.save(build)).toEqual({ ok: false, reason: 'quota' })
    })
    expect(library.snapshot?.entries).toEqual([])
    expect(library.error).toBe('quota')
    expect(library.busy).toBe(false)
    expect(build.config).toEqual(DEFAULT_CONFIG)
  })
  it('does not delete a newer revision read by another tab', async () => {
    const build = repository.buildFromConfig(DEFAULT_CONFIG, 'Original')
    const row = { key: `build:${build.id}`, version: 1, revision: 1, raw: JSON.stringify(build) }
    backend.rows.set(row.key, row)
    await mount()
    backend.rows.set(row.key, {
      ...row,
      revision: 2,
      raw: JSON.stringify({ ...build, name: 'Other tab' }),
    })
    await act(async () => {
      const result = await library.remove(build.id, 1)
      expect(result.ok && result.value.status).toBe('conflict')
    })
    expect(library.error).toBe('conflict')
    expect(library.snapshot?.entries[0].build.name).toBe('Other tab')
    expect(backend.rows.get(row.key)?.deleted).not.toBe(true)
  })
  it('distinguishes unavailable storage from an empty library', async () => {
    vi.mocked(repository.openDocumentRepository).mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    })
    await mount()
    expect(library.snapshot).toBeNull()
    expect(library.error).toBe('unavailable')
    expect(host.textContent).toBe('not loaded')
  })
  it('closes a delayed repository instead of binding an unmounted dialog', async () => {
    const owner = new repository.DocumentRepository(backend, false)
    const close = vi.spyOn(owner, 'close')
    let resolve!: (value: Awaited<ReturnType<typeof repository.openDocumentRepository>>) => void
    vi.mocked(repository.openDocumentRepository).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      root.render(null)
    })
    await act(async () => {
      resolve({ ok: true, value: owner })
    })
    expect(close).toHaveBeenCalledOnce()
  })
})
