// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LZString from 'lz-string'
import { DEFAULT_CONFIG, encodeConfig, inspectDocument, type Config } from './config'
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
  it.each([1, 2, 3])(
    'PRES-08 retains formerly valid v%s rack raw and suspends all repair autosave',
    async (v) => {
      const legacy = {
        ...DEFAULT_CONFIG,
        v,
        family: v === 1 ? 'studio' : 'container',
        items: [
          { id: 'old-7.5ft-rack', sku: 'rack', x: v === 1 ? -6.5 : -5, z: -0.8, rotation: 0 },
        ],
      }
      const raw = LZString.compressToEncodedURIComponent(JSON.stringify(legacy))
      localStorage.setItem(DRAFT_KEY, raw)
      await mount()
      expect(current.repair).toMatchObject({ required: true, workspace: true, canAccept: false })
      expect(current.committedConfig.items).toEqual(legacy.items)
      expect(current.repair.issues.join(' ')).toContain(v === 1 ? 'lined floor' : 'ceiling')
      expect(backend.rows.get('draft')?.raw).toBe(raw)
      const writes = backend.writes
      act(() => {
        current.setConfig({ ...current.committedConfig, finish: 'olive' })
      })
      await act(async () => {
        await current.flushPersistence()
      })
      expect(current.committedConfig.finish).toBe('olive')
      expect(current.persistence.writeSafe).toBe(false)
      expect(backend.rows.get('draft')?.raw).toBe(raw)
      expect(backend.writes).toBe(writes)
      expect(
        current.recovery.some((entry) => entry.record.raw === raw && entry.status === 'durable'),
      ).toBe(true)
      act(() => {
        current.undo()
      })
      expect(current.committedConfig.finish).toBe(DEFAULT_CONFIG.finish)
    },
  )
  it('opens saved/raw repair with both originals durable, repairs incrementally, then explicitly accepts', async () => {
    await mount()
    const original = current.committedConfig
    const draftRaw = backend.rows.get('draft')!.raw
    const candidate: Config = {
      ...DEFAULT_CONFIG,
      family: 'container',
      items: [
        { id: 'rack', sku: 'rack', x: -5, z: -0.8, rotation: 0 },
        { id: 'mat', sku: 'mat', x: 19, z: 0, rotation: 0 },
      ],
    }
    const raw = '  ' + JSON.stringify({ ...candidate, v: 2 })
    await act(async () => {
      expect(await current.openRepair(candidate, { raw, format: 'json' })).toMatchObject({
        ok: true,
        value: { status: 'repair' },
      })
    })
    expect(current.committedConfig).toEqual(candidate)
    expect(current.repair).toMatchObject({ required: true, workspace: true, canAccept: false })
    expect(current.persistence.writeSafe).toBe(false)
    const storedRaw = [...backend.rows.values()]
      .filter((row) => row.key.startsWith('recovery:'))
      .map((row) => JSON.parse(row.raw).raw)
    expect(storedRaw).toEqual(
      expect.arrayContaining([JSON.stringify(original), JSON.stringify(candidate), raw]),
    )
    const revision = current.revision
    act(() => {
      current.setConfig({
        ...candidate,
        items: candidate.items.filter((item) => item.sku !== 'rack'),
      })
    })
    expect(current.lastEditResult?.status).toBe('committed')
    expect(current.repair.canAccept).toBe(false)
    expect(current.revision).toBe(revision + 1)
    await act(async () => {
      await current.flushPersistence()
    })
    expect(backend.rows.get('draft')?.raw).toBe(draftRaw)
    act(() => {
      current.setConfig({
        ...current.committedConfig,
        items: [{ ...candidate.items[1], x: -5, z: -0.5 }],
      })
    })
    expect(current.repair).toMatchObject({ required: true, workspace: true, canAccept: true })
    expect(inspectDocument(current.committedConfig).status).toBe('accepted')
    await act(async () => {
      await current.flushPersistence()
    })
    expect(backend.rows.get('draft')?.raw).toBe(draftRaw)
    await act(async () => {
      expect(await current.acceptRecovery()).toMatchObject({ ok: true, value: { status: 'saved' } })
    })
    expect(current.repair.required).toBe(false)
    expect(current.persistence.writeSafe).toBe(true)
    expect(current.persistence.savedRevision).toBe(current.revision)
    expect(backend.rows.get('draft')?.raw).toBe(encodeConfig(current.committedConfig))
    const repairedRaw = backend.rows.get('draft')?.raw
    act(() => {
      current.undo()
    })
    expect(current.repair).toMatchObject({ required: true, workspace: true })
    await act(async () => {
      await current.flushPersistence()
    })
    expect(backend.rows.get('draft')?.raw).toBe(repairedRaw)
    act(() => {
      current.redo()
    })
    expect(current.repair.canAccept).toBe(true)
    expect(current.persistence.writeSafe).toBe(false)
  })
  it('does not replace the live document when durable repair preservation fails', async () => {
    await mount()
    const original = current.committedConfig
    const candidate: Config = { ...DEFAULT_CONFIG, family: 'container' }
    const revision = current.revision
    const draftRaw = backend.rows.get('draft')?.raw
    backend.fail = 'quota'
    await act(async () => {
      expect(await current.openRepair(candidate)).toEqual({ ok: false, reason: 'quota' })
    })
    expect(current.committedConfig).toBe(original)
    expect(current.revision).toBe(revision)
    expect(current.canUndo).toBe(false)
    expect(current.persistence).toMatchObject({
      writeSafe: false,
      status: 'volatile',
      reason: 'quota',
    })
    expect(
      current.recovery
        .filter((entry) => entry.status === 'volatile')
        .map((entry) => entry.record.raw),
    ).toEqual(expect.arrayContaining([JSON.stringify(original), JSON.stringify(candidate)]))
    expect(backend.rows.get('draft')?.raw).toBe(draftRaw)
  })
  it('rejects stale repair restore after preserving both inputs, without losing the newer edit', async () => {
    await mount()
    const base = current.committedConfig
    const candidate: Config = { ...DEFAULT_CONFIG, family: 'container' }
    backend.beforeTransaction = () => {
      backend.beforeTransaction = undefined
      current.setConfig({ ...base, finish: 'olive' })
    }
    await act(async () => {
      expect(await current.openRepair(candidate)).toEqual({ ok: false, reason: 'conflict' })
    })
    expect(current.committedConfig.finish).toBe('olive')
    expect(current.committedConfig.family).toBe('studio')
    expect(current.persistence.writeSafe).toBe(false)
    expect(
      current.recovery.some(
        (entry) => entry.record.raw === JSON.stringify(candidate) && entry.status === 'durable',
      ),
    ).toBe(true)
  })
  it('refuses invalid/future repair documents without replacing current', async () => {
    await mount()
    const base = current.committedConfig
    await act(async () => {
      expect(await current.openRepair({ ...base, v: 99 } as unknown as Config)).toEqual({
        ok: false,
        reason: 'corrupt-store',
      })
    })
    expect(current.committedConfig).toBe(base)
  })
  it('keeps the current document when the repository is unavailable for repair', async () => {
    vi.mocked(repository.openDocumentRepository).mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    })
    await mount()
    const base = current.committedConfig
    await act(async () => {
      expect(await current.openRepair({ ...base, family: 'container' })).toEqual({
        ok: false,
        reason: 'unavailable',
      })
    })
    expect(current.committedConfig).toBe(base)
    expect(current.persistence).toMatchObject({
      writeSafe: false,
      status: 'volatile',
      reason: 'unavailable',
    })
    expect(backend.writes).toBe(0)
  })
  it('keeps later repair edits and original draft when an acceptance becomes stale', async () => {
    await mount()
    const raw = backend.rows.get('draft')?.raw
    await act(async () => {
      await current.openRepair({ ...DEFAULT_CONFIG, family: 'container', items: [] })
    })
    backend.beforeTransaction = () => {
      backend.beforeTransaction = undefined
      current.setConfig({ ...current.committedConfig, finish: 'olive' })
    }
    await act(async () => {
      expect(await current.acceptRecovery()).toEqual({ ok: false, reason: 'conflict' })
    })
    expect(current.committedConfig.finish).toBe('olive')
    expect(current.repair.workspace).toBe(true)
    expect(current.persistence.writeSafe).toBe(false)
    expect(backend.rows.get('draft')?.raw).toBe(raw)
  })
  it('does not claim reset success when displaced volatile work cannot be preserved', async () => {
    await mount()
    act(() => {
      current.setConfig({ ...current.committedConfig, finish: 'olive' })
    })
    await act(async () => {
      await current.flushPersistence()
    })
    const original = current.committedConfig
    backend.fail = 'quota'
    await act(async () => {
      expect(await current.resetConfig()).toEqual({ ok: false, reason: 'quota' })
    })
    expect(current.committedConfig).toBe(original)
    expect(current.persistence.writeSafe).toBe(false)
  })
})
