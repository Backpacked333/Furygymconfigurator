// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, encodeConfig } from './config'
import { useConfig } from './useConfig'
import * as repository from './repository'
import { DRAFT_KEY } from './recovery'
import { TestBackend } from './persistenceTestFixtures'

describe('committed hook lifecycle', () => {
  let root: Root, container: HTMLDivElement, backend: TestBackend
  let current: ReturnType<typeof useConfig>
  function Harness() {
    current = useConfig()
    return null
  }
  const mount = async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      await current.flushPersistence()
    })
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    backend = new TestBackend()
    vi.spyOn(repository, 'openDocumentRepository').mockImplementation(async () => ({
      ok: true,
      value: new repository.DocumentRepository(backend, false),
    }))
    localStorage.clear()
    history.replaceState(null, '', '/')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('keeps StrictMode previews out of storage/history and writes once on commit', async () => {
    await mount()
    const revision = current.revision,
      writes = backend.writes
    let token!: ReturnType<typeof current.beginEdit>
    act(() => {
      token = current.beginEdit()
    })
    act(() => {
      for (let i = 0; i < 60; i++)
        current.previewEdit(token, { ...current.committedConfig, time: 7 + i / 10 })
    })
    await act(async () => {
      await current.flushPersistence()
    })
    expect(current.config.time).toBe(12.9)
    expect(current.committedConfig).toEqual(DEFAULT_CONFIG)
    expect(current.revision).toBe(revision)
    expect(current.canUndo).toBe(false)
    expect(backend.writes).toBe(writes)
    act(() => {
      current.commitEdit(token)
    })
    await act(async () => {
      await current.flushPersistence()
    })
    expect(current.revision).toBe(revision + 1)
    expect(current.canUndo).toBe(true)
    expect(backend.writes).toBe(writes + 1)
    expect(current.persistence.status).toBe('saved')
  })
  it('does not overwrite a nondefault draft through malformed link initialization', async () => {
    const draft = { ...DEFAULT_CONFIG, finish: 'chalk' as const },
      raw = encodeConfig(draft)
    localStorage.setItem(DRAFT_KEY, raw)
    history.replaceState(null, '', '/#c=malformed')
    await mount()
    expect(current.committedConfig).toEqual(draft)
    expect(backend.rows.get('draft')?.raw).toBe(raw)
    expect(current.recovery.some((record) => record.record.raw === '#c=malformed')).toBe(true)
  })
  it('does not write rejected preview bytes to recovery', async () => {
    await mount()
    let token!: ReturnType<typeof current.beginEdit>
    act(() => {
      token = current.beginEdit()
    })
    const size = localStorage.length,
      writes = backend.writes
    act(() => {
      current.previewEdit(token, { ...DEFAULT_CONFIG, time: NaN })
    })
    await act(async () => {
      await current.flushPersistence()
    })
    expect(current.lastEditResult?.status).toBe('rejected')
    expect(localStorage.length).toBe(size)
    expect(backend.writes).toBe(writes)
    act(() => {
      current.cancelEdit(token)
    })
    expect(current.isPreviewing).toBe(false)
  })
  it('retains the raw repair document until explicit repaired acceptance', async () => {
    const repair = { ...DEFAULT_CONFIG, items: [{ ...DEFAULT_CONFIG.items[0], x: 19 }] },
      raw = encodeConfig(repair)
    localStorage.setItem(DRAFT_KEY, raw)
    await mount()
    expect(current.repair.required).toBe(true)
    expect(current.persistence.writeSafe).toBe(false)
    expect(backend.rows.get('draft')?.raw).toBe(raw)
    await act(async () => {
      expect(await current.acceptRecovery(DEFAULT_CONFIG)).toMatchObject({
        ok: true,
        value: { status: 'saved' },
      })
    })
    await act(async () => {
      await current.flushPersistence()
    })
    expect(current.repair.required).toBe(false)
    expect(current.persistence.writeSafe).toBe(true)
    expect(
      [...backend.rows.values()].some(
        (row) => row.key.startsWith('recovery:') && JSON.parse(row.raw).raw === raw,
      ),
    ).toBe(true)
  })
  it('leaves edits volatile when IndexedDB is unavailable', async () => {
    vi.mocked(repository.openDocumentRepository).mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    })
    await mount()
    act(() => {
      current.setConfig({ ...DEFAULT_CONFIG, finish: 'olive' })
    })
    expect(current.committedConfig.finish).toBe('olive')
    expect(current.persistence).toMatchObject({
      writeSafe: false,
      status: 'volatile',
      reason: 'unavailable',
    })
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })
  it('enqueues a committed edit before unmount can skip its passive effect', async () => {
    await mount()
    const draft = { ...DEFAULT_CONFIG, finish: 'chalk' as const }
    await act(async () => {
      current.setConfig(draft)
      root.unmount()
      await current.flushPersistence()
    })
    expect(backend.rows.get('draft')?.raw).toBe(encodeConfig(draft))
  })
  it('archives unsaved volatile edits before an explicit reset', async () => {
    await mount()
    const volatile = { ...DEFAULT_CONFIG, finish: 'olive' as const }
    backend.fail = 'quota'
    act(() => {
      current.setConfig(volatile)
    })
    await act(async () => {
      await current.flushPersistence()
    })
    expect(current.persistence.writeSafe).toBe(false)
    backend.fail = undefined
    await act(async () => {
      await current.resetConfig()
    })
    await act(async () => {
      await current.flushPersistence()
    })
    expect(current.committedConfig).toEqual(DEFAULT_CONFIG)
    expect(current.persistence.writeSafe).toBe(true)
    expect(
      [...backend.rows.values()].some(
        (row) =>
          row.key.startsWith('recovery:') && JSON.parse(row.raw).raw === JSON.stringify(volatile),
      ),
    ).toBe(true)
  })
})
