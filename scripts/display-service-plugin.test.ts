// Vite hooks with inert server doubles only; never a UI browser or private backend.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigEnv, Plugin, ViteDevServer } from 'vite'
import { displayServicePlugin } from './display-service-plugin'
import type { DisplayHttpService, DisplayMiddleware } from '../src/image-service/display/http'

afterEach(() => vi.unstubAllEnvs())
function enable() {
  vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
  vi.stubEnv('FURY_PRIVATE_DISPLAY', '1')
  vi.stubEnv('NODE_ENV', 'development')
}
function factory() {
  const close = vi.fn(async () => {})
  const create = vi.fn(async () => ({
    service: { close } as unknown as DisplayHttpService & { close(): Promise<void> },
    authenticate: () => null,
  }))
  return { close, create }
}
async function configure(plugin: Plugin, overrides: Record<string, unknown> = {}) {
  const server = {
    config: {
      command: 'serve',
      mode: 'development',
      isProduction: false,
      root: '/home/ubuntu/Documents/fury-display',
      logger: { info: vi.fn(), warn: vi.fn() },
      ...overrides,
    },
    middlewares: { use: vi.fn() },
    httpServer: new EventEmitter(),
  }
  const hook = plugin.configureServer!,
    handler = typeof hook === 'function' ? hook : hook.handler
  await handler.call({} as never, server as unknown as ViteDevServer)
  return server
}
describe('private display DEV connection gate', () => {
  it('connects fixed factory only when explicitly enabled, and closes owned resources', async () => {
    enable()
    const f = factory(),
      server = await configure(displayServicePlugin(f.create))
    expect(f.create).toHaveBeenCalledExactlyOnceWith('/home/ubuntu/Documents/fury-display')
    expect(server.middlewares.use).toHaveBeenCalledTimes(2)
    server.httpServer.emit('close')
    expect(f.close).toHaveBeenCalledOnce()
  })
  it.each([
    ['FURY_IMAGE_PROTOTYPE', '0'],
    ['FURY_PRIVATE_DISPLAY', '0'],
    ['NODE_ENV', 'production'],
  ])('never loads backend under %s=%s', async (key, value) => {
    enable()
    vi.stubEnv(key, value)
    const f = factory(),
      server = await configure(displayServicePlugin(f.create))
    expect(f.create).not.toHaveBeenCalled()
    expect(server.middlewares.use).toHaveBeenCalledTimes(2)
  })
  it.each([{ command: 'build' }, { mode: 'production' }, { isProduction: true }])(
    'rejects configuration %j',
    async (overrides) => {
      enable()
      const f = factory()
      await configure(displayServicePlugin(f.create), overrides)
      expect(f.create).not.toHaveBeenCalled()
    },
  )
  it('never applies to build/preview even with flags and precedes broad mocks in Vite', async () => {
    enable()
    const plugin = displayServicePlugin(factory().create),
      apply = plugin.apply as (config: unknown, env: ConfigEnv) => boolean
    const { default: config } = await import('../vite.config')
    const evaluate = config as (env: ConfigEnv) => Promise<{ plugins: Plugin[] }>
    for (const env of [
      { command: 'build', mode: 'development' },
      { command: 'serve', mode: 'production' },
      { command: 'serve', mode: 'development', isPreview: true },
    ] as ConfigEnv[]) {
      expect(apply({}, env)).toBe(false)
      expect((await evaluate(env)).plugins.map((p) => p.name)).not.toContain(
        'fury-private-display-candidate',
      )
    }
    const names = (await evaluate({ command: 'serve', mode: 'development' })).plugins.map(
      (p) => p.name,
    )
    expect(names.indexOf('fury-private-display-candidate')).toBeLessThan(
      names.indexOf('fury-local-mock-image-prototype'),
    )
  })
  it('blocks public Vite source/worker guesses while keeping ordinary app paths unchanged', async () => {
    enable()
    vi.stubEnv('FURY_PRIVATE_DISPLAY', '0')
    const server = await configure(displayServicePlugin(factory().create)),
      guard = server.middlewares.use.mock.calls[0][0] as DisplayMiddleware
    for (const url of [
      '/src/render/display/browser/scene.tsx',
      '/@fs/home/ubuntu/Documents/fury-display/src/image-service/display/service.ts',
      '/src/display/session.ts',
      '/%73rc/render/display/browser/entry.ts',
      '/src/display/readiness.ts',
      '/src/display/session',
      '/src/display/readiness',
      '/src/render/other/../display/backend.ts',
      '/%2573rc/render/display/backend.ts',
      '//[',
    ]) {
      const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() },
        next = vi.fn()
      guard({ url } as never, response as never, next)
      expect(response.statusCode).toBe(404)
      expect(next).not.toHaveBeenCalled()
    }
    const next = vi.fn()
    guard({ url: '/src/App.tsx' } as never, {} as never, next)
    expect(next).toHaveBeenCalledOnce()
  })
  it('setup failure installs unavailable guard, not fallback or a replacement run', async () => {
    enable()
    const create = vi.fn(async () => {
        throw new Error('synthetic absent runtime')
      }),
      server = await configure(displayServicePlugin(create))
    expect(server.middlewares.use).toHaveBeenCalledTimes(2)
    expect(server.config.logger.warn).toHaveBeenCalledOnce()
  })
})
