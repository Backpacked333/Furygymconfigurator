// Plugin invocation against a fake Vite server only; no listener/customer app/browser is started.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigEnv, Plugin, ViteDevServer } from 'vite'
import { localRenderPlugin } from './local-render-plugin'
import type { LocalRenderHttpService } from '../src/image-service/localRenderHttp'

afterEach(() => vi.unstubAllEnvs())
function factory() {
  const close = vi.fn()
  const create = vi.fn(
    async () => ({ close }) as unknown as LocalRenderHttpService & { close(): void },
  )
  return { create, close }
}
async function configure(plugin: Plugin, overrides: Record<string, unknown> = {}) {
  const server = {
    config: {
      command: 'serve',
      mode: 'development',
      isProduction: false,
      root: '/home/ubuntu/Documents/fury-real',
      logger: { info: vi.fn(), warn: vi.fn() },
      ...overrides,
    },
    middlewares: { use: vi.fn() },
    httpServer: new EventEmitter(),
  }
  const hook = plugin.configureServer!
  const handler = typeof hook === 'function' ? hook : hook.handler
  await handler.call({} as never, server as unknown as ViteDevServer)
  return server
}
function enable() {
  vi.stubEnv('FURY_IMAGE_PROTOTYPE', '1')
  vi.stubEnv('FURY_LOCAL_REAL_IMAGES', '1')
  vi.stubEnv('NODE_ENV', 'development')
}

describe('explicit DEV local-real plugin', () => {
  it('only enables with both distinct flags and closes the owned service', async () => {
    enable()
    const f = factory(),
      plugin = localRenderPlugin(f.create),
      server = await configure(plugin)
    expect(f.create).toHaveBeenCalledExactlyOnceWith('/home/ubuntu/Documents/fury-real')
    expect(server.middlewares.use).toHaveBeenCalledTimes(1)
    server.httpServer.emit('close')
    expect(f.close).toHaveBeenCalledOnce()
  })
  it.each([
    ['FURY_IMAGE_PROTOTYPE', '0'],
    ['FURY_LOCAL_REAL_IMAGES', '0'],
    ['NODE_ENV', 'production'],
  ])(
    'does not load Node capture/service under %s=%s; installs unavailable guard',
    async (key, value) => {
      enable()
      vi.stubEnv(key, value)
      const f = factory(),
        server = await configure(localRenderPlugin(f.create))
      expect(f.create).not.toHaveBeenCalled()
      expect(server.middlewares.use).toHaveBeenCalledOnce()
    },
  )
  it.each([{ command: 'build' }, { mode: 'production' }, { isProduction: true }])(
    'denies production configuration %j',
    async (overrides) => {
      enable()
      const f = factory()
      await configure(localRenderPlugin(f.create), overrides)
      expect(f.create).not.toHaveBeenCalled()
    },
  )
  it('is not applied to builds or preview, even with both flags', () => {
    enable()
    const plugin = localRenderPlugin(factory().create)
    const apply = plugin.apply as (config: unknown, environment: ConfigEnv) => boolean
    expect(apply({}, { command: 'build', mode: 'development' })).toBe(false)
    expect(apply({}, { command: 'serve', mode: 'development', isPreview: true })).toBe(false)
    expect(apply({}, { command: 'serve', mode: 'production' })).toBe(false)
  })
  it('installs only unavailable guard if setup/import fails', async () => {
    enable()
    const create = vi.fn(async () => {
      throw new Error('Synthetic missing runtime')
    })
    const server = await configure(localRenderPlugin(create))
    expect(server.middlewares.use).toHaveBeenCalledOnce()
    expect(server.config.logger.warn).toHaveBeenCalledOnce()
  })
  it('Vite config preserves default plugins and mounts the real guard before broad mock middleware', async () => {
    enable()
    const { default: config } = await import('../vite.config')
    const evaluate = config as (environment: ConfigEnv) => Promise<{ plugins: Plugin[] }>
    const dev = await evaluate({ command: 'serve', mode: 'development' })
    const names = dev.plugins.map((plugin) => plugin.name).filter(Boolean)
    expect(names.indexOf('fury-local-real-render-images')).toBeLessThan(
      names.indexOf('fury-local-mock-image-prototype'),
    )
    for (const env of [
      { command: 'build', mode: 'development' },
      { command: 'serve', mode: 'production' },
      { command: 'serve', mode: 'development', isPreview: true },
    ] as ConfigEnv[]) {
      const value = await evaluate(env)
      expect(value.plugins.map((plugin) => plugin.name)).not.toContain(
        'fury-local-real-render-images',
      )
      expect(value.plugins.map((plugin) => plugin.name)).not.toContain(
        'fury-local-mock-image-prototype',
      )
    }
    vi.stubEnv('FURY_IMAGE_PROTOTYPE', '0')
    vi.stubEnv('FURY_LOCAL_REAL_IMAGES', '0')
    const disabled = await evaluate({ command: 'serve', mode: 'development' })
    expect(disabled.plugins.map((plugin) => plugin.name)).toContain('fury-local-real-render-images')
    expect(disabled.plugins.map((plugin) => plugin.name)).not.toContain(
      'fury-local-mock-image-prototype',
    )
  })
})
