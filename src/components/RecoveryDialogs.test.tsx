// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../lib/config'
import type { LibrarySnapshot } from '../lib/repository'
import type { useConfig } from '../lib/useConfig'
import { LibraryDialog } from './Dialogs'
import RecoveryDialog from './RecoveryDialog'

const library = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./Modal', () => ({
  default: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}))
vi.mock('./useLibrary', async (original) => ({
  ...(await original<typeof import('./useLibrary')>()),
  useLibrary: () => library.read(),
}))

describe('explicit repair entry points', () => {
  let host: HTMLDivElement, root: Root
  let candidate: Config, original: string, snapshot: LibrarySnapshot
  const close = vi.fn(),
    notify = vi.fn(),
    plan = vi.fn(),
    load = vi.fn()
  const repair = vi.fn()
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(label))!
  const render = async (node: ReactNode) => {
    await act(async () => root.render(node))
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    close.mockReset()
    notify.mockReset()
    plan.mockReset()
    load.mockReset()
    repair.mockReset()
    candidate = { ...structuredClone(DEFAULT_CONFIG), family: 'container' }
    original = JSON.stringify(
      {
        id: 'repair-original',
        name: 'Original oversized rack',
        date: '2026-10-14',
        config: candidate,
      },
      null,
      2,
    )
    snapshot = {
      entries: [
        {
          build: JSON.parse(original),
          originalRaw: original,
          revision: 3,
          status: 'repair',
          issues: ['Rack exceeds the usable ceiling.'],
        },
      ],
      rejected: [],
      tombstones: [],
    }
    library.read.mockReturnValue({
      snapshot,
      busy: false,
      error: null,
      save: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn(),
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('awaits preservation and passes exact saved-build bytes instead of ordinary loading', async () => {
    let finish!: (value: boolean) => void
    repair.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    await render(
      <LibraryDialog
        config={DEFAULT_CONFIG}
        unit="ft"
        onClose={close}
        onLoad={load}
        onRepair={repair}
        notify={notify}
      />,
    )
    await act(async () => button('Open for repair').click())
    expect(repair).toHaveBeenCalledWith(candidate, { raw: original, format: 'json' })
    expect(load).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(button('Open for repair').disabled).toBe(true)
    expect(host.textContent).toContain('Preserving both designs')
    await act(async () => finish(true))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('keeps the library open when preservation fails and blocks saving unaccepted repair work', async () => {
    repair.mockResolvedValue(false)
    await render(
      <LibraryDialog
        config={DEFAULT_CONFIG}
        unit="ft"
        onClose={close}
        onLoad={load}
        onRepair={repair}
        notify={notify}
        saveBlocked
      />,
    )
    await act(async () => button('Open for repair').click())
    expect(close).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(button('Save').disabled).toBe(true)
    expect(button('Open for repair').disabled).toBe(false)
    expect(host.textContent).toContain('explicitly accept the repaired design')
  })
  it('opens a preserved invalid original as repair and retains its original format', async () => {
    const record = {
      id: 'raw-id',
      raw: original,
      format: 'json' as const,
      source: 'library' as const,
      createdAt: '2026-10-14',
      resolved: false,
    }
    repair.mockResolvedValue({ ok: true, value: { status: 'repair', revision: 8 } })
    const design = {
      committedConfig: DEFAULT_CONFIG,
      isPreviewing: false,
      recovery: [{ status: 'durable', record }],
      persistence: { status: 'ready' },
      repair: { required: false, issues: [], canAccept: true, workspace: false },
      openRepair: repair,
      acceptRecovery: vi.fn(),
    } as unknown as ReturnType<typeof useConfig>
    await render(<RecoveryDialog document={design} onClose={close} notify={notify} onPlan={plan} />)
    await act(async () => button('Open original for repair').click())
    expect(repair).toHaveBeenCalledWith(candidate, record)
    expect(design.acceptRecovery).not.toHaveBeenCalled()
    expect(plan).toHaveBeenCalledTimes(1)
  })
})
