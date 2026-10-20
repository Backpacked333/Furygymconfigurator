// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  start: vi.fn(),
  legacyImport: vi.fn(),
  prototypeImport: vi.fn(),
  mountLegacy: vi.fn(),
  createRoot: vi.fn(),
  render: vi.fn(),
}))
vi.mock('../lib/startup', () => ({ startApplication: calls.start }))
vi.mock('react-dom/client', () => ({ default: { createRoot: calls.createRoot } }))

describe('actual application entry selection (mocked modules, no renderer startup)', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // Re-register factories: resetModules does not clear Vitest's cached mock exports.
    vi.doMock('../legacyEntry', () => {
      calls.legacyImport()
      return { mountLegacy: calls.mountLegacy }
    })
    vi.doMock('./ImageConfigurator', () => {
      calls.prototypeImport()
      return { ImageConfigurator: () => null }
    })
    host = document.createElement('div')
    host.id = 'root'
    document.body.append(host)
    calls.createRoot.mockReturnValue({ render: calls.render })
  })
  afterEach(() => {
    host.remove()
    vi.unstubAllEnvs()
    window.history.replaceState(null, '', '/')
  })
  it.each([
    [true, '/', false],
    [true, '/?prototype=other', false],
    [true, '/?prototype=images', true],
    [false, '/?prototype=images', false],
    [false, '/?experience=library', true],
  ] as const)('DEV=%s at %s selects prototype=%s lazily', async (dev, url, prototype) => {
    vi.stubEnv('DEV', dev)
    window.history.replaceState(null, '', url)
    await import('../main')
    expect(calls.start).toHaveBeenCalledOnce()
    expect(calls.start.mock.calls[0][0]).toBe(host)
    expect(calls.legacyImport).not.toHaveBeenCalled()
    expect(calls.prototypeImport).not.toHaveBeenCalled()
    // Execute only the entry chosen by the actual main module; both loaders are inert test doubles.
    await calls.start.mock.calls[0][1]()
    expect(calls.legacyImport).toHaveBeenCalledTimes(prototype ? 0 : 1)
    expect(calls.mountLegacy).toHaveBeenCalledTimes(prototype ? 0 : 1)
    expect(calls.prototypeImport).toHaveBeenCalledTimes(prototype ? 1 : 0)
    expect(calls.render).toHaveBeenCalledTimes(prototype ? 1 : 0)
  })
})
